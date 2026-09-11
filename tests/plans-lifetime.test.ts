import { describe, expect, it } from 'vitest';
import { createPlans, subscriptionTerms } from '../src/config/plans.js';
import { loadEnv } from '../src/config/env.js';
import { expiringFilter, recurringDueFilter } from '../src/application/scheduler.service.js';

const env = loadEnv({
  NODE_ENV: 'test', APP_BASE_URL: 'https://app.test.invalid',
  BOT_TOKEN: '1234567890:abcdefghijklmnopqrstuvwxyzABCDE', BOT_USERNAME: 'test_bot',
  CHANNEL_ID: '-1001234567890', SUPPORT_URL: 'https://support.test.invalid',
  MONGODB_URI: 'mongodb://localhost:27017/test', PROJECT_NAME: 'Test',
  OFFER_URL: 'https://legal.test.invalid/offer', OFFER_VERSION: '1',
  PRIVACY_URL: 'https://legal.test.invalid/privacy', PAYMENT_MODE: 'yookassa_external',
  YOOKASSA_SHOP_ID: 'shop', YOOKASSA_SECRET_KEY: 'secret',
  PLAN_MONTH_AMOUNT_RUB: '990', PLAN_THREE_MONTH_AMOUNT_RUB: '2550',
  PLAN_LIFETIME_AMOUNT_RUB: '5000', CHECKOUT_SECRET: 'x'.repeat(32),
});

describe('subscription plans and lifetime invariants', () => {
  const plans = createPlans(env);

  it('uses the configured client prices', () => {
    expect(plans.get('month')?.amountMinor).toBe(99_000);
    expect(plans.get('three_months')?.amountMinor).toBe(255_000);
    expect(plans.get('lifetime')?.amountMinor).toBe(500_000);
  });

  it('activates lifetime without an artificial end or renewal', () => {
    const now = new Date('2026-09-10T12:00:00Z');
    const terms = subscriptionTerms(plans.get('lifetime')!, now, undefined, true, true);
    expect(terms).toEqual({
      currentPeriodStart: now, currentPeriodEnd: null, lifetime: true,
      autoRenew: false, nextPaymentAt: null,
    });
  });

  it('keeps lifetime out of renewal and expiration scheduler filters', () => {
    expect(recurringDueFilter()).toMatchObject({ lifetime: { $ne: true } });
    expect(expiringFilter().$or.every((branch) => branch.lifetime.$ne === true)).toBe(true);
  });
});
