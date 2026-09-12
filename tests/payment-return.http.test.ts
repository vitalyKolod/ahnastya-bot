import pino from 'pino';
import type { Api } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import type { PaymentService } from '../src/application/payment.service.js';
import type { ChannelAccessService } from '../src/application/channel-access.service.js';
import { createHttpServer } from '../src/presentation/http/server.js';
import { ValidationError } from '../src/shared/errors.js';

const token = 'A'.repeat(43);
const env = loadEnv({
  NODE_ENV: 'test',
  APP_BASE_URL: 'https://payments.test.invalid',
  BOT_TOKEN: '1234567890:abcdefghijklmnopqrstuvwxyzABCDE',
  BOT_USERNAME: 'test_payment_bot',
  CHANNEL_ID: '-1001234567890',
  SUPPORT_URL: 'https://support.test.invalid',
  MONGODB_URI: 'mongodb://localhost:27017/test',
  PROJECT_NAME: 'Test',
  OFFER_URL: 'https://legal.test.invalid/offer',
  OFFER_VERSION: '1',
  PRIVACY_URL: 'https://legal.test.invalid/privacy',
  PAYMENT_MODE: 'yookassa_external',
  YOOKASSA_SHOP_ID: 'shop',
  YOOKASSA_SECRET_KEY: 'secret',
  PLAN_MONTH_AMOUNT_RUB: '100',
  PLAN_THREE_MONTH_AMOUNT_RUB: '200',
  PLAN_LIFETIME_AMOUNT_RUB: '5000',
  CHECKOUT_SECRET: 'x'.repeat(32),
  BUSINESS_TIMEZONE: 'Europe/Moscow',
});
const destination = `https://t.me/${env.BOT_USERNAME}`;
const success = {
  subscriptionId: {} as never,
  telegramId: 42,
  planTitle: 'Месяц',
  amountMinor: 10000,
  currentPeriodEnd: new Date('2026-10-10T12:00:00Z'),
  autoRenew: true,
  lifetime: false,
  processingUiMessageId: 101,
};
const flushBackground = () =>
  new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

