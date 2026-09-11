import 'dotenv/config';
import pino from 'pino';
import { Api } from 'grammy';
import { loadEnv } from '../config/env.js';
import { createPlans } from '../config/plans.js';
import { connectDatabase, closeDatabase } from '../infrastructure/db/connection.js';
import { YooKassaPaymentGateway } from '../infrastructure/payments/yookassa.gateway.js';
import { CheckoutService } from '../application/checkout.service.js';
import { PaymentService } from '../application/payment.service.js';
import { SubscriptionService } from '../application/subscription.service.js';
import { ChannelAccessService } from '../application/channel-access.service.js';
import { SchedulerService } from '../application/scheduler.service.js';
import { AdminService } from '../application/admin.service.js';
import { BroadcastService } from '../application/broadcast.service.js';
import { createBot } from '../presentation/telegram/bot.js';
import { createHttpServer } from '../presentation/http/server.js';
import { AboutGalleryService } from '../application/about-gallery.service.js';
import { PurchaseIntentService } from '../application/purchase-intent.service.js';
async function main() {
  const env = loadEnv();
  const logger = pino({
    level: env.LOG_LEVEL,
    redact: {
      paths: ['req.headers.authorization', 'BOT_TOKEN', 'YOOKASSA_SECRET_KEY', 'claimToken'],
      censor: '[REDACTED]',
    },
  });
  const plans = createPlans(env);
  await connectDatabase(env.MONGODB_URI, logger);
  const gateway = new YooKassaPaymentGateway(
    env.YOOKASSA_SHOP_ID,
    env.YOOKASSA_SECRET_KEY,
    env.YOOKASSA_CONNECT_TIMEOUT_MS,
    env.YOOKASSA_REQUEST_TIMEOUT_MS,
  );
  const api = new Api(env.BOT_TOKEN);
  const checkout = new CheckoutService(env, plans, gateway, logger);
  const payments = new PaymentService(
    gateway,
    plans,
    env.CLAIM_TOKEN_TTL_MINUTES,
    env.GRACE_PERIOD_DAYS,
    logger,
    env.CHECKOUT_SECRET,
  );
  const subscriptions = new SubscriptionService();
  const channel = new ChannelAccessService(
    api,
    env.CHANNEL_ID,
    env.INVITE_TTL_MINUTES,
    env.INVITE_RATE_LIMIT_MINUTES,
    logger,
  );
  const admin = new AdminService();
  const broadcast = new BroadcastService(api, logger);
  const gallery = new AboutGalleryService(logger);
  const purchaseIntents = new PurchaseIntentService(env, logger);
  const bot = createBot(env, plans, checkout, subscriptions, channel, admin, broadcast, payments, gallery, purchaseIntents, logger);
  const http = createHttpServer(env, payments, api, logger);
  const scheduler = new SchedulerService(env, plans, gateway, api, channel, logger, payments, http.deliverPaymentResult);
  await http.listen({ port: env.PORT, host: '0.0.0.0' });
  scheduler.start();
  void bot.start({
    allowed_updates: ['message', 'callback_query', 'chat_join_request'],
    onStart: (info) => logger.info({ event: 'bot.started', username: info.username }),
  });
  logger.info({ event: 'app.started', port: env.PORT, paymentMode: env.PAYMENT_MODE });
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ event: 'app.shutdown', signal });
    scheduler.stop();
    await bot.stop();
    await http.close();
    await closeDatabase();
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}
main().catch((err) => {
  pino().fatal({ event: 'app.start_failed', err });
  process.exitCode = 1;
});
