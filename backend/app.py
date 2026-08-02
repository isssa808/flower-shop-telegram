# -*- coding: utf-8 -*-
"""
Backend Flower Batum Flower Mini App.
Один Flask-процесс отдаёт и API, и статику (customer + admin), чтобы всё
поднималось одной командой: python app.py

Переменные окружения:
  BOT_TOKEN         — токен бота от @BotFather (для проверки initData и
                       уведомлений). Для локальных тестов можно не задавать —
                       используется значение по умолчанию ниже, но тогда
                       реальный Telegram проверку не пройдёт (это ожидаемо,
                       см. README).
  OWNER_TELEGRAM_ID — ваш личный Telegram ID. Если задан, при старте
                       приложение само добавит вас в таблицу staff с ролью
                       owner — чтобы попасть в админку, не нужно руками
                       лезть в базу данных.
  OWNER_NAME        — ваше имя для отображения в админке (необязательно).
  SHOP_NAME, SHOP_ADDRESS — название/адрес точки продаж по умолчанию
                       (необязательно).
  DEBUG             — "1" для флаг-отладки Flask (авто-перезагрузка).
"""
import os
import json
import time
import threading
import functools
import urllib.request
import urllib.error
from flask import Flask, request, jsonify, send_from_directory, g

from models import get_db, init_db, DB_PATH
from auth import validate_init_data

BASE_DIR = os.path.dirname(__file__)
FRONTEND_DIR = os.path.join(BASE_DIR, "..", "frontend")
BOT_TOKEN = os.environ.get("BOT_TOKEN", "LOCAL_DEV_TOKEN")

# Загруженные фото храним рядом с БД (на постоянном Volume), иначе они
# исчезали бы при каждом редеплое. Каталог создаётся при старте.
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "").strip() or os.path.join(os.path.dirname(DB_PATH), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

ALLOWED_PHOTO_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
MAX_UPLOAD_BYTES = 5 * 1024 * 1024  # 5 МБ на файл/запрос

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES
init_db(reset=False)


@app.errorhandler(413)
def _too_large(_e):
    return jsonify({"error": "file too large", "detail": "макс. 5 МБ"}), 413


# --------------------------------------------------------------------------
# Автозапуск: точка продаж и стартовые категории по умолчанию (если их ещё
# нет), плюс — если задана переменная окружения OWNER_TELEGRAM_ID — владелец
# сразу добавляется в таблицу staff. Это нужно, чтобы после деплоя не
# требовалось лезть в базу данных руками: узнали свой Telegram ID (например,
# через @userinfobot), прописали его в OWNER_TELEGRAM_ID на хостинге,
# перезапустили — и вы уже сотрудник с ролью owner.
# --------------------------------------------------------------------------
def bootstrap():
    conn = get_db()
    # Короткий диагностический лог при старте: путь к БД и число строк. Помогает
    # быстро увидеть в логах Railway, жива ли персистентность (при пустой БД на
    # каждом старте — значит данные не на постоянном Volume, см. историю фикса).
    try:
        _pc = conn.execute("SELECT COUNT(*) c FROM products").fetchone()["c"]
        _oc = conn.execute("SELECT COUNT(*) c FROM orders").fetchone()["c"]
        print(f"[db] DB_PATH={DB_PATH} products={_pc} orders={_oc}", flush=True)
    except Exception as _e:
        print(f"[db] diag failed: {_e}", flush=True)
    if not conn.execute("SELECT 1 FROM locations LIMIT 1").fetchone():
        conn.execute(
            "INSERT INTO locations (id, name, address) VALUES (1, ?, ?)",
            (os.environ.get("SHOP_NAME", "Flowers Batum Flower"), os.environ.get("SHOP_ADDRESS", "")),
        )
    if not conn.execute("SELECT 1 FROM categories LIMIT 1").fetchone():
        conn.executemany(
            "INSERT INTO categories (slug, name, sort_order) VALUES (?, ?, ?)",
            [
                ("bouquets", "Букеты на каждый день", 1),
                ("weddings", "Свадьбы и мероприятия", 2),
                ("balloons", "Шары", 3),
                ("wrapping", "Подарочная упаковка", 4),
            ],
        )
    # Разовая чистка: владелец попросил убрать категории «Клубника в шоколаде»
    # и «Опт». На уже задеплоенных БД они засеялись раньше — удаляем их здесь.
    # Товары такой категории (например демо-клубника) переносим в «Букеты» и
    # прячем, чтобы не осталось «висящих» ссылок. Идемпотентно: после удаления
    # категории делать нечего. Полноценное управление категориями — из админки.
    default_cat = conn.execute(
        "SELECT id FROM categories WHERE slug='bouquets'"
    ).fetchone()
    for slug in ("strawberries", "wholesale"):
        row = conn.execute("SELECT id FROM categories WHERE slug=?", (slug,)).fetchone()
        if not row:
            continue
        cid = row["id"]
        if default_cat:
            conn.execute(
                "UPDATE products SET category_id=?, status='hidden' WHERE category_id=?",
                (default_cat["id"], cid),
            )
        conn.execute("DELETE FROM categories WHERE id=?", (cid,))
    owner_id = os.environ.get("OWNER_TELEGRAM_ID", "").strip()
    if owner_id and not conn.execute("SELECT 1 FROM staff WHERE telegram_id=?", (owner_id,)).fetchone():
        conn.execute(
            "INSERT INTO staff (telegram_id, name, role) VALUES (?, ?, 'owner')",
            (owner_id, os.environ.get("OWNER_NAME", "Владелец")),
        )
    # Демо-товары: чтобы каталог не был пустым сразу после первого запуска.
    # Заводятся только если товаров ещё нет и SEED_DEMO != "0". Когда заведёте
    # свой ассортимент через админку — поставьте переменную SEED_DEMO=0.
    if os.environ.get("SEED_DEMO", "1") != "0" and \
       not conn.execute("SELECT 1 FROM products LIMIT 1").fetchone():
        seed_demo_catalog(conn)
    conn.commit()
    conn.close()


PLACEHOLDER_PHOTO = "/static/img/placeholder.svg"


def seed_demo_catalog(conn):
    """Небольшой демо-ассортимент под точку id=1. Товары можно править и
    удалять в админке; повторно они не появятся, пока в каталоге есть хоть один
    товар (или если задать SEED_DEMO=0)."""
    # id категорий совпадают с порядком вставки в bootstrap (bouquets=1, weddings=2, balloons=3, wrapping=4)
    conn.executemany(
        "INSERT INTO products (id, location_id, category_id, name, description, composition, "
        "photo_url, status, occasion_tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (1, 1, 1, "Букет «Батуми»", "Розы Netherlands, эвкалипт, авторская сборка",
             "11 роз, эвкалипт", PLACEHOLDER_PHOTO, "in_stock", "романтика,день рождения"),
            (2, 1, 1, "Букет «Бульвар»", "Тюльпаны микс с гипсофилой",
             "15 тюльпанов, гипсофила", PLACEHOLDER_PHOTO, "in_stock", "весна,просто так"),
            (3, 1, 2, "Свадебный букет невесты", "Под цвет и стиль мероприятия, обсуждается индивидуально",
             "розы, эвкалипт, лента", PLACEHOLDER_PHOTO, "made_to_order", "свадьба"),
            (4, 1, 3, "Шар фольгированный «Сердце»", "Гелиевый шар, 45 см",
             "1 шар", PLACEHOLDER_PHOTO, "in_stock", "день рождения,романтика"),
        ],
    )
    conn.executemany(
        "INSERT INTO product_variants (product_id, label, price) VALUES (?, ?, ?)",
        [
            (1, "S — 11 роз", 95), (1, "M — 25 роз", 190),
            (2, "Стандарт — 15 тюльпанов", 65),
            (3, "По согласованию", 0),
            (4, "1 шт", 25),
        ],
    )
    print("[seed] демо-каталог создан (4 товара)", flush=True)


