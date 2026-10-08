import { describe, expect, it, vi } from 'vitest';
import { AdminService } from '../src/application/admin.service.js';
import { createPlans, planForCheckout } from '../src/config/plans.js';
import { PlanModel } from '../src/infrastructure/db/models.js';
import { loadEnv } from '../src/config/env.js';

const env = loadEnv({
  NODE_ENV: 'test',
  APP_BASE_URL: 'https://app.test.invalid',
  BOT_TOKEN: '1234567890:abcdefghijklmnopqrstuvwxyzABCDE',
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
  PLAN_MONTH_AMOUNT_RUB: '990',
  PLAN_THREE_MONTH_AMOUNT_RUB: '2550',
  PLAN_LIFETIME_AMOUNT_RUB: '5000',
  CHECKOUT_SECRET: 'x'.repeat(32),
});

describe('admin tariff changes', () => {
  it('uses the saved price immediately while preserving the old checkout terms', async () => {
    const plans = createPlans(env);
    const before = plans.get('month')!;
    const write = vi.spyOn(PlanModel, 'findOneAndUpdate').mockResolvedValue(null);
    try {
      const saved = await new AdminService(plans).savePlan({
        id: 'month',
        title: 'Месяц новый',
        amountMinor: 120000,
        durationMonths: 2,
      });
      expect(write).toHaveBeenCalledOnce();
      expect(plans.get('month')).toEqual(saved);
      expect(saved.amountMinor).toBe(120000);
      expect(saved.durationMonths).toBe(2);
      expect(
        planForCheckout(saved, {
          planTitle: before.title,
          planDurationMonths: before.durationMonths,
          planLifetime: before.lifetime,
          planAutoRenewSupported: before.autoRenewSupported,
        }),
      ).toMatchObject({ title: before.title, durationMonths: 1 });
    } finally {
      write.mockRestore();
    }
  });

  it('soft deletes a tariff so existing subscription references remain available', async () => {
    const plans = createPlans(env);
    const write = vi
      .spyOn(PlanModel, 'updateOne')
      .mockResolvedValue({
        acknowledged: true,
        matchedCount: 1,
        modifiedCount: 1,
        upsertedCount: 0,
        upsertedId: null,
      });
    try {
      const removed = await new AdminService(plans).setPlanEnabled('month', false);
      expect(removed.enabled).toBe(false);
      expect(plans.has('month')).toBe(true);
    } finally {
      write.mockRestore();
    }
  });
});
