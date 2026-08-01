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

CREATE TABLE IF NOT EXISTS product_recipe (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    flower_stock_id INTEGER NOT NULL REFERENCES flower_stock(id),
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
    total REAL NOT NULL DEFAULT 0,
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
"""


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
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
