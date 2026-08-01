# -*- coding: utf-8 -*-
"""Проверка маршрутизации бота без обращения к реальному Telegram API —
подменяем call() и смотрим, что бот пытается отправить."""
import bot

calls_log = []


def fake_call(method, **params):
    calls_log.append((method, params))
    return {"result": []}


bot.call = fake_call

bot.handle_update({"message": {"text": "/start", "chat": {"id": 111}, "from": {"id": 111}}})
bot.handle_update({"message": {"text": "/admin", "chat": {"id": 222}, "from": {"id": 222}}})
bot.handle_update({"message": {"text": "просто текст, не команда", "chat": {"id": 333}, "from": {"id": 333}}})

assert len(calls_log) == 2, f"ожидали 2 отправки (на /start и /admin), получили {len(calls_log)}"

start_call = calls_log[0][1]
start_button = start_call["reply_markup"]["inline_keyboard"][0][0]
assert start_button["web_app"]["url"] == bot.APP_URL, "кнопка магазина должна вести на APP_URL"

admin_call = calls_log[1][1]
admin_button = admin_call["reply_markup"]["inline_keyboard"][0][0]
assert admin_button["web_app"]["url"] == f"{bot.APP_URL}/admin", "кнопка админки должна вести на APP_URL/admin"

print("bot.py: /start и /admin шлют корректные web_app-кнопки, обычный текст игнорируется — OK")
