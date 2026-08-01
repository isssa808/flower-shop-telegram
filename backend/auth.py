"""
Проверка подлинности данных, которые Telegram передаёт в Mini App
(window.Telegram.WebApp.initData). Алгоритм — официальный, из документации
Telegram Bot API: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

Это чистая криптография (HMAC-SHA256), интернет не нужен — можно проверять
локально. А вот получить BOT_TOKEN и настоящий initData можно только после
регистрации бота через @BotFather и открытия приложения в реальном Telegram.
"""
import hashlib
import hmac
import json
import time
from urllib.parse import parse_qsl


def validate_init_data(init_data: str, bot_token: str, max_age_seconds: int = 86400):
    """Возвращает dict с данными пользователя, если подпись верна, иначе None."""
    if not init_data or not bot_token:
        return None
    try:
        parsed = dict(parse_qsl(init_data, strict_parsing=True))
    except ValueError:
        return None

    received_hash = parsed.pop("hash", None)
    if not received_hash:
        return None

    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(parsed.items()))

    secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    computed_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(computed_hash, received_hash):
        return None

    auth_date = int(parsed.get("auth_date", 0))
    if max_age_seconds and time.time() - auth_date > max_age_seconds:
        return None

    user = json.loads(parsed["user"]) if "user" in parsed else None
    return {"user": user, "auth_date": auth_date, "raw": parsed}


def sign_init_data(fields: dict, bot_token: str) -> str:
    """Обратная операция — собирает и подписывает initData. Нужна только для
    локальных тестов ниже (в реальном приложении initData создаёт сам Telegram)."""
    from urllib.parse import urlencode

    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    computed_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
    fields = dict(fields)
    fields["hash"] = computed_hash
    return urlencode(fields)


if __name__ == "__main__":
    # Самопроверка алгоритма без сети и без реального бота.
    fake_token = "123456:TEST-TOKEN"
    fake_fields = {
        "auth_date": str(int(time.time())),
        "query_id": "AAG_test",
        "user": json.dumps({"id": 111222333, "first_name": "Nino", "username": "nino_test"}),
    }
    init_data = sign_init_data(fake_fields, fake_token)
    result = validate_init_data(init_data, fake_token)
    assert result and result["user"]["id"] == 111222333, "Подпись не прошла проверку"

    tampered = init_data.replace("Nino", "Hacker")
    assert validate_init_data(tampered, fake_token) is None, "Подделанные данные не должны проходить"

    print("auth.py: подпись создаётся и проверяется корректно (self-test OK)")
