import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { GrammyError, HttpError, InlineKeyboard, type Api } from 'grammy';
import type { Logger } from 'pino';
import type {
  PaymentService,
  PaymentUiTarget,
  ProcessPaymentResult,
} from '../../application/payment.service.js';
import type { Env } from '../../config/env.js';
import { ru } from '../../content/ru.js';
import { formatUserDate } from '../../shared/date.js';
import { AppError } from '../../shared/errors.js';
import { escapeHtml, minorToRub } from '../../shared/utils.js';

const shell = (title: string, body: string) =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{margin:0;background:#faf6f3;color:#352b2b;font:16px system-ui}main{max-width:680px;margin:5vh auto;padding:32px;background:white;border-radius:24px;box-shadow:0 12px 50px #5d3b2918}h1{font-family:Georgia;font-size:2.2rem}.error{color:#a22}@media(max-width:720px){main{margin:0;min-height:100vh;border-radius:0;padding:24px}}</style></head><body><main>${body}</main></body></html>`;

interface SuccessNotification {
  telegramId: number;
  planCode?: string;
  purchaseIntentId?: string;
  planTitle: string;
  amountMinor: number;
  currentPeriodEnd: Date | null;
  autoRenew: boolean;
  lifetime: boolean;
  paymentUiMessageId?: number;
  processingUiMessageId?: number;
}

function webhookLogContext(body: unknown) {
  if (!body || typeof body !== 'object') return {};
  const candidate = body as { event?: unknown; object?: { id?: unknown } };
  return {
    ...(typeof candidate.event === 'string' ? { webhookEvent: candidate.event } : {}),
    ...(typeof candidate.object?.id === 'string' ? { paymentId: candidate.object.id } : {}),
  };
}

export function isTransientTelegramError(error: unknown): boolean {
  if (error instanceof HttpError) return true;
  if (error instanceof GrammyError)
    return error.error_code === 429 || (error.error_code >= 500 && error.error_code <= 599);
  if (!(error instanceof Error)) return false;
  const coded = error as Error & { code?: string; cause?: { code?: string; message?: string } };
  const code = coded.code ?? coded.cause?.code;
  return (
    ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'].includes(code ?? '') ||
    /fetch failed|network|socket|timed?\s*out/i.test(error.message) ||
    /fetch failed|network|socket|timed?\s*out/i.test(coded.cause?.message ?? '')
  );
}

export function createHttpServer(env: Env, payments: PaymentService, api: Api, logger: Logger) {
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 64 * 1024,
    trustProxy: env.TRUST_PROXY,
  });
  void app.register(helmet, {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'self'"], styleSrc: ["'unsafe-inline'"] },
    },
  });
  void app.register(rateLimit, { max: 60, timeWindow: '1 minute' });
  app.get('/health', () => ({ status: 'ok' }));
  app.get('/ready', async (_req, reply) => {
    const { default: mongoose } = await import('mongoose');
    return Number(mongoose.connection.readyState) === 1
      ? { status: 'ready' }
      : reply.code(503).send({ status: 'not_ready' });
  });

  app.get<{ Querystring: { token?: string } }>(
    '/payment/return',
    { logLevel: 'silent' },
    async (req, reply) => {
      const token = req.query.token;
      const prepared = token ? await payments.prepareReturn(token, env.BOT_USERNAME) : null;
      if (!prepared)
        return reply
          .code(400)
          .type('text/html')
          .send(
            shell(
              'Ссылка недействительна',
              '<h1>Ссылка недействительна</h1><p>Она истекла или была повреждена. Вернитесь в Telegram и попробуйте снова.</p>',
            ),
          );

      if (prepared.processing) {
        try {
          const message = await api.sendMessage(
            prepared.processing.telegramId,
            ru.paymentProcessing,
            {
              parse_mode: 'HTML',
            },
          );
          const saved = await payments.saveProcessingUi(
            prepared.processing.providerPaymentId,
            message.message_id,
          );
          if (!saved)
            await api
              .deleteMessage(prepared.processing.telegramId, message.message_id)
              .catch(() => undefined);
          logger.info({
            event: 'payment.return.processing_ui_sent',
            telegramId: prepared.processing.telegramId,
          });
        } catch (error) {
          await payments
            .releaseProcessingNotification(prepared.processing.providerPaymentId)
            .catch(() => undefined);
          logger.error({ event: 'payment.return.processing_ui_failed', err: error });
        }
      }

      logger.info({ event: 'payment.return.redirect' });
      const response = reply.redirect(prepared.redirect, 302);
      setImmediate(() => {
        void finishReturnedPayment(token!, prepared.providerPaymentId).catch((error) =>
          logger.error({ event: 'payment.return.verification_failed', err: error }),
        );
      });
      return response;
    },
  );

  app.post(
    '/webhooks/yookassa',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const context = { requestId: req.id, ...webhookLogContext(req.body) };
      logger.info({ event: 'yookassa.webhook.received', ...context });
      if ('paymentId' in context)
        logger.info({ event: 'yookassa.webhook.payment_id', ...context });
      if ('webhookEvent' in context)
        logger.info({ event: 'yookassa.webhook.event', ...context });
      try {
        const result = await payments.handleWebhook(req.body);
        if ('notification' in result && result.notification && result.notificationKey)
          await sendSuccessNotification(
            result.providerPaymentId,
            result.notification,
            result.notificationKey,
          );
        if ('status' in result && result.status === 'canceled' && result.uiTarget)
          await showCanceled(result.uiTarget);
        logger.info({ event: 'yookassa.webhook.accepted', ...context });
        return reply.code(200).send({ ok: true });
      } catch (error) {
        const event =
          error instanceof AppError && error.statusCode < 500
            ? 'yookassa.webhook.rejected'
            : 'yookassa.webhook.processing_failed';
        logger.error({ event, ...context, err: error });
        throw error;
      }
    },
  );

  async function finishReturnedPayment(rawToken: string, providerPaymentId: string) {
    const returned = await payments.handleReturn(rawToken);
    if (!returned) return;
    await deliverPaymentResult(providerPaymentId, returned.result);
  }

  async function deliverPaymentResult(
    providerPaymentId: string,
    result: ProcessPaymentResult & { notificationKey?: string },
    delayedUiTarget?: PaymentUiTarget,
  ) {
    if (result.status === 'succeeded' && result.notification && result.notificationKey)
      await sendSuccessNotification(providerPaymentId, result.notification, result.notificationKey);
    if (result.status === 'canceled') {
      const target = await payments.getPaymentUiTarget(providerPaymentId);
      if (target) await showCanceled(target);
    }
    if (result.status === 'pending' && delayedUiTarget?.processingUiMessageId)
      await api
        .editMessageText(
          delayedUiTarget.telegramId,
          delayedUiTarget.processingUiMessageId,
          ru.paymentVerificationDelayed,
          { parse_mode: 'HTML' },
        )
        .catch((error) => logger.warn({ event: 'payment.processing_ui_edit_failed', err: error }));
  }

  async function showCanceled(target: PaymentUiTarget) {
    if (!target.processingUiMessageId) return;
    try {
      await api.editMessageText(
        target.telegramId,
        target.processingUiMessageId,
        ru.paymentCanceled,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('💳 ПОПРОБОВАТЬ СНОВА', 'plans'),
        },
      );
      logger.info({ event: 'payment.processing_ui_edited', telegramId: target.telegramId });
    } catch (error) {
      logger.warn({
        event: 'payment.processing_ui_edit_failed',
        telegramId: target.telegramId,
        err: error,
      });
    }
  }

  async function sendSuccessNotification(
    providerPaymentId: string,
    n: SuccessNotification,
    notificationKey: string,
  ) {
    const logContext = {
      paymentId: providerPaymentId,
      purchaseIntentId: n.purchaseIntentId,
      telegramId: n.telegramId,
      planCode: n.planCode,
    };
    logger.info({ event: 'telegram.notification.started', ...logContext });
    const date = n.currentPeriodEnd
      ? formatUserDate(n.currentPeriodEnd, env.BUSINESS_TIMEZONE)
      : null;
    try {
      const delivery = await payments.getUiDeliveryState(providerPaymentId);
      let accessDelivered = Boolean(delivery?.accessNotificationSentAt);
      if (n.paymentUiMessageId)
        try {
          await api.deleteMessage(n.telegramId, n.paymentUiMessageId);
          logger.info({ event: 'payment.ui_cleaned', telegramId: n.telegramId });
        } catch (deleteError) {
          try {
            await api.editMessageText(n.telegramId, n.paymentUiMessageId, '☑️ Оплачено', {
              reply_markup: new InlineKeyboard(),
            });
          } catch (editError) {
            logger.warn({
              event: 'payment.ui_cleanup_failed',
              telegramId: n.telegramId,
              err: editError,
              deleteError,
            });
          }
      }
      const successText = `✅ <b>Оплата успешно прошла!</b>\n\n🖇️ Тариф: ${escapeHtml(n.planTitle)}\n💳 Оплачено: ${minorToRub(n.amountMinor)}\n${n.lifetime ? '♾️ Доступ без ограничения срока' : `📅 Доступ до: ${date}\n🔄 Автопродление: ${n.autoRenew ? 'включено' : 'выключено'}`}\n\nДобро пожаловать в кладовую контента ❤️\n\n${ru.accessReady}`;
      const accessKeyboard = new InlineKeyboard().text('❤️ ВСТУПИТЬ В КАНАЛ', 'invite');
      if (!delivery?.successUiSentAt) {
        logger.info({ event: 'channel.access.started', ...logContext });
        if (n.processingUiMessageId) {
          try {
            logger.info({ event: 'telegram.notification.send_attempt', ...logContext });
            await api.editMessageText(n.telegramId, n.processingUiMessageId, successText, {
              parse_mode: 'HTML',
              reply_markup: accessKeyboard,
            });
            logger.info({ event: 'telegram.notification.sent', ...logContext });
            logger.info({ event: 'payment.processing_ui_edited', telegramId: n.telegramId });
          } catch (error) {
            logger.warn({
              event: 'payment.processing_ui_edit_failed',
              telegramId: n.telegramId,
              err: error,
            });
            logger.info({ event: 'telegram.notification.send_attempt', ...logContext });
            await api.sendMessage(n.telegramId, successText, {
              parse_mode: 'HTML',
              reply_markup: accessKeyboard,
            });
            logger.info({ event: 'telegram.notification.sent', ...logContext });
          }
        } else {
          logger.info({ event: 'telegram.notification.send_attempt', ...logContext });
          await api.sendMessage(n.telegramId, successText, {
            parse_mode: 'HTML',
            reply_markup: accessKeyboard,
          });
          logger.info({ event: 'telegram.notification.sent', ...logContext });
        }
        await payments.markSuccessUiSent(providerPaymentId);
        logger.info({ event: 'payment.success_ui_sent', telegramId: n.telegramId });
        await payments.markAccessNotificationSent(providerPaymentId);
        accessDelivered = true;
        logger.info({ event: 'channel.access.succeeded', ...logContext });
      }
      if (!accessDelivered) {
        logger.info({ event: 'channel.access.started', ...logContext });
        logger.info({ event: 'telegram.notification.send_attempt', ...logContext });
        await api.sendMessage(n.telegramId, ru.accessReady, {
          parse_mode: 'HTML',
          reply_markup: accessKeyboard,
        });
        logger.info({ event: 'telegram.notification.sent', ...logContext });
        await payments.markAccessNotificationSent(providerPaymentId);
        logger.info({ event: 'channel.access.succeeded', ...logContext });
      }
      await payments.markSuccessNotificationSent(notificationKey);
      logger.info({ event: 'telegram.notification.succeeded', ...logContext });
    } catch (error) {
      if (isTransientTelegramError(error)) {
        logger.warn({ event: 'telegram.notification.transient_failed', ...logContext, err: error });
        const nextAttemptAt = await payments.scheduleSuccessNotificationRetry(notificationKey, error);
        logger.info({
          event: 'telegram.notification.retry_scheduled',
          ...logContext,
          nextAttemptAt,
        });
      } else {
        await payments.markSuccessNotificationFailed(notificationKey, error);
        logger.error({ event: 'telegram.notification.failed', ...logContext, err: error });
      }
    }
  }

  app.setErrorHandler((error, req, reply) => {
    logger.error({ event: 'http.error', requestId: req.id, err: error });
    const normalized = error instanceof Error ? error : new Error('Unknown error');
    const status = normalized instanceof AppError ? normalized.statusCode : 500;
    void reply
      .code(status)
      .type('text/html')
      .send(
        shell(
          'Ошибка',
          `<p class="error">${status < 500 ? escapeHtml(normalized.message) : 'Внутренняя ошибка'}</p>`,
        ),
      );
  });
  return Object.assign(app, { deliverPaymentResult });
}
