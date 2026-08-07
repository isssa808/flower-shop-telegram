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
import math
import base64
import threading
import functools
import urllib.request
import urllib.error
import urllib.parse
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
def _add_column_if_missing(conn, table, column, decl):
    """Идемпотентный ALTER TABLE ADD COLUMN (SQLite не умеет IF NOT EXISTS для колонок)."""
    cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
        conn.commit()
        print(f"[db] migrate: {table}.{column} added", flush=True)


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

    # Миграции для уже задеплоенной БД: добавляем новые колонки, если их ещё нет
    # (CREATE TABLE IF NOT EXISTS не меняет существующие таблицы). Идемпотентно.
    _add_column_if_missing(conn, "products", "is_addon", "INTEGER NOT NULL DEFAULT 0")
    _add_column_if_missing(conn, "products", "badge", "TEXT NOT NULL DEFAULT ''")
    _add_column_if_missing(conn, "orders", "delivery_zone", "TEXT")
    _add_column_if_missing(conn, "orders", "delivery_fee", "REAL NOT NULL DEFAULT 0")
    # Отметки времени переходов статуса — для истории (время сборки/передачи/доставки).
    _add_column_if_missing(conn, "orders", "assembled_at", "TEXT")
    _add_column_if_missing(conn, "orders", "handed_at", "TEXT")
    _add_column_if_missing(conn, "orders", "delivered_at", "TEXT")
    # Приём заказа (кто/когда), защита от двойного возврата склада, флаги напоминаний.
    _add_column_if_missing(conn, "orders", "accepted_at", "TEXT")
    _add_column_if_missing(conn, "orders", "accepted_by", "TEXT")
    _add_column_if_missing(conn, "orders", "stock_returned", "INTEGER NOT NULL DEFAULT 0")
    _add_column_if_missing(conn, "orders", "stale_reminded", "INTEGER NOT NULL DEFAULT 0")
    _add_column_if_missing(conn, "orders", "slot_reminded", "INTEGER NOT NULL DEFAULT 0")
    # Склад: группа/тип, размер пачки по умолчанию, фото; вариант в позиции заказа.
    _add_column_if_missing(conn, "flower_stock", "flower_type", "TEXT")
    _add_column_if_missing(conn, "flower_stock", "pack_size", "REAL NOT NULL DEFAULT 0")
    _add_column_if_missing(conn, "flower_stock", "photo_url", "TEXT")
    _add_column_if_missing(conn, "order_items", "variant_id", "INTEGER")
    # Штучные товары (шары/вазы/сладости): свой остаток вместо рецепта из цветов.
    _add_column_if_missing(conn, "products", "track_stock", "INTEGER NOT NULL DEFAULT 0")
    _add_column_if_missing(conn, "products", "stock_qty", "REAL NOT NULL DEFAULT 0")
    # Ручной порядок товаров (владелец расставляет перетаскиванием). Общий на все
    # товары, влияет и на витрину («по умолчанию»). Бэкфилл: если порядок ещё ни у
    # кого не проставлен — задать sort_order = id, чтобы сохранить прежний вид.
    _add_column_if_missing(conn, "products", "sort_order", "INTEGER NOT NULL DEFAULT 0")
    if not conn.execute("SELECT 1 FROM products WHERE sort_order != 0 LIMIT 1").fetchone():
        conn.execute("UPDATE products SET sort_order = id")
        conn.commit()
    # «Стоимость по запросу»: у товара нет фиксированной цены — вместо «в корзину»
    # показываем «Уточнить у менеджера». Можно включить любому букету.
    _add_column_if_missing(conn, "products", "price_on_request", "INTEGER NOT NULL DEFAULT 0")
    # Разовый перенос старых product_recipe → recipe_lines (на товар целиком), если пусто.
    if not conn.execute("SELECT 1 FROM recipe_lines LIMIT 1").fetchone():
        for r in conn.execute("SELECT product_id, flower_stock_id, quantity_needed FROM product_recipe").fetchall():
            conn.execute(
                "INSERT INTO recipe_lines (product_id, variant_id, flower_stock_id, flower_type, quantity_needed) "
                "VALUES (?, NULL, ?, NULL, ?)",
                (r["product_id"], r["flower_stock_id"], r["quantity_needed"]),
            )
        conn.commit()
    # Партии прихода для плашки свежести: если таблица пуста — засеять по одной
    # партии на цветок с текущим остатком. Дата — последнего прихода из движений,
    # иначе updated_at. Инлайн (bootstrap выполняется раньше поздних хелперов).
    if not conn.execute("SELECT 1 FROM stock_batches LIMIT 1").fetchone():
        for _f in conn.execute("SELECT id, quantity, updated_at FROM flower_stock WHERE quantity > 0").fetchall():
            _inc = conn.execute(
                "SELECT created_at FROM stock_movements WHERE flower_stock_id=? AND movement_type='income' "
                "ORDER BY created_at DESC LIMIT 1", (_f["id"],)
            ).fetchone()
            _d = ((_inc["created_at"] if _inc else _f["updated_at"]) or "")[:10] or None
            conn.execute(
                "INSERT INTO stock_batches (flower_stock_id, received_at, qty_received, qty_left) "
                "VALUES (?, ?, ?, ?)", (_f["id"], _d, _f["quantity"], _f["quantity"]),
            )
        conn.commit()
    # Засев окон доставки дефолтами, если таблица пуста (дальше редактируются в админке).
    if not conn.execute("SELECT 1 FROM delivery_slots LIMIT 1").fetchone():
        _def_slots = ["09:00-11:00", "10:00-12:00", "12:00-14:00", "14:00-16:00",
                      "16:00-18:00", "18:00-20:00", "20:00-22:00"]
        for _i, _w in enumerate(_def_slots):
            conn.execute("INSERT INTO delivery_slots (window, capacity, sort_order) VALUES (?, 2, ?)", (_w, _i))
        conn.commit()

    # Разовая зачистка файла-метки, оставшегося после диагностики персистентности.
    try:
        _pt = os.path.join(os.path.dirname(DB_PATH) or ".", "persist_test.txt")
        if os.path.exists(_pt):
            os.remove(_pt)
    except OSError:
        pass

    # Самовосстановление фото: если у товара photo_url — заглушка/пусто, но на
    # Volume лежит его загруженный файл product_<id>.<ext>, вернуть ссылку. Чинит
    # товары, у которых картинку затирало прежнее сохранение (баг PUT до фикса).
    try:
        for _r in conn.execute(
            "SELECT id, photo_url FROM products WHERE photo_url IS NULL OR photo_url = '' "
            "OR photo_url LIKE '%placeholder%'"
        ).fetchall():
            for _ext in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
                if os.path.exists(os.path.join(UPLOAD_DIR, f"product_{_r['id']}{_ext}")):
                    conn.execute(
                        "UPDATE products SET photo_url=? WHERE id=?",
                        (f"/static/uploads/product_{_r['id']}{_ext}?v={int(time.time())}", _r["id"]),
                    )
                    print(f"[db] photo relinked: product_{_r['id']}{_ext}", flush=True)
                    break
    except Exception as _e:
        print(f"[db] photo relink failed: {_e}", flush=True)

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
    # Бэкфилл связки товар↔категории: каждому товару — строка из его текущей
    # (единственной) category_id. Идемпотентно (INSERT OR IGNORE + UNIQUE), новые
    # товары со связкой это не трогает.
    conn.execute(
        "INSERT OR IGNORE INTO product_categories (product_id, category_id) "
        "SELECT id, category_id FROM products WHERE category_id IS NOT NULL"
    )
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
        "photo_url, status, occasion_tags, is_addon) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (1, 1, 1, "Букет «Батуми»", "Розы Netherlands, эвкалипт, авторская сборка",
             "11 роз, эвкалипт", PLACEHOLDER_PHOTO, "in_stock", "романтика,день рождения", 0),
            (2, 1, 1, "Букет «Бульвар»", "Тюльпаны микс с гипсофилой",
             "15 тюльпанов, гипсофила", PLACEHOLDER_PHOTO, "in_stock", "весна,просто так", 0),
            (3, 1, 2, "Свадебный букет невесты", "Под цвет и стиль мероприятия, обсуждается индивидуально",
             "розы, эвкалипт, лента", PLACEHOLDER_PHOTO, "made_to_order", "свадьба", 0),
            (4, 1, 3, "Шар фольгированный «Сердце»", "Гелиевый шар, 45 см",
             "1 шар", PLACEHOLDER_PHOTO, "in_stock", "день рождения,романтика", 1),
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
# Максимум попыток досыла одного уведомления, после чего помечаем failed.
NOTIFY_MAX_ATTEMPTS = 12


def _send_message_api(chat_id, text, reply_markup=None):
    """Один вызов sendMessage. Возвращает статус:
      "ok"        — доставлено;
      "permanent" — Telegram отклонил (неверный chat_id, бот не в чате, блок) —
                    повторять бессмысленно;
      "transient" — сеть/таймаут/5xx — можно повторить позже;
      "skip"      — нечего слать (нет chat_id или тестовый токен)."""
    if not chat_id or BOT_TOKEN == "LOCAL_DEV_TOKEN":
        app.logger.info(f"[notify skip] to={chat_id}: {text}")
        return "skip"
    payload = {"chat_id": chat_id, "text": text}
    if reply_markup:
        payload["reply_markup"] = json.loads(reply_markup) if isinstance(reply_markup, str) else reply_markup
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return "ok" if json.loads(resp.read()).get("ok", False) else "permanent"
    except urllib.error.HTTPError as e:
        # 4xx (chat not found / bot kicked / blocked) — постоянная; 5xx — временная.
        kind = "permanent" if 400 <= e.code < 500 else "transient"
        app.logger.warning(f"[notify {kind}] to={chat_id}: HTTP {e.code}")
        return kind
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        app.logger.warning(f"[notify transient] to={chat_id}: {e}")
        return "transient"


def enqueue_notification(chat_id, text, reply_markup=None, fallback_chat_id=None):
    """Кладём уведомление в outbox (переживает падение сети) и сразу пробуем
    отправить. Заказ уже в БД, поэтому не потеряется в любом случае.
    fallback_chat_id — куда доставить, если основной чат отклонён навсегда
    (напр. в личку владельца, когда общий чат настроен с ошибкой) — чтобы не
    было «тишины везде»."""
    if not chat_id:
        # Если основного адреса нет, но есть запасной — шлём сразу туда.
        if fallback_chat_id:
            enqueue_notification(fallback_chat_id, text, reply_markup)
        return
    rm_json = json.dumps(reply_markup) if isinstance(reply_markup, dict) else reply_markup
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO notifications (chat_id, text, reply_markup, status, attempts) "
        "VALUES (?, ?, ?, 'pending', 0)",
        (str(chat_id), text, rm_json),
    )
    note_id = cur.lastrowid
    conn.commit()
    conn.close()
    if BOT_TOKEN == "LOCAL_DEV_TOKEN":
        return
    status = _send_message_api(chat_id, text, rm_json)
    if status == "ok":
        conn = get_db()
        conn.execute("UPDATE notifications SET status='sent', attempts=1 WHERE id=?", (note_id,))
        conn.commit()
        conn.close()
    elif status == "permanent":
        conn = get_db()
        conn.execute("UPDATE notifications SET status='failed', attempts=1 WHERE id=?", (note_id,))
        conn.commit()
        conn.close()
        app.logger.error(f"[notify give up] id={note_id} chat={chat_id} (постоянная ошибка)")
        # Откат: доставить запасному адресу (владельцу в личку), если он другой.
        if fallback_chat_id and str(fallback_chat_id) != str(chat_id):
            enqueue_notification(fallback_chat_id, text, reply_markup)
        else:
            _alert_delivery_failure(chat_id, text)
    # transient — оставляем pending, досыл фоновым потоком


# Совместимость со старым именем: обычное текстовое уведомление через outbox.
def notify_telegram(chat_id, text):
    enqueue_notification(chat_id, text)


def _alert_delivery_failure(failed_chat_id, text):
    """Если уведомление клиенту/курьеру так и не доставилось (permanent) —
    предупреждаем владельца в личку, чтобы связались вручную. Защита от петли:
    не алертим о неудаче доставки в сам чат владельца/персонала."""
    owner = STAFF_CHAT_ID
    if not owner or str(failed_chat_id) == str(owner) or str(failed_chat_id) == str(resolve_staff_chat_id()):
        return
    first = (text or "").split("\n", 1)[0]
    enqueue_notification(owner, f"⚠️ Не смог доставить уведомление (чат {failed_chat_id}): {first}. Свяжитесь вручную.")


def _notify_process_pending():
    """Досылаем висящие уведомления. Вызывается фоновым потоком раз в ~15с."""
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM notifications WHERE status='pending' AND attempts < ? "
        "ORDER BY id LIMIT 20",
        (NOTIFY_MAX_ATTEMPTS,),
    ).fetchall()
    conn.close()
    for r in rows:
        status = _send_message_api(r["chat_id"], r["text"], r["reply_markup"])
        alert = False
        conn = get_db()
        if status == "ok":
            conn.execute("UPDATE notifications SET status='sent', attempts=attempts+1 WHERE id=?", (r["id"],))
        elif status == "permanent":
            conn.execute("UPDATE notifications SET status='failed', attempts=attempts+1 WHERE id=?", (r["id"],))
            app.logger.error(f"[notify give up] id={r['id']} chat={r['chat_id']} (постоянная ошибка)")
            alert = True
        else:  # transient / skip — считаем попытку, дойдём до лимита и сдадимся
            new_attempts = r["attempts"] + 1
            new_status = "failed" if new_attempts >= NOTIFY_MAX_ATTEMPTS else "pending"
            conn.execute(
                "UPDATE notifications SET status=?, attempts=? WHERE id=?",
                (new_status, new_attempts, r["id"]),
            )
            if new_status == "failed":
                app.logger.error(f"[notify give up] id={r['id']} chat={r['chat_id']}")
                alert = True
        conn.commit()
        conn.close()
        if alert:
            _alert_delivery_failure(r["chat_id"], r["text"])


