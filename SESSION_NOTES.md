# Flowers Batum Flower — рабочие заметки сессии (handoff)

Файл для продолжения работы после сжатия контекста. Держать в актуальном состоянии.
Полная память проекта: `C:\Users\bidjo\.claude\projects\C--Users-bidjo\memory\flower-shop-telegram.md`.
План текущей задачи (склад): `C:\Users\bidjo\.claude\plans\telegram-mini-app-quiet-dove.md`.

## Инфра (кратко)
- Flask + SQLite, один процесс отдаёт API + статику. Репо `isssa808/flower-shop-telegram`, ветка `main`. Локально: `C:\Users\bidjo\Desktop\claude\flower-shop-telegram`. cwd Bash не всегда в репо → `cd` в репо или `git -C`.
- Railway: project `0e2d4e5d-2389-4a96-8920-7fc6c2387598`, service `b3c2ec4a-66a6-4d05-90b1-6362d30463ff`, env `14d708e7-4f04-40c9-bc88-1e06a6780b57`, railway-agent threadId `a90bc621-e2fa-4958-9809-a168aca79b50`. Домен https://flower-shop-telegram-production.up.railway.app
- **ДЕПЛОЙ:** `git push origin main` → railway-agent `deployServiceTool` с commitSha → ждать SUCCESS (list-deployments), смотреть логи (get-logs, filter "db"). Автодеплой по пушу НЕ включён.
- **Локального Python/Node НЕТ** — синтаксис проверяется только деплоем. Railway держит старый деплой живым, если новый упал на сборке → даунтайма нет.
- БД на Volume `/data/shop.db`, journal_mode=DELETE + synchronous=FULL, `timeout=5`. gunicorn `--workers 1` (в app.py фоновые потоки: bot getUpdates, notify outbox, reminders). Фото на `/data/uploads`, отдаётся через `/static/uploads/<file>?v=<ts>`.
- Миграции: `_add_column_if_missing` в `bootstrap()` (app.py, вызывается после init_db). Новые ТАБЛИЦЫ — в `SCHEMA` (models.py, `CREATE TABLE IF NOT EXISTS`, executescript на каждом старте). Миграции только ДОБАВЛЯЮТ колонки → откат кода базу не ломает.

## Рабочая договорённость (важно)
- Frontend-правки НЕ проверять локальным рендером/браузером (в этой среде браузер зависает и всё равно не отражает реальный Telegram). Цикл: **код → деплой → владелец смотрит в реальном Telegram → фидбек**. См. память `flower-frontend-verify-workflow`.
- Владелец пишет по-русски, валюта только лари ₾. Приоритет: надёжность/«чтобы всё работало» + эргономика («в меру, понятно, продуктивно, красиво», без переизбытка кнопок).
- Перед необратимым — точка отката (предыдущий SUCCESS-деплой). Все изменения — коммитами.

## Сделано в этой сессии (всё задеплоено, SUCCESS)
1. **UI профиля** (commit db9cd95): убраны подчёркивания контактов; переключатели Тема/Язык/Вибрация на всю ширину; «Связаться» плоскими строками; тема — убран вариант «Системная», при первом входе берётся из prefers-color-scheme (Светлая/Тёмная).
2. **Поля Дата/Время** (commit e4ce2d7): `input[type=date]` снят нативный iOS-вид (`appearance:none`), обоим полям высота 46px — выглядят одинаково.
3. **Логика заказа — кнопки/надёжность/напоминания** (commit 64929a7): инлайн-кнопки «✅ Принять / ✖️ Отменить» под уведомлением о новом заказе (callback в потоке бота `_handle_callback`, жать могут owner/florist); единая `change_order_status` с валидацией переходов (только вперёд + отмена); возврат склада при отмене `_restore_stock` (идемпотентно, флаг orders.stock_returned); `_writeoff_stock` при переоткрытии; предупреждение при списании в минус; авто-связка «назначил курьера на собранный → Передан курьеру»; напоминания (поток раз в 60с): зависший new 15мин–12ч, слот за ≤60мин, алерт владельцу о недоставленном уведомлении `_alert_delivery_failure`. Миграции orders: accepted_at, accepted_by, stock_returned, stale_reminded, slot_reminded.
4. **Owner-override статусов** (commit 63f9922): `change_order_status(force=True)` для owner — снимает проверку направления (может откатить/переоткрыть); флорист/курьер ограничены. При «отмене отмены» `_writeoff_stock` списывает заново. Фронт не трогали (селект статуса уже показывает все статусы). Владелец проверил кнопки в реальном TG — «предварительно всё работает».

