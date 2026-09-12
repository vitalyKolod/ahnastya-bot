import { InlineKeyboard, type Api } from 'grammy';
import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import type { Plan, PlanId } from '../config/plans.js';
import { addGrace } from '../domain/subscription/period.js';
import {
  NotificationModel,
  PaymentModel,
  PurchaseIntentModel,
  RenewalModel,
  SubscriptionModel,
  UserModel,
} from '../infrastructure/db/models.js';
import { MongoLease } from '../infrastructure/db/lock.js';
import type { PaymentGateway } from '../infrastructure/payments/payment-gateway.js';
import type { ChannelAccessService } from './channel-access.service.js';
import { newId } from '../shared/utils.js';
import { ru } from '../content/ru.js';
import type { PaymentService, PaymentUiTarget, ProcessPaymentResult } from './payment.service.js';
export const recurringDueFilter = (now = new Date()) => ({
  status: { $in: ['active', 'past_due'] },
  lifetime: { $ne: true },
  autoRenew: true,
  paymentMethodId: { $exists: true },
  nextPaymentAt: { $lte: now },
});
export const expiringFilter = (now = new Date()) => ({
  $or: [
    {
      status: 'active',
      lifetime: { $ne: true },
      autoRenew: false,
      currentPeriodEnd: { $lte: now },
    },
    { status: 'past_due', lifetime: { $ne: true }, graceUntil: { $lte: now } },
  ],
});
export class SchedulerService {
  private timer?: NodeJS.Timeout;
  private verificationTimer?: NodeJS.Timeout;
  constructor(
    private readonly env: Env,
    private readonly plans: ReadonlyMap<PlanId, Plan>,
    private readonly gateway: PaymentGateway,
    private readonly api: Api,
    private readonly channel: ChannelAccessService,
    private readonly logger: Logger,
    private readonly payments?: PaymentService,
    private readonly deliverPaymentResult?: (
      providerPaymentId: string,
      result: ProcessPaymentResult & { notificationKey?: string },
      delayedUiTarget?: PaymentUiTarget,
    ) => Promise<void>,
  ) {}
  start() {
    this.timer = setInterval(
      () =>
        void this.tick().catch((error) =>
          this.logger.error({ event: 'scheduler.error', err: error }),
        ),
      this.env.SCHEDULER_INTERVAL_MINUTES * 60_000,
    );
    if (this.payments && this.deliverPaymentResult)
      this.verificationTimer = setInterval(
        () =>
          void new MongoLease('payment-verification', 9_000)
            .run(() => this.paymentVerifications())
            .catch((error) =>
              this.logger.error({ event: 'scheduler.payment_verification_error', err: error }),
            ),
        10_000,
      );
    void this.tick();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.verificationTimer) clearInterval(this.verificationTimer);
  }
  async tick() {
    await new MongoLease('subscription-jobs', this.env.SCHEDULER_INTERVAL_MINUTES * 50_000).run(
      async () => {
        await this.reminders();
        await this.paymentVerifications();
        await this.processAbandonedCheckoutReminders();
        await this.renewals();
        await this.expirations();
      },
    );
  }
  private async paymentVerifications() {
    if (!this.payments || !this.deliverPaymentResult) return;
    const results = await this.payments.verifyDuePayments();
    for (const item of results)
      await this.deliverPaymentResult(item.providerPaymentId, item.result, item.delayedUiTarget);
    await this.processTelegramNotificationRetries();
  }
  async processTelegramNotificationRetries(now = new Date()) {
    if (!this.payments || !this.deliverPaymentResult) return;
    const pending = await this.payments.claimDueSuccessNotifications(now);
    for (const item of pending)
      await this.deliverPaymentResult(item.providerPaymentId, {
        status: 'succeeded',
        notification: item.notification,
        notificationKey: item.notificationKey,
      });
  }
  async processAbandonedCheckoutReminders(now = new Date()) {
    const staleAfter = new Date(now.getTime() - 7 * 86_400_000);
    const candidates = await PurchaseIntentModel.find({
      reminderDueAt: { $lte: now },
      reminderSentAt: null,
      startedAt: { $gte: staleAfter },
      status: { $in: ['browsing', 'payment_created'] },
    })
      .sort({ reminderDueAt: 1 })
      .limit(100);
    for (const candidate of candidates) {
      this.logger.info({ event: 'abandoned_checkout.detected', intentId: candidate.id });
      const [subscription, payment] = await Promise.all([
        SubscriptionModel.findOne({ userId: candidate.userId, status: 'active' }),
        candidate.paymentId ? PaymentModel.findById(candidate.paymentId) : null,
      ]);
      if (subscription || payment?.status === 'succeeded') {
        await PurchaseIntentModel.updateOne(
          { _id: candidate._id, reminderSentAt: null },
          { $set: { status: subscription || payment ? 'paid' : 'canceled' } },
        );
        this.logger.info({
          event: 'abandoned_checkout.reminder_skipped',
          intentId: candidate.id,
          reason: 'already_active_or_paid',
        });
        continue;
      }
      let confirmationUrl: string | undefined;
      if (payment?.providerPaymentId && payment.status === 'pending') {
        const remote = await this.gateway.getPayment(payment.providerPaymentId);
        if (remote.paid || remote.status === 'succeeded') {
          this.logger.info({
            event: 'abandoned_checkout.reminder_skipped',
            intentId: candidate.id,
            reason: 'provider_succeeded',
          });
          continue;
        }
        if (remote.status === 'pending' || remote.status === 'waiting_for_capture')
          confirmationUrl =
            remote.confirmationUrl ??
            (candidate.checkoutSessionId
              ? ((
                  await import('../infrastructure/db/models.js').then(({ CheckoutModel }) =>
                    CheckoutModel.findById(candidate.checkoutSessionId)
                      .select('confirmationUrl')
                      .lean(),
                  )
                )?.confirmationUrl ?? undefined)
              : undefined);
      }
      const claimed = await PurchaseIntentModel.findOneAndUpdate(
        {
          _id: candidate._id,
          reminderSentAt: null,
          reminderClaimedAt: null,
          status: { $in: ['browsing', 'payment_created'] },
        },
        { $set: { reminderClaimedAt: now } },
        { new: true },
      );
      if (!claimed) continue;
      const activeImmediatelyBeforeSend = await SubscriptionModel.exists({
        userId: claimed.userId,
        status: 'active',
      });
      const paidImmediatelyBeforeSend = claimed.paymentId
        ? await PaymentModel.exists({ _id: claimed.paymentId, status: 'succeeded' })
        : null;
      if (activeImmediatelyBeforeSend || paidImmediatelyBeforeSend) {
        await PurchaseIntentModel.updateOne(
          { _id: claimed._id },
          { $set: { status: 'paid' }, $unset: { reminderClaimedAt: 1 } },
        );
        this.logger.info({
          event: 'abandoned_checkout.reminder_skipped',
          intentId: claimed.id,
          reason: 'paid_during_processing',
        });
        continue;
      }
      const keyboard = new InlineKeyboard();
      if (confirmationUrl) keyboard.url('❤️ ПРОДОЛЖИТЬ ОФОРМЛЕНИЕ', confirmationUrl);
      else
        keyboard.text(
          candidate.planId ? '❤️ ПРОДОЛЖИТЬ ОФОРМЛЕНИЕ' : '❤️ ВЫБРАТЬ ТАРИФ',
          'abandoned:resume',
        );

      try {
        await this.api.sendMessage(candidate.telegramId, ru.abandonedCheckout, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
        await PurchaseIntentModel.updateOne(
          { _id: claimed._id, reminderSentAt: null },
          {
            $set: { reminderSentAt: new Date(), status: 'abandoned' },
            $unset: { reminderClaimedAt: 1 },
          },
        );
        this.logger.info({ event: 'abandoned_checkout.reminder_sent', intentId: claimed.id });
      } catch (error) {
        await PurchaseIntentModel.updateOne(
          { _id: claimed._id },
          { $unset: { reminderClaimedAt: 1 } },
        );
        this.logger.error({
          event: 'abandoned_checkout.reminder_failed',
          intentId: claimed.id,
          err: error,
        });
      }
    }
  }
  private async sendOnce(sub: InstanceType<typeof SubscriptionModel>, type: string, text: string) {
    if (sub.lifetime || !sub.currentPeriodEnd) return;
    const dedupKey = `${sub.id}:${sub.currentPeriodEnd.toISOString()}:${type}`;
    try {
      await NotificationModel.create({
        subscriptionId: sub._id,
        periodEnd: sub.currentPeriodEnd,
        type,
        dedupKey,
      });
      const user = await UserModel.findById(sub.userId);
      if (user) {
        await this.api.sendMessage(user.telegramId, text);
        await NotificationModel.updateOne({ dedupKey }, { $set: { sentAt: new Date() } });
        this.logger.info({ event: 'reminder.sent', type, subscriptionId: sub.id });
      }
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: number }).code === 11000
      )
        return;
      await NotificationModel.updateOne({ dedupKey }, { $set: { error: String(error) } });
    }
  }
  private async reminders() {
    const now = Date.now();
    for (const days of [3, 1] as const) {
      const from = new Date(now + days * 86_400_000 - 10 * 60_000),
        to = new Date(now + days * 86_400_000 + this.env.SCHEDULER_INTERVAL_MINUTES * 60_000);
      const subs = await SubscriptionModel.find({
        status: 'active',
        lifetime: { $ne: true },
        currentPeriodEnd: { $gte: from, $lt: to },
      });
      for (const sub of subs) {
        const type = `expiry_${days}d_${sub.autoRenew ? 'auto' : 'manual'}`;
        await this.sendOnce(
          sub,
          type,
          sub.autoRenew
            ? `Через ${days === 1 ? 'один день' : '3 дня'} автоматически продлится твоя подписка ❤️`
            : `Подписка заканчивается через ${days === 1 ? 'один день' : '3 дня'} ❤️`,
        );
      }
    }
  }
  private async renewals() {
    const due = await SubscriptionModel.find(recurringDueFilter()).limit(100);
    for (const sub of due) {
      const plan = this.plans.get(sub.planId as PlanId);
      if (!plan || plan.lifetime || !plan.renewalPeriodMonths || !sub.currentPeriodEnd) continue;
      let attempt;
      try {
        attempt = await RenewalModel.create({
          subscriptionId: sub._id,
          cycle: sub.currentPeriodEnd,
          status: 'processing',
          attemptNumber: 0,
        });
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code?: number }).code === 11000
        )
          continue;
        throw error;
      }
      const internalId = newId(),
        key = `renewal:${sub.id}:${sub.currentPeriodEnd.toISOString()}`;
      try {
        const checkout = await import('../infrastructure/db/models.js').then((m) =>
          m.CheckoutModel.create({
            publicId: newId(),
            planId: plan.id,
            amountMinor: plan.amountMinor,
            currency: 'RUB',
            status: 'payment_pending',
            offerVersion: this.env.OFFER_VERSION,
          }),
        );
        const local = await PaymentModel.create({
          internalId,
          checkoutSessionId: checkout._id,
          subscriptionId: sub._id,
          userId: sub.userId,
          provider: 'yookassa',
          idempotenceKey: key,
          type: 'renewal',
          planId: plan.id,
          amountMinor: plan.amountMinor,
          currency: 'RUB',
          status: 'pending',
        });
        const remote = await this.gateway.createRecurringPayment({
          idempotenceKey: key,
          amountMinor: plan.amountMinor,
          currency: 'RUB',
          description: `Продление ${this.env.PROJECT_NAME}`,
          returnUrl: new URL('/payment/return', this.env.APP_BASE_URL).toString(),
          savePaymentMethod: false,
          metadata: {
            checkoutSessionId: String(checkout._id),
            planId: plan.id,
            internalPaymentId: internalId,
          },
          paymentMethodId: sub.paymentMethodId!,
        });
        await PaymentModel.updateOne(
          { _id: local._id },
          { $set: { providerPaymentId: remote.id, providerStatus: remote.status } },
        );
        attempt.paymentId = local._id;
        attempt.status = 'pending';
        await attempt.save();
        this.logger.info({ event: 'renewal.started', subscriptionId: sub.id });
      } catch (error) {
        attempt.status = 'failed';
        attempt.lastError = String(error);
        await attempt.save();
        sub.status = 'past_due';
        sub.graceUntil = sub.graceUntil ?? addGrace(new Date(), this.env.GRACE_PERIOD_DAYS);
        sub.nextPaymentAt = new Date(
          Date.now() + this.env.RENEWAL_RETRY_OFFSETS_HOURS[0]! * 3_600_000,
        );
        await sub.save();
        await this.sendOnce(
          sub,
          'renewal_failed',
          '⚠️ Не получилось продлить подписку. Доступ пока остаётся активным. Пожалуйста, проверь способ оплаты ❤️',
        );
      }
    }
  }
  private async expirations() {
    const subs = await SubscriptionModel.find(expiringFilter());
    for (const sub of subs) {
      sub.status = 'expired';
      sub.autoRenew = false;
      sub.nextPaymentAt = null;
      await sub.save();
      const user = await UserModel.findById(sub.userId);
      if (user) {
        await this.channel
          .removeMember(user.telegramId)
          .catch((error) =>
            this.logger.error({ event: 'member.remove_failed', err: error, userId: user.id }),
          );
        await this.sendOnce(
          sub,
          'subscription_expired',
          '💔 Подписка приостановлена. Доступ к закрытому каналу временно закрыт. Ты всегда можешь вернуться ❤️',
        );
      }
      this.logger.info({ event: 'subscription.expired', subscriptionId: sub.id });
    }
  }
}