def _notify_retry_loop():
    while True:
        try:
            _notify_process_pending()
        except Exception as e:
            app.logger.warning(f"[notify loop] {e}")
        time.sleep(15)


def start_notify_thread():
    if BOT_TOKEN == "LOCAL_DEV_TOKEN":
        return
    threading.Thread(target=_notify_retry_loop, daemon=True).start()
    print("[notify] outbox-поток запущен (досыл pending раз в 15с)", flush=True)


# --------------------------------------------------------------------------
# Напоминания и алерты: зависшие непринятые заказы и приближающиеся слоты
# доставки. Разовые (флаги в orders), фоновым потоком раз в 60с.
# --------------------------------------------------------------------------
STALE_NEW_MINUTES = 15
SLOT_REMIND_MINUTES = 60
PAYMENT_EXPIRE_MINUTES = 30  # неоплаченный онлайн-заказ авто-отменяется


def _mark_order_flag(order_id, col):
    conn = get_db()
    conn.execute(f"UPDATE orders SET {col}=1 WHERE id=?", (order_id,))
    conn.commit()
    conn.close()


def _staff_telegram_id(staff_id):
    conn = get_db()
    row = conn.execute("SELECT telegram_id FROM staff WHERE id=?", (staff_id,)).fetchone()
    conn.close()
    return row["telegram_id"] if row else None


def _reminders_sweep():
    """Разовые напоминания: зависшие непринятые заказы и приближающиеся слоты."""
    conn = get_db()
    try:
        # Возраст от STALE_NEW_MINUTES до 12ч: свежие непринятые заказы. Старые
        # (напр. брошенные тестовые) не пингуем — «примите сейчас» уже неактуально.
        stale = conn.execute(
            "SELECT id FROM orders WHERE status='new' "
            "AND (stale_reminded IS NULL OR stale_reminded=0) "
            "AND (julianday('now') - julianday(created_at)) * 1440 BETWEEN ? AND 720",
            (STALE_NEW_MINUTES,),
        ).fetchall()
        today = _batumi_today_str()
        slot_rows = conn.execute(
            "SELECT id, delivery_slot, assigned_staff_id FROM orders "
            "WHERE fulfillment_type='delivery' AND status NOT IN ('delivered','cancelled') "
            "AND (slot_reminded IS NULL OR slot_reminded=0) AND delivery_date=?",
            (today,),
        ).fetchall()
        # Неоплаченные онлайн-заказы старше 30 мин: авто-отмена (склад НЕ списан —
        # ничего возвращать не нужно, просто снимаем «висящий» awaiting_payment).
        expired_unpaid = conn.execute(
            "SELECT id FROM orders WHERE status='awaiting_payment' "
            "AND (julianday('now') - julianday(created_at)) * 1440 > ?",
            (PAYMENT_EXPIRE_MINUTES,),
        ).fetchall()
    finally:
        conn.close()

    for r in expired_unpaid:
        c = get_db()
        try:
            c.execute("UPDATE orders SET status='cancelled' WHERE id=? AND status='awaiting_payment'", (r["id"],))
            c.execute("UPDATE payments SET status='expired', updated_at=? "
                      "WHERE order_id=? AND status IN ('created','approved')", (_batumi_stamp(), r["id"]))
            c.commit()
        finally:
            c.close()

    for r in stale:
        enqueue_notification(
            resolve_staff_chat_id(),
            f"⏰ Заказ #{r['id']} не принят уже {STALE_NEW_MINUTES} мин — гляньте, пожалуйста.",
            fallback_chat_id=STAFF_CHAT_ID,
        )
        _mark_order_flag(r["id"], "stale_reminded")

    now = _batumi_now()
    now_min = now.tm_hour * 60 + now.tm_min
    for r in slot_rows:
        start = _parse_hhmm((r["delivery_slot"] or "").split("-")[0])
        if start is None:
            continue
        diff = start - now_min
        if 0 <= diff <= SLOT_REMIND_MINUTES:
            text = f"🚚 Через ~{diff} мин доставка заказа #{r['id']} ({r['delivery_slot']})."
            enqueue_notification(resolve_staff_chat_id(), text, fallback_chat_id=STAFF_CHAT_ID)
            if r["assigned_staff_id"]:
                c = _staff_telegram_id(r["assigned_staff_id"])
                if c:
                    enqueue_notification(c, text)
            _mark_order_flag(r["id"], "slot_reminded")


def _reminders_loop():
    # sleep ПЕРЕД первым проходом: поток стартует из середины модуля, а
    # _reminders_sweep обращается к функциям, объявленным ниже по файлу — даём
    # модулю догрузиться (напоминания не срочны при старте).
    while True:
        time.sleep(60)
        try:
            _reminders_sweep()
        except Exception as e:
            app.logger.warning(f"[reminders] {e}")


def start_reminders_thread():
    if BOT_TOKEN == "LOCAL_DEV_TOKEN":
        return
    threading.Thread(target=_reminders_loop, daemon=True).start()
    print("[reminders] поток напоминаний запущен (раз в 60с)", flush=True)


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


def _edit_message_text(chat_id, message_id, text):
    """Меняем текст ранее отправленного сообщения (и убираем у него кнопки —
    editMessageText без reply_markup снимает инлайн-клавиатуру)."""
    if not chat_id or not message_id:
        return
    _tg_call("editMessageText", {"chat_id": chat_id, "message_id": message_id, "text": text})


def _answer_callback(cq_id, text=None, alert=False):
    """Ответ на нажатие инлайн-кнопки: всплывашка видна только нажавшему."""
    payload = {"callback_query_id": cq_id}
    if text:
        payload["text"] = text
        payload["show_alert"] = alert
    _tg_call("answerCallbackQuery", payload)


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
            {"command": "chatid", "description": "Показать ID этого чата"},
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


def _handle_callback(cq):
    """Обработка нажатий инлайн-кнопок «Принять/Отменить» под заказом. Жать могут
    только сотрудники owner/florist (сверка telegram_id по таблице staff)."""
    cq_id = cq.get("id")
    data = cq.get("data") or ""
    from_id = str((cq.get("from") or {}).get("id", ""))
    msg = cq.get("message") or {}
    chat_id = (msg.get("chat") or {}).get("id")
    msg_id = msg.get("message_id")
    action, _, oid = data.partition(":")
    if action not in ("accept", "cancel") or not oid.isdigit():
        return _answer_callback(cq_id)
    order_id = int(oid)
    conn = get_db()
    staff = conn.execute("SELECT * FROM staff WHERE telegram_id=?", (from_id,)).fetchone()
    o = conn.execute("SELECT status FROM orders WHERE id=?", (order_id,)).fetchone()
    conn.close()
    if not staff or staff["role"] not in ("owner", "florist"):
        return _answer_callback(cq_id, "Недостаточно прав", alert=True)
    if not o:
        return _answer_callback(cq_id, "Заказ не найден", alert=True)
    if action == "accept" and o["status"] != "new":
        return _answer_callback(cq_id, "Заказ уже обработан", alert=True)
    if action == "cancel" and o["status"] in ("delivered", "cancelled"):
        return _answer_callback(cq_id, "Заказ уже обработан", alert=True)
    new_status = "assembling" if action == "accept" else "cancelled"
    updated, err = change_order_status(order_id, new_status, actor_name=staff["name"], notify_staff=False)
    if err:
        return _answer_callback(cq_id, err, alert=True)
    word = "✅ Принял" if action == "accept" else "✖️ Отменил"
    extra = f"\n\n{word}: {staff['name']}, {_batumi_stamp()}"
    if action == "cancel":
        extra += " · склад возвращён"
    _edit_message_text(chat_id, msg_id, ((msg.get("text") or "").rstrip()) + extra)
    _answer_callback(cq_id, "Принято ✓" if action == "accept" else "Отменено ✓")


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
            cq = upd.get("callback_query")
            if cq:
                try:
                    _handle_callback(cq)
                except Exception as e:
                    print(f"[bot] ошибка обработки кнопки: {e}", flush=True)
                continue
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
                elif text.startswith("/chatid") or text.startswith("/id"):
                    # Бот сам сообщает ID текущего чата — чтобы владелец вставил его
                    # в Настройки → Уведомления (без сторонних ботов). Работает и в
                    # группе (бот-админ получает все сообщения).
                    _tg_call("sendMessage", {
                        "chat_id": chat_id,
                        "text": f"ID этого чата: {chat_id}\n\nСкопируйте его в админке → Настройки → Уведомления → «Chat ID для уведомлений о заказах».",
                    })
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
start_notify_thread()
start_reminders_thread()


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


# --------------------------------------------------------------------------
# Доставка и тексты витрины. Значения — в app_settings (редактируются в
# админке), здесь дефолты. Доставка только по Батуми; тариф зависит от времени.
# --------------------------------------------------------------------------
SHOP_DEFAULTS = {
    "min_delivery_amount": "100",
    "delivery_fee_day": "15",
    "delivery_fee_night": "30",
    "delivery_day_end": "22:00",   # после этого времени — ночной тариф (приём до 00:00)
    "slot_capacity": "2",          # макс. заказов на один 2-часовой слот доставки
    "shop_phone": "",
    "shop_instagram": "flowers_batum_flower",
    "manager_username": "FlowersBatumFlower",   # @username для кнопки «Написать менеджеру» (без @)
    "express_delivery_text": "в течение часа",
    "delivery_payment_info": (
        "Доставка по Батуми при заказе от 100 ₾: 15 ₾ до 22:00, 30 ₾ с 22:00 до 00:00. "
        "За пределы Батуми — по договорённости, напишите нам напрямую. "
        "Оплата: наличными, картой курьеру или переводом."
    ),
    "disclaimer_note": (
        "Обратите внимание: цветы живые, поэтому композиция может немного отличаться от фото "
        "по оттенку, форме и наполнению — но она будет не менее красивой."
    ),
    # Онлайн-оплата (PayPal). Курс с зашитой комиссией задаёт владелец; пусто/0 —
    # соответствующая валюта недоступна. paypal_enabled: "1" включает канал.
    "paypal_enabled": "",
    "pay_rate_eur": "",
    "pay_rate_usd": "",
}


def get_setting_or_default(key):
    val = get_setting(key)
    if val is None or val == "":
        return SHOP_DEFAULTS.get(key, "")
    return val


def _parse_hhmm(s):
    try:
        h, m = str(s).split(":")
        return int(h) * 60 + int(m)
    except (ValueError, AttributeError):
        return None


def _num_setting(key):
    try:
        return float(get_setting_or_default(key))
    except (ValueError, TypeError):
        return float(SHOP_DEFAULTS.get(key, 0) or 0)


# Валюты онлайн-оплаты: код валюты PayPal -> ключ настройки с курсом (GEL за 1 ед.).
PAY_CURRENCIES = {"EUR": "pay_rate_eur", "USD": "pay_rate_usd"}


def _pay_rate(currency):
    """Курс GEL за 1 единицу валюты (с зашитой комиссией). 0/пусто = недоступна."""
    key = PAY_CURRENCIES.get((currency or "").upper())
    return _num_setting(key) if key else 0


def _paypal_available():
    """PayPal доступен: включён владельцем, задан хотя бы один курс И на сервере
    прописаны ключи PayPal (env). Иначе кнопку оплаты не показываем."""
    if get_setting_or_default("paypal_enabled") != "1":
        return False
    if not _paypal_configured():
        return False
    return _pay_rate("EUR") > 0 or _pay_rate("USD") > 0


def compute_delivery_fee(slot):
    """Тариф доставки по времени: дневной до delivery_day_end, иначе ночной.
    Для «как можно скорее» (пустой слот) — по текущему времени Батуми (UTC+4)."""
    day_end = _parse_hhmm(get_setting_or_default("delivery_day_end")) or (22 * 60)
    start = _parse_hhmm(slot.split("-")[0].strip()) if slot else None
    if start is None:
        now = time.gmtime(time.time() + 4 * 3600)  # Батуми = UTC+4, без перехода на летнее время
        start = now.tm_hour * 60 + now.tm_min
    return _num_setting("delivery_fee_night") if start >= day_end else _num_setting("delivery_fee_day")


# Фиксированные 2-часовые окна доставки (по ТЗ владельца). 09-11 и 10-12
# пересекаются — так и задумано. Формат значения совпадает с тем, что уходит в
# заказ (delivery_slot) и парсится compute_delivery_fee.
DELIVERY_SLOTS = [
    "09:00-11:00", "10:00-12:00", "12:00-14:00", "14:00-16:00",
    "16:00-18:00", "18:00-20:00", "20:00-22:00",
]


def _batumi_now():
    """Текущее время Батуми (UTC+4, без переходов на летнее время)."""
    return time.gmtime(time.time() + 4 * 3600)


def _batumi_today_str():
    n = _batumi_now()
    return f"{n.tm_year:04d}-{n.tm_mon:02d}-{n.tm_mday:02d}"


def _batumi_stamp():
    """Полная метка времени Батуми 'YYYY-MM-DD HH:MM:SS' — для кассы по дням."""
    n = _batumi_now()
    return (f"{n.tm_year:04d}-{n.tm_mon:02d}-{n.tm_mday:02d} "
            f"{n.tm_hour:02d}:{n.tm_min:02d}:{n.tm_sec:02d}")


def _slot_capacity():
    try:
        return max(1, int(float(get_setting_or_default("slot_capacity"))))
    except (ValueError, TypeError):
        return 2


def slot_taken_count(conn, date, slot):
    """Сколько активных (не отменённых) заказов уже на эту дату+слот."""
    return conn.execute(
        "SELECT COUNT(*) c FROM orders WHERE delivery_date = ? AND delivery_slot = ? "
        "AND status != 'cancelled'",
        (date, slot),
    ).fetchone()["c"]


def get_delivery_slots(conn):
    """Окна доставки из БД (редактируются в админке): [{window, capacity}] по порядку."""
    rows = conn.execute("SELECT window, capacity FROM delivery_slots ORDER BY sort_order, id").fetchall()
    return [{"window": r["window"], "capacity": max(1, r["capacity"] or 1)} for r in rows]


