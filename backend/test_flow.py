# -*- coding: utf-8 -*-
"""Сквозной тест: покупатель делает заказ -> склад автосписывается ->
персонал видит заказ и меняет статус -> добавляет приход на склад."""
import json
import time
import urllib.request

from auth import sign_init_data

BASE = "http://127.0.0.1:5000"
TOKEN = "LOCAL_DEV_TOKEN"


def call(method, path, init_data=None, body=None):
    headers = {"Content-Type": "application/json"}
    if init_data:
        headers["X-Telegram-Init-Data"] = init_data
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def make_init_data(user_id, name):
    fields = {
        "auth_date": str(int(time.time())),
        "query_id": "AAtest",
        "user": json.dumps({"id": user_id, "first_name": name}),
    }
    return sign_init_data(fields, TOKEN)


CUSTOMER = make_init_data(555444333, "Гость")
OWNER = make_init_data(111111111, "Владелец")  # совпадает с telegram_id владельца из seed.py

print("1) Остаток розы Netherlands ДО заказа:")
status, stock = call("GET", "/api/admin/stock?location_id=1", OWNER)
rose = next(s for s in stock if "Netherlands" in s["name"])
print("   ", rose["name"], "=", rose["quantity"])

print("2) Покупатель создаёт заказ (букет «Батуми», вариант S)")
status, order = call("POST", "/api/orders", CUSTOMER, {
    "location_id": 1,
    "customer_name": "Гость",
    "customer_phone": "+995555000111",
    "fulfillment_type": "delivery",
    "address": "Батуми, Новый бульвар, 12",
    "delivery_date": "2026-07-31",
    "delivery_slot": "14:00-16:00",
    "recipient_name": "Мариам",
    "card_message": "С днём рождения!",
    "payment_method": "cash",
    "items": [{"variant_id": 1, "quantity": 1}],
})
assert status == 201, (status, order)
print("   заказ создан:", order)

print("3) Остаток розы Netherlands ПОСЛЕ заказа (рецепт: -11 шт на этот букет):")
status, stock = call("GET", "/api/admin/stock?location_id=1", OWNER)
rose = next(s for s in stock if "Netherlands" in s["name"])
print("   ", rose["name"], "=", rose["quantity"], "(было 240, ожидаем 229)")
assert rose["quantity"] == 229, "автосписание по рецепту не сработало"

print("4) Персонал видит заказ в списке новых:")
status, orders = call("GET", "/api/admin/orders?status=new&location_id=1", OWNER)
assert len(orders) == 1 and orders[0]["id"] == order["id"]
print("   ", [o["id"] for o in orders], "customer_name=", orders[0]["customer_name"])

print("5) Персонал меняет статус на 'confirmed':")
status, updated = call("PUT", f"/api/admin/orders/{order['id']}/status", OWNER, {"status": "confirmed"})
print("   новый статус:", updated["status"])
assert updated["status"] == "confirmed"

print("6) Покупатель БЕЗ доступа персонала пробует зайти в админку:")
status, resp = call("GET", "/api/admin/orders?location_id=1", CUSTOMER)
print("   ожидаем 403:", status, resp)
assert status == 403

print("7) Приход поставки: +50 роз Netherlands:")
status, updated_stock = call("POST", "/api/admin/stock/1/income", OWNER, {"quantity": 50, "note": "поставка от 30.07"})
print("   новый остаток:", updated_stock["quantity"], "(ожидаем 279)")
assert updated_stock["quantity"] == 279

print("8) Списание: -5 роз (брак):")
status, updated_stock = call("POST", "/api/admin/stock/1/writeoff", OWNER, {"quantity": 5, "note": "увяли"})
print("   новый остаток:", updated_stock["quantity"], "(ожидаем 274)")
assert updated_stock["quantity"] == 274

print("9) Запрос без initData вообще (проверка, что публичный /api/orders закрыт):")
status, resp = call("POST", "/api/orders", None, {"items": []})
print("   ожидаем 401:", status, resp)
assert status == 401

print("\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ ✅")
