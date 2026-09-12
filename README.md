# Telegram-сервис подписки

Production-oriented TypeScript-сервис для продажи доступа к приватному Telegram-каналу. Покупка начинается в Telegram, а оплата проходит на hosted payment page ЮKassa: Telegram UI → `confirmation_url` → подтверждённый webhook → активная подписка → персональная join-request ссылка → проверка Telegram ID → доступ.

## Архитектура

Зависимости направлены `presentation → application → domain`; MongoDB, Telegram и ЮKassa находятся в infrastructure. Handlers не обращаются к моделям для подписочной логики. Деньги хранятся целым числом копеек, даты — UTC, отображение — в `BUSINESS_TIMEZONE`. Критичные операции защищены атомарными Mongo updates, unique indexes, renewal-cycle keys и lease.

Основные каталоги: `config` — env и тарифы; `domain` — календарные периоды; `application` — checkout/payment/subscription/channel/scheduler; `infrastructure` — Mongoose, шлюз ЮKassa, lock; `presentation` — Fastify checkout и grammY; `content/ru.ts` — пользовательские тексты.

## Быстрый старт

Требуются Node.js 20+ и MongoDB с replica set (включая single-node replica set) для транзакционной активации подписки.

```bash
cp .env.example .env
npm install
npm run dev
```

Проверки: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`. Production: `npm run build && npm start`, PM2 через `pm2 start ecosystem.config.cjs`, либо Docker image из `Dockerfile`.

## Telegram

1. В BotFather создайте бота, задайте username и внесите токен в `BOT_TOKEN`.
2. Создайте приватный канал и добавьте бота администратором.
3. Выдайте права создавать/редактировать invite links, одобрять заявки и блокировать участников. В `CHANNEL_ID` укажите числовой ID канала (`-100...`).
4. В `BOT_USERNAME` укажите username без `@`; `ADMIN_IDS` — числовые ID через запятую. Username не используется для авторизации.
5. Для кружка отправьте video note боту во время локальной разработки и временно залогируйте `ctx.message.video_note.file_id` в приватной dev-среде; затем удалите диагностический код и внесите ID в `WELCOME_VIDEO_NOTE_FILE_ID`. Пустое значение безопасно пропускается.

Бот использует long polling и одновременно поднимает HTTP. В production держите один polling worker; Mongo lease защищает scheduler, но Telegram updates должен получать один consumer.

## Конфигурация

Скопируйте `.env.example`. Все поля валидируются при старте. Обязательны публичные HTTPS URL приложения/оферты/privacy/support, Telegram и Mongo credentials, цены, `CHECKOUT_SECRET` (минимум 32 случайных символа), YooKassa shop ID/secret. `TRUST_PROXY=true` устанавливайте только за доверенным reverse proxy. Секреты и raw claim tokens не логируются.

Юридические тексты не входят в проект: задаются `OFFER_URL`, `OFFER_VERSION`, `PRIVACY_URL`. Backend сохраняет версию и время согласий вместе с внутренними идентификаторами checkout. Цены задаются в `PLAN_MONTH_AMOUNT_RUB`, `PLAN_THREE_MONTH_AMOUNT_RUB`, `PLAN_LIFETIME_AMOUNT_RUB` и не принимаются из callback. Необязательные `CONSULTATION_URL` и `HOW_IT_LOOKS_MEDIA_FILE_ID` добавляют кнопку консультации и медиа на экран примеров; пустые значения безопасно скрываются. `APP_BASE_URL` — только публичный origin приложения без route, query или hash (production: `https://pay.kladovaya-content.ru`). Он не должен содержать `/webhooks/yookassa` или `/payment/return`. `RENEWAL_RETRY_OFFSETS_HOURS`, grace, TTL invite/legacy claim и scheduler interval настраиваются env.

## ЮKassa

Создайте тестовый магазин, внесите тестовые `YOOKASSA_SHOP_ID` и `YOOKASSA_SECRET_KEY`. Return URL формируется как `${APP_BASE_URL}/payment/return`. В кабинете укажите webhook:

```text
https://pay.kladovaya-content.ru/webhooks/yookassa
```

Подпишите события `payment.succeeded` и `payment.canceled`. Endpoint не верит payload: извлекает только ID, затем получает платёж официальным API и сверяет status/paid/amount/currency/internal metadata. Повторы идемпотентны.

Автоплатёж требует доступной для магазина функции сохранения способов оплаты и согласия плательщика. Адаптер отправляет `save_payment_method=true`; ID сохраняется только при `payment_method.saved=true`. Карточные реквизиты не хранятся. Fiscal receipt не хардкодирован: реальные receipt/customer/VAT параметры должен предоставить бухгалтер/merchant, после чего их следует подключить отдельным конфигурируемым mapper в YooKassa adapter.

Для локального webhook нужен самостоятельно выбранный HTTPS tunnel. Зависимости от конкретного tunnel-сервиса нет.

## Первый end-to-end тест

1. Запустите MongoDB и приложение, затем отправьте боту `/start`.
2. Нажмите «Присоединиться», выберите тариф и примите условия в Telegram.
3. Перейдите по кнопке оплаты на hosted page ЮKassa и оплатите тестовой картой.
4. Убедитесь по логам в `payment.succeeded`: webhook повторно запрашивает платёж у ЮKassa, сверяет сумму и internal metadata, затем активирует подписку.
5. Получите автоматическое Telegram-уведомление, нажмите «Получить доступ» и отправьте join request. Для исходного Telegram ID будет approve; пересланная ссылка для другого ID — decline.
6. Повторите webhook: период не должен продлиться повторно и повторное уведомление не отправляется.

Для проверки reminders временно создайте subscription с `currentPeriodEnd` около границы +3/+1 день и уменьшите scheduler interval. Для renewal установите `nextPaymentAt` в прошлое и рабочий saved payment method; повторный tick не создаст второй `RenewalAttempt`. Для expiry задайте истёкший `graceUntil`: бот блокирует участника, а при новой оплате снимает ban и выдаёт новую ссылку.

## Безопасность и эксплуатация

Fastify включает Helmet, body limit, Zod validation и rate limits. Claim — случайные 256 бит, в Mongo хранится SHA-256 с server secret, TTL проверяется приложением. Invite одноразовые, ожидаемый Telegram ID проверяется. Mongoose включает `sanitizeFilter`. Логи Pino структурированы и redact-ят authorization/secrets. SIGINT/SIGTERM закрывают polling, HTTP и MongoDB. `/health` показывает процесс, `/ready` возвращает 503 без Mongo.

Рекомендуются TLS reverse proxy, firewall для Mongo, отдельный DB user с минимальными правами, encrypted backups и мониторинг ошибок/lease. Не логируйте `.env`; не коммитьте его.

## Troubleshooting

- Нет webhook: проверьте публичный HTTPS URL, события в кабинете и доступность endpoint.
- Нет уведомления после возврата: webhook ещё не дошёл или проверка amount/currency/metadata не прошла; смотрите структурированный event `http.error`.
- Не сохраняется способ оплаты: recurring payments не активированы для магазина либо provider вернул `saved=false`; подписка будет без автопродления.
- Join request отклонён: Telegram ID не совпал, ссылка истекла/использована или закончилась подписка/grace.
- Claim transaction fails на standalone Mongo: включите replica set.
- Бот не может удалить участника: проверьте admin rights и правильность `CHANNEL_ID`.
