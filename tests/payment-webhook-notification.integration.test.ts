import mongoose from 'mongoose';
import pino from 'pino';
import type { Api } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaymentService } from '../src/application/payment.service.js';
import type { Plan } from '../src/config/plans.js';
import { loadEnv } from '../src/config/env.js';
import {
  CheckoutModel,
  NotificationModel,
  PaymentModel,
  PurchaseIntentModel,
  SubscriptionModel,
  UserModel,
} from '../src/infrastructure/db/models.js';
import type { PaymentGateway } from '../src/infrastructure/payments/payment-gateway.js';
import { createHttpServer } from '../src/presentation/http/server.js';

const query = <T>(value: T) => {
  const promise = Promise.resolve(value);
  return {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    select() { return this; },
    lean: () => Promise.resolve(value),
    session: () => Promise.resolve(value),
    sort() { return this; },
  };
};

const env = loadEnv({
  NODE_ENV: 'test', APP_BASE_URL: 'https://payments.test.invalid',
  BOT_TOKEN: '1234567890:abcdefghijklmnopqrstuvwxyzABCDE', BOT_USERNAME: 'test_payment_bot',
  CHANNEL_ID: '-1001234567890', SUPPORT_URL: 'https://support.test.invalid',
  MONGODB_URI: 'mongodb://localhost:27017/test', PROJECT_NAME: 'Test',
  OFFER_URL: 'https://legal.test.invalid/offer', OFFER_VERSION: '1',
  PRIVACY_URL: 'https://legal.test.invalid/privacy', PAYMENT_MODE: 'yookassa_external',
  YOOKASSA_SHOP_ID: 'shop', YOOKASSA_SECRET_KEY: 'secret',
  PLAN_MONTH_AMOUNT_RUB: '100', PLAN_THREE_MONTH_AMOUNT_RUB: '200',
  PLAN_LIFETIME_AMOUNT_RUB: '500', CHECKOUT_SECRET: 'x'.repeat(32),
});

describe('payment.succeeded webhook notification integration', () => {
  afterEach(() => vi.restoreAllMocks());

  it('activates the subscription and sends one success message to User.telegramId', async () => {
    const paymentId = new mongoose.Types.ObjectId();
    const checkoutId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const subscriptionId = new mongoose.Types.ObjectId();
    const purchaseIntentId = new mongoose.Types.ObjectId();
    const telegramId = 987654321;
    const payment = {
      _id: paymentId,
      internalId: 'internal-1', providerPaymentId: 'provider-1', userId, checkoutSessionId: checkoutId,
      type: 'initial', planId: 'month', amountMinor: 10_000, currency: 'RUB', status: 'pending',
      paymentUiMessageId: undefined, processingUiMessageId: undefined, subscriptionId: undefined,
      save: vi.fn().mockImplementation(function (this: { subscriptionId?: mongoose.Types.ObjectId }) {
        return Promise.resolve(this);
      }),
    };
    const user = { _id: userId, telegramId };
    const checkout = { _id: checkoutId, autoRenewAcceptedAt: new Date() };
    const subscription = {
      _id: subscriptionId, userId, status: 'active', currentPeriodEnd: new Date('2026-10-11T00:00:00Z'),
      autoRenew: true, lifetime: false,
    };
    const plan: Plan = {
      id: 'month', title: 'Месяц', amountMinor: 10_000, currency: 'RUB', durationMonths: 1,
      renewalPeriodMonths: 1, lifetime: false, autoRenewSupported: true, enabled: true,
    };
    const remote = {
      id: 'provider-1', status: 'succeeded', paid: true, amountMinor: 10_000, currency: 'RUB',
      paidAt: new Date('2026-09-11T12:00:00Z'),
      metadata: { internalPaymentId: 'internal-1', checkoutSessionId: String(checkoutId), planId: 'month' },
    };
    const gateway = {
      normalizeWebhookEvent: vi.fn().mockReturnValue({ type: 'succeeded', providerPaymentId: 'provider-1' }),
      getPayment: vi.fn().mockResolvedValue(remote),
    } as unknown as PaymentGateway;

    vi.spyOn(PaymentModel, 'findOne')
      .mockReturnValueOnce(query(payment) as never)
      .mockReturnValueOnce(query({}) as never);
    vi.spyOn(PaymentModel, 'findOneAndUpdate').mockResolvedValue(payment);
    vi.spyOn(PaymentModel, 'updateOne').mockResolvedValue({ modifiedCount: 1 } as never);
    vi.spyOn(PaymentModel, 'findById').mockReturnValue(query(payment) as never);
    vi.spyOn(UserModel, 'findById')
      .mockReturnValueOnce(query(user) as never)
      .mockReturnValueOnce(query(user) as never);
    vi.spyOn(PurchaseIntentModel, 'findOne').mockReturnValue(query({ _id: purchaseIntentId }) as never);
    vi.spyOn(PurchaseIntentModel, 'updateMany').mockResolvedValue({ modifiedCount: 1 } as never);
    vi.spyOn(SubscriptionModel, 'findOne').mockReturnValue(query(null) as never);
    const subscriptionCreate = vi
      .spyOn(SubscriptionModel, 'create')
      .mockResolvedValue([subscription] as never);
    vi.spyOn(CheckoutModel, 'findById').mockReturnValue(query(checkout) as never);
    vi.spyOn(CheckoutModel, 'updateOne').mockResolvedValue({ modifiedCount: 1 } as never);
    vi.spyOn(NotificationModel, 'create').mockResolvedValue({} as never);
    vi.spyOn(NotificationModel, 'updateOne').mockResolvedValue({ modifiedCount: 1 } as never);
    vi.spyOn(mongoose.connection, 'transaction').mockImplementation(async (callback) =>
      callback({} as never),
    );

    const service = new PaymentService(
      gateway, new Map([['month', plan]]), 60, 3, pino({ level: 'silent' }), env.CHECKOUT_SECRET,
    );
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 501 }),
      editMessageText: vi.fn(), deleteMessage: vi.fn(),
    };
    const app = createHttpServer(env, service, api as unknown as Api, pino({ level: 'silent' }));

    const response = await app.inject({
      method: 'POST', url: '/webhooks/yookassa',
      payload: { event: 'payment.succeeded', object: { id: 'provider-1' } },
    });

    expect(response.statusCode).toBe(200);
    expect(subscriptionCreate).toHaveBeenCalledTimes(1);
    expect(payment.subscriptionId).toEqual(subscriptionId);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith(
      telegramId,
      expect.stringContaining('Оплата успешно прошла'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    await app.close();
  });
});