bootstrap()


# --------------------------------------------------------------------------
# Уведомления в Telegram — используем только stdlib (urllib), чтобы не нужно
# было ставить лишние пакеты. Если сети нет или BOT_TOKEN не настоящий,
# просто тихо логируем и не роняем запрос — заказ важнее уведомления.
# --------------------------------------------------------------------------
def notify_telegram(chat_id, text):
    if not chat_id or BOT_TOKEN == "LOCAL_DEV_TOKEN":
        app.logger.info(f"[notify skip] to={chat_id}: {text}")
        return
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    data = json.dumps({"chat_id": chat_id, "text": text}).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=5)
    except (urllib.error.URLError, TimeoutError) as e:
        app.logger.warning(f"[notify failed] {e}")


# Чат/канал персонала для новых заказов. Если не задан — шлём владельцу в личку
# (он уже писал боту, так что chat_id = его telegram_id работает).
STAFF_CHAT_ID = os.environ.get("STAFF_CHAT_ID") or os.environ.get("OWNER_TELEGRAM_ID")


# --------------------------------------------------------------------------
# Публичный адрес приложения. На Railway домен доступен в RAILWAY_PUBLIC_DOMAIN
# (без схемы), но можно задать APP_URL явно — он имеет приоритет.
# --------------------------------------------------------------------------
def _public_app_url():
    explicit = os.environ.get("APP_URL", "").strip().rstrip("/")
    if explicit:
        return explicit
    domain = os.environ.get("RAILWAY_PUBLIC_DOMAIN", "").strip()
    if domain:
        return f"https://{domain}"
    return ""


APP_URL = _public_app_url()


def _tg_call(method, payload):
    """Тонкий вызов Bot API на stdlib. Возвращает True/False, не роняет старт."""
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/{method}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read()).get("ok", False)
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        app.logger.warning(f"[bot setup failed] {method}: {e}")
        return False


