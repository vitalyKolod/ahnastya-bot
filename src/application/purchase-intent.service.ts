import type mongoose from 'mongoose';
import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import type { PlanId } from '../config/plans.js';
import {
  CheckoutModel,
  PaymentModel,
  PurchaseIntentModel,
  SubscriptionModel,
} from '../infrastructure/db/models.js';

export const openIntentFilter = { status: { $in: ['browsing', 'payment_created'] } } as const;
export const shouldStartPurchaseIntent = (subscriptionStatus?: string) =>
  subscriptionStatus !== 'active';

export function isAbandonedReminderEligible(input: {
  now: Date;
  reminderDueAt: Date;
  startedAt: Date;
  reminderSentAt?: Date | null;
  status: string;
  hasActiveSubscription?: boolean;
  lifetime?: boolean;
  paymentStatus?: string;
}) {
  return (
    input.reminderDueAt <= input.now &&
    input.startedAt >= new Date(input.now.getTime() - 7 * 86_400_000) &&
    !input.reminderSentAt &&
    (input.status === 'browsing' || input.status === 'payment_created') &&
    !input.hasActiveSubscription &&
    !input.lifetime &&
    input.paymentStatus !== 'succeeded'
  );
}

export function isReminderCooldownActive(lastReminderAt: Date | null, now: Date, hours: number) {
  return Boolean(lastReminderAt && lastReminderAt > new Date(now.getTime() - hours * 3_600_000));
}

export function reminderCta(input: { planId?: string; paymentStatus?: string; confirmationUrl?: string }) {
  if (input.paymentStatus === 'pending' && input.confirmationUrl)
    return { type: 'url' as const, label: '❤️ ПРОДОЛЖИТЬ ОФОРМЛЕНИЕ', url: input.confirmationUrl };
  return {
    type: 'callback' as const,
    label: input.planId ? '❤️ ПРОДОЛЖИТЬ ОФОРМЛЕНИЕ' : '❤️ ВЫБРАТЬ ТАРИФ',
    data: 'abandoned:resume',
  };
}

export class PurchaseIntentService {
  constructor(
    private readonly env: Pick<Env, 'ABANDONED_CHECKOUT_DELAY_MINUTES' | 'ABANDONED_REMINDER_COOLDOWN_HOURS'>,
    private readonly logger: Logger,
  ) {}

  async start(userId: mongoose.Types.ObjectId, telegramId: number) {
    const active = await SubscriptionModel.exists({ userId, status: 'active' });
    if (active) return null;
    const now = new Date();
    const cooldownAfter = new Date(now.getTime() - this.env.ABANDONED_REMINDER_COOLDOWN_HOURS * 3_600_000);
    const recentReminder = await PurchaseIntentModel.exists({ userId, reminderSentAt: { $gte: cooldownAfter } });
    if (recentReminder) return null;
    const existing = await PurchaseIntentModel.findOne({ userId, ...openIntentFilter }).sort({ createdAt: -1 });
    if (existing) {
      existing.lastActivityAt = now;
      await existing.save();
      return existing;
    }
    const intent = await PurchaseIntentModel.create({
      userId,
      telegramId,
      status: 'browsing',
      startedAt: now,
      lastActivityAt: now,
      reminderDueAt: new Date(now.getTime() + this.env.ABANDONED_CHECKOUT_DELAY_MINUTES * 60_000),
    });
    this.logger.info({ event: 'purchase_intent.started', intentId: intent.id, userId: String(userId) });
    return intent;
  }

  async selectPlan(userId: mongoose.Types.ObjectId, planId: PlanId) {
    const intent = await PurchaseIntentModel.findOneAndUpdate(
      { userId, ...openIntentFilter },
      { $set: { planId, lastActivityAt: new Date() } },
      { new: true, sort: { createdAt: -1 } },
    );
    if (intent) this.logger.info({ event: 'purchase_intent.plan_selected', intentId: intent.id, planId });
    return intent;
  }

  async attachPayment(userId: mongoose.Types.ObjectId, checkoutPublicId: string) {
    const checkout = await CheckoutModel.findOne({ publicId: checkoutPublicId });
    const payment = checkout?.internalPaymentId
      ? await PaymentModel.findOne({ internalId: checkout.internalPaymentId })
      : null;
    const intent = await PurchaseIntentModel.findOneAndUpdate(
      { userId, ...openIntentFilter },
      { $set: { status: 'payment_created', checkoutSessionId: checkout?._id, paymentId: payment?._id, lastActivityAt: new Date() } },
      { new: true, sort: { createdAt: -1 } },
    );
    if (intent) this.logger.info({ event: 'purchase_intent.payment_created', intentId: intent.id });
  }

  async cancel(userId: mongoose.Types.ObjectId) {
    await PurchaseIntentModel.updateMany({ userId, ...openIntentFilter }, { $set: { status: 'canceled' } });
  }

  async resume(userId: mongoose.Types.ObjectId) {
    const intent = await PurchaseIntentModel.findOneAndUpdate(
      { userId, status: 'abandoned', reminderSentAt: { $ne: null } },
      { $set: { status: 'browsing', lastActivityAt: new Date() } },
      { new: true, sort: { createdAt: -1 } },
    );
    if (intent) this.logger.info({ event: 'abandoned_checkout.resumed', intentId: intent.id });
    return intent;
  }

  async completeForPayment(paymentId: mongoose.Types.ObjectId) {
    const result = await PurchaseIntentModel.updateMany(
      { paymentId, status: { $in: ['browsing', 'payment_created', 'abandoned'] } },
      { $set: { status: 'paid', lastActivityAt: new Date() } },
    );
    if (result.modifiedCount) this.logger.info({ event: 'purchase_intent.completed', paymentId: String(paymentId) });
  }
}
