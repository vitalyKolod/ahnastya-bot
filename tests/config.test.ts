import { describe, expect, it } from 'vitest';
import { rubToMinor } from '../src/config/plans.js';
import { loadEnv } from '../src/config/env.js';
import { hashToken, newToken } from '../src/shared/utils.js';
describe('money and tokens', () => {
  it('converts RUB without float arithmetic', () => {
    expect(rubToMinor('1990')).toBe(199000);
    expect(rubToMinor('10.05')).toBe(1005);
  });
  it('creates opaque token and stable non-raw hash', () => {
    const token = newToken();
    expect(token.length).toBeGreaterThan(30);
    expect(hashToken(token, 'x')).toBe(hashToken(token, 'x'));
    expect(hashToken(token, 'x')).not.toContain(token);
    expect(`pay_${token}`).toHaveLength(47);
    expect(`pay_${token}`.length).toBeLessThanOrEqual(64);
  });
});

const productionEnv = {
  NODE_ENV: 'production',
  APP_BASE_URL: 'https://pay.kladovaya-content.ru',
  BOT_TOKEN: '1234567890:abcdefghijklmnopqrstuvwxyzABCDE',
  BOT_USERNAME: 'test_bot',
  CHANNEL_ID: '-1001234567890',
  SUPPORT_URL: 'https://t.me/support',
  MONGODB_URI: 'mongodb://db:27017/app',
  PROJECT_NAME: 'Test',
  OFFER_URL: 'https://pay.kladovaya-content.ru/offer',
  OFFER_VERSION: '1',
  PRIVACY_URL: 'https://pay.kladovaya-content.ru/privacy',
  PAYMENT_MODE: 'yookassa_external',
  YOOKASSA_SHOP_ID: 'shop',
  YOOKASSA_SECRET_KEY: 'secret',
  PLAN_MONTH_AMOUNT_RUB: '100',
  PLAN_THREE_MONTH_AMOUNT_RUB: '200',
  PLAN_LIFETIME_AMOUNT_RUB: '500',
  CHECKOUT_SECRET: 'x'.repeat(32),
};

describe('production APP_BASE_URL', () => {
  it('accepts and canonicalizes the application origin', () => {
    expect(
      loadEnv({ ...productionEnv, APP_BASE_URL: 'https://pay.kladovaya-content.ru/' }).APP_BASE_URL,
    ).toBe('https://pay.kladovaya-content.ru');
  });

  it.each([
    'https://pay.kladovaya-content.ru/webhooks/yookassa',
    'https://pay.kladovaya-content.ru/payment/return',
    'http://pay.kladovaya-content.ru',
    'https://old-project.ngrok.io',
    'http://localhost:3000',
  ])('rejects a non-origin or wrong production URL: %s', (APP_BASE_URL) => {
    expect(() => loadEnv({ ...productionEnv, APP_BASE_URL })).toThrow('APP_BASE_URL');
  });
});

describe('Telegram proxy configuration', () => {
  it.each([
    { TELEGRAM_API_ROOT: 'https://telegram-proxy.example' },
    { TELEGRAM_PROXY_SECRET: 'proxy-secret' },
  ])('requires root and secret together', (proxyEnv) => {
    expect(() => loadEnv({ ...productionEnv, ...proxyEnv })).toThrow(
      'TELEGRAM_API_ROOT and TELEGRAM_PROXY_SECRET must be set together',
    );
  });

  it.each([
    'http://telegram-proxy.example',
    'https://telegram-proxy.example/getMe',
    'https://telegram-proxy.example?debug=true',
    'https://telegram-proxy.example#fragment',
  ])('rejects a non-HTTPS proxy origin: %s', (TELEGRAM_API_ROOT) => {
    expect(() =>
      loadEnv({ ...productionEnv, TELEGRAM_API_ROOT, TELEGRAM_PROXY_SECRET: 'proxy-secret' }),
    ).toThrow('TELEGRAM_API_ROOT must be an HTTPS origin');
  });
});
