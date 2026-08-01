# -*- coding: utf-8 -*-
"""
Минимальный бот на long polling — только для того, чтобы показать кнопку
запуска Mini App. Никаких сторонних библиотек (только urllib), чтобы не
требовать pip install чего-либо ещё.

Это ОТДЕЛЬНЫЙ процесс от app.py — при деплое нужно запускать оба:
  backend:  python3 app.py
  bot:      python3 bot.py

Перед запуском:
  1. Получите BOT_TOKEN у @BotFather (см. README).
  2. Задеплойте app.py на HTTPS-адрес (Telegram не откроет Mini App по http).
  3. Укажите этот адрес в переменной окружения APP_URL.

Права доступа к самой админке проверяются на сервере (backend/auth.py по
таблице staff), а не здесь — кнопка "Панель персонала" ниже показывается
любому, кто написал /admin, это не дыра в безопасности, а просто ярлык.
"""
import os
import json
import time
import urllib.request
import urllib.error

BOT_TOKEN = os.environ.get("BOT_TOKEN")
APP_URL = os.environ.get("APP_URL", "https://example.com")
API = f"https://api.telegram.org/bot{BOT_TOKEN}"


def call(method, **params):
    data = json.dumps(params).encode()
    req = urllib.request.Request(f"{API}/{method}", data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=25) as resp:
        return json.loads(resp.read())


def send_shop_button(chat_id):
    call(
        "sendMessage",
        chat_id=chat_id,
        text="Добро пожаловать в Flowers Batum Flower 🌸\nНажмите кнопку, чтобы открыть каталог и оформить заказ.",
        reply_markup={"inline_keyboard": [[{"text": "🌸 Открыть магазин", "web_app": {"url": APP_URL}}]]},
    )


def send_admin_button(chat_id):
    call(
        "sendMessage",
        chat_id=chat_id,
        text="Панель для персонала (доступ только у сотрудников из таблицы staff).",
        reply_markup={"inline_keyboard": [[{"text": "🛠 Панель персонала", "web_app": {"url": f"{APP_URL}/admin"}}]]},
    )


def handle_update(update):
    msg = update.get("message")
    if not msg or "text" not in msg:
        return
    text = msg["text"].strip()
    chat_id = msg["chat"]["id"]
    if text.startswith("/start"):
        send_shop_button(chat_id)
    elif text.startswith("/admin"):
        send_admin_button(chat_id)


def main():
    if not BOT_TOKEN:
        raise SystemExit("Задайте переменную окружения BOT_TOKEN перед запуском бота")
    print(f"Бот запущен. APP_URL={APP_URL}. Ctrl+C для остановки.")
    offset = 0
    while True:
        try:
            result = call("getUpdates", offset=offset, timeout=20)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            print("Нет связи с Telegram, повтор через 5с:", e)
            time.sleep(5)
            continue
        for update in result.get("result", []):
            offset = update["update_id"] + 1
            try:
                handle_update(update)
            except Exception as e:
                print("Ошибка обработки апдейта:", e)


if __name__ == "__main__":
    main()
