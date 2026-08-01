#!/bin/bash
set -e
cd /home/claude/flower-shop-app/backend
rm -rf __pycache__
python3 seed.py
python3 app.py > /tmp/flask.log 2>&1 &
SERVER_PID=$!
sleep 2

echo "=== 1) сквозной тест магазина ==="
python3 test_flow.py

echo ""
echo "=== 2) тест маршрутизации бота ==="
python3 test_bot.py

echo ""
echo "=== 3) статика отдаётся корректно (200) ==="
for path in "/" "/customer/style.css" "/customer/app.js" "/admin" "/admin/style.css" "/admin/app.js" "/shared/tokens.css" "/shared/telegram.js" "/static/img/placeholder.svg"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:5000$path")
  echo "  $code  $path"
  if [ "$code" != "200" ]; then echo "!!! OШИБКА: $path вернул $code"; exit 1; fi
done

kill $SERVER_PID 2>/dev/null || true
rm -rf /home/claude/flower-shop-app/backend/__pycache__
echo ""
echo "=== ВСЁ ПРОВЕРЕНО УСПЕШНО ==="
