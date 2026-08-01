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
import functools
import urllib.request
import urllib.error
from flask import Flask, request, jsonify, send_from_directory, g

from models import get_db, init_db
from auth import validate_init_data

BASE_DIR = os.path.dirname(__file__)
FRONTEND_DIR = os.path.join(BASE_DIR, "..", "frontend")
BOT_TOKEN = os.environ.get("BOT_TOKEN", "LOCAL_DEV_TOKEN")

app = Flask(__name__)
init_db(reset=False)


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
                ("strawberries", "Клубника в шоколаде", 4),
                ("wrapping", "Подарочная упаковка", 5),
                ("wholesale", "Опт", 6),
            ],
        )
    owner_id = os.environ.get("OWNER_TELEGRAM_ID", "").strip()
    if owner_id and not conn.execute("SELECT 1 FROM staff WHERE telegram_id=?", (owner_id,)).fetchone():
        conn.execute(
            "INSERT INTO staff (telegram_id, name, role) VALUES (?, ?, 'owner')",
            (owner_id, os.environ.get("OWNER_NAME", "Владелец")),
        )
    conn.commit()
    conn.close()


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


STAFF_CHAT_ID = os.environ.get("STAFF_CHAT_ID")  # чат/канал персонала для новых заказов


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
        app.logger.info("[bot setup skip] BOT_TOKEN не задан")
        return
    if not APP_URL:
        app.logger.warning("[bot setup skip] APP_URL/RAILWAY_PUBLIC_DOMAIN не заданы")
        return
    ok_btn = _tg_call("setChatMenuButton", {
        "menu_button": {
            "type": "web_app",
            "text": "🌸 Открыть магазин",
            "web_app": {"url": APP_URL},
        }
    })
    _tg_call("setMyCommands", {
        "commands": [
            {"command": "start", "description": "Открыть магазин"},
            {"command": "admin", "description": "Панель персонала"},
        ]
    })
    app.logger.info(f"[bot setup] menu button -> {APP_URL} (ok={ok_btn})")


setup_bot_menu()


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
    row = conn.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
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

    notify_telegram(STAFF_CHAT_ID, f"🌸 Новый заказ #{order_id} на {total} — {body.get('customer_name', '')}")
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
    ext = os.path.splitext(f.filename)[1] or ".jpg"
    filename = f"product_{product_id}{ext}"
    save_dir = os.path.join(FRONTEND_DIR, "img", "uploads")
    os.makedirs(save_dir, exist_ok=True)
    f.save(os.path.join(save_dir, filename))
    url = f"/static/img/uploads/{filename}"
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