def setup_bot_menu():
    """При старте вешаем постоянную кнопку-меню бота, открывающую Mini App.
    Благодаря этому магазин открывается на телефоне прямо из чата с ботом —
    отдельный вечно-живой процесс bot.py для этого не нужен."""
    if BOT_TOKEN == "LOCAL_DEV_TOKEN":
        print("[bot setup skip] BOT_TOKEN не задан", flush=True)
        return
    if not APP_URL:
        print("[bot setup skip] APP_URL/RAILWAY_PUBLIC_DOMAIN не заданы", flush=True)
        return
    ok_btn = _tg_call("setChatMenuButton", {
        "menu_button": {
            "type": "web_app",
            "text": "🌸 Открыть магазин",
            "web_app": {"url": APP_URL},
        }
    })
    ok_cmd = _tg_call("setMyCommands", {
        "commands": [
            {"command": "start", "description": "Открыть магазин"},
            {"command": "admin", "description": "Панель персонала"},
        ]
    })
    print(f"[bot setup] menu button -> {APP_URL} (button ok={ok_btn}, commands ok={ok_cmd})", flush=True)


# --------------------------------------------------------------------------
# Мини-бот на long polling прямо внутри веб-процесса (фоновый поток). Нужен
# только чтобы по /start дать кнопку магазина, а по /admin — кнопку админки:
# именно так Telegram открывает нужный адрес со свежим initData. Отдельный
# процесс/сервис для этого не требуется. Отключается переменной RUN_BOT=0.
# ВАЖНО: держите gunicorn на одном воркере (--workers 1), чтобы не было двух
# параллельных потребителей getUpdates (Telegram отдаёт апдейт только одному).
# --------------------------------------------------------------------------
def _bot_send_button(chat_id, text, button_text, url):
    _tg_call("sendMessage", {
        "chat_id": chat_id,
        "text": text,
        "reply_markup": {"inline_keyboard": [[{"text": button_text, "web_app": {"url": url}}]]},
    })


def _bot_poll_loop():
    offset = 0
    api = f"https://api.telegram.org/bot{BOT_TOKEN}/getUpdates"
    while True:
        try:
            data = json.dumps({"offset": offset, "timeout": 20}).encode()
            req = urllib.request.Request(api, data=data, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=25) as resp:
                result = json.loads(resp.read())
        except Exception as e:  # 409 при пересечении деплоев, потеря сети и т.п.
            time.sleep(5)
            continue
        for upd in result.get("result", []):
            offset = upd["update_id"] + 1
            msg = upd.get("message")
            if not msg or "text" not in msg:
                continue
            text = msg["text"].strip()
            chat_id = msg["chat"]["id"]
            try:
                if text.startswith("/start"):
                    _bot_send_button(
                        chat_id,
                        "Добро пожаловать в Flowers Batum Flower 🌸\nНажмите кнопку, чтобы открыть каталог и оформить заказ.",
                        "🌸 Открыть магазин", APP_URL,
                    )
                elif text.startswith("/admin"):
                    _bot_send_button(
                        chat_id,
                        "Панель для персонала (доступ только у сотрудников из таблицы staff).",
                        "🛠 Открыть админку", f"{APP_URL}/admin",
                    )
            except Exception as e:
                print(f"[bot] ошибка обработки апдейта: {e}", flush=True)


def start_bot_thread():
    if BOT_TOKEN == "LOCAL_DEV_TOKEN" or not APP_URL:
        return
    if os.environ.get("RUN_BOT", "1") == "0":
        return
    threading.Thread(target=_bot_poll_loop, daemon=True).start()
    print("[bot] long-poll поток запущен (/start, /admin)", flush=True)


setup_bot_menu()
start_bot_thread()


# --------------------------------------------------------------------------
# Авторизация. Telegram сам присылает initData на фронте — мы только
# проверяем подпись и (для админки) ищем telegram_id в таблице staff.
# --------------------------------------------------------------------------
def require_auth(f):
    @functools.wraps(f)
    def wrapper(*args, **kwargs):
        init_data = request.headers.get("X-Telegram-Init-Data", "")
        result = validate_init_data(init_data, BOT_TOKEN)
        if not result:
            return jsonify({"error": "unauthorized", "detail": "invalid or missing initData"}), 401
        g.tg_user = result["user"]
        return f(*args, **kwargs)
    return wrapper


def require_staff(f):
    @functools.wraps(f)
    @require_auth
    def wrapper(*args, **kwargs):
        conn = get_db()
        staff = conn.execute(
            "SELECT * FROM staff WHERE telegram_id = ?", (str(g.tg_user["id"]),)
        ).fetchone()
        conn.close()
        if not staff:
            return jsonify({"error": "forbidden", "detail": "not staff"}), 403
        g.staff = dict(staff)
        return f(*args, **kwargs)
    return wrapper