def available_slots(conn, date):
    """Свободные окна на дату: где заказов меньше ЛИМИТА ОКНА. Для сегодняшней даты
    прошедшие по времени Батуми окна исключаем (start <= текущее время)."""
    today = _batumi_today_str()
    now_min = None
    if date == today:
        n = _batumi_now()
        now_min = n.tm_hour * 60 + n.tm_min
    result = []
    for s in get_delivery_slots(conn):
        window = s["window"]
        if now_min is not None:
            start = _parse_hhmm(window.split("-")[0].strip())
            if start is not None and start <= now_min:
                continue  # окно уже началось/прошло
        if slot_taken_count(conn, date, window) < s["capacity"]:
            result.append(window)
    return result


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


@app.route("/api/shop")
def api_shop():
    """Публичные данные магазина для витрины: контакты, правила доставки, тексты."""
    conn = get_db()
    loc = conn.execute("SELECT name, address FROM locations WHERE id=1").fetchone()
    conn.close()
    return jsonify({
        "name": (loc["name"] if loc else "") or "Flowers Batum Flower",
        "address": (loc["address"] if loc else "") or "",
        "phone": get_setting_or_default("shop_phone"),
        "instagram": get_setting_or_default("shop_instagram"),
        "manager_username": get_setting_or_default("manager_username"),
        "min_delivery_amount": _num_setting("min_delivery_amount"),
        "delivery_fee_day": _num_setting("delivery_fee_day"),
        "delivery_fee_night": _num_setting("delivery_fee_night"),
        "delivery_day_end": get_setting_or_default("delivery_day_end"),
        # Тексты — «сырые» (пусто, если владелец не задал): витрина подставит
        # встроенный перевод EN/RU, а заданный владельцем текст перекроет его.
        "express_delivery_text": get_setting("express_delivery_text", ""),
        "delivery_payment_info": get_setting("delivery_payment_info", ""),
        "disclaimer_note": get_setting("disclaimer_note", ""),
        # Онлайн-оплата: только курсы (не секреты!) — витрина показывает «≈ €X / ≈ $Y»
        # и предлагает валюту. paypal_enabled = включено И задан хотя бы один курс.
        "paypal_enabled": _paypal_available(),
        "pay_rate_eur": _num_setting("pay_rate_eur"),
        "pay_rate_usd": _num_setting("pay_rate_usd"),
    })


@app.route("/api/categories")
def api_categories():
    location_id = request.args.get("location_id", 1)
    conn = get_db()
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM categories ORDER BY sort_order"
    ).fetchall()]
    conn.close()
    return jsonify(rows)


ALLOWED_BADGES = {"", "new", "hit", "recommended"}


def _clean_badge(value):
    v = (value or "").strip()
    return v if v in ALLOWED_BADGES else ""


def _save_variant_recipe(conn, product_id, variant_id, recipe):
    """Пишем строки рецепта варианта в recipe_lines. Строка = конкретный цветок
    (flower_stock_id) ИЛИ группа (flower_type). Пустые/нулевые пропускаем."""
    for ln in (recipe or []):
        qn = float(ln.get("quantity_needed") or 0)
        if qn <= 0:
            continue
        fid = ln.get("flower_stock_id") or None
        ftype = (ln.get("flower_type") or "").strip() or None
        if fid:
            ftype = None  # конкретный цветок имеет приоритет над группой
        elif not ftype:
            continue
        conn.execute(
            "INSERT INTO recipe_lines (product_id, variant_id, flower_stock_id, flower_type, quantity_needed) "
            "VALUES (?, ?, ?, ?, ?)", (product_id, variant_id, fid, ftype, qn))


def _save_product_categories(conn, product_id, category_ids):
    """Перезаписывает связку товар↔категории. category_ids — список id (любой
    порядок). Оставляем только существующие категории, без дублей, сохраняя
    порядок. products.category_id держим = первой (валидность NOT NULL-колонки).
    Возвращает нормализованный список id (или [] если валидных нет)."""
    valid = {r["id"] for r in conn.execute("SELECT id FROM categories").fetchall()}
    seen, clean = set(), []
    for c in (category_ids or []):
        try:
            cid = int(c)
        except (TypeError, ValueError):
            continue
        if cid in valid and cid not in seen:
            seen.add(cid)
            clean.append(cid)
    if not clean:
        return []
    conn.execute("DELETE FROM product_categories WHERE product_id=?", (product_id,))
    for cid in clean:
        conn.execute(
            "INSERT OR IGNORE INTO product_categories (product_id, category_id) VALUES (?, ?)",
            (product_id, cid),
        )
    conn.execute("UPDATE products SET category_id=? WHERE id=?", (clean[0], product_id))
    return clean


def _requested_category_ids(body):
    """Категории из тела запроса: новый category_ids (массив) или старый одиночный
    category_id (совместимость). None = поле не пришло (категории не менять)."""
    ids = body.get("category_ids")
    if ids is None:
        if body.get("category_id") is not None:
            return [body["category_id"]]
        return None
    return ids


def _product_category_ids(conn, product_id, fallback_category_id=None):
    """Список id категорий товара из связки; fallback на одиночную category_id."""
    rows = conn.execute(
        "SELECT category_id FROM product_categories WHERE product_id=? ORDER BY id",
        (product_id,),
    ).fetchall()
    ids = [r["category_id"] for r in rows]
    if not ids and fallback_category_id is not None:
        ids = [fallback_category_id]
    return ids


def _product_with_variants(conn, product_row, levels=None):
    p = dict(product_row)
    if levels is None:
        levels = _stock_levels(conn)
    per, grp = levels
    variants = conn.execute(
        "SELECT id, label, price FROM product_variants WHERE product_id = ?", (p["id"],)
    ).fetchall()
    prod_lines = conn.execute(
        "SELECT flower_stock_id, flower_type, quantity_needed FROM recipe_lines "
        "WHERE product_id=? AND variant_id IS NULL", (p["id"],)
    ).fetchall()
    any_recipe = bool(prod_lines)
    any_avail = False
    vlist = []
    for v in variants:
        vd = dict(v)
        vlines = conn.execute(
            "SELECT flower_stock_id, flower_type, quantity_needed FROM recipe_lines WHERE variant_id=?",
            (v["id"],)
        ).fetchall()
        vd["recipe"] = [dict(l) for l in vlines]   # для админки — рецепт этого размера
        eff = vlines if vlines else prod_lines
        if eff:
            any_recipe = True
            avail = _variant_available(eff, per, grp)
        else:
            avail = True  # без рецепта — доступен (ручной статус)
        vd["available"] = avail
        any_avail = any_avail or avail
        vlist.append(vd)
    p["variants"] = vlist
    p["recipe"] = [dict(l) for l in prod_lines]     # рецепт на товар целиком (если задан)
    # Приоритет: штучный товар (свой остаток) → рецепт из цветов → без учёта (всегда доступен).
    if p.get("track_stock"):
        avail = (p.get("stock_qty") or 0) > 0
        for vd in vlist:
            vd["available"] = avail
        p["available"] = avail
    elif vlist:
        p["available"] = (any_avail if any_recipe else True)
    else:
        p["available"] = (_variant_available(prod_lines, per, grp) if prod_lines else True)
    p["occasion_tags"] = [t for t in (p.get("occasion_tags") or "").split(",") if t]
    p["category_ids"] = _product_category_ids(conn, p["id"], p.get("category_id"))
    # Популярность: лайки и число заказов (кроме отменённых). Показываем на карточке.
    p["likes"] = conn.execute(
        "SELECT COUNT(*) c FROM favorites WHERE product_id = ?", (p["id"],)
    ).fetchone()["c"]
    p["order_count"] = conn.execute(
        "SELECT COUNT(DISTINCT o.id) c FROM order_items oi JOIN orders o ON o.id = oi.order_id "
        "WHERE oi.product_id = ? AND o.status != 'cancelled'", (p["id"],)
    ).fetchone()["c"]
    p["badge"] = p.get("badge") or ""
    return p


@app.route("/api/products")
def api_products():
    location_id = request.args.get("location_id", 1)
    category = request.args.get("category")
    search = request.args.get("search")
    occasion = request.args.get("occasion")
    addon = request.args.get("addon")

    query = "SELECT * FROM products WHERE location_id = ? AND status != 'hidden'"
    params = [location_id]
    if addon == "1":
        query += " AND is_addon = 1"
    if category:
        query += (" AND id IN (SELECT pc.product_id FROM product_categories pc "
                  "JOIN categories c ON c.id = pc.category_id WHERE c.slug = ?)")
        params.append(category)
    if search:
        query += " AND (name LIKE ? OR description LIKE ?)"
        params += [f"%{search}%", f"%{search}%"]
    if occasion:
        query += " AND occasion_tags LIKE ?"
        params.append(f"%{occasion}%")
    query += " ORDER BY sort_order, id"

    conn = get_db()
    rows = conn.execute(query, params).fetchall()
    levels = _stock_levels(conn)
    result = [_product_with_variants(conn, r, levels) for r in rows]
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
# Избранное / лайки. Хранится на сервере по tg_id — переживает смену
# устройства, а число лайков товара = сколько пользователей его добавили.
# --------------------------------------------------------------------------
@app.route("/api/favorites")
@require_auth
def api_favorites():
    conn = get_db()
    rows = conn.execute(
        "SELECT product_id FROM favorites WHERE tg_id = ?", (str(g.tg_user["id"]),)
    ).fetchall()
    conn.close()
    return jsonify([r["product_id"] for r in rows])


@app.route("/api/favorites/<int:product_id>", methods=["POST"])
@require_auth
def api_favorite_toggle(product_id):
    tg_id = str(g.tg_user["id"])
    conn = get_db()
    exists = conn.execute(
        "SELECT 1 FROM favorites WHERE tg_id = ? AND product_id = ?", (tg_id, product_id)
    ).fetchone()
    if exists:
        conn.execute(
            "DELETE FROM favorites WHERE tg_id = ? AND product_id = ?", (tg_id, product_id)
        )
        liked = False
    else:
        # INSERT OR IGNORE на случай гонки/повторного тапа (UNIQUE tg_id+product_id)
        conn.execute(
            "INSERT OR IGNORE INTO favorites (tg_id, product_id) VALUES (?, ?)", (tg_id, product_id)
        )
        liked = True
    conn.commit()
    likes = conn.execute(
        "SELECT COUNT(*) c FROM favorites WHERE product_id = ?", (product_id,)
    ).fetchone()["c"]
    conn.close()
    return jsonify({"liked": liked, "likes": likes})


# --------------------------------------------------------------------------
# Публичные слоты доставки — клиент видит только свободные окна на дату.
# --------------------------------------------------------------------------
@app.route("/api/slots")
def api_slots():
    date = (request.args.get("date") or "").strip()
    conn = get_db()
    slots = available_slots(conn, date) if date else []
    conn.close()
    return jsonify({"date": date, "slots": slots, "capacity": _slot_capacity()})


@app.route("/api/admin/delivery-slots", methods=["GET", "PUT"])
@require_owner
def api_admin_delivery_slots():
    """Окна доставки с индивидуальным лимитом. PUT заменяет список целиком."""
    conn = get_db()
    if request.method == "PUT":
        body = request.get_json(force=True)
        clean = []
        for s in (body.get("slots") or []):
            window = (s.get("window") or "").strip()
            if "-" not in window or _parse_hhmm(window.split("-")[0].strip()) is None:
                continue
            try:
                cap = max(1, int(float(s.get("capacity") or 1)))
            except (ValueError, TypeError):
                cap = 1
            clean.append((window, cap))
        conn.execute("DELETE FROM delivery_slots")
        for i, (window, cap) in enumerate(clean):
            conn.execute("INSERT INTO delivery_slots (window, capacity, sort_order) VALUES (?, ?, ?)", (window, cap, i))
        conn.commit()
    rows = conn.execute("SELECT window, capacity FROM delivery_slots ORDER BY sort_order, id").fetchall()
    conn.close()
    return jsonify([{"window": r["window"], "capacity": r["capacity"]} for r in rows])


# --------------------------------------------------------------------------
# Публичное API — заказы
# --------------------------------------------------------------------------
def format_order_message(order, items):
    """Полный текст уведомления о заказе для общего чата персонала: состав,
    суммы, доставка, контакты. order — dict строки orders, items — список dict
    строк order_items. Заказ уже в БД, поэтому это только зеркало."""
    total = order.get("total") or 0
    fee = order.get("delivery_fee") or 0
    items_total = total - fee
    ful = "Доставка (Батуми)" if order.get("fulfillment_type") == "delivery" else "Самовывоз"
    lines = [f"🌸 Новый заказ #{order['id']} — {int(total)} ₾", "", f"Тип: {ful}"]
    when = " ".join(x for x in [order.get("delivery_date") or "", order.get("delivery_slot") or ""] if x)
    if when:
        lines.append(f"Когда: {when}")
    if order.get("fulfillment_type") == "delivery" and order.get("address"):
        lines.append(f"Адрес: {order['address']}")
    lines.append("")
    lines.append("Состав:")
    for it in items:
        label = f" ({it['variant_label']})" if it.get("variant_label") else ""
        lines.append(f"• {it['product_name']}{label} ×{it['quantity']} — {int(it['price'] * it['quantity'])} ₾")
    if fee:
        lines.append(f"Доставка: {int(fee)} ₾ (товары {int(items_total)} ₾)")
    lines.append("")
    lines.append(f"Заказчик: {order.get('customer_name') or '—'}, {order.get('customer_phone') or '—'}")
    if order.get("recipient_name") or order.get("recipient_phone"):
        rn = order.get("recipient_name") or ""
        rp = order.get("recipient_phone") or ""
        lines.append(f"Получатель: {rn}{(', ' + rp) if rp else ''}".strip())
    if order.get("card_message"):
        lines.append(f"Открытка: {order['card_message']}")
    pay = {"cash": "наличные", "card_courier": "карта курьеру", "card_store": "картой в магазине",
           "transfer": "перевод", "paypal": "PayPal (онлайн)"}.get(
        order.get("payment_method"), order.get("payment_method") or "—")
    lines.append(f"Оплата: {pay}")
    return "\n".join(lines)