Точки отката: последний стабильный до склада — деплой коммита `63f9922`.

## ТЕКУЩАЯ ЗАДАЧА: Склад ↔ букет (план утверждён)

### Решения владельца (зафиксированы)
- Рецепт — **на каждый размер** (S/M/L), т.е. привязка к `variant_id`.
- Доступность — **только по остатку** (0 → серый), без флага сезонности («не сезон» = держать 0).
- Текстовый «Состав» (products.composition) **оставляем** для клиента; структурный рецепт — отдельно, для склада.
- Единицы: склад в **штуках (стеблях)**. У цветка «размер пачки по умолчанию» (pack_size). Приёмка: **пачек × правимый размер пачки** (+ «пачки другого размера» напр. 9×10+1×15, + ввод штук напрямую). Плавающее число в пачке решается правкой размера пачки на приёмке.
- **Группа/тип цветка** (Розы, Тюльпаны…): одно поле для группировки-аккордеона, сортировки, поиска И ЗАМЕН.
- **Замены в миксах**: строка рецепта = ЛИБО конкретный цветок, ЛИБО ГРУППА («51 из группы Розы» — любой цвет). Доступность групповой строки = SUM(остаток по группе) ≥ нужного. Списание группы — сначала с того, чего больше. Не гасит букет, пока в группе суммарно хватает.
- Фото у каждого цветка. Позиции склада постоянны (Volume).
- Недоступный букет: серый, «+» выключен, плашка «Нет в наличии — уточните у менеджера» (текст редактируемый). Букеты БЕЗ рецепта — как сейчас (ручной статус).

### Модель (recipe_lines — новая таблица)
`recipe_lines(id, product_id, variant_id NULLABLE, flower_stock_id NULLABLE, flower_type TEXT, quantity_needed REAL)`. Строка = конкретный цветок (flower_stock_id) ИЛИ группа (flower_type). Старая `product_recipe` остаётся (сид), но новую логику вести на `recipe_lines`.
Новые колонки: `flower_stock.flower_type/pack_size/photo_url`, `order_items.variant_id`.

### Прогресс по этапам
- **Этап 1 — Склад, БЭКЕНД: ГОТОВО+ЗАДЕПЛОЕНО** (commit `7ee8a1d`, деплой c1a1c897 SUCCESS). Логи: миграции flower_type/pack_size/photo_url/variant_id применились, recipe_lines создана, products=16 orders=7. Что сделано:
  - `POST /api/admin/stock` принимает flower_type, pack_size.
  - `PUT/DELETE /api/admin/stock/<id>` — частичная правка (name/flower_type/unit/supplier/low_stock_threshold/pack_size); удаление (блок если в рецептах recipe_lines/product_recipe, иначе чистит stock_movements и удаляет).
  - `POST /api/admin/stock/<id>/photo` — фото цветка (файл `flower_<id>.<ext>`, как у товара).
  - `POST /api/admin/stock/intake` — массовая приёмка: `{items:[{flower_id, batches:[{packs,pack_size}], extra_stems, direct_stems, note}]}`, штук = Σ(packs×pack_size)+extra+direct, движения income, одна транзакция.