def require_owner(f):
    """Управление магазином (категории, персонал, настройки) — только владелец."""
    @functools.wraps(f)
    @require_staff
    def wrapper(*args, **kwargs):
        if g.staff.get("role") != "owner":
            return jsonify({"error": "forbidden", "detail": "owner only"}), 403
        return f(*args, **kwargs)
    return wrapper


# --------------------------------------------------------------------------
# Настройки магазина в БД (таблица app_settings). Владелец меняет их из
# админки без правки переменных окружения: чат для уведомлений о заказах,
# название и адрес точки.
# --------------------------------------------------------------------------
def get_setting(key, default=None):
    conn = get_db()
    row = conn.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
    conn.close()
    return row["value"] if row and row["value"] is not None else default


def set_setting(key, value):
    conn = get_db()
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )
    conn.commit()
    conn.close()


def resolve_staff_chat_id():
    """Куда слать уведомления о новых заказах: сначала настройка из админки,
    иначе переменные окружения (STAFF_CHAT_ID → OWNER_TELEGRAM_ID)."""
    return (get_setting("staff_chat_id") or "").strip() or STAFF_CHAT_ID


# Простая транслитерация для slug категории (имена — на русском). Slug виден
# только в параметрах API (?category=...), не показывается покупателю.
_TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}


def slugify(name):
    out = []
    for ch in (name or "").strip().lower():
        if ch in _TRANSLIT:
            out.append(_TRANSLIT[ch])
        elif ch.isalnum():
            out.append(ch)
        elif ch in " -_":
            out.append("-")
    slug = "-".join(filter(None, "".join(out).split("-")))
    return slug or "category"


def unique_slug(conn, name, exclude_id=None):
    base = slugify(name)
    slug = base
    i = 2
    while True:
        row = conn.execute(
            "SELECT id FROM categories WHERE slug=? AND id IS NOT ?",
            (slug, exclude_id),
        ).fetchone()
        if not row:
            return slug
        slug = f"{base}-{i}"
        i += 1


# --------------------------------------------------------------------------
# Статика — отдаём customer- и admin-приложения одним сервером
# --------------------------------------------------------------------------
@app.route("/")
def customer_index():
    return send_from_directory(os.path.join(FRONTEND_DIR, "customer"), "index.html")


@app.route("/admin")
@app.route("/admin/")
def admin_index():
    return send_from_directory(os.path.join(FRONTEND_DIR, "admin"), "index.html")


@app.route("/customer/<path:path>")
def customer_static(path):
    return send_from_directory(os.path.join(FRONTEND_DIR, "customer"), path)


@app.route("/admin/<path:path>")
def admin_static(path):
    return send_from_directory(os.path.join(FRONTEND_DIR, "admin"), path)


@app.route("/static/img/<path:path>")
def img_static(path):
    return send_from_directory(os.path.join(FRONTEND_DIR, "img"), path)


@app.route("/static/uploads/<path:path>")
def uploads_static(path):
    # Загруженные фото товаров лежат на постоянном Volume (UPLOAD_DIR).
    return send_from_directory(UPLOAD_DIR, path)


@app.route("/shared/<path:path>")
def shared_static(path):
    return send_from_directory(os.path.join(FRONTEND_DIR, "shared"), path)


# --------------------------------------------------------------------------
# Публичное API — каталог
# --------------------------------------------------------------------------
@app.route("/api/locations")
def api_locations():
    conn = get_db()
    rows = [dict(r) for r in conn.execute("SELECT * FROM locations").fetchall()]
    conn.close()
    return jsonify(rows)


@app.route("/api/categories")
def api_categories():
    location_id = request.args.get("location_id", 1)
    conn = get_db()
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM categories ORDER BY sort_order"
    ).fetchall()]
    conn.close()
    return jsonify(rows)


def _product_with_variants(conn, product_row):
    p = dict(product_row)
    variants = conn.execute(
        "SELECT id, label, price FROM product_variants WHERE product_id = ?", (p["id"],)
    ).fetchall()
    p["variants"] = [dict(v) for v in variants]
    p["occasion_tags"] = [t for t in (p.get("occasion_tags") or "").split(",") if t]
    return p


@app.route("/api/products")
def api_products():
    location_id = request.args.get("location_id", 1)
    category = request.args.get("category")
    search = request.args.get("search")
    occasion = request.args.get("occasion")

    query = "SELECT * FROM products WHERE location_id = ? AND status != 'hidden'"
    params = [location_id]
    if category:
        query += " AND category_id = (SELECT id FROM categories WHERE slug = ?)"
        params.append(category)
    if search:
        query += " AND (name LIKE ? OR description LIKE ?)"
        params += [f"%{search}%", f"%{search}%"]
    if occasion:
        query += " AND occasion_tags LIKE ?"
        params.append(f"%{occasion}%")
    query += " ORDER BY id"

    conn = get_db()
    rows = conn.execute(query, params).fetchall()
    result = [_product_with_variants(conn, r) for r in rows]
    conn.close()
    return jsonify(result)