def _order_action_markup(order_id):
    """Инлайн-кнопки под уведомлением о новом заказе: приём/отмена прямо из чата."""
    return {"inline_keyboard": [[
        {"text": "✅ Принять", "callback_data": f"accept:{order_id}"},
        {"text": "✖️ Отменить", "callback_data": f"cancel:{order_id}"},
    ]]}


@app.route("/api/orders", methods=["POST"])
@require_auth
def api_create_order():
    body = request.get_json(force=True)
    items = body.get("items") or []
    if not items:
        return jsonify({"error": "empty order"}), 400

    user = g.tg_user or {}
    customer_name = (body.get("customer_name") or user.get("first_name", "") or "").strip()
    customer_phone = (body.get("customer_phone") or "").strip()
    if not customer_name or not customer_phone:
        return jsonify({"error": "name and phone required",
                        "detail": "Укажите имя и телефон"}), 400

    conn = get_db()
    cur = conn.cursor()

    items_total = 0
    resolved_items = []
    simple_need = {}   # штучные товары: product_id -> суммарное кол-во в заказе
    simple_info = {}   # product_id -> {"name", "stock"}
    for it in items:
        variant = cur.execute(
            "SELECT pv.id AS variant_id, pv.price, pv.label, p.name, p.id as product_id, "
            "p.track_stock, p.stock_qty FROM product_variants pv "
            "JOIN products p ON p.id = pv.product_id WHERE pv.id = ?",
            (it["variant_id"],),
        ).fetchone()
        if not variant:
            conn.close()
            return jsonify({"error": f"variant {it['variant_id']} not found"}), 400
        qty = int(it.get("quantity", 1))
        items_total += variant["price"] * qty
        resolved_items.append((variant["product_id"], variant["variant_id"], variant["name"], variant["label"], variant["price"], qty))
        if variant["track_stock"]:
            pid = variant["product_id"]
            simple_need[pid] = simple_need.get(pid, 0) + qty
            simple_info[pid] = {"name": variant["name"], "stock": variant["stock_qty"] or 0}

    # --- Правила доставки (только по Батуми, порог + тариф по времени) ---
    fulfillment = body.get("fulfillment_type", "delivery")
    delivery_zone = None
    delivery_fee = 0
    slot = (body.get("delivery_slot", "") or "").strip()
    delivery_date = (body.get("delivery_date", "") or "").strip()
    address = (body.get("address", "") or "").strip()
    if fulfillment == "delivery":
        zone = (body.get("delivery_zone") or "batumi").strip()
        if zone != "batumi":
            conn.close()
            return jsonify({"error": "delivery zone not served",
                            "detail": "Доставка через приложение — только по Батуми. За город напишите нам напрямую или выберите самовывоз."}), 400
        # Обязательные поля доставки: без них заказ не оформить (надёжность ТЗ).
        if not address:
            conn.close()
            return jsonify({"error": "address required", "detail": "Укажите адрес доставки"}), 400
        if not delivery_date:
            conn.close()
            return jsonify({"error": "date required", "detail": "Выберите дату доставки"}), 400
        if not slot:
            conn.close()
            return jsonify({"error": "slot required", "detail": "Выберите время доставки"}), 400
        slots_cfg = {s["window"]: s["capacity"] for s in get_delivery_slots(conn)}
        if slot not in slots_cfg:
            conn.close()
            return jsonify({"error": "invalid slot", "detail": "Выберите время из списка"}), 400
        # Повторная проверка лимита окна перед вставкой — защита от гонки, когда
        # окно заняли между показом клиенту и оформлением.
        if slot_taken_count(conn, delivery_date, slot) >= slots_cfg[slot]:
            conn.close()
            return jsonify({"error": "slot full",
                            "detail": "Это время только что заняли, выберите другое"}), 409
        min_amount = _num_setting("min_delivery_amount")
        if items_total < min_amount:
            conn.close()
            return jsonify({"error": "below min delivery amount", "min": min_amount,
                            "detail": f"Доставка от {int(min_amount)} ₾. Добавьте товаров или оформите самовывоз."}), 400
        delivery_zone = "batumi"
        delivery_fee = compute_delivery_fee(slot)

    total = items_total + delivery_fee

    # Онлайн-оплата: заказ создаётся в статусе awaiting_payment и «приходит»
    # персоналу только после подтверждённой оплаты. Сейчас поддержан только PayPal.
    online = body.get("payment_method") == "paypal"
    if online and not _paypal_available():
        conn.close()
        return jsonify({"error": "payment unavailable",
                        "detail": "Онлайн-оплата временно недоступна, выберите другой способ."}), 400
    order_status = "awaiting_payment" if online else "new"

    # Проверка склада (учёт размеров варианта и замен-групп): не даём уйти в минус.
    stock_plan, stock_short = _plan_order_stock(
        conn, [(pid, vid, qty) for (pid, vid, nm, lb, pr, qty) in resolved_items if pid not in simple_need]
    )
    for pid, need in simple_need.items():
        if simple_info[pid]["stock"] < need:
            stock_short.append(simple_info[pid]["name"])
    if stock_short:
        conn.close()
        return jsonify({"error": "out of stock",
                        "detail": "Не хватает на складе: " + ", ".join(sorted(set(stock_short))) + ". Уточните у менеджера."}), 409

    cur.execute(
        """INSERT INTO orders (location_id, customer_tg_id, customer_name, customer_phone,
           fulfillment_type, address, delivery_date, delivery_slot, recipient_name,
           recipient_phone, card_message, photo_before_delivery, payment_method,
           delivery_zone, delivery_fee, total, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            body.get("location_id", 1),
            str(user.get("id", "")),
            customer_name,
            customer_phone,
            fulfillment,
            address if fulfillment == "delivery" else "",
            delivery_date,
            slot,
            body.get("recipient_name", ""),
            body.get("recipient_phone", ""),
            body.get("card_message", ""),
            1 if body.get("photo_before_delivery") else 0,
            body.get("payment_method", "cash"),
            delivery_zone,
            delivery_fee,
            total,
            order_status,
        ),
    )
    order_id = cur.lastrowid

    # Позиции заказа пишем всегда (нужны и для активации после оплаты).
    for product_id, variant_id, name, label, price, qty in resolved_items:
        cur.execute(
            "INSERT INTO order_items (order_id, product_id, variant_id, product_name, variant_label, price, quantity) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (order_id, product_id, variant_id, name, label, price, qty),
        )

    # Онлайн-оплата: заказ ждёт оплаты — НЕ назначаем курьера, НЕ списываем склад и
    # НЕ уведомляем персонал. Всё это сделает _activate_paid_order после подтверждённой
    # оплаты (см. _finalize_paypal), чтобы флорист не собрал неоплаченный заказ.
    if online:
        conn.commit()
        conn.close()
        return jsonify({"id": order_id, "total": total, "delivery_fee": delivery_fee,
                        "items_total": items_total, "status": order_status,
                        "needs_payment": True}), 201

    # Основной курьер: авто-назначение на доставку (один курьер на все заказы —
    # не назначаем вручную каждый). Настраивается в админке; читаем через тот же cur.
    if fulfillment == "delivery":
        _dc = cur.execute("SELECT value FROM app_settings WHERE key='default_courier_id'").fetchone()
        _dc = ((_dc["value"] if _dc else "") or "").strip()
        if _dc:
            _c = cur.execute("SELECT id FROM staff WHERE id=? AND role='courier'", (_dc,)).fetchone()
            if _c:
                cur.execute("UPDATE orders SET assigned_staff_id=? WHERE id=?", (_c["id"], order_id))

    # Списание склада по заранее рассчитанному плану (размеры варианта + замены-группы).
    for fid, amt in stock_plan:
        cur.execute("UPDATE flower_stock SET quantity = quantity - ? WHERE id = ?", (amt, fid))
        cur.execute(
            "INSERT INTO stock_movements (flower_stock_id, movement_type, quantity, note) "
            "VALUES (?, 'sale', ?, ?)",
            (fid, amt, f"заказ #{order_id}"),
        )
        _batch_consume(conn, fid, amt)  # съесть партии по FIFO (для плашки свежести)
    # Списание штучных товаров (свой остаток).
    for pid, need in simple_need.items():
        cur.execute("UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?", (need, pid))

    # Полную строку заказа читаем обратно для богатого уведомления.
    order_row = conn.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    item_rows = conn.execute(
        "SELECT product_name, variant_label, price, quantity FROM order_items WHERE order_id=?",
        (order_id,),
    ).fetchall()
    conn.commit()
    conn.close()

    # Уведомление в общий чат персонала — через outbox (не потеряется, досылается).
    # fallback = личка владельца: если общий чат настроен с ошибкой, заказ всё равно дойдёт.
    enqueue_notification(
        resolve_staff_chat_id(),
        format_order_message(dict(order_row), [dict(i) for i in item_rows]),
        reply_markup=_order_action_markup(order_id),
        fallback_chat_id=STAFF_CHAT_ID,
    )
    return jsonify({"id": order_id, "total": total, "delivery_fee": delivery_fee,
                    "items_total": items_total, "status": "new"}), 201


# ==========================================================================
# Онлайн-оплата — PayPal (первый провайдер; обобщённо под payments/вебхук).
# Принципы безопасности: сумму считаем на сервере из orders.total и курса из
# настроек; «оплачено» ставим ТОЛЬКО по факту capture, идемпотентно; заказ
# «приходит» персоналу и списывает склад лишь после подтверждённой оплаты.
# Секреты (client_id/secret/webhook_id) — только в env, не в БД, не в /api/shop.
# ==========================================================================
PAYPAL_ENV = os.environ.get("PAYPAL_ENV", "sandbox").strip().lower()
PAYPAL_CLIENT_ID = os.environ.get("PAYPAL_CLIENT_ID", "").strip()
PAYPAL_CLIENT_SECRET = os.environ.get("PAYPAL_CLIENT_SECRET", "").strip()
PAYPAL_WEBHOOK_ID = os.environ.get("PAYPAL_WEBHOOK_ID", "").strip()
PAYPAL_BASE = "https://api-m.paypal.com" if PAYPAL_ENV == "live" else "https://api-m.sandbox.paypal.com"

_paypal_token_cache = {"token": None, "exp": 0}


def _paypal_configured():
    return bool(PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET)


def _pay_amount(total_gel, currency):
    """Сумма к оплате в валюте: лари / курс, округление ВВЕРХ до цента. None — недоступна."""
    rate = _pay_rate(currency)
    if rate <= 0:
        return None
    return math.ceil((float(total_gel) / rate) * 100) / 100.0


def _paypal_http(method, path, token=None, json_body=None, form_body=None):
    """Вызов PayPal REST. Возвращает (status_code, dict|None). Сеть/HTTP-ошибки не бросаем."""
    url = PAYPAL_BASE + path
    headers = {"Accept": "application/json"}
    data = None
    if form_body is not None:
        data = urllib.parse.urlencode(form_body).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    elif json_body is not None:
        data = json.dumps(json_body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read())
        except Exception:
            body = None
        app.logger.warning(f"[paypal] {method} {path} HTTP {e.code}")
        return e.code, body
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        app.logger.warning(f"[paypal] {method} {path} network: {e}")
        return 0, None


def _paypal_token():
    """OAuth access_token (client_credentials) с кэшем до истечения."""
    now = time.time()
    if _paypal_token_cache["token"] and _paypal_token_cache["exp"] > now + 60:
        return _paypal_token_cache["token"]
    if not _paypal_configured():
        return None
    basic = base64.b64encode(f"{PAYPAL_CLIENT_ID}:{PAYPAL_CLIENT_SECRET}".encode()).decode()
    st, body = None, None
    url = PAYPAL_BASE + "/v1/oauth2/token"
    data = urllib.parse.urlencode({"grant_type": "client_credentials"}).encode()
    req = urllib.request.Request(url, data=data, headers={
        "Authorization": f"Basic {basic}",
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
    }, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = json.loads(resp.read())
    except Exception as e:
        app.logger.error(f"[paypal] token error: {e}")
        return None
    tok = body.get("access_token")
    _paypal_token_cache["token"] = tok
    _paypal_token_cache["exp"] = now + int(body.get("expires_in", 0) or 0)
    return tok


def _paypal_create_order(amount, currency, order_id):
    """PayPal-заказ intent=CAPTURE. Возвращает (pp_order_id, approval_url) или (None, None)."""
    token = _paypal_token()
    if not token:
        return None, None
    conn = get_db()
    loc = conn.execute("SELECT name FROM locations WHERE id=1").fetchone()
    conn.close()
    brand = (loc["name"] if loc else "") or "Flowers Batum Flower"
    payload = {
        "intent": "CAPTURE",
        "purchase_units": [{
            "custom_id": str(order_id),
            "description": f"Order #{order_id}",
            "amount": {"currency_code": currency, "value": f"{amount:.2f}"},
        }],
        "application_context": {
            "brand_name": brand,
            "user_action": "PAY_NOW",
            "shipping_preference": "NO_SHIPPING",
            "return_url": f"{APP_URL}/pay/paypal/return",
            "cancel_url": f"{APP_URL}/pay/paypal/cancel",
        },
    }
    st, body = _paypal_http("POST", "/v2/checkout/orders", token=token, json_body=payload)
    if st not in (200, 201) or not body:
        return None, None
    approval = None
    for link in body.get("links", []):
        if link.get("rel") in ("payer-action", "approve"):
            approval = link.get("href")
            break
    return body.get("id"), approval


def _paypal_order_details(pp_order_id, token):
    st, body = _paypal_http("GET", f"/v2/checkout/orders/{pp_order_id}", token=token)
    return body if st == 200 else None


def _paypal_capture(pp_order_id, token):
    return _paypal_http("POST", f"/v2/checkout/orders/{pp_order_id}/capture", token=token, json_body={})


def _paypal_extract_amount(data):
    """Из ответа capture/details достаёт (value, currency_code) захваченного платежа."""
    try:
        pu = (data.get("purchase_units") or [])[0]
        caps = ((pu.get("payments") or {}).get("captures") or [])
        if caps:
            a = caps[0].get("amount", {})
            return float(a.get("value")), a.get("currency_code")
        a = pu.get("amount", {})
        return float(a.get("value")), a.get("currency_code")
    except (IndexError, KeyError, TypeError, ValueError):
        return None, None


def _paypal_verify_webhook(headers, event):
    """Проверка подписи вебхука через PayPal API. Без webhook_id — не доверяем."""
    if not PAYPAL_WEBHOOK_ID:
        return False
    token = _paypal_token()
    if not token:
        return False
    payload = {
        "transmission_id": headers.get("Paypal-Transmission-Id"),
        "transmission_time": headers.get("Paypal-Transmission-Time"),
        "cert_url": headers.get("Paypal-Cert-Url"),
        "auth_algo": headers.get("Paypal-Auth-Algo"),
        "transmission_sig": headers.get("Paypal-Transmission-Sig"),
        "webhook_id": PAYPAL_WEBHOOK_ID,
        "webhook_event": event,
    }
    st, body = _paypal_http("POST", "/v1/notifications/verify-webhook-signature", token=token, json_body=payload)
    return bool(body) and body.get("verification_status") == "SUCCESS"


def _activate_paid_order(conn, order_id):
    """После подтверждённой оплаты: назначить курьера, списать склад, перевести в
    'new'. Только для заказа в статусе awaiting_payment (идемпотентность). Всё в
    переданном conn/транзакции. Возвращает список нехваток склада (для предупреждения)."""
    order = conn.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    if not order or order["status"] != "awaiting_payment":
        return []
    if order["fulfillment_type"] == "delivery":
        dc = conn.execute("SELECT value FROM app_settings WHERE key='default_courier_id'").fetchone()
        dc = ((dc["value"] if dc else "") or "").strip()
        if dc:
            c = conn.execute("SELECT id FROM staff WHERE id=? AND role='courier'", (dc,)).fetchone()
            if c:
                conn.execute("UPDATE orders SET assigned_staff_id=? WHERE id=?", (c["id"], order_id))
    items = conn.execute(
        "SELECT oi.product_id, oi.variant_id, oi.quantity, p.track_stock "
        "FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=?",
        (order_id,),
    ).fetchall()
    plan_lines = [(i["product_id"], i["variant_id"], i["quantity"]) for i in items if not (i["track_stock"] or 0)]
    stock_plan, shortage = _plan_order_stock(conn, plan_lines)
    for fid, amt in stock_plan:
        conn.execute("UPDATE flower_stock SET quantity = quantity - ? WHERE id=?", (amt, fid))
        conn.execute("INSERT INTO stock_movements (flower_stock_id, movement_type, quantity, note) "
                     "VALUES (?, 'sale', ?, ?)", (fid, amt, f"заказ #{order_id}"))
        _batch_consume(conn, fid, amt)
    for i in items:
        if (i["track_stock"] or 0) and i["product_id"]:
            conn.execute("UPDATE products SET stock_qty = stock_qty - ? WHERE id=?", (i["quantity"], i["product_id"]))
    conn.execute("UPDATE orders SET status='new' WHERE id=?", (order_id,))
    return shortage


def _finalize_paypal(pp_order_id, amount, currency, raw):
    """Идемпотентно помечает платёж/заказ оплаченным и активирует заказ.
    Возвращает 'paid' | 'already' | 'wrong_amount' | 'unknown'."""
    conn = get_db()
    pay = conn.execute("SELECT * FROM payments WHERE provider_payment_id=?", (pp_order_id,)).fetchone()
    if not pay:
        conn.close()
        return "unknown"
    if pay["status"] == "paid":
        conn.close()
        return "already"
    rawj = (json.dumps(raw)[:4000] if raw else None)
    # Сверка суммы и валюты capture с ожидаемыми — защита от подмены.
    if amount is None or currency != pay["currency"] or round(amount, 2) != round(pay["amount"] or 0, 2):
        conn.execute("UPDATE payments SET status='wrong_amount', raw_payload=?, updated_at=? WHERE id=?",
                     (rawj, _batumi_stamp(), pay["id"]))
        conn.commit()
        conn.close()
        if STAFF_CHAT_ID:
            enqueue_notification(STAFF_CHAT_ID,
                                 f"⚠️ Оплата заказа #{pay['order_id']} пришла на неверную сумму/валюту — проверьте вручную.")
        return "wrong_amount"
    order_id = pay["order_id"]
    conn.execute("UPDATE payments SET status='paid', raw_payload=?, updated_at=? WHERE id=?",
                 (rawj, _batumi_stamp(), pay["id"]))
    conn.execute("UPDATE orders SET payment_status='paid' WHERE id=?", (order_id,))
    shortage = _activate_paid_order(conn, order_id)
    order_row = conn.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    item_rows = conn.execute(
        "SELECT product_name, variant_label, price, quantity FROM order_items WHERE order_id=?",
        (order_id,),
    ).fetchall()
    conn.commit()
    conn.close()
    # Уведомления вне транзакции (через outbox).
    msg = "💳 ОПЛАЧЕНО (PayPal)\n" + format_order_message(dict(order_row), [dict(i) for i in item_rows])
    if shortage:
        msg += "\n⚠️ Проверьте остатки: " + ", ".join(sorted(set(shortage)))
    enqueue_notification(resolve_staff_chat_id(), msg,
                         reply_markup=_order_action_markup(order_id), fallback_chat_id=STAFF_CHAT_ID)
    if order_row and order_row["customer_tg_id"]:
        enqueue_notification(order_row["customer_tg_id"], f"Оплата получена ✅ Заказ #{order_id} принят в работу.")
    return "paid"


def _reconcile_paypal(pp_order_id):
    """По id PayPal-заказа гарантирует capture и финализацию. Идемпотентно.
    Единая точка для return-страницы и вебхука."""
    conn = get_db()
    pay = conn.execute("SELECT status FROM payments WHERE provider_payment_id=?", (pp_order_id,)).fetchone()
    conn.close()
    if not pay:
        return "unknown"
    if pay["status"] == "paid":
        return "already"
    token = _paypal_token()
    if not token:
        return "error"
    details = _paypal_order_details(pp_order_id, token)
    if not details:
        return "error"
    st = details.get("status")
    if st == "APPROVED":
        cst, cap = _paypal_capture(pp_order_id, token)
        if cap and cap.get("status") == "COMPLETED":
            details, st = cap, "COMPLETED"
        else:
            # 422 = уже захвачен/иное состояние — перечитываем детали.
            details = _paypal_order_details(pp_order_id, token) or details
            st = details.get("status")
    if st == "COMPLETED":
        amt, cur = _paypal_extract_amount(details)
        return _finalize_paypal(pp_order_id, amt, cur, details)
    return st or "unknown"


def _order_owned_by_user(order_row):
    return bool(order_row) and str(order_row["customer_tg_id"]) == str((g.tg_user or {}).get("id", ""))


@app.route("/api/orders/<int:order_id>/pay", methods=["POST"])
@require_auth
def api_order_pay(order_id):
    body = request.get_json(force=True) or {}
    currency = (body.get("currency") or "").upper()
    if currency not in PAY_CURRENCIES:
        return jsonify({"error": "bad currency", "detail": "Выберите валюту оплаты"}), 400
    conn = get_db()
    order = conn.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    conn.close()
    if not _order_owned_by_user(order):
        return jsonify({"error": "forbidden"}), 403
    if (order["payment_status"] or "unpaid") == "paid":
        return jsonify({"error": "already paid", "detail": "Заказ уже оплачен"}), 409
    if order["status"] != "awaiting_payment":
        return jsonify({"error": "not payable", "detail": "Этот заказ нельзя оплатить онлайн"}), 409
    if not (_paypal_available() and _paypal_configured()):
        return jsonify({"error": "payment unavailable", "detail": "Онлайн-оплата недоступна"}), 400
    amount = _pay_amount(order["total"], currency)
    if amount is None or amount <= 0:
        return jsonify({"error": "payment unavailable", "detail": "Эта валюта недоступна"}), 400
    pp_order_id, approval = _paypal_create_order(amount, currency, order_id)
    if not pp_order_id or not approval:
        return jsonify({"error": "paypal error", "detail": "PayPal недоступен, попробуйте позже"}), 502
    conn = get_db()
    conn.execute(
        "INSERT INTO payments (order_id, provider, provider_payment_id, amount, currency, amount_gel, rate, status) "
        "VALUES (?, 'paypal', ?, ?, ?, ?, ?, 'created')",
        (order_id, pp_order_id, amount, currency, order["total"], _pay_rate(currency)),
    )
    conn.commit()
    conn.close()
    return jsonify({"approval_url": approval, "pay_amount": amount, "pay_currency": currency})


@app.route("/api/orders/<int:order_id>/payment-status")
@require_auth
def api_order_payment_status(order_id):
    conn = get_db()
    order = conn.execute("SELECT customer_tg_id, payment_status, status FROM orders WHERE id=?", (order_id,)).fetchone()
    conn.close()
    if not _order_owned_by_user(order):
        return jsonify({"error": "forbidden"}), 403
    return jsonify({"payment_status": order["payment_status"] or "unpaid", "order_status": order["status"]})


def _pay_result_page(title, message):
    return (
        "<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        f"<title>{title}</title><style>body{{font-family:-apple-system,BlinkMacSystemFont,"
        "'Segoe UI',Roboto,sans-serif;background:#f5f5f7;color:#1a1a1a;display:flex;"
        "min-height:100vh;margin:0;align-items:center;justify-content:center;padding:24px}"
        ".card{background:#fff;border-radius:16px;padding:28px;max-width:340px;text-align:center;"
        "box-shadow:0 2px 10px rgba(0,0,0,.08)}h1{font-size:20px;margin:0 0 10px}"
        "p{color:#555;line-height:1.5;margin:0}.e{font-size:40px;margin-bottom:8px}</style></head>"
        f"<body><div class=\"card\"><div class=\"e\">🌸</div><h1>{title}</h1><p>{message}</p></div></body></html>"
    )


@app.route("/pay/paypal/return")
def paypal_return():
    pp_order_id = request.args.get("token", "")
    if pp_order_id:
        try:
            _reconcile_paypal(pp_order_id)
        except Exception as e:
            app.logger.error(f"[paypal] return reconcile: {e}")
    return _pay_result_page("Оплата обрабатывается",
                            "Спасибо! Можно вернуться в Telegram — статус заказа обновится автоматически.")


@app.route("/pay/paypal/cancel")
def paypal_cancel():
    return _pay_result_page("Оплата отменена",
                            "Вы отменили оплату. Вернитесь в Telegram и попробуйте снова.")


@app.route("/api/pay/paypal/webhook", methods=["POST"])
def paypal_webhook():
    raw = request.get_data()
    try:
        event = json.loads(raw)
    except ValueError:
        return jsonify({"error": "bad payload"}), 400
    if not _paypal_verify_webhook(request.headers, event):
        app.logger.warning("[paypal] webhook signature verify failed")
        return jsonify({"error": "unverified"}), 400
    etype = event.get("event_type", "")
    resource = event.get("resource", {}) or {}
    pp_order_id = None
    if etype == "CHECKOUT.ORDER.APPROVED":
        pp_order_id = resource.get("id")
    elif etype == "PAYMENT.CAPTURE.COMPLETED":
        pp_order_id = (((resource.get("supplementary_data") or {}).get("related_ids") or {}).get("order_id"))
    if pp_order_id:
        try:
            _reconcile_paypal(pp_order_id)
        except Exception as e:
            app.logger.error(f"[paypal] webhook reconcile: {e}")
    return jsonify({"ok": True})


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
@require_owner
def api_admin_products():
    conn = get_db()
    if request.method == "POST":
        body = request.get_json(force=True)
        # Категории (одна или несколько). Валидируем против существующих; ≥1 обязательна.
        valid_ids = {r["id"] for r in conn.execute("SELECT id FROM categories").fetchall()}
        cat_ids = []
        for c in (_requested_category_ids(body) or []):
            try:
                c = int(c)
            except (TypeError, ValueError):
                continue
            if c in valid_ids and c not in cat_ids:
                cat_ids.append(c)
        if not cat_ids:
            conn.close()
            return jsonify({"error": "category required", "detail": "Выберите хотя бы одну категорию"}), 400
        # Новый товар встаёт в конец общего порядка.
        next_sort = conn.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM products").fetchone()["n"]
        cur = conn.execute(
            "INSERT INTO products (location_id, category_id, name, description, composition, "
            "photo_url, status, occasion_tags, is_addon, badge, track_stock, stock_qty, sort_order, "
            "price_on_request) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                body["location_id"], cat_ids[0], body["name"],
                body.get("description", ""), body.get("composition", ""),
                body.get("photo_url", "/static/img/placeholder.svg"),
                body.get("status", "in_stock"), ",".join(body.get("occasion_tags", [])),
                1 if body.get("is_addon") else 0, _clean_badge(body.get("badge")),
                1 if body.get("track_stock") else 0, float(body.get("stock_qty") or 0),
                next_sort,
                1 if body.get("price_on_request") else 0,
            ),
        )
        product_id = cur.lastrowid
        _save_product_categories(conn, product_id, cat_ids)
        for v in body.get("variants", []):
            vc = conn.execute(
                "INSERT INTO product_variants (product_id, label, price) VALUES (?, ?, ?)",
                (product_id, v["label"], v["price"]),
            )
            _save_variant_recipe(conn, product_id, vc.lastrowid, v.get("recipe"))
        conn.commit()
        row = conn.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
        result = _product_with_variants(conn, row)
        conn.close()
        return jsonify(result), 201

    location_id = request.args.get("location_id", 1)
    rows = conn.execute(
        "SELECT * FROM products WHERE location_id = ? ORDER BY sort_order, id", (location_id,)
    ).fetchall()
    levels = _stock_levels(conn)
    result = [_product_with_variants(conn, r, levels) for r in rows]
    conn.close()
    return jsonify(result)


@app.route("/api/admin/products/<int:product_id>", methods=["PUT", "DELETE"])
@require_owner
def api_admin_product_edit(product_id):
    conn = get_db()
    if request.method == "DELETE":
        conn.execute("DELETE FROM products WHERE id = ?", (product_id,))
        conn.commit()
        conn.close()
        return jsonify({"deleted": product_id})

    body = request.get_json(force=True)
    # Поля, которые всегда обновляем из формы. photo_url НЕ трогаем, если он не
    # передан явно: фото грузится отдельным запросом /photo, а форма редактирования
    # его не шлёт — иначе любое сохранение (напр. смена цены) затирало бы картинку.
    fields = {
        "name": body.get("name"),
        "description": body.get("description", ""),
        "composition": body.get("composition", ""),
        "status": body.get("status", "in_stock"),
        "occasion_tags": ",".join(body.get("occasion_tags", [])),
        "is_addon": 1 if body.get("is_addon") else 0,
        "badge": _clean_badge(body.get("badge")),
        "track_stock": 1 if body.get("track_stock") else 0,
        "stock_qty": float(body.get("stock_qty") or 0),
        "price_on_request": 1 if body.get("price_on_request") else 0,
    }
    if body.get("photo_url"):
        fields["photo_url"] = body["photo_url"]
    set_clause = ", ".join(f"{k}=?" for k in fields)  # ключи — фикс. литералы, не ввод
    conn.execute(
        f"UPDATE products SET {set_clause} WHERE id=?",
        (*fields.values(), product_id),
    )
    # Категории обновляем только если поле пришло. Пустой/невалидный список — ошибка
    # (товар не оставляем без категории). _save_product_categories чинит и category_id.
    requested_cats = _requested_category_ids(body)
    if requested_cats is not None:
        saved = _save_product_categories(conn, product_id, requested_cats)
        if not saved:
            conn.close()
            return jsonify({"error": "category required", "detail": "Выберите хотя бы одну категорию"}), 400
    if "variants" in body:
        conn.execute("DELETE FROM recipe_lines WHERE product_id = ?", (product_id,))
        conn.execute("DELETE FROM product_variants WHERE product_id = ?", (product_id,))
        for v in body["variants"]:
            vc = conn.execute(
                "INSERT INTO product_variants (product_id, label, price) VALUES (?, ?, ?)",
                (product_id, v["label"], v["price"]),
            )
            _save_variant_recipe(conn, product_id, vc.lastrowid, v.get("recipe"))
    conn.commit()
    row = conn.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
    result = _product_with_variants(conn, row)
    conn.close()
    return jsonify(result)


@app.route("/api/admin/products/reorder", methods=["POST"])
@require_owner
def api_admin_products_reorder():
    # Владелец расставил товары перетаскиванием — сохраняем общий порядок.
    # Тело: {"order": [id, id, ...]} в нужной последовательности. Проставляем
    # sort_order = позиция (0,1,2,…) только тем товарам, что реально существуют.
    body = request.get_json(force=True) or {}
    order = body.get("order") or []
    conn = get_db()
    valid = {r["id"] for r in conn.execute("SELECT id FROM products").fetchall()}
    pos = 0
    for pid in order:
        try:
            pid = int(pid)
        except (TypeError, ValueError):
            continue
        if pid not in valid:
            continue
        conn.execute("UPDATE products SET sort_order = ? WHERE id = ?", (pos, pid))
        pos += 1
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "count": pos})


@app.route("/api/admin/products/<int:product_id>/photo", methods=["POST"])
@require_owner
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
@require_owner
def api_admin_stock():
    conn = get_db()
    if request.method == "POST":
        body = request.get_json(force=True)
        cur = conn.execute(
            "INSERT INTO flower_stock (location_id, name, flower_type, unit, quantity, low_stock_threshold, supplier, pack_size) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                body["location_id"], body["name"], body.get("flower_type", ""),
                body.get("unit", "шт"), body.get("quantity", 0),
                body.get("low_stock_threshold", 10), body.get("supplier", ""),
                body.get("pack_size", 0),
            ),
        )
        stock_id = cur.lastrowid
        _batch_add(conn, stock_id, body.get("quantity", 0))  # стартовый остаток = первая партия
        conn.commit()
        row = conn.execute("SELECT * FROM flower_stock WHERE id=?", (stock_id,)).fetchone()
        conn.close()
        return jsonify(dict(row)), 201

    location_id = request.args.get("location_id", 1)
    rows = conn.execute(
        "SELECT * FROM flower_stock WHERE location_id = ? ORDER BY name", (location_id,)
    ).fetchall()
    fresh = _stock_freshness_map(conn)
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        f = fresh.get(r["id"]) or {}
        d["fresh_last"] = f.get("last")
        d["fresh_prev"] = f.get("prev")
        d["fresh_star"] = bool(f.get("star"))
        d["fresh_age"] = f.get("age")
        d["fresh_prev_age"] = f.get("prev_age")
        result.append(d)
    return jsonify(result)


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
    if movement_type == "income":
        _batch_add(conn, stock_id, quantity)
    elif movement_type == "writeoff":
        _batch_consume(conn, stock_id, quantity)
    conn.commit()
    updated = conn.execute("SELECT * FROM flower_stock WHERE id=?", (stock_id,)).fetchone()
    conn.close()
    return dict(updated)


# --------------------------------------------------------------------------
# Партии прихода (свежесть). Ведутся параллельно с flower_stock.quantity —
# на неё и на доступность не влияют, только на плашку «получена ДД.ММ».
# --------------------------------------------------------------------------
def _batch_add(conn, flower_id, qty, received_at=None):
    """Новая партия прихода. qty<=0 игнорируется."""
    q = float(qty or 0)
    if q <= 0:
        return
    conn.execute(
        "INSERT INTO stock_batches (flower_stock_id, received_at, qty_received, qty_left) "
        "VALUES (?, ?, ?, ?)", (flower_id, received_at or _batumi_today_str(), q, q),
    )


def _batch_consume(conn, flower_id, amount):
    """Списать amount из партий по FIFO (старые → новые). Best-effort: если партий
    не хватает (старые данные), недостачу молча игнорируем — на quantity не влияет."""
    remaining = float(amount or 0)
    if remaining <= 0:
        return
    for b in conn.execute(
        "SELECT id, qty_left FROM stock_batches WHERE flower_stock_id=? AND qty_left>0 "
        "ORDER BY received_at, id", (flower_id,)
    ).fetchall():
        if remaining <= 0:
            break
        take = min(remaining, b["qty_left"])
        conn.execute("UPDATE stock_batches SET qty_left = qty_left - ? WHERE id=?", (take, b["id"]))
        remaining -= take


def _batch_return(conn, flower_id, amount):
    """Вернуть amount в партии (реверс FIFO — пополняем старые → новые до qty_received)."""
    remaining = float(amount or 0)
    if remaining <= 0:
        return
    for b in conn.execute(
        "SELECT id, qty_left, qty_received FROM stock_batches WHERE flower_stock_id=? "
        "AND qty_left < qty_received ORDER BY received_at, id", (flower_id,)
    ).fetchall():
        if remaining <= 0:
            break
        add = min(remaining, b["qty_received"] - b["qty_left"])
        conn.execute("UPDATE stock_batches SET qty_left = qty_left + ? WHERE id=?", (add, b["id"]))
        remaining -= add


def _days_since(date_str):
    """Сколько полных дней прошло с даты 'YYYY-MM-DD' до сегодня (Батуми)."""
    try:
        then = time.mktime(time.strptime((date_str or "")[:10], "%Y-%m-%d"))
        now = time.mktime(time.strptime(_batumi_today_str(), "%Y-%m-%d"))
    except (ValueError, TypeError):
        return None
    return int(round((now - then) / 86400))


def _stock_freshness_map(conn):
    """{flower_id: {last, prev, star, age}} по партиям с остатком. Свежая партия —
    самая новая (по received_at), звезда — если есть ещё более старая с остатком."""
    grouped = {}
    for r in conn.execute(
        "SELECT flower_stock_id fid, received_at FROM stock_batches WHERE qty_left>0 "
        "ORDER BY flower_stock_id, received_at DESC, id DESC"
    ).fetchall():
        grouped.setdefault(r["fid"], []).append(r["received_at"])
    out = {}
    for fid, dates in grouped.items():
        prev = dates[1] if len(dates) > 1 else None
        out[fid] = {
            "last": dates[0], "prev": prev, "star": len(dates) > 1,
            "age": _days_since(dates[0]), "prev_age": _days_since(prev) if prev else None,
        }
    return out


@app.route("/api/admin/stock/<int:stock_id>/income", methods=["POST"])
@require_owner
def api_admin_stock_income(stock_id):
    body = request.get_json(force=True)
    updated = _stock_movement(stock_id, "income", float(body["quantity"]), body.get("note", "приход"))
    if updated is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(updated)


@app.route("/api/admin/stock/<int:stock_id>/writeoff", methods=["POST"])
@require_owner
def api_admin_stock_writeoff(stock_id):
    body = request.get_json(force=True)
    updated = _stock_movement(stock_id, "writeoff", float(body["quantity"]), body.get("note", "списание"))
    if updated is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(updated)


@app.route("/api/admin/stock/<int:stock_id>", methods=["PUT", "DELETE"])
@require_owner
def api_admin_stock_edit(stock_id):
    conn = get_db()
    row = conn.execute("SELECT * FROM flower_stock WHERE id=?", (stock_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "not found"}), 404
    if request.method == "DELETE":
        used = conn.execute("SELECT COUNT(*) c FROM recipe_lines WHERE flower_stock_id=?", (stock_id,)).fetchone()["c"]
        used += conn.execute("SELECT COUNT(*) c FROM product_recipe WHERE flower_stock_id=?", (stock_id,)).fetchone()["c"]
        if used:
            conn.close()
            return jsonify({"error": "in use", "detail": "Цветок используется в рецептах — сначала уберите его из букетов"}), 400
        conn.execute("DELETE FROM stock_batches WHERE flower_stock_id=?", (stock_id,))
        conn.execute("DELETE FROM stock_movements WHERE flower_stock_id=?", (stock_id,))
        conn.execute("DELETE FROM flower_stock WHERE id=?", (stock_id,))
        conn.commit()
        conn.close()
        return jsonify({"ok": True})
    body = request.get_json(force=True)
    # Частичный апдейт: только переданные поля; ключи — фиксированные литералы.
    fields = {}
    for k in ("name", "flower_type", "unit", "supplier"):
        if k in body:
            fields[k] = body[k]
    for k in ("low_stock_threshold", "pack_size"):
        if k in body:
            fields[k] = float(body[k])
    if fields:
        sets = ", ".join(f"{k}=?" for k in fields)
        conn.execute(f"UPDATE flower_stock SET {sets} WHERE id=?", (*fields.values(), stock_id))
        conn.commit()
    updated = conn.execute("SELECT * FROM flower_stock WHERE id=?", (stock_id,)).fetchone()
    conn.close()
    return jsonify(dict(updated))


@app.route("/api/admin/stock/<int:stock_id>/photo", methods=["POST"])
@require_owner
def api_admin_stock_photo(stock_id):
    if "photo" not in request.files:
        return jsonify({"error": "no file"}), 400
    f = request.files["photo"]
    ext = os.path.splitext(f.filename or "")[1].lower()
    if ext not in ALLOWED_PHOTO_EXTS:
        return jsonify({"error": "unsupported file type", "detail": "только изображ: jpg, png, webp, gif"}), 400
    filename = f"flower_{stock_id}{ext}"
    f.save(os.path.join(UPLOAD_DIR, filename))
    url = f"/static/uploads/{filename}?v={int(time.time())}"
    conn = get_db()
    conn.execute("UPDATE flower_stock SET photo_url=? WHERE id=?", (url, stock_id))
    conn.commit()
    conn.close()
    return jsonify({"photo_url": url})


@app.route("/api/admin/stock/intake", methods=["POST"])
@require_owner
def api_admin_stock_intake():
    """Массовая приёмка. items: [{flower_id, batches:[{packs,pack_size}], extra_stems,
    direct_stems, note}]. Итог штук = сумма(packs*pack_size) + extra_stems + direct_stems."""
    body = request.get_json(force=True)
    items = body.get("items") or []
    conn = get_db()
    applied = []
    for it in items:
        stock_id = it.get("flower_id")
        if not stock_id or not conn.execute("SELECT 1 FROM flower_stock WHERE id=?", (stock_id,)).fetchone():
            continue
        stems = 0.0
        for b in (it.get("batches") or []):
            stems += float(b.get("packs", 0) or 0) * float(b.get("pack_size", 0) or 0)
        stems += float(it.get("extra_stems", 0) or 0)
        stems += float(it.get("direct_stems", 0) or 0)
        if stems <= 0:
            continue
        conn.execute("UPDATE flower_stock SET quantity = quantity + ? WHERE id=?", (stems, stock_id))
        conn.execute(
            "INSERT INTO stock_movements (flower_stock_id, movement_type, quantity, note) VALUES (?, 'income', ?, ?)",
            (stock_id, stems, it.get("note") or "приёмка"),
        )
        _batch_add(conn, stock_id, stems)  # новая партия для плашки свежести
        applied.append({"flower_id": stock_id, "added": stems})
    conn.commit()
    conn.close()
    return jsonify({"applied": applied})


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
        # Товар может быть в нескольких категориях: удаление просто снимает эту
        # категорию с товаров (каскад по связке). Блокируем ТОЛЬКО если товар
        # останется совсем без категорий (для него эта — единственная).
        orphans = conn.execute(
            "SELECT COUNT(*) AS c FROM product_categories pc WHERE pc.category_id=? "
            "AND NOT EXISTS (SELECT 1 FROM product_categories pc2 "
            "WHERE pc2.product_id=pc.product_id AND pc2.category_id != ?)",
            (category_id, category_id),
        ).fetchone()["c"]
        if orphans:
            conn.close()
            return jsonify({
                "error": "category not empty",
                "detail": f"{orphans} товар(ов) останутся без категории. Сначала добавьте им другую категорию.",
            }), 400
        # Починка «первой» категории у товаров, где она указывала на удаляемую
        # (до DELETE, чтобы FK на products.category_id не помешал).
        conn.execute(
            "UPDATE products SET category_id = (SELECT pc.category_id FROM product_categories pc "
            "WHERE pc.product_id = products.id AND pc.category_id != ? ORDER BY pc.id LIMIT 1) "
            "WHERE category_id = ?",
            (category_id, category_id),
        )
        conn.execute("DELETE FROM categories WHERE id=?", (category_id,))  # связка — каскадом
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
# Настройки-строки, которые владелец редактирует в админке (кроме staff_chat_id,
# который обрабатывается отдельно, и name/address — они в таблице locations).
EDITABLE_SETTINGS = [
    "min_delivery_amount", "delivery_fee_day", "delivery_fee_night", "delivery_day_end",
    "slot_capacity", "default_courier_id",
    "shop_phone", "shop_instagram", "manager_username", "express_delivery_text", "delivery_payment_info",
    "disclaimer_note",
    "paypal_enabled", "pay_rate_eur", "pay_rate_usd",
]


@app.route("/api/admin/settings", methods=["GET", "PUT"])
@require_owner
def api_admin_settings():
    chat_test = None  # результат проверки чата уведомлений (после сохранения)
    if request.method == "PUT":
        body = request.get_json(force=True)
        if "staff_chat_id" in body:
            new_chat = (str(body.get("staff_chat_id") or "")).strip()
            set_setting("staff_chat_id", new_chat)
            # Сразу проверяем, что бот может писать в этот чат — чтобы неверный ID
            # не приводил к «тихому» отвалу уведомлений. Тестовое сообщение шлём
            # в эффективный чат (настройка или, если пусто, дефолт из env).
            target = resolve_staff_chat_id()
            if target:
                status = _send_message_api(
                    target, "✅ Сюда будут приходить уведомления о новых заказах Flowers Batum Flower."
                )
                chat_test = {"target": str(target), "status": status}
        for key in EDITABLE_SETTINGS:
            if key in body:
                set_setting(key, (str(body.get(key) if body.get(key) is not None else "")).strip())
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
    result = {
        "staff_chat_id": get_setting("staff_chat_id", ""),
        "staff_chat_id_effective": resolve_staff_chat_id() or "",
        "staff_chat_id_env": STAFF_CHAT_ID or "",
        "shop_name": loc["name"] if loc else "",
        "shop_address": (loc["address"] if loc else "") or "",
    }
    for key in EDITABLE_SETTINGS:
        result[key] = get_setting_or_default(key)
    if chat_test is not None:
        result["chat_test"] = chat_test
    return jsonify(result)


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
    # Курьер видит ТОЛЬКО назначенные ему заказы (свои доставки).
    if g.staff.get("role") == "courier":
        query += " AND assigned_staff_id = ?"
        params.append(g.staff["id"])
    if status:
        query += " AND status = ?"
        params.append(status)
    else:
        # Неоплаченные онлайн-заказы (awaiting_payment) скрыты, пока не оплатят.
        query += " AND status != 'awaiting_payment'"
    query += " ORDER BY created_at DESC"
    rows = conn.execute(query, params).fetchall()
    staff_names = {s["id"]: s["name"] for s in conn.execute("SELECT id, name FROM staff").fetchall()}
    result = []
    for r in rows:
        o = dict(r)
        items = conn.execute(
            "SELECT oi.*, p.photo_url FROM order_items oi "
            "LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id=?",
            (o["id"],),
        ).fetchall()
        o["items"] = [dict(i) for i in items]
        o["assigned_courier_name"] = staff_names.get(o.get("assigned_staff_id"))
        result.append(o)
    conn.close()
    return jsonify(result)


# Цепочка статусов по ТЗ: создан → собирается → собран → передан курьеру →
# доставлен (+ отменён). confirmed оставлен в лейблах для старых заказов.
VALID_STATUSES = ["new", "assembling", "assembled", "out_for_delivery", "delivered", "cancelled"]
STATUS_LABELS_RU = {
    "new": "Новый", "confirmed": "Подтверждён", "assembling": "Собирается",
    "assembled": "Собран", "out_for_delivery": "Передан курьеру",
    "delivered": "Доставлен", "cancelled": "Отменён",
}
# При переходе в статус проставляем отметку времени в соответствующую колонку.
STATUS_TIMESTAMP_COL = {
    "assembled": "assembled_at",
    "out_for_delivery": "handed_at",
    "delivered": "delivered_at",
}


def _batumi_stamp():
    n = _batumi_now()
    return f"{n.tm_year:04d}-{n.tm_mon:02d}-{n.tm_mday:02d} {n.tm_hour:02d}:{n.tm_min:02d}"


def _transition_allowed(cur_status, new_status):
    """Разрешаем только движение вперёд по цепочке + отмену активного заказа.
    Нельзя откатывать статус и нельзя менять уже завершённый (доставлен/отменён)."""
    chain = ["new", "assembling", "assembled", "out_for_delivery", "delivered"]
    if cur_status in ("delivered", "cancelled"):
        return False, "Заказ уже завершён — статус менять нельзя"
    if new_status == cur_status:
        return True, None
    if new_status == "cancelled":
        return True, None
    if cur_status in chain and new_status in chain and chain.index(new_status) > chain.index(cur_status):
        return True, None
    return False, "Нельзя вернуть статус назад"


def _stock_levels(conn):
    """Текущие остатки: per={flower_id: qty}, grp={тип: сумма qty по группе}."""
    per, grp = {}, {}
    for r in conn.execute("SELECT id, flower_type, quantity FROM flower_stock").fetchall():
        q = r["quantity"] or 0
        per[r["id"]] = q
        t = (r["flower_type"] or "").strip()
        if t:
            grp[t] = grp.get(t, 0) + q
    return per, grp


def _recipe_lines_for(conn, product_id, variant_id):
    """Строки рецепта варианта; если своих нет — рецепт товара (variant_id IS NULL)."""
    lines = []
    if variant_id:
        lines = conn.execute(
            "SELECT flower_stock_id, flower_type, quantity_needed FROM recipe_lines WHERE variant_id=?",
            (variant_id,),
        ).fetchall()
    if not lines:
        lines = conn.execute(
            "SELECT flower_stock_id, flower_type, quantity_needed FROM recipe_lines "
            "WHERE product_id=? AND variant_id IS NULL",
            (product_id,),
        ).fetchall()
    return lines


def _variant_available(lines, per, grp):
    """Хватает ли склада на 1 шт по рецепту (конкретный цветок / сумма группы)."""
    for ln in lines:
        need = ln["quantity_needed"] or 0
        if ln["flower_stock_id"]:
            if per.get(ln["flower_stock_id"], 0) < need:
                return False
        elif ln["flower_type"]:
            if grp.get((ln["flower_type"] or "").strip(), 0) < need:
                return False
    return True


def _plan_order_stock(conn, order_lines):
    """order_lines: [(product_id, variant_id, qty)]. Что и сколько списать: конкретные
    строки — с цветка; групповые — из группы, сначала где больше (замены).
    Возвращает (plan=[(flower_id, amount)], shortage=[тексты нехватки])."""
    stock, gmembers = {}, {}
    for r in conn.execute("SELECT id, flower_type, quantity, name FROM flower_stock").fetchall():
        t = (r["flower_type"] or "").strip()
        stock[r["id"]] = {"qty": r["quantity"] or 0, "type": t, "name": r["name"]}
        if t:
            gmembers.setdefault(t, []).append(r["id"])
    plan, shortage = [], []
    for (product_id, variant_id, qty) in order_lines:
        for ln in _recipe_lines_for(conn, product_id, variant_id):
            need = (ln["quantity_needed"] or 0) * qty
            if need <= 0:
                continue
            if ln["flower_stock_id"]:
                fid = ln["flower_stock_id"]
                info = stock.get(fid)
                if not info or info["qty"] < need:
                    shortage.append(info["name"] if info else f"цветок #{fid}")
                if info:
                    info["qty"] -= need
                plan.append((fid, need))
            elif ln["flower_type"]:
                t = (ln["flower_type"] or "").strip()
                members = sorted(gmembers.get(t, []), key=lambda f: -stock[f]["qty"])
                if sum(stock[f]["qty"] for f in members) < need:
                    shortage.append(t)
                remaining = need
                for f in members:
                    if remaining <= 0:
                        break
                    take = min(remaining, stock[f]["qty"])
                    if take > 0:
                        stock[f]["qty"] -= take
                        plan.append((f, take))
                        remaining -= take
                if remaining > 0 and members:  # нехватку отметили; остаток спишем с первого
                    stock[members[0]]["qty"] -= remaining
                    plan.append((members[0], remaining))
    return plan, shortage


def _order_original_consumption(conn, order_id):
    """Сколько реально списано при создании заказа (движения sale «заказ #id»),
    агрегировано по цветку — для точного возврата/повторного списания."""
    rows = conn.execute(
        "SELECT flower_stock_id, SUM(quantity) s FROM stock_movements "
        "WHERE note=? AND movement_type='sale' GROUP BY flower_stock_id",
        (f"заказ #{order_id}",),
    ).fetchall()
    return [(r["flower_stock_id"], r["s"]) for r in rows if r["flower_stock_id"]]


def _adjust_simple_goods(conn, order_id, sign):
    """Корректировка остатка штучных товаров (products.stock_qty) по позициям заказа.
    sign +1 = вернуть (отмена), -1 = списать снова (переоткрытие)."""
    rows = conn.execute(
        "SELECT oi.quantity q, p.id pid FROM order_items oi JOIN products p ON p.id = oi.product_id "
        "WHERE oi.order_id=? AND p.track_stock=1", (order_id,)
    ).fetchall()
    for r in rows:
        conn.execute("UPDATE products SET stock_qty = stock_qty + ? WHERE id=?", (sign * r["q"], r["pid"]))


def _restore_stock(conn, order_id):
    """Возврат склада при отмене — по фактически списанному. Идемпотентно (stock_returned)."""
    row = conn.execute("SELECT stock_returned FROM orders WHERE id=?", (order_id,)).fetchone()
    if not row or (row["stock_returned"] or 0):
        return False
    for fid, amt in _order_original_consumption(conn, order_id):
        conn.execute("UPDATE flower_stock SET quantity = quantity + ? WHERE id=?", (amt, fid))
        conn.execute(
            "INSERT INTO stock_movements (flower_stock_id, movement_type, quantity, note) "
            "VALUES (?, 'return', ?, ?)", (fid, amt, f"отмена #{order_id}"))
        _batch_return(conn, fid, amt)  # вернуть в партии (реверс FIFO)
    _adjust_simple_goods(conn, order_id, +1)
    conn.execute("UPDATE orders SET stock_returned=1 WHERE id=?", (order_id,))
    return True


def _writeoff_stock(conn, order_id):
    """Повторное списание при «отмене отмены» — по тому же фактически списанному.
    Идемпотентно (stock_returned)."""
    row = conn.execute("SELECT stock_returned FROM orders WHERE id=?", (order_id,)).fetchone()
    if not row or not (row["stock_returned"] or 0):
        return False
    for fid, amt in _order_original_consumption(conn, order_id):
        conn.execute("UPDATE flower_stock SET quantity = quantity - ? WHERE id=?", (amt, fid))
        conn.execute(
            "INSERT INTO stock_movements (flower_stock_id, movement_type, quantity, note) "
            "VALUES (?, 'sale', ?, ?)", (fid, amt, f"переоткрытие #{order_id}"))
        _batch_consume(conn, fid, amt)  # снова съесть партии по FIFO
    _adjust_simple_goods(conn, order_id, -1)
    conn.execute("UPDATE orders SET stock_returned=0 WHERE id=?", (order_id,))
    return True


def change_order_status(order_id, new_status, actor_name=None, notify_staff=True, force=False):
    """Единая точка смены статуса: валидация перехода, отметки времени, отметка
    приёма, возврат склада при отмене и уведомления. Используется и HTTP-эндпоинтом,
    и кнопками в Telegram. force=True (владелец) снимает проверку направления —
    можно исправить случайный статус/переоткрыть. Возвращает (order_dict|None,
    err|None): err!=None — переход отклонён; order_dict=None — заказ не найден."""
    conn = get_db()
    order = conn.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    if not order:
        conn.close()
        return None, "not found"
    cur_status = order["status"]
    if not force:
        ok, err = _transition_allowed(cur_status, new_status)
        if not ok:
            conn.close()
            return dict(order), err
    if new_status == cur_status:
        conn.close()
        return dict(order), None
    conn.execute("UPDATE orders SET status=? WHERE id=?", (new_status, order_id))
    ts_col = STATUS_TIMESTAMP_COL.get(new_status)
    if ts_col:
        conn.execute(
            f"UPDATE orders SET {ts_col}=? WHERE id=? AND ({ts_col} IS NULL OR {ts_col}='')",
            (_batumi_stamp(), order_id),
        )
    if cur_status == "new" and new_status != "cancelled":
        conn.execute(
            "UPDATE orders SET accepted_at=?, accepted_by=? WHERE id=? "
            "AND (accepted_at IS NULL OR accepted_at='')",
            (_batumi_stamp(), actor_name or "", order_id),
        )
    # Склад: при отмене — вернуть; при «отмене отмены» (владелец переоткрыл заказ)
    # — списать заново, чтобы остатки не разъехались.
    if new_status == "cancelled" and cur_status != "cancelled":
        _restore_stock(conn, order_id)
    elif cur_status == "cancelled" and new_status != "cancelled":
        _writeoff_stock(conn, order_id)
    conn.commit()
    updated = conn.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    conn.close()
    label = STATUS_LABELS_RU.get(new_status, new_status)
    if updated["customer_tg_id"]:
        enqueue_notification(updated["customer_tg_id"], f"Статус заказа #{order_id}: {label}")
    if notify_staff:
        enqueue_notification(resolve_staff_chat_id(), f"Заказ #{order_id}: статус → {label}",
                             fallback_chat_id=STAFF_CHAT_ID)
    return dict(updated), None


@app.route("/api/admin/orders/<int:order_id>/status", methods=["PUT"])
@require_staff
def api_admin_order_status(order_id):
    body = request.get_json(force=True)
    status = body.get("status")
    if status not in VALID_STATUSES:
        return jsonify({"error": "invalid status", "valid": VALID_STATUSES}), 400
    # Курьер может отметить только «Доставлен» и только на своём заказе.
    if g.staff.get("role") == "courier":
        conn = get_db()
        row = conn.execute("SELECT assigned_staff_id FROM orders WHERE id=?", (order_id,)).fetchone()
        conn.close()
        if not row or row["assigned_staff_id"] != g.staff["id"]:
            return jsonify({"error": "forbidden", "detail": "Это не ваш заказ"}), 403
        if status != "delivered":
            return jsonify({"error": "forbidden", "detail": "Курьер может отметить только «Доставлен»"}), 403
    updated, err = change_order_status(order_id, status, actor_name=g.staff.get("name"),
                                       force=(g.staff.get("role") == "owner"))
    if updated is None:
        return jsonify({"error": "not found"}), 404
    if err:
        return jsonify({"error": "invalid transition", "detail": err}), 400
    return jsonify(updated)


VALID_PAYMENT_METHODS = ("cash", "card", "transfer")


@app.route("/api/admin/orders/<int:order_id>/payment", methods=["PUT"])
@require_staff
def api_admin_order_payment(order_id):
    """Способ оплаты заказа (доставки предоплачены; ставит владелец/флорист при
    приёме). Нужен для сходимости кассы в отчёте. cash|card|transfer или пусто."""
    if g.staff.get("role") == "courier":
        return jsonify({"error": "forbidden"}), 403
    body = request.get_json(force=True)
    pm = body.get("payment_method") or None
    if pm is not None and pm not in VALID_PAYMENT_METHODS:
        return jsonify({"error": "invalid payment_method", "valid": VALID_PAYMENT_METHODS}), 400
    conn = get_db()
    if not conn.execute("SELECT 1 FROM orders WHERE id=?", (order_id,)).fetchone():
        conn.close()
        return jsonify({"error": "not found"}), 404
    conn.execute("UPDATE orders SET payment_method=? WHERE id=?", (pm, order_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "payment_method": pm})


# --------------------------------------------------------------------------
# Админ API — живые продажи в точке (касса). Флорист/владелец вбивают продажу,
# списывают склад (каталог — по рецепту, ручной ввод — по выбранным цветам).
# --------------------------------------------------------------------------
def _apply_sale_writeoff(conn, sale_id, product_id, variant_id, quantity, manual_lines):
    """Списать склад под продажу. Возвращает True, если чего-то не хватило (для
    предупреждения). Ручные строки manual_lines=[(flower_id, qty)] — абсолютные
    штуки; иначе — по рецепту каталожного товара. Кламп в ноль (не в минус)."""
    plan, short = [], False
    if manual_lines:
        plan = [(int(fid), float(q)) for fid, q in manual_lines if fid and float(q or 0) > 0]
    elif product_id:
        prow = conn.execute("SELECT track_stock FROM products WHERE id=?", (product_id,)).fetchone()
        if prow and prow["track_stock"]:
            cur = conn.execute("SELECT stock_qty FROM products WHERE id=?", (product_id,)).fetchone()["stock_qty"] or 0
            new = max(0, cur - quantity)
            if cur - quantity < 0:
                short = True
            conn.execute("UPDATE products SET stock_qty=? WHERE id=?", (new, product_id))
            return short
        plan, sh = _plan_order_stock(conn, [(product_id, variant_id, quantity)])
        if sh:
            short = True
    for fid, amt in plan:
        cur = conn.execute("SELECT quantity FROM flower_stock WHERE id=?", (fid,)).fetchone()
        if not cur:
            continue
        have = cur["quantity"] or 0
        take = min(have, amt)
        if amt > have:
            short = True
        if take <= 0:
            continue
        conn.execute("UPDATE flower_stock SET quantity = quantity - ? WHERE id=?", (take, fid))
        conn.execute(
            "INSERT INTO stock_movements (flower_stock_id, movement_type, quantity, note) "
            "VALUES (?, 'sale', ?, ?)", (fid, take, f"продажа #{sale_id}"))
        _batch_consume(conn, fid, take)
    return short


def _reverse_sale_writeoff(conn, sale):
    """Вернуть склад при удалении продажи — по движениям note 'продажа #id'."""
    rows = conn.execute(
        "SELECT flower_stock_id, SUM(quantity) s FROM stock_movements "
        "WHERE note=? AND movement_type='sale' GROUP BY flower_stock_id",
        (f"продажа #{sale['id']}",),
    ).fetchall()
    for r in rows:
        if not r["flower_stock_id"]:
            continue
        conn.execute("UPDATE flower_stock SET quantity = quantity + ? WHERE id=?", (r["s"], r["flower_stock_id"]))
        conn.execute(
            "INSERT INTO stock_movements (flower_stock_id, movement_type, quantity, note) "
            "VALUES (?, 'return', ?, ?)", (r["flower_stock_id"], r["s"], f"отмена продажи #{sale['id']}"))
        _batch_return(conn, r["flower_stock_id"], r["s"])
    if sale["product_id"]:
        prow = conn.execute("SELECT track_stock FROM products WHERE id=?", (sale["product_id"],)).fetchone()
        if prow and prow["track_stock"]:
            conn.execute("UPDATE products SET stock_qty = stock_qty + ? WHERE id=?",
                         (sale["quantity"], sale["product_id"]))


@app.route("/api/admin/sales", methods=["GET", "POST"])
@require_staff
def api_admin_sales():
    if g.staff.get("role") == "courier":
        return jsonify({"error": "forbidden"}), 403
    conn = get_db()
    if request.method == "POST":
        body = request.get_json(force=True)
        product_id = body.get("product_id") or None
        variant_id = body.get("variant_id") or None
        title = (body.get("title") or "").strip()
        # Название: из каталога подставим сами, если не прислали.
        if product_id and not title:
            prow = conn.execute("SELECT name FROM products WHERE id=?", (product_id,)).fetchone()
            title = prow["name"] if prow else ""
        if not title:
            conn.close()
            return jsonify({"error": "no title", "detail": "Укажите название букета"}), 400
        try:
            amount = float(body.get("amount"))
        except (TypeError, ValueError):
            conn.close()
            return jsonify({"error": "bad amount", "detail": "Укажите сумму"}), 400
        if amount < 0:
            conn.close()
            return jsonify({"error": "bad amount"}), 400
        quantity = int(body.get("quantity") or 1)
        pm = body.get("payment_method") or None
        if pm is not None and pm not in VALID_PAYMENT_METHODS:
            conn.close()
            return jsonify({"error": "invalid payment_method"}), 400
        variant_label = None
        if variant_id:
            vr = conn.execute("SELECT label FROM product_variants WHERE id=?", (variant_id,)).fetchone()
            variant_label = vr["label"] if vr else None
        cur = conn.execute(
            "INSERT INTO sales (location_id, product_id, title, variant_label, amount, quantity, "
            "payment_method, sold_by, sold_by_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (body.get("location_id") or 1, product_id, title, variant_label,
             amount, quantity, pm, g.staff.get("name"), g.staff.get("id"), _batumi_stamp()),
        )
        sale_id = cur.lastrowid
        manual = [(l.get("flower_id"), l.get("qty")) for l in (body.get("writeoff") or [])]
        short = False
        if body.get("writeoff_enabled", True):
            short = _apply_sale_writeoff(conn, sale_id, product_id, variant_id, quantity, manual)
        conn.commit()
        row = conn.execute("SELECT * FROM sales WHERE id=?", (sale_id,)).fetchone()
        conn.close()
        return jsonify({"sale": dict(row), "shortage": short}), 201

    # GET: продажи за период (day|month, по Батуми).
    period = request.args.get("period", "day")
    n = _batumi_now()
    prefix = (f"{n.tm_year:04d}-{n.tm_mon:02d}" if period == "month"
              else f"{n.tm_year:04d}-{n.tm_mon:02d}-{n.tm_mday:02d}")
    rows = conn.execute(
        "SELECT * FROM sales WHERE COALESCE(created_at,'') LIKE ? ORDER BY created_at DESC",
        (prefix + "%",),
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/admin/sales/<int:sale_id>", methods=["DELETE"])
@require_staff
def api_admin_sale_delete(sale_id):
    if g.staff.get("role") == "courier":
        return jsonify({"error": "forbidden"}), 403
    conn = get_db()
    sale = conn.execute("SELECT * FROM sales WHERE id=?", (sale_id,)).fetchone()
    if not sale:
        conn.close()
        return jsonify({"error": "not found"}), 404
    _reverse_sale_writeoff(conn, sale)
    conn.execute("DELETE FROM sales WHERE id=?", (sale_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/admin/pos-data")
@require_staff
def api_admin_pos_data():
    """Данные для формы живой продажи (доступно и флористу): каталог с вариантами/
    рецептами + список позиций склада для ручного списания. Товары/склад-эндпоинты
    сами по себе только для владельца, поэтому даём флористу этот срез."""
    if g.staff.get("role") == "courier":
        return jsonify({"error": "forbidden"}), 403
    location_id = request.args.get("location_id", 1)
    conn = get_db()
    prows = conn.execute(
        "SELECT * FROM products WHERE location_id = ? ORDER BY name", (location_id,)
    ).fetchall()
    products = [_product_with_variants(conn, r) for r in prows]
    flowers = [{"id": r["id"], "name": r["name"], "flower_type": r["flower_type"]}
               for r in conn.execute("SELECT id, name, flower_type FROM flower_stock ORDER BY name").fetchall()]
    conn.close()
    return jsonify({"products": products, "flowers": flowers})


# --------------------------------------------------------------------------
# Админ API — курьеры и назначение на заказ. Владелец/флорист назначают курьера,
# курьер получает уведомление в личку и видит заказ у себя.
# --------------------------------------------------------------------------
@app.route("/api/admin/couriers")
@require_staff
def api_admin_couriers():
    conn = get_db()
    rows = conn.execute("SELECT id, name FROM staff WHERE role='courier' ORDER BY name").fetchall()
    conn.close()
    return jsonify([{"id": r["id"], "name": r["name"]} for r in rows])


@app.route("/api/admin/orders/<int:order_id>/assign", methods=["PUT"])
@require_staff
def api_admin_order_assign(order_id):
    # Назначать курьера может владелец или флорист, но не сам курьер.
    if g.staff.get("role") == "courier":
        return jsonify({"error": "forbidden"}), 403
    body = request.get_json(force=True)
    courier_id = body.get("courier_id") or None
    conn = get_db()
    order = conn.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    if not order:
        conn.close()
        return jsonify({"error": "not found"}), 404
    courier = None
    if courier_id:
        courier = conn.execute(
            "SELECT * FROM staff WHERE id=? AND role='courier'", (courier_id,)
        ).fetchone()
        if not courier:
            conn.close()
            return jsonify({"error": "invalid courier", "detail": "Курьер не найден"}), 400
    conn.execute("UPDATE orders SET assigned_staff_id=? WHERE id=?", (courier_id, order_id))
    conn.commit()
    updated = conn.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    conn.close()
    # Уведомляем назначенного курьера в личку (он узнаёт о доставке через Telegram).
    if courier:
        addr = order["address"] or "—"
        when = " ".join(x for x in [order["delivery_date"] or "", order["delivery_slot"] or ""] if x)
        enqueue_notification(
            courier["telegram_id"],
            f"🛵 Вам назначена доставка заказа #{order_id}\n"
            f"Адрес: {addr}\nКогда: {when or '—'}\n"
            f"Получатель: {order['recipient_name'] or order['customer_name'] or '—'}\n"
            f"Телефон: {order['recipient_phone'] or order['customer_phone'] or '—'}",
        )
    # Связка курьер↔статус: если заказ уже собран, назначение курьера = передача
    # на доставку → авто-статус «Передан курьеру» (чтобы не ставить руками дважды).
    if courier and order["status"] == "assembled":
        advanced, _err = change_order_status(order_id, "out_for_delivery", actor_name=g.staff.get("name"))
        if advanced is not None:
            updated = advanced
    return jsonify(dict(updated))


# --------------------------------------------------------------------------
# Админ API — статистика продаж (только владелец): день/месяц по доставленным.
# --------------------------------------------------------------------------
@app.route("/api/admin/stats")
@require_owner
def api_admin_stats():
    period = request.args.get("period", "day")
    n = _batumi_now()
    if period == "month":
        prefix = f"{n.tm_year:04d}-{n.tm_mon:02d}"      # YYYY-MM
    else:
        prefix = f"{n.tm_year:04d}-{n.tm_mon:02d}-{n.tm_mday:02d}"  # YYYY-MM-DD
    conn = get_db()
    # Ориентируемся на дату доставки (delivered_at); если её нет у старых заказов —
    # берём по created_at. Считаем только доставленные заказы.
    orders = conn.execute(
        "SELECT id, total FROM orders WHERE status='delivered' AND "
        "COALESCE(NULLIF(delivered_at,''), created_at) LIKE ?",
        (prefix + "%",),
    ).fetchall()
    order_ids = [o["id"] for o in orders]
    orders_count = len(order_ids)
    revenue = sum(o["total"] or 0 for o in orders)
    bouquets = 0
    if order_ids:
        placeholders = ",".join("?" * len(order_ids))
        bouquets = conn.execute(
            f"SELECT COALESCE(SUM(quantity),0) c FROM order_items WHERE order_id IN ({placeholders})",
            order_ids,
        ).fetchone()["c"]
    conn.close()
    return jsonify({
        "period": period,
        "orders": orders_count,
        "bouquets": bouquets,
        "revenue": revenue,
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=os.environ.get("DEBUG") == "1")
