import { Bot } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { createTelegramClientOptions } from '../src/infrastructure/telegram/client.js';
import { createHttpServer } from '../src/presentation/http/server.js';
import type { PaymentService } from '../src/application/payment.service.js';
import type { ChannelAccessService } from '../src/application/channel-access.service.js';
import pino from 'pino';

const BOT_TOKEN = '1234567890:abcdefghijklmnopqrstuvwxyzABCDE';
const baseEnv = {
  NODE_ENV: 'test',
  APP_BASE_URL: 'https://payments.test.invalid',
  BOT_TOKEN,
  BOT_USERNAME: 'test_bot',
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
  PLAN_LIFETIME_AMOUNT_RUB: '500',
  CHECKOUT_SECRET: 'x'.repeat(32),
};

describe('Telegram API client', () => {
  it('builds proxy method URLs without the bot token', () => {
    const env = loadEnv({
      ...baseEnv,
      TELEGRAM_API_ROOT: 'https://telegram-proxy.example',
      TELEGRAM_PROXY_SECRET: 'proxy-secret',
    });
    const options = createTelegramClientOptions(env);
    const url = options.buildUrl?.(env.TELEGRAM_API_ROOT!, BOT_TOKEN, 'getMe', 'prod').toString();

    expect(url).toBe('https://telegram-proxy.example/getMe');
    expect(url).not.toContain(BOT_TOKEN);
  });

  it('adds the proxy secret and preserves grammY headers', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: 'Test' } }),
        ),
      );
    const options = createTelegramClientOptions(
      {
        TELEGRAM_API_ROOT: 'https://telegram-proxy.example',
        TELEGRAM_PROXY_SECRET: 'proxy-secret',
      },
      fetchMock,
    );

    const bot = new Bot(BOT_TOKEN, { client: options });
    await bot.api.getMe();

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get('X-Proxy-Secret')).toBe('proxy-secret');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('uses the standard Telegram API when proxy env is absent', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: 'Test' } }),
        ),
      );
    const direct = createTelegramClientOptions(loadEnv(baseEnv));
    const bot = new Bot(BOT_TOKEN, { client: { ...direct, fetch: fetchMock } });

    await bot.api.getMe();

    const request = fetchMock.mock.calls[0]?.[0];
    const requestUrl =
      typeof request === 'string' ? request : request instanceof URL ? request.href : request?.url;
    expect(requestUrl).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
  });

  it('uses the shared bot.api for payment success notifications', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: 1, date: 1, chat: { id: 42, type: 'private' } },
        }),
      ),
    );
    const env = loadEnv(baseEnv);
    const bot = new Bot(BOT_TOKEN, { client: { fetch: fetchMock } });
    const payments = {
      handleWebhook: vi.fn().mockResolvedValue({
        status: 'succeeded',
        providerPaymentId: 'provider-1',
        notification: {
          telegramId: 42,
          planTitle: 'Месяц',
          amountMinor: 10000,
          autoRenew: false,
          lifetime: true,
        },
        notificationKey: 'payment:1:succeeded',
      }),
      getUiDeliveryState: vi.fn().mockResolvedValue({}),
      markSuccessUiSent: vi.fn(),
      markAccessNotificationSent: vi.fn(),
      markSuccessNotificationSent: vi.fn(),
      scheduleSuccessNotificationRetry: vi.fn(),
      markSuccessNotificationFailed: vi.fn(),
      releaseSuccessNotification: vi.fn(),
    };
    const app = createHttpServer(
      env,
      payments as unknown as PaymentService,
      {
        issueInvite: vi.fn().mockResolvedValue('https://t.me/+personal-invite'),
      } as unknown as ChannelAccessService,
      bot.api,
      pino({ level: 'silent' }),
    );

    await app.inject({
      method: 'POST',
      url: '/webhooks/yookassa',
      payload: { event: 'payment.succeeded', object: { id: 'provider-1' } },
    });
    await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      expect.objectContaining({ method: 'POST' }),
    );
    await app.close();
  });
});