@app.route("/api/products/<int:product_id>")
def api_product_detail(product_id):
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM products WHERE id = ? AND status != 'hidden'", (product_id,)
    ).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "not found"}), 404
    result = _product_with_variants(conn, row)
    conn.close()
    return jsonify(result)


# --------------------------------------------------------------------------
# Публичное API — заказы
# --------------------------------------------------------------------------
@app.route("/api/orders", methods=["POST"])
@require_auth
def api_create_order():
    body = request.get_json(force=True)
    items = body.get("items") or []
    if not items:
        return jsonify({"error": "empty order"}), 400

    conn = get_db()
    cur = conn.cursor()

    total = 0
    resolved_items = []
    for it in items:
        variant = cur.execute(
            "SELECT pv.price, pv.label, p.name, p.id as product_id FROM product_variants pv "
            "JOIN products p ON p.id = pv.product_id WHERE pv.id = ?",
            (it["variant_id"],),
        ).fetchone()
        if not variant:
            conn.close()
            return jsonify({"error": f"variant {it['variant_id']} not found"}), 400
        qty = int(it.get("quantity", 1))
        total += variant["price"] * qty
        resolved_items.append((variant["product_id"], variant["name"], variant["label"], variant["price"], qty))

    user = g.tg_user or {}
    cur.execute(
        """INSERT INTO orders (location_id, customer_tg_id, customer_name, customer_phone,
           fulfillment_type, address, delivery_date, delivery_slot, recipient_name,
           recipient_phone, card_message, photo_before_delivery, payment_method, total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            body.get("location_id", 1),
            str(user.get("id", "")),
            body.get("customer_name") or user.get("first_name", ""),
            body.get("customer_phone", ""),
            body.get("fulfillment_type", "delivery"),
            body.get("address", ""),
            body.get("delivery_date", ""),
            body.get("delivery_slot", ""),
            body.get("recipient_name", ""),
            body.get("recipient_phone", ""),
            body.get("card_message", ""),
            1 if body.get("photo_before_delivery") else 0,
            body.get("payment_method", "cash"),
            total,
        ),
    )
    order_id = cur.lastrowid

    for product_id, name, label, price, qty in resolved_items:
        cur.execute(
            "INSERT INTO order_items (order_id, product_id, product_name, variant_label, price, quantity) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (order_id, product_id, name, label, price, qty),
        )
        # автосписание по рецепту, если он задан для товара
        recipe = cur.execute(
            "SELECT flower_stock_id, quantity_needed FROM product_recipe WHERE product_id = ?",
            (product_id,),
        ).fetchall()
        for r in recipe:
            need = r["quantity_needed"] * qty
            cur.execute(
                "UPDATE flower_stock SET quantity = quantity - ? WHERE id = ?",
                (need, r["flower_stock_id"]),
            )
            cur.execute(
                "INSERT INTO stock_movements (flower_stock_id, movement_type, quantity, note) "
                "VALUES (?, 'sale', ?, ?)",
                (r["flower_stock_id"], need, f"заказ #{order_id}"),
            )

    conn.commit()
    conn.close()

    notify_telegram(resolve_staff_chat_id(), f"🌸 Новый заказ #{order_id} на {total} — {body.get('customer_name', '')}")
    return jsonify({"id": order_id, "total": total, "status": "new"}), 201


@app.route("/api/orders/mine")
@require_auth
def api_my_orders():
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM orders WHERE customer_tg_id = ? ORDER BY created_at DESC",
        (str(g.tg_user["id"]),),
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/orders/<int:order_id>")
@require_auth
def api_order_detail(order_id):
    conn = get_db()
    order = conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if not order:
        conn.close()
        return jsonify({"error": "not found"}), 404
    is_owner = str(order["customer_tg_id"]) == str(g.tg_user["id"])
    is_staff = conn.execute(
        "SELECT 1 FROM staff WHERE telegram_id = ?", (str(g.tg_user["id"]),)
    ).fetchone()
    if not (is_owner or is_staff):
        conn.close()
        return jsonify({"error": "forbidden"}), 403
    items = conn.execute("SELECT * FROM order_items WHERE order_id = ?", (order_id,)).fetchall()
    conn.close()
    result = dict(order)
    result["items"] = [dict(i) for i in items]
    return jsonify(result)


# --------------------------------------------------------------------------
# Админ API — каталог
# --------------------------------------------------------------------------
@app.route("/api/admin/me")
@require_staff
def api_admin_me():
    return jsonify(g.staff)


@app.route("/api/admin/products", methods=["GET", "POST"])
@require_staff
def api_admin_products():
    conn = get_db()
    if request.method == "POST":
        body = request.get_json(force=True)
        cur = conn.execute(
            "INSERT INTO products (location_id, category_id, name, description, composition, "
            "photo_url, status, occasion_tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                body["location_id"], body["category_id"], body["name"],
                body.get("description", ""), body.get("composition", ""),
                body.get("photo_url", "/static/img/placeholder.svg"),
                body.get("status", "in_stock"), ",".join(body.get("occasion_tags", [])),
            ),
        )
        product_id = cur.lastrowid
        for v in body.get("variants", []):
            conn.execute(
                "INSERT INTO product_variants (product_id, label, price) VALUES (?, ?, ?)",
                (product_id, v["label"], v["price"]),
            )
        conn.commit()
        row = conn.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
        result = _product_with_variants(conn, row)
        conn.close()
        return jsonify(result), 201

    location_id = request.args.get("location_id", 1)
    rows = conn.execute(
        "SELECT * FROM products WHERE location_id = ? ORDER BY id DESC", (location_id,)
    ).fetchall()
    result = [_product_with_variants(conn, r) for r in rows]
    conn.close()
    return jsonify(result)


@app.route("/api/admin/products/<int:product_id>", methods=["PUT", "DELETE"])
@require_staff
def api_admin_product_edit(product_id):
    conn = get_db()
    if request.method == "DELETE":
        conn.execute("DELETE FROM products WHERE id = ?", (product_id,))
        conn.commit()
        conn.close()
        return jsonify({"deleted": product_id})

    body = request.get_json(force=True)
    conn.execute(
        "UPDATE products SET name=?, description=?, composition=?, status=?, "
        "occasion_tags=?, photo_url=? WHERE id=?",
        (
            body.get("name"), body.get("description", ""), body.get("composition", ""),
            body.get("status", "in_stock"), ",".join(body.get("occasion_tags", [])),
            body.get("photo_url", "/static/img/placeholder.svg"), product_id,
        ),
    )
    if "variants" in body:
        conn.execute("DELETE FROM product_variants WHERE product_id = ?", (product_id,))
        for v in body["variants"]:
            conn.execute(
                "INSERT INTO product_variants (product_id, label, price) VALUES (?, ?, ?)",
                (product_id, v["label"], v["price"]),
            )
    conn.commit()
    row = conn.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
    result = _product_with_variants(conn, row)
    conn.close()
    return jsonify(result)


@app.route("/api/admin/products/<int:product_id>/photo", methods=["POST"])
@require_staff
def api_admin_product_photo(product_id):
    if "photo" not in request.files:
        return jsonify({"error": "no file"}), 400
    f = request.files["photo"]
    ext = os.path.splitext(f.filename or "")[1].lower()
    if ext not in ALLOWED_PHOTO_EXTS:
        return jsonify({"error": "unsupported file type", "detail": "только изображ: jpg, png, webp, gif"}), 400
    # Имя строим сами из product_id (int из маршрута) + проверенного расширения —
    # имя файла от пользователя не используется, обхода путей нет.
    filename = f"product_{product_id}{ext}"
    f.save(os.path.join(UPLOAD_DIR, filename))
    # ?v=<время> — чтобы Telegram/браузер не показывал старую картинку из кэша
    url = f"/static/uploads/{filename}?v={int(time.time())}"
    conn = get_db()
    conn.execute("UPDATE products SET photo_url=? WHERE id=?", (url, product_id))
    conn.commit()
    conn.close()
    return jsonify({"photo_url": url})


# --------------------------------------------------------------------------
# Админ API — склад
# --------------------------------------------------------------------------
@app.route("/api/admin/stock", methods=["GET", "POST"])
@require_staff
def api_admin_stock():
    conn = get_db()
    if request.method == "POST":
        body = request.get_json(force=True)
        cur = conn.execute(
            "INSERT INTO flower_stock (location_id, name, unit, quantity, low_stock_threshold, supplier) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                body["location_id"], body["name"], body.get("unit", "шт"),
                body.get("quantity", 0), body.get("low_stock_threshold", 10),
                body.get("supplier", ""),
            ),
        )
        conn.commit()
        stock_id = cur.lastrowid
        row = conn.execute("SELECT * FROM flower_stock WHERE id=?", (stock_id,)).fetchone()
        conn.close()
        return jsonify(dict(row)), 201

    location_id = request.args.get("location_id", 1)
    rows = conn.execute(
        "SELECT * FROM flower_stock WHERE location_id = ? ORDER BY name", (location_id,)
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


def _stock_movement(stock_id, movement_type, quantity, note):
    conn = get_db()
    row = conn.execute("SELECT * FROM flower_stock WHERE id=?", (stock_id,)).fetchone()
    if not row:
        conn.close()
        return None
    delta = quantity if movement_type == "income" else -quantity
    conn.execute("UPDATE flower_stock SET quantity = quantity + ? WHERE id=?", (delta, stock_id))
    conn.execute(
        "INSERT INTO stock_movements (flower_stock_id, movement_type, quantity, note) VALUES (?, ?, ?, ?)",
        (stock_id, movement_type, quantity, note),
    )
    conn.commit()
    updated = conn.execute("SELECT * FROM flower_stock WHERE id=?", (stock_id,)).fetchone()
    conn.close()
    return dict(updated)


@app.route("/api/admin/stock/<int:stock_id>/income", methods=["POST"])
@require_staff
def api_admin_stock_income(stock_id):
    body = request.get_json(force=True)
    updated = _stock_movement(stock_id, "income", float(body["quantity"]), body.get("note", "приход"))
    if updated is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(updated)


@app.route("/api/admin/stock/<int:stock_id>/writeoff", methods=["POST"])
@require_staff
def api_admin_stock_writeoff(stock_id):
    body = request.get_json(force=True)
    updated = _stock_movement(stock_id, "writeoff", float(body["quantity"]), body.get("note", "списание"))
    if updated is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(updated)


# --------------------------------------------------------------------------
# Админ API — категории (только владелец). Slug генерируется автоматически из
# названия, покупателю не показывается. Удалять можно только пустую категорию.
# --------------------------------------------------------------------------
@app.route("/api/admin/categories", methods=["POST"])
@require_owner
def api_admin_category_create():
    body = request.get_json(force=True)
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name required"}), 400
    conn = get_db()
    slug = unique_slug(conn, name)
    # новый порядок — в конец списка
    row = conn.execute("SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories").fetchone()
    sort_order = body.get("sort_order")
    if sort_order is None:
        sort_order = row["m"] + 1
    cur = conn.execute(
        "INSERT INTO categories (slug, name, sort_order) VALUES (?, ?, ?)",
        (slug, name, sort_order),
    )
    conn.commit()
    created = conn.execute("SELECT * FROM categories WHERE id=?", (cur.lastrowid,)).fetchone()
    conn.close()
    return jsonify(dict(created)), 201


@app.route("/api/admin/categories/<int:category_id>", methods=["PUT", "DELETE"])
@require_owner
def api_admin_category_edit(category_id):
    conn = get_db()
    row = conn.execute("SELECT * FROM categories WHERE id=?", (category_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "not found"}), 404

    if request.method == "DELETE":
        cnt = conn.execute(
            "SELECT COUNT(*) AS c FROM products WHERE category_id=?", (category_id,)
        ).fetchone()["c"]
        if cnt:
            conn.close()
            return jsonify({
                "error": "category not empty",
                "detail": f"В категории {cnt} товар(ов). Перенесите их в другую категорию, потом удалите.",
            }), 400
        conn.execute("DELETE FROM categories WHERE id=?", (category_id,))
        conn.commit()
        conn.close()
        return jsonify({"deleted": category_id})

    body = request.get_json(force=True)
    name = (body.get("name") or "").strip() or row["name"]
    slug = unique_slug(conn, name, exclude_id=category_id) if name != row["name"] else row["slug"]
    sort_order = body.get("sort_order")
    if sort_order is None:
        sort_order = row["sort_order"]
    conn.execute(
        "UPDATE categories SET name=?, slug=?, sort_order=? WHERE id=?",
        (name, slug, sort_order, category_id),
    )
    conn.commit()
    updated = conn.execute("SELECT * FROM categories WHERE id=?", (category_id,)).fetchone()
    conn.close()
    return jsonify(dict(updated))


# --------------------------------------------------------------------------
# Админ API — персонал (только владелец). Нельзя удалить самого себя и нельзя
# убрать последнего владельца (иначе можно потерять доступ к админке).
# --------------------------------------------------------------------------
VALID_ROLES = ["owner", "florist", "courier"]


@app.route("/api/admin/staff", methods=["GET", "POST"])
@require_owner
def api_admin_staff():
    conn = get_db()
    if request.method == "POST":
        body = request.get_json(force=True)
        tg_id = (str(body.get("telegram_id") or "")).strip()
        name = (body.get("name") or "").strip()
        role = body.get("role", "florist")
        if not tg_id or not name:
            conn.close()
            return jsonify({"error": "telegram_id and name required"}), 400
        if role not in VALID_ROLES:
            conn.close()
            return jsonify({"error": "invalid role", "valid": VALID_ROLES}), 400
        if conn.execute("SELECT 1 FROM staff WHERE telegram_id=?", (tg_id,)).fetchone():
            conn.close()
            return jsonify({"error": "already staff", "detail": "Сотрудник с таким Telegram ID уже есть"}), 400
        cur = conn.execute(
            "INSERT INTO staff (telegram_id, name, role) VALUES (?, ?, ?)",
            (tg_id, name, role),
        )
        conn.commit()
        created = conn.execute("SELECT * FROM staff WHERE id=?", (cur.lastrowid,)).fetchone()
        conn.close()
        return jsonify(dict(created)), 201

    rows = conn.execute("SELECT * FROM staff ORDER BY role='owner' DESC, name").fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/admin/staff/<int:staff_id>", methods=["PUT", "DELETE"])
@require_owner
def api_admin_staff_edit(staff_id):
    conn = get_db()
    row = conn.execute("SELECT * FROM staff WHERE id=?", (staff_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "not found"}), 404
    owners = conn.execute("SELECT COUNT(*) AS c FROM staff WHERE role='owner'").fetchone()["c"]
    is_self = str(row["telegram_id"]) == str(g.tg_user["id"])

    if request.method == "DELETE":
        if is_self:
            conn.close()
            return jsonify({"error": "cannot remove self", "detail": "Нельзя удалить самого себя"}), 400
        if row["role"] == "owner" and owners <= 1:
            conn.close()
            return jsonify({"error": "last owner", "detail": "Нельзя удалить последнего владельца"}), 400
        conn.execute("DELETE FROM staff WHERE id=?", (staff_id,))
        conn.commit()
        conn.close()
        return jsonify({"deleted": staff_id})

    body = request.get_json(force=True)
    name = (body.get("name") or "").strip() or row["name"]
    role = body.get("role", row["role"])
    if role not in VALID_ROLES:
        conn.close()
        return jsonify({"error": "invalid role", "valid": VALID_ROLES}), 400
    # нельзя понизить последнего владельца — иначе некому управлять
    if row["role"] == "owner" and role != "owner" and owners <= 1:
        conn.close()
        return jsonify({"error": "last owner", "detail": "Нельзя снять роль с последнего владельца"}), 400
    conn.execute("UPDATE staff SET name=?, role=? WHERE id=?", (name, role, staff_id))
    conn.commit()
    updated = conn.execute("SELECT * FROM staff WHERE id=?", (staff_id,)).fetchone()
    conn.close()
    return jsonify(dict(updated))


# --------------------------------------------------------------------------
# Админ API — настройки магазина (только владелец): чат для уведомлений о
# заказах, название и адрес точки. Хранятся в app_settings.
# --------------------------------------------------------------------------
@app.route("/api/admin/settings", methods=["GET", "PUT"])
@require_owner
def api_admin_settings():
    if request.method == "PUT":
        body = request.get_json(force=True)
        if "staff_chat_id" in body:
            set_setting("staff_chat_id", (str(body.get("staff_chat_id") or "")).strip())
        if "shop_name" in body or "shop_address" in body:
            conn = get_db()
            conn.execute(
                "UPDATE locations SET name=COALESCE(?, name), address=COALESCE(?, address) WHERE id=1",
                (
                    (body.get("shop_name") or "").strip() or None,
                    body.get("shop_address"),
                ),
            )
            conn.commit()
            conn.close()
    # актуальное состояние (после возможного PUT)
    conn = get_db()
    loc = conn.execute("SELECT name, address FROM locations WHERE id=1").fetchone()
    conn.close()
    return jsonify({
        "staff_chat_id": get_setting("staff_chat_id", ""),
        "staff_chat_id_effective": resolve_staff_chat_id() or "",
        "staff_chat_id_env": STAFF_CHAT_ID or "",
        "shop_name": loc["name"] if loc else "",
        "shop_address": (loc["address"] if loc else "") or "",
    })


# --------------------------------------------------------------------------
# Админ API — заказы
# --------------------------------------------------------------------------
@app.route("/api/admin/orders")
@require_staff
def api_admin_orders():
    status = request.args.get("status")
    location_id = request.args.get("location_id", 1)
    conn = get_db()
    query = "SELECT * FROM orders WHERE location_id = ?"
    params = [location_id]
    if status:
        query += " AND status = ?"
        params.append(status)
    query += " ORDER BY created_at DESC"
    rows = conn.execute(query, params).fetchall()
    result = []
    for r in rows:
        o = dict(r)
        items = conn.execute("SELECT * FROM order_items WHERE order_id=?", (o["id"],)).fetchall()
        o["items"] = [dict(i) for i in items]
        result.append(o)
    conn.close()
    return jsonify(result)


VALID_STATUSES = ["new", "confirmed", "assembling", "out_for_delivery", "delivered", "cancelled"]
STATUS_LABELS_RU = {
    "new": "Новый", "confirmed": "Подтверждён", "assembling": "Собирается",
    "out_for_delivery": "В пути", "delivered": "Доставлен", "cancelled": "Отменён",
}


@app.route("/api/admin/orders/<int:order_id>/status", methods=["PUT"])
@require_staff
def api_admin_order_status(order_id):
    body = request.get_json(force=True)
    status = body.get("status")
    if status not in VALID_STATUSES:
        return jsonify({"error": "invalid status", "valid": VALID_STATUSES}), 400
    conn = get_db()
    conn.execute(
        "UPDATE orders SET status=?, assigned_staff_id=COALESCE(?, assigned_staff_id) WHERE id=?",
        (status, body.get("assigned_staff_id"), order_id),
    )
    conn.commit()
    order = conn.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    conn.close()
    if order and order["customer_tg_id"]:
        notify_telegram(
            order["customer_tg_id"],
            f"Статус заказа #{order_id}: {STATUS_LABELS_RU.get(status, status)}",
        )
    return jsonify(dict(order)) if order else (jsonify({"error": "not found"}), 404)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=os.environ.get("DEBUG") == "1")