function harness(
  overrides: Record<string, unknown> = {},
  apiOverrides: Record<string, unknown> = {},
) {
  const payments = {
    prepareReturn: vi.fn().mockResolvedValue({
      redirect: destination,
      providerPaymentId: 'provider-1',
      processing: { providerPaymentId: 'provider-1', telegramId: 42 },
    }),
    saveProcessingUi: vi.fn().mockResolvedValue(true),
    releaseProcessingNotification: vi.fn().mockResolvedValue(undefined),
    handleReturn: vi
      .fn()
      .mockResolvedValue({ providerPaymentId: 'provider-1', result: { status: 'pending' } }),
    handleWebhook: vi.fn().mockResolvedValue({ handled: true }),
    getPaymentUiTarget: vi.fn().mockResolvedValue({ telegramId: 42, processingUiMessageId: 101 }),
    getUiDeliveryState: vi.fn().mockResolvedValue({}),
    markSuccessUiSent: vi.fn().mockResolvedValue(undefined),
    markAccessNotificationSent: vi.fn().mockResolvedValue(undefined),
    markSuccessNotificationSent: vi.fn().mockResolvedValue(undefined),
    scheduleSuccessNotificationRetry: vi.fn().mockResolvedValue(new Date('2026-10-10T12:00:05Z')),
    markSuccessNotificationFailed: vi.fn().mockResolvedValue(undefined),
    claimDueSuccessNotifications: vi.fn().mockResolvedValue([]),
    releaseSuccessNotification: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const api = {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 101 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
    ...apiOverrides,
  };
  const channel = {
    issueInvite: vi.fn().mockResolvedValue('https://t.me/+personal-invite'),
  };
  const app = createHttpServer(
    env,
    payments as unknown as PaymentService,
    channel as unknown as ChannelAccessService,
    api as unknown as Api,
    pino({ level: 'silent' }),
  );
  return { app, payments, channel, api };
}

describe('payment return UX', () => {
  const apps: Array<ReturnType<typeof createHttpServer>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it('return pending sends processing UI and redirects without a start parameter', async () => {
    const h = harness();
    apps.push(h.app);
    const response = await h.app.inject({ method: 'GET', url: `/payment/return?token=${token}` });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(destination);
    expect(h.api.sendMessage).toHaveBeenCalledWith(
      42,
      expect.stringContaining('Проверяем оплату'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    expect(h.api.sendMessage.mock.calls[0]![1]).not.toContain('Оплата получена');
    expect(h.payments.saveProcessingUi).toHaveBeenCalledWith('provider-1', 101);
  });

  it('return succeeded edits processing into success with channel access', async () => {
    const h = harness({
      handleReturn: vi.fn().mockResolvedValue({
        providerPaymentId: 'provider-1',
        result: { status: 'succeeded', notification: success, notificationKey: 'key' },
      }),
    });
    apps.push(h.app);
    await h.app.inject({ method: 'GET', url: `/payment/return?token=${token}` });
    await flushBackground();
    expect(h.api.editMessageText).toHaveBeenCalledWith(
      42,
      101,
      expect.stringContaining('Оплата успешно прошла'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    expect(h.api.editMessageText.mock.calls[0]![2]).toContain('10 октября 2026 г.');
    expect(h.api.editMessageText.mock.calls[0]![2]).toContain('Твой доступ готов');
  });

  it('webhook later edits an existing processing message', async () => {
    const h = harness({
      handleWebhook: vi.fn().mockResolvedValue({
        handled: true,
        providerPaymentId: 'provider-1',
        notification: success,
        notificationKey: 'key',
      }),
    });
    apps.push(h.app);
    await h.app.inject({ method: 'GET', url: `/payment/return?token=${token}` });
    await h.app.inject({ method: 'POST', url: '/webhooks/yookassa', payload: {} });
    expect(h.api.editMessageText).toHaveBeenCalledWith(
      42,
      101,
      expect.stringContaining('Оплата успешно прошла'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
  });

  it('payment.succeeded webhook sends success and access once to the correct user without return', async () => {
    const h = harness({
      handleWebhook: vi.fn().mockResolvedValue({
        handled: true,
        providerPaymentId: 'provider-1',
        notification: { ...success, processingUiMessageId: undefined },
        notificationKey: 'key',
      }),
    });
    apps.push(h.app);
    const response = await h.app.inject({
      method: 'POST',
      url: '/webhooks/yookassa',
      payload: { event: 'payment.succeeded', object: { id: 'provider-1' } },
    });
    expect(response.statusCode).toBe(200);
    expect(h.payments.handleReturn).not.toHaveBeenCalled();
    expect(h.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.api.sendMessage).toHaveBeenCalledWith(
      42,
      expect.stringContaining('Оплата успешно прошла'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    expect(h.channel.issueInvite).toHaveBeenCalledWith(42, 'provider-1');
    expect(JSON.stringify(h.api.sendMessage.mock.calls[0]![2])).toContain(
      'https://t.me/+personal-invite',
    );
    expect(
      h.api.sendMessage.mock.calls.some((call) =>
        String(call[1]).includes('Оплата успешно прошла'),
      ),
    ).toBe(true);
    expect(
      h.api.sendMessage.mock.calls.some((call) => String(call[1]).includes('Твой доступ готов')),
    ).toBe(true);
  });

  it('cleanup edit failure does not prevent the success send', async () => {
    const h = harness(
      {
        handleWebhook: vi.fn().mockResolvedValue({
          handled: true,
          providerPaymentId: 'provider-1',
          notification: { ...success, processingUiMessageId: undefined, paymentUiMessageId: 77 },
          notificationKey: 'key',
        }),
      },
      {
        deleteMessage: vi.fn().mockRejectedValue(new Error('cleanup delete failed')),
        editMessageText: vi.fn().mockRejectedValue(new Error('cleanup edit failed')),
      },
    );
    apps.push(h.app);
    await h.app.inject({
      method: 'POST',
      url: '/webhooks/yookassa',
      payload: { event: 'payment.succeeded', object: { id: 'provider-1' } },
    });
    expect(h.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.api.sendMessage).toHaveBeenCalledWith(
      42,
      expect.stringContaining('Оплата успешно прошла'),
      expect.any(Object),
    );
  });

  it('keeps a transient Telegram failure pending, retries, and ignores a duplicate webhook', async () => {
    const delivery = {
      successUiSentAt: undefined as Date | undefined,
      accessNotificationSentAt: undefined as Date | undefined,
    };
    const notification = {
      ...success,
      processingUiMessageId: 0,
      purchaseIntentId: 'intent-1',
      planCode: 'month',
    };
    const h = harness(
      {
        handleWebhook: vi.fn().mockResolvedValue({
          handled: true,
          providerPaymentId: 'provider-1',
          notification,
          notificationKey: 'key',
        }),
        getUiDeliveryState: vi.fn().mockImplementation(() => Promise.resolve({ ...delivery })),
        markSuccessUiSent: vi.fn().mockImplementation(() => {
          delivery.successUiSentAt = new Date();
        }),
        markAccessNotificationSent: vi.fn().mockImplementation(() => {
          delivery.accessNotificationSentAt = new Date();
        }),
      },
      {
        sendMessage: vi
          .fn()
          .mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { code: 'ETIMEDOUT' }))
          .mockResolvedValue({ message_id: 501 }),
      },
    );
    apps.push(h.app);
    const request = {
      method: 'POST' as const,
      url: '/webhooks/yookassa',
      payload: { event: 'payment.succeeded', object: { id: 'provider-1' } },
    };
    await h.app.inject(request);
    expect(h.payments.scheduleSuccessNotificationRetry).toHaveBeenCalledWith(
      'key',
      expect.any(Error),
    );
    expect(h.payments.markSuccessNotificationSent).not.toHaveBeenCalled();

    await h.app.deliverPaymentResult('provider-1', {
      status: 'succeeded',
      notification,
      notificationKey: 'key',
    });
    expect(h.payments.markSuccessNotificationSent).toHaveBeenCalledWith('key');
    await h.app.inject(request);
    expect(h.api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('duplicate webhooks do not duplicate Telegram messages', async () => {
    const delivery = {
      successUiSentAt: undefined as Date | undefined,
      accessNotificationSentAt: undefined as Date | undefined,
    };
    const h = harness({
      handleWebhook: vi.fn().mockResolvedValue({
        handled: true,
        providerPaymentId: 'provider-1',
        notification: { ...success, processingUiMessageId: undefined },
        notificationKey: 'key',
      }),
      getUiDeliveryState: vi.fn().mockImplementation(() => Promise.resolve({ ...delivery })),
      markSuccessUiSent: vi.fn().mockImplementation(() => {
        delivery.successUiSentAt = new Date();
      }),
      markAccessNotificationSent: vi.fn().mockImplementation(() => {
        delivery.accessNotificationSentAt = new Date();
      }),
    });
    apps.push(h.app);
    const request = {
      method: 'POST' as const,
      url: '/webhooks/yookassa',
      payload: { event: 'payment.succeeded', object: { id: 'provider-1' } },
    };
    await h.app.inject(request);
    await h.app.inject(request);
    expect(
      h.api.sendMessage.mock.calls.filter((call) =>
        String(call[1]).includes('Оплата успешно прошла'),
      ),
    ).toHaveLength(1);
    expect(
      h.api.sendMessage.mock.calls.filter((call) => String(call[1]).includes('Твой доступ готов')),
    ).toHaveLength(1);
  });

  it('returns 400 for a rejected webhook and 500 for a processing failure', async () => {
    const rejected = harness({
      handleWebhook: vi.fn().mockRejectedValue(new ValidationError('Invalid YooKassa webhook')),
    });
    const failed = harness({
      handleWebhook: vi.fn().mockRejectedValue(new Error('database down')),
    });
    apps.push(rejected.app, failed.app);
    const request = { method: 'POST' as const, url: '/webhooks/yookassa', payload: {} };
    expect((await rejected.app.inject(request)).statusCode).toBe(400);
    expect((await failed.app.inject(request)).statusCode).toBe(500);
  });

  it('webhook/return race does not duplicate success or access messages', async () => {
    const delivery = {
      successUiSentAt: undefined as Date | undefined,
      accessNotificationSentAt: undefined as Date | undefined,
    };
    const h = harness({
      handleReturn: vi
        .fn()
        .mockResolvedValue({ providerPaymentId: 'provider-1', result: { status: 'pending' } }),
      handleWebhook: vi.fn().mockResolvedValue({
        handled: true,
        providerPaymentId: 'provider-1',
        notification: success,
        notificationKey: 'key',
      }),
      getUiDeliveryState: vi.fn().mockImplementation(() => Promise.resolve({ ...delivery })),
      markSuccessUiSent: vi.fn().mockImplementation(() => {
        delivery.successUiSentAt = new Date();
      }),
      markAccessNotificationSent: vi.fn().mockImplementation(() => {
        delivery.accessNotificationSentAt = new Date();
      }),
    });
    apps.push(h.app);
    await h.app.inject({ method: 'GET', url: `/payment/return?token=${token}` });
    await Promise.all([
      h.app.inject({ method: 'POST', url: '/webhooks/yookassa', payload: {} }),
      flushBackground(),
    ]);
    expect(h.api.editMessageText).toHaveBeenCalledTimes(1);
    expect(h.api.editMessageText.mock.calls[0]![2]).toContain('Твой доступ готов');
  });

  it('already succeeded payment skips misleading processing UI', async () => {
    const h = harness({
      prepareReturn: vi
        .fn()
        .mockResolvedValue({ redirect: destination, providerPaymentId: 'provider-1' }),
      handleReturn: vi.fn().mockResolvedValue({
        providerPaymentId: 'provider-1',
        result: {
          status: 'succeeded',
          notification: { ...success, processingUiMessageId: undefined },
          notificationKey: 'key',
        },
      }),
    });
    apps.push(h.app);
    await h.app.inject({ method: 'GET', url: `/payment/return?token=${token}` });
    await flushBackground();
    expect(
      h.api.sendMessage.mock.calls.some((call) => String(call[1]).includes('Проверяем оплату')),
    ).toBe(false);
    expect(
      h.api.sendMessage.mock.calls.some((call) =>
        String(call[1]).includes('Оплата успешно прошла'),
      ),
    ).toBe(true);
  });

  it('canceled payment edits processing and adds retry callback', async () => {
    const h = harness({
      handleReturn: vi
        .fn()
        .mockResolvedValue({ providerPaymentId: 'provider-1', result: { status: 'canceled' } }),
    });
    apps.push(h.app);
    await h.app.inject({ method: 'GET', url: `/payment/return?token=${token}` });
    await flushBackground();
    const call = h.api.editMessageText.mock.calls[0]!;
    expect(call[2]).toContain('Оплата не завершена');
    expect(JSON.stringify(call[3])).toContain('plans');
  });

  it.each(['invalid', 'expired'])('shows safe HTML for an %s token', async () => {
    const h = harness({ prepareReturn: vi.fn().mockResolvedValue(null) });
    apps.push(h.app);
    const response = await h.app.inject({ method: 'GET', url: `/payment/return?token=${token}` });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('Ссылка недействительна');
  });
});