- **Этап 1 — Склад, UI: ГОТОВО+ЗАДЕПЛОЕНО** (commit `6ed1a9e`, деплой 5ec9b332 SUCCESS). Вкладка «Склад» перестроена: тулбар поиск+«Приёмка»; аккордеон по группам (сворачивается), сортировка по алфавиту, миниатюры фото; клик по позиции → карточка-редактор (фото/поля/быстрый приход-списание/удаление с подтверждением); экран «Приёмка» с калькулятором пачек (пачек×размер + «пачки другого размера» + штук напрямую, живой итог, «Оприходовать» → intake). Старый per-item приход/списание убран. Ждёт теста владельца в TG.
- (архив описания задачи UI, выполнено) Надо было перестроить вкладку «Склад» (frontend/admin: `renderStock` app.js:513, `openStockAction` :540, add-stock :575; секция index.html #view-stock :38-43, sheet #stock-action-sheet :96-100; стили в admin/style.css). Что нужно:
  - Список склада **сгруппирован по flower_type**, заголовки-аккордеоны сворачиваются/разворачиваются («жалюзи»). **Поиск** (по названию/типу) + **сортировка по алфавиту** (группы, внутри названия). Миниатюра фото. Кнопки «Изменить»/«Удалить» позиции (PUT/DELETE). Форма цветка: + поля тип/группа, штук в пачке, загрузка фото (POST /photo).
  - Экран **«Приёмка»**: тот же аккордеон; у каждого цветка калькулятор — [пачек]×[штук в пачке] (префилл pack_size) + «+ пачки другого размера» + «итог в штуках»; живой итог; кнопка «Оприходовать» → POST /api/admin/stock/intake. Новый цветок заводится тут же.
  - NB: старые per-item «+ приход / − списание» можно оставить или заменить приёмкой — согласовать. Загрузка фото — multipart, как у товара (`api_admin_product_photo` шаблон, app.js есть отправка FormData).
- **Этап 2 — Букеты↔склад: ГОТОВО+ЗАДЕПЛОЕНО** (commit `c4a7b73`, деплой 979e1a37 SUCCESS). Рецепт по размерам с заменами (recipe_lines: конкретный цветок ИЛИ группа/тип), редактор в форме товара («+ ингредиент», «скопировать с размера»); авто-доступность в _product_with_variants (per/grp уровни, конкретная≥/сумма группы≥); витрина — грей-аут+«+» выкл+плашка, недоступные размеры выключены; заказ — order_items.variant_id + предпроверка склада (409 при нехватке, «сначала где больше») + списание по плану; возврат/переоткрытие = реверс фактических движений заказа; разовый перенос product_recipe→recipe_lines. i18n out_of_stock/out_of_stock_short/size_unavailable. Ждёт теста владельца.
- **(архив) Этап 2 — план (выполнено):**
  - Рецепт по размерам в форме товара (frontend/admin app.js:380-460): блок «Из чего собран (для склада)» на каждый вариант, строки {конкретный цветок | группа} + qty, +/−, «скопировать с другого размера». Бэкенд: create/edit товара (app.py ~1333/1371) пишет recipe_lines; GET товара отдаёт рецепт.
  - Доступность в `GET /api/products` / `_product_with_variants` (app.py ~967-1014): на вариант available = all(строк); конкретная: flower_stock.quantity≥qty; групповая: SUM по flower_type ≥ qty; товар available=any(вариантов); без рецепта — как сейчас.
  - Витрина (frontend/customer app.js ~200-219, shared/product-view.js): грей-аут недоступного, «+» выкл, плашка (текст в app_settings). Стиль .pc-unavailable.
  - Списание/возврат под размеры: order create писать order_items.variant_id (в резолве вариантов app.py ~1150-1162 SELECT добавить pv.id, в resolved_items прокинуть variant_id), списывать по recipe_lines варианта (fallback product-level NULL): конкретная — с цветка; групповая — из группы больший-остаток-первым; каждое списание движением sale note "заказ #id". Проверка остатка (не в минус). `_restore_stock`/`_writeoff_stock` переделать на РЕВЕРС записанных движений заказа (точно для миксов) вместо пересчёта по рецепту.

## Ключевые файлы/сваи
- Бэкенд `backend/app.py`: bootstrap/миграции; склад-эндпоинты (~1444+); `_stock_movement`; заказ create + списание (~1150-1260); `change_order_status`/`_restore_stock`/`_writeoff_stock`/`_transition_allowed`; `_product_with_variants`/GET products; уведомления (enqueue_notification, format_order_message, _handle_callback, reminders).
- Модель `backend/models.py`: SCHEMA (все CREATE IF NOT EXISTS), recipe_lines добавлена; get_db.
- Фронт `frontend/admin/`: app.js (STATUS_LABELS, renderOrders/renderStock/product form/renderSettings), index.html, style.css.
- Фронт `frontend/customer/`: app.js, index.html, style.css; `frontend/shared/`: product-view.js/.css, tokens.css (стили полей .field/.field select тут), i18n.js.

## Ещё в бэклоге (после склада)
- ОНЛАЙН-ОПЛАТА: решение принято — **TBC eCommerce** (карта/Apple Pay/Google Pay, уже подключён) + **Cryptomus** (USDT TRC20). Единый поток: заказ → POST /pay → checkout_url → Telegram.WebApp.openLink → вебхук (проверка подписи; Cryptomus MD5(base64(json без sign)+API_KEY)+IP 91.227.144.54; TBC — перезапрос статуса) → payment_status=paid → OUTBOX → экспресс. Таблица payments. Секреты в env. Детали в памяти (блок «ЭТАП 6 ОПЛАТА»).
- Большой ручной тест всего в реальном Telegram.
