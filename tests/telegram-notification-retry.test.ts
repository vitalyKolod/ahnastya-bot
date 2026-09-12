import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { SchedulerService } from '../src/application/scheduler.service.js';
import type { PaymentService } from '../src/application/payment.service.js';
import type { Env } from '../src/config/env.js';
import type { PaymentGateway } from '../src/infrastructure/payments/payment-gateway.js';
import type { Api } from 'grammy';
import type { ChannelAccessService } from '../src/application/channel-access.service.js';

describe('Telegram success notification scheduler', () => {
  it('delivers a claimed pending notification without reprocessing payment or subscription', async () => {
    const notification = {
      subscriptionId: {} as never,
      telegramId: 987654321,
      purchaseIntentId: 'intent-1',
      planCode: 'month',
      planTitle: 'Месяц',
      amountMinor: 10_000,
      currentPeriodEnd: new Date('2026-10-11T00:00:00Z'),
      autoRenew: true,
      lifetime: false,
    };
    const payments = {
      claimDueSuccessNotifications: vi.fn().mockResolvedValueOnce([
        { providerPaymentId: 'provider-1', notificationKey: 'key', notification },
      ]),
      verifyDuePayments: vi.fn(),
    };
    const deliver = vi.fn().mockResolvedValue(undefined);
    const scheduler = new SchedulerService(
      {} as Env,
      new Map(),
      {} as PaymentGateway,
      {} as Api,
      {} as ChannelAccessService,
      pino({ level: 'silent' }),
      payments as unknown as PaymentService,
      deliver,
    );

    await scheduler.processTelegramNotificationRetries(new Date('2026-09-11T12:00:05Z'));

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith('provider-1', {
      status: 'succeeded', notification, notificationKey: 'key',
    });
    expect(payments.verifyDuePayments).not.toHaveBeenCalled();
  });
});
