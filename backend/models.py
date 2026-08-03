"""
База данных магазина (SQLite). Схема покрывает: точки продаж, каталог с
вариантами цены, складской учёт цветов с приходом/списанием, привязку
букета к «рецепту» (для автосписания при продаже), заказы и позиции заказа,
персонал.
"""
import sqlite3
import os

# Путь к БД можно переопределить переменной DB_PATH — это нужно, чтобы на
# Railway положить файл на постоянный Volume (например /data/shop.db) и не
# терять товары/заказы при каждом редеплое. По умолчанию — рядом с кодом.
DB_PATH = os.environ.get("DB_PATH", "").strip() or os.path.join(os.path.dirname(__file__), "shop.db")

_db_dir = os.path.dirname(DB_PATH)
if _db_dir:
    os.makedirs(_db_dir, exist_ok=True)

SCHEMA = """
CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT
);

CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    location_id INTEGER NOT NULL REFERENCES locations(id),
    category_id INTEGER NOT NULL REFERENCES categories(id),
    name TEXT NOT NULL,
    description TEXT,
    composition TEXT,
    photo_url TEXT,
    status TEXT NOT NULL DEFAULT 'in_stock',   -- in_stock | made_to_order | hidden
    occasion_tags TEXT,                          -- через запятую
    is_addon INTEGER NOT NULL DEFAULT 0,         -- 1 = показывать в «Добавьте к заказу»
    badge TEXT NOT NULL DEFAULT '',              -- '' | new | hit | recommended
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS product_variants (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    label TEXT NOT NULL,                          -- "S — 15 роз"
    price REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS flower_stock (
    id INTEGER PRIMARY KEY,
    location_id INTEGER NOT NULL REFERENCES locations(id),
    name TEXT NOT NULL,                           -- "Роза Ecuador красная 60см"
    unit TEXT NOT NULL DEFAULT 'шт',
    quantity REAL NOT NULL DEFAULT 0,
    low_stock_threshold REAL DEFAULT 10,
    supplier TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_movements (
    id INTEGER PRIMARY KEY,
    flower_stock_id INTEGER NOT NULL REFERENCES flower_stock(id),
    movement_type TEXT NOT NULL,                  -- income | writeoff | sale
    quantity REAL NOT NULL,                        -- всегда положительное число
    note TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Партии прихода цветка (для плашки свежести «получена ДД.ММ»). Ведутся
-- параллельно с flower_stock.quantity: приход создаёт партию, списание съедает
-- партии по FIFO (старые → новые). qty_left>0 у нескольких партий = на складе
-- ещё лежит предыдущая поставка (звёздочка на плашке). Возраст считается по
-- самой свежей партии с остатком.
CREATE TABLE IF NOT EXISTS stock_batches (
    id INTEGER PRIMARY KEY,
    flower_stock_id INTEGER NOT NULL REFERENCES flower_stock(id) ON DELETE CASCADE,
    received_at TEXT,                              -- дата прихода "YYYY-MM-DD"
    qty_received REAL NOT NULL,
    qty_left REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS product_recipe (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    flower_stock_id INTEGER NOT NULL REFERENCES flower_stock(id),
    quantity_needed REAL NOT NULL
);

-- Рецепт по размерам с заменами. Строка = ЛИБО конкретный цветок (flower_stock_id),
-- ЛИБО группа/тип (flower_type, любой цвет внутри) + количество в штуках.
CREATE TABLE IF NOT EXISTS recipe_lines (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    variant_id INTEGER REFERENCES product_variants(id) ON DELETE CASCADE,
    flower_stock_id INTEGER REFERENCES flower_stock(id),
    flower_type TEXT,
    quantity_needed REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY,
    telegram_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'florist'           -- owner | florist | courier
);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    location_id INTEGER REFERENCES locations(id),
    customer_tg_id TEXT,
    customer_name TEXT,
    customer_phone TEXT,
    fulfillment_type TEXT NOT NULL DEFAULT 'delivery', -- delivery | pickup
    address TEXT,
    delivery_date TEXT,
    delivery_slot TEXT,
    recipient_name TEXT,
    recipient_phone TEXT,
    card_message TEXT,
    photo_before_delivery INTEGER DEFAULT 0,
    payment_method TEXT,                            -- cash | card_courier | transfer
    payment_status TEXT DEFAULT 'unpaid',
    status TEXT NOT NULL DEFAULT 'new',              -- new|confirmed|assembling|out_for_delivery|delivered|cancelled
    assigned_staff_id INTEGER REFERENCES staff(id),
    delivery_zone TEXT,                             -- batumi | outside (доставка только по Батуми)
    delivery_fee REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,                   -- товары + доставка
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id),
    product_name TEXT NOT NULL,
    variant_label TEXT,
    price REAL NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Живые продажи в точке (флорист вбивает вручную): касса за день = доставки + эти.
-- product_id NULL = вбит вручную (без каталога). Списание со склада — через
-- stock_movements с note "продажа #<id>" (как у заказов), для отмены-реверса.
CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY,
    location_id INTEGER,
    product_id INTEGER,
    title TEXT NOT NULL,
    variant_label TEXT,
    amount REAL NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    payment_method TEXT,                            -- cash | card | transfer
    sold_by TEXT,
    sold_by_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Окна доставки с индивидуальным лимитом заказов на окно (редактируются в админке).
CREATE TABLE IF NOT EXISTS delivery_slots (
    id INTEGER PRIMARY KEY,
    window TEXT NOT NULL,               -- "09:00-11:00"
    capacity INTEGER NOT NULL DEFAULT 2,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY,
    tg_id TEXT NOT NULL,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tg_id, product_id)
);

-- Очередь уведомлений (outbox). Заказ пишется в БД раньше, поэтому даже если
-- Telegram недоступен, заказ не теряется, а уведомление досылается фоновым
-- повтором. status: pending | sent | failed.
CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY,
    chat_id TEXT NOT NULL,
    text TEXT NOT NULL,
    reply_markup TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
"""


def get_db():
    # timeout=5 — сколько ждать снятия блокировки вместо мгновенной ошибки
    # "database is locked" при параллельной записи.
    conn = sqlite3.connect(DB_PATH, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # ВАЖНО про персистентность на Railway: контейнер при редеплое завершается
    # жёстко (SIGKILL), поэтому режим WAL здесь ТЕРЯЛ данные — закоммиченные
    # строки оставались в shop.db-wal, который не сливался в основной файл и не
    # переживал перезапуск (при каждом старте база была пустой). Поэтому
    # используем обычный откатный журнал (DELETE) + synchronous=FULL: каждый
    # commit пишется прямо в shop.db с fsync и durably остаётся на Volume.
    # Для одного gunicorn-воркера потеря «параллельных чтений при записи»
    # некритична, а надёжность данных важнее.
    conn.execute("PRAGMA journal_mode = DELETE")
    conn.execute("PRAGMA synchronous = FULL")
    return conn


def init_db(reset=False):
    if reset and os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    conn = get_db()
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()


if __name__ == "__main__":
    init_db(reset=True)
    print(f"База создана: {DB_PATH}")
