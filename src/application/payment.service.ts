import mongoose from 'mongoose';
import type { Logger } from 'pino';
import { subscriptionTerms, type Plan, type PlanId } from '../config/plans.js';
import { calculatePeriod, addGrace } from '../domain/subscription/period.js';
import {
  CheckoutModel,
  NotificationModel,
  PaymentModel,
  PaymentReturnSessionModel,
  PurchaseIntentModel,
  RenewalModel,
  SubscriptionModel,
  UserModel,
} from '../infrastructure/db/models.js';
import type { PaymentGateway } from '../infrastructure/payments/payment-gateway.js';
import { NotFoundError, PaymentError, TransientExternalServiceError } from '../shared/errors.js';
import { hashToken, RETURN_TOKEN_PATTERN } from '../shared/utils.js';
export type ReturnPaymentResult =
  | { status: 'pending' }
  | { status: 'canceled' }
  | {
      status: 'succeeded';
      planTitle: string;
      amountMinor: number;
      currentPeriodEnd: Date | null;
      autoRenew: boolean;
      lifetime: boolean;
    };
export type ProcessPaymentResult =
  | { status: 'pending' | 'canceled' }
  | {
      status: 'succeeded';
      notification?: {
        subscriptionId: mongoose.Types.ObjectId;
        telegramId: number;
        planTitle: string;
        amountMinor: number;
        currentPeriodEnd: Date | null;
        autoRenew: boolean;
        lifetime: boolean;
        paymentUiMessageId?: number;
        processingUiMessageId?: number;
      };
    };
export interface PaymentUiTarget {
  telegramId: number;
  processingUiMessageId?: number;
}
export interface ExpectedPaymentData {
  providerPaymentId: string;
  internalPaymentId: string;
  checkoutSessionId: string;
  planId: string;
  amountMinor: number;
  currency: string;
}
export function assertVerifiedPayment(
  remote: Awaited<ReturnType<PaymentGateway['getPayment']>>,
  expected: ExpectedPaymentData,
  plan: Plan | undefined,
): asserts plan is Plan {
  if (
    remote.id !== expected.providerPaymentId ||
    !plan ||
    remote.amountMinor !== expected.amountMinor ||
    remote.amountMinor !== plan.amountMinor ||
    remote.currency !== expected.currency ||
    remote.metadata.internalPaymentId !== expected.internalPaymentId ||
    remote.metadata.planId !== expected.planId ||
    remote.metadata.checkoutSessionId !== expected.checkoutSessionId
  )
    throw new PaymentError('Verified payment data mismatch');
}
export class PaymentService {
  constructor(
    private readonly gateway: PaymentGateway,
    private readonly plans: ReadonlyMap<PlanId, Plan>,
    private readonly claimTtlMinutes: number,
    private readonly gracePeriodDays: number,
    private readonly logger: Logger,
    private readonly tokenSecret: string,
  ) {}
  async prepareReturn(rawToken: string, botUsername: string) {
    if (!RETURN_TOKEN_PATTERN.test(rawToken)) return null;
    const returnSession = await PaymentReturnSessionModel.findOne({
      returnTokenHash: hashToken(rawToken, this.tokenSecret),
      expiresAt: { $gt: new Date() },
    });
    if (!returnSession) return null;
    const existingPayment = await PaymentModel.findById(returnSession.paymentId);
    if (
      !existingPayment ||
      existingPayment.internalId !== returnSession.internalPaymentId ||
      !existingPayment.providerPaymentId
    )
      throw new PaymentError('Payment return binding mismatch');
    const user = existingPayment.userId ? await UserModel.findById(existingPayment.userId) : null;
    const payment = user
      ? await PaymentModel.findOneAndUpdate(
          { _id: returnSession.paymentId, processingNotificationSentAt: null, status: 'pending' },
          { $set: { processingNotificationSentAt: new Date() } },
          { new: true },
        )
      : null;
    return {
      redirect: `https://t.me/${botUsername}`,
      providerPaymentId: existingPayment.providerPaymentId,
      ...(payment && user
        ? {
            processing: {
              providerPaymentId: payment.providerPaymentId,
              telegramId: user.telegramId,
            },
          }
        : {}),
    };
  }
  async saveProcessingUi(providerPaymentId: string | null | undefined, messageId: number) {
    if (!providerPaymentId) return false;
    const saved = await PaymentModel.updateOne(
      { providerPaymentId, status: 'pending' },
      { $set: { processingUiMessageId: messageId } },
    );
    return saved.modifiedCount === 1;
  }
  async releaseProcessingNotification(providerPaymentId: string | null | undefined) {
    if (providerPaymentId)
      await PaymentModel.updateOne(
        { providerPaymentId },
        { $unset: { processingNotificationSentAt: 1, processingUiMessageId: 1 } },
      );
  }
  async getReturnRedirect(rawToken: string, botUsername: string) {
    const result = await this.handleReturn(rawToken);
    if (!result) return null;
    return {
      redirect: `https://t.me/${botUsername}`,
      providerPaymentId: result.providerPaymentId,
      result: result.result,
    };
  }
  async handleReturn(rawToken: string): Promise<{
    providerPaymentId: string;
    result: ProcessPaymentResult & { notificationKey?: string };
  } | null> {
    if (!RETURN_TOKEN_PATTERN.test(rawToken)) return null;
    const returnSession = await PaymentReturnSessionModel.findOne({
      returnTokenHash: hashToken(rawToken, this.tokenSecret),
      expiresAt: { $gt: new Date() },
    });
    if (!returnSession) return null;
    const payment = await PaymentModel.findById(returnSession.paymentId);
    if (
      !payment ||
      payment.internalId !== returnSession.internalPaymentId ||
      !payment.providerPaymentId
    )
      throw new PaymentError('Payment return binding mismatch');
    const result = await this.processProviderPayment(payment.providerPaymentId);
    if (result.status === 'succeeded') {
      await PaymentReturnSessionModel.updateOne(
        { _id: returnSession._id, consumedAt: null },
        { $set: { consumedAt: new Date() } },
      );
    }
    return {
      providerPaymentId: payment.providerPaymentId,
      result: await this.claimSuccessNotification(payment.providerPaymentId, result),
    };
  }
  async verifyDuePayments(now = new Date()) {
    const due = await PaymentModel.find({
      status: 'pending',
      verificationPending: true,
      nextVerificationAt: { $lte: now },
    }).select({ providerPaymentId: 1 }).limit(100);
    const results: Array<{
      providerPaymentId: string;
      result: ProcessPaymentResult & { notificationKey?: string };
      delayedUiTarget?: PaymentUiTarget;
    }> = [];
    for (const payment of due) {
      if (!payment.providerPaymentId) continue;
      const claimed = await PaymentModel.findOneAndUpdate(
        {
          _id: payment._id,
          status: 'pending',
          verificationPending: true,
          nextVerificationAt: { $lte: now },
        },
        { $set: { nextVerificationAt: new Date(now.getTime() + 60_000) } },
      );
      if (!claimed) continue;
      const processed = await this.processProviderPayment(payment.providerPaymentId);
      let delayedUiTarget: PaymentUiTarget | undefined;
      if (processed.status === 'pending') {
        const delayed = await PaymentModel.findOneAndUpdate(
          { _id: payment._id, status: 'pending', verificationPending: true,
            verificationNoticeSentAt: null,
            verificationStartedAt: { $lte: new Date(now.getTime() - 60_000) } },
          { $set: { verificationNoticeSentAt: now } },
          { new: true },
        );
        if (delayed?.processingUiMessageId) {
          const user = delayed.userId ? await UserModel.findById(delayed.userId) : null;
          if (user) delayedUiTarget = { telegramId: user.telegramId,
            processingUiMessageId: delayed.processingUiMessageId };
        }
      }
      results.push({
        providerPaymentId: payment.providerPaymentId,
        result: await this.claimSuccessNotification(payment.providerPaymentId, processed),
        ...(delayedUiTarget ? { delayedUiTarget } : {}),
      });
    }
    return results;
  }
  async checkReturnedPayment(rawToken: string, telegramId: number): Promise<ReturnPaymentResult> {
    if (!RETURN_TOKEN_PATTERN.test(rawToken))
      throw new NotFoundError('Ссылка оплаты недействительна');
    const tokenHash = hashToken(rawToken, this.tokenSecret);
    const returnSession = await PaymentReturnSessionModel.findOne({
      returnTokenHash: tokenHash,
      expiresAt: { $gt: new Date() },
    });
    if (!returnSession) throw new NotFoundError('Ссылка оплаты недействительна или истекла');
    const payment = await PaymentModel.findById(returnSession.paymentId);
    if (
      !payment ||
      payment.internalId !== returnSession.internalPaymentId ||
      !payment.providerPaymentId
    )
      throw new PaymentError('Payment return binding mismatch');
    const user = await UserModel.findOne({ telegramId });
    if (!user || String(payment.userId) !== String(user._id))
      throw new PaymentError('Payment owner mismatch');
    const result = await this.processProviderPayment(payment.providerPaymentId);
    if (result.status === 'succeeded') {
      await PaymentReturnSessionModel.updateOne(
        { _id: returnSession._id, consumedAt: null },
        { $set: { consumedAt: new Date() } },
      );
    }
    if (result.status !== 'succeeded') return result;
    if (!result.notification) throw new PaymentError('Successful payment has no subscription');
    this.logger.info({ event: 'payment.return.succeeded', paymentId: payment.internalId });
    return { status: 'succeeded', ...result.notification };
  }
  async handleWebhook(payload: unknown) {
    const event = this.gateway.normalizeWebhookEvent(payload);
    if (event.type === 'ignored' || event.type === 'refund') return { handled: false };
    const processed = await this.processProviderPayment(event.providerPaymentId, event.type);
    const result = await this.claimSuccessNotification(event.providerPaymentId, processed);
    if (result.status === 'canceled')
      return {
        handled: true,
        providerPaymentId: event.providerPaymentId,
        status: 'canceled' as const,
        uiTarget: await this.getPaymentUiTarget(event.providerPaymentId),
      };
    if (result.status !== 'succeeded' || !result.notification) return { handled: true };
    return {
      handled: true,
      providerPaymentId: event.providerPaymentId,
      notification: result.notification,
      notificationKey: result.notificationKey,
    };
  }
  async releaseSuccessNotification(providerPaymentId: string, notificationKey?: string) {
    await PaymentModel.updateOne(
      { providerPaymentId },
      { $unset: { successNotificationSentAt: 1 } },
    );
    if (notificationKey)
      await NotificationModel.deleteOne({ dedupKey: notificationKey, sentAt: null });
  }
  async markSuccessNotificationSent(notificationKey: string) {
    await NotificationModel.updateOne(
      { dedupKey: notificationKey },
      { $set: { sentAt: new Date() }, $unset: { error: 1 } },
    );
  }
  async getUiDeliveryState(providerPaymentId: string) {
    return PaymentModel.findOne({ providerPaymentId })
      .select({ successUiSentAt: 1, accessNotificationSentAt: 1 })
      .lean();
  }
  async getPaymentUiTarget(providerPaymentId: string): Promise<PaymentUiTarget | null> {
    const payment = await PaymentModel.findOne({ providerPaymentId });
    const user = payment?.userId ? await UserModel.findById(payment.userId) : null;
    if (!payment || !user) return null;
    return {
      telegramId: user.telegramId,
      ...(payment.processingUiMessageId
        ? { processingUiMessageId: payment.processingUiMessageId }
        : {}),
    };
  }
  async markSuccessUiSent(providerPaymentId: string) {
    await PaymentModel.updateOne({ providerPaymentId }, { $set: { successUiSentAt: new Date() } });
  }
  async markAccessNotificationSent(providerPaymentId: string) {
    await PaymentModel.updateOne(
      { providerPaymentId },
      { $set: { accessNotificationSentAt: new Date() } },
    );
  }
  private async claimSuccessNotification(
    providerPaymentId: string,
    result: ProcessPaymentResult,
  ): Promise<ProcessPaymentResult & { notificationKey?: string }> {
    if (result.status !== 'succeeded' || !result.notification) return result;
    const payment = await PaymentModel.findOneAndUpdate(
      { providerPaymentId, successNotificationSentAt: null },
      { $set: { successNotificationSentAt: new Date() } },
    );
    if (!payment) return { status: 'succeeded' };
    const notificationKey = `payment:${payment.internalId}:succeeded`;
    try {
      await NotificationModel.create({
        subscriptionId: result.notification.subscriptionId,
        periodEnd: result.notification.currentPeriodEnd,
        type: 'payment_succeeded',
        dedupKey: notificationKey,
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: number }).code === 11000
      )
        return { status: 'succeeded' };
      await this.releaseSuccessNotification(providerPaymentId);
      throw error;
    }
    return { ...result, notificationKey };
  }
  private async processProviderPayment(
    providerPaymentId: string,
    eventType?: string,
  ): Promise<ProcessPaymentResult> {
    this.logger.info({ event: 'payment.verification.started', providerPaymentId });
    let remote: Awaited<ReturnType<PaymentGateway['getPayment']>>;
    try {
      remote = await this.gateway.getPayment(providerPaymentId);
    } catch (error) {
      if (!(error instanceof TransientExternalServiceError)) throw error;
      const payment = await PaymentModel.findOne({ providerPaymentId });
      if (!payment || payment.status !== 'pending') return { status: 'pending' };
      const startedAt = payment.verificationStartedAt ?? new Date();
      const elapsed = Date.now() - startedAt.getTime();
      if (elapsed >= 6 * 60 * 60_000) {
        await PaymentModel.updateOne(
          { _id: payment._id, status: 'pending' },
          { $set: { verificationPending: false }, $unset: { nextVerificationAt: 1 } },
        );
        this.logger.warn({ event: 'payment.verification.exhausted', paymentId: payment.internalId });
        return { status: 'pending' };
      }
      const attempt = (payment.verificationAttempts ?? 0) + 1;
      const offsets = [10, 30, 60, 120, 300];
      const delaySeconds = offsets[Math.min(attempt - 1, offsets.length - 1)]!;
      const nextVerificationAt = new Date(Date.now() + delaySeconds * 1_000);
      await PaymentModel.updateOne(
        { _id: payment._id, status: 'pending' },
        {
          $set: { verificationPending: true, verificationStartedAt: startedAt, nextVerificationAt },
          $inc: { verificationAttempts: 1 },
        },
      );
      this.logger.warn({ event: 'payment.verification.transient_error', paymentId: payment.internalId, err: error });
      this.logger.info({ event: 'payment.verification.retry_scheduled', paymentId: payment.internalId, nextVerificationAt });
      return { status: 'pending' };
    }
    const payment = await PaymentModel.findOne({ providerPaymentId: remote.id });
    if (!payment) throw new NotFoundError('Unknown provider payment');
    const plan = this.plans.get(payment.planId as PlanId);
    assertVerifiedPayment(
      remote,
      {
        providerPaymentId,
        internalPaymentId: payment.internalId,
        checkoutSessionId: String(payment.checkoutSessionId),
        planId: payment.planId,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
      },
      plan,
    );
    if (remote.status === 'pending' || remote.status === 'waiting_for_capture') {
      const verificationStartedAt = payment.verificationStartedAt ?? new Date();
      if (Date.now() - verificationStartedAt.getTime() >= 6 * 60 * 60_000) {
        await PaymentModel.updateOne(
          { _id: payment._id, status: 'pending' },
          { $set: { verificationPending: false, providerStatus: remote.status }, $unset: { nextVerificationAt: 1 } },
        );
        this.logger.warn({ event: 'payment.verification.exhausted', paymentId: payment.internalId });
        return { status: 'pending' };
      }
      const attempt = (payment.verificationAttempts ?? 0) + 1;
      const offsets = [10, 30, 60, 120, 300];
      const nextVerificationAt = new Date(
        Date.now() + offsets[Math.min(attempt - 1, offsets.length - 1)]! * 1_000,
      );
      await PaymentModel.updateOne(
        { _id: payment._id, status: 'pending' },
        {
          $set: {
            verificationPending: true,
            verificationStartedAt,
            nextVerificationAt,
            providerStatus: remote.status,
          },
          $inc: { verificationAttempts: 1 },
        },
      );
      this.logger.info({ event: 'payment.verification.retry_scheduled', paymentId: payment.internalId, nextVerificationAt });
      return { status: 'pending' as const };
    }
    await PaymentModel.updateOne(
      { _id: payment._id },
      { $set: { verificationPending: false, providerStatus: remote.status }, $unset: { nextVerificationAt: 1 } },
    );
    if (eventType === 'canceled' || !remote.paid || remote.status !== 'succeeded') {
      await PaymentModel.updateOne(
        { _id: payment._id, status: { $ne: 'succeeded' } },
        { $set: { status: 'canceled', providerStatus: remote.status } },
      );
      await CheckoutModel.updateOne(
        { _id: payment.checkoutSessionId, status: { $in: ['created', 'payment_pending'] } },
        { $set: { status: 'canceled' }, $unset: { activeCheckoutKey: 1 } },
      );
      if (payment.type === 'renewal' && payment.subscriptionId) {
        await SubscriptionModel.updateOne(
          { _id: payment.subscriptionId, status: { $ne: 'expired' } },
          {
            $set: {
              status: 'past_due',
              graceUntil: addGrace(new Date(), this.gracePeriodDays),
            },
          },
        );
        await RenewalModel.updateOne(
          { paymentId: payment._id, status: { $ne: 'succeeded' } },
          { $set: { status: 'failed', lastError: remote.status } },
        );
      }
      this.logger.warn({ event: 'payment.verification.canceled', paymentId: payment.internalId });
      return { status: 'canceled' as const };
    }
    const alreadySucceeded = payment.status === 'succeeded';
    this.logger.info({ event: 'payment.verification.succeeded', paymentId: payment.internalId });
    if (alreadySucceeded && payment.type === 'renewal') return { status: 'succeeded' as const };
    const now = remote.paidAt ?? new Date();
    const claimed = alreadySucceeded
      ? payment
      : await PaymentModel.findOneAndUpdate(
          { _id: payment._id, status: { $ne: 'succeeded' } },
          {
            $set: {
              status: 'succeeded',
              providerStatus: remote.status,
              paidAt: now,
              ...(remote.paymentMethod?.saved ? { paymentMethodId: remote.paymentMethod.id } : {}),
            },
          },
          { new: true },
        );
    // A concurrent webhook/return request may have claimed this payment first.
    // Read the activated subscription so this request can render the same success state.
    if (!claimed) {
      const currentPayment = await PaymentModel.findById(payment._id);
      const [subscription, user] = await Promise.all([
        currentPayment?.subscriptionId
          ? SubscriptionModel.findById(currentPayment.subscriptionId)
          : null,
        UserModel.findById(payment.userId),
      ]);
      if (subscription && user)
        return {
          status: 'succeeded',
          notification: {
            subscriptionId: subscription._id,
            telegramId: user.telegramId,
            planTitle: plan.title,
            amountMinor: plan.amountMinor,
            currentPeriodEnd: subscription.currentPeriodEnd ?? null,
            autoRenew: subscription.autoRenew,
            lifetime: subscription.lifetime,
            ...(currentPayment?.paymentUiMessageId
              ? { paymentUiMessageId: currentPayment.paymentUiMessageId }
              : {}),
            ...(currentPayment?.processingUiMessageId
              ? { processingUiMessageId: currentPayment.processingUiMessageId }
              : {}),
          },
        };
      return { status: 'succeeded' as const };
    }
    if (payment.type === 'renewal' && payment.subscriptionId) {
      const subscription = await SubscriptionModel.findById(payment.subscriptionId);
      if (!subscription) throw new NotFoundError('Renewal subscription not found');
      if (plan.renewalPeriodMonths === null || subscription.lifetime)
        throw new PaymentError('Lifetime subscription cannot be renewed');
      if (!subscription.currentPeriodEnd) throw new PaymentError('Renewal period is missing');
      const period = calculatePeriod(now, plan.renewalPeriodMonths, subscription.currentPeriodEnd);
      await SubscriptionModel.updateOne(
        { _id: subscription._id, currentPeriodEnd: subscription.currentPeriodEnd },
        {
          $set: {
            status: 'active',
            currentPeriodStart: period.start,
            currentPeriodEnd: period.end,
            nextPaymentAt: period.end,
            lastSuccessfulPaymentAt: now,
          },
          $unset: { graceUntil: 1 },
        },
      );
      await RenewalModel.updateOne({ paymentId: payment._id }, { $set: { status: 'succeeded' } });
      const subscriptionId = String(subscription._id);
      this.logger.info({ event: 'subscription.renewed', subscriptionId });
      return { status: 'succeeded' };
    }
    if (!payment.userId) {
      // Compatibility for checkout sessions created before Telegram-native checkout.
      await CheckoutModel.updateOne(
        { _id: payment.checkoutSessionId, status: 'payment_pending' },
        {
          $set: {
            status: 'paid',
            claimExpiresAt: new Date(now.getTime() + this.claimTtlMinutes * 60_000),
          },
        },
      );
      this.logger.info({ event: 'payment.succeeded', paymentId: payment.internalId });
      return { status: 'succeeded' };
    }
    const activated = await mongoose.connection.transaction(async (session) => {
      const currentPayment = await PaymentModel.findById(payment._id).session(session);
      if (!currentPayment) throw new NotFoundError('Payment not found');
      if (currentPayment.subscriptionId) return null;
      const user = await UserModel.findById(currentPayment.userId).session(session);
      if (!user) throw new NotFoundError('Payment user not found');
      let subscription = await SubscriptionModel.findOne({ userId: user._id }).session(session);
      const checkout = await CheckoutModel.findById(currentPayment.checkoutSessionId).session(
        session,
      );
      if (!checkout) throw new NotFoundError('Payment checkout not found');
      const terms = subscriptionTerms(
        plan,
        now,
        subscription?.currentPeriodEnd ?? undefined,
        Boolean(currentPayment.paymentMethodId),
        Boolean(checkout.autoRenewAcceptedAt),
      );
      const autoRenew = terms.autoRenew;
      if (subscription) {
        subscription.set({
          planId: plan.id,
          status: 'active',
          currentPeriodStart: terms.currentPeriodStart,
          currentPeriodEnd: terms.currentPeriodEnd,
          lifetime: terms.lifetime,
          autoRenew,
          paymentMethodId: currentPayment.paymentMethodId,
          nextPaymentAt: terms.nextPaymentAt ?? undefined,
          graceUntil: undefined,
          cancelAtPeriodEnd: false,
          lastSuccessfulPaymentAt: now,
        });
        await subscription.save({ session });
      } else {
        const [created] = await SubscriptionModel.create(
          [
            {
              userId: user._id,
              planId: plan.id,
              status: 'active',
              startedAt: now,
              currentPeriodStart: terms.currentPeriodStart,
              currentPeriodEnd: terms.currentPeriodEnd,
              lifetime: terms.lifetime,
              autoRenew,
              paymentMethodId: currentPayment.paymentMethodId,
              nextPaymentAt: terms.nextPaymentAt ?? undefined,
              cancelAtPeriodEnd: false,
              lastSuccessfulPaymentAt: now,
            },
          ],
          { session },
        );
        if (!created) throw new PaymentError('Could not activate subscription');
        subscription = created;
      }
      if (!subscription) throw new PaymentError('Could not activate subscription');
      currentPayment.subscriptionId = subscription._id;
      await currentPayment.save({ session });
      await CheckoutModel.updateOne(
        { _id: currentPayment.checkoutSessionId },
        {
          $set: { status: 'claimed', claimedByUserId: user._id, claimedAt: now },
          $unset: { activeCheckoutKey: 1 },
        },
        { session },
      );
      await PurchaseIntentModel.updateMany(
        { paymentId: currentPayment._id, status: { $ne: 'paid' } },
        { $set: { status: 'paid', lastActivityAt: now } },
        { session },
      );
      return {
        subscriptionId: subscription._id,
        telegramId: user.telegramId,
        planTitle: plan.title,
        amountMinor: plan.amountMinor,
        currentPeriodEnd: subscription.currentPeriodEnd ?? null,
        autoRenew: subscription.autoRenew,
        lifetime: subscription.lifetime,
        ...(currentPayment.paymentUiMessageId
          ? { paymentUiMessageId: currentPayment.paymentUiMessageId }
          : {}),
        ...(currentPayment.processingUiMessageId
          ? { processingUiMessageId: currentPayment.processingUiMessageId }
          : {}),
      };
    });
    this.logger.info({ event: 'payment.succeeded', paymentId: payment.internalId });
    this.logger.info({ event: 'purchase_intent.completed', paymentId: payment.internalId });
    if (plan.lifetime && activated)
      this.logger.info({
        event: 'subscription.lifetime_activated',
        subscriptionId: String(activated.subscriptionId),
      });
    let notification = activated;
    if (!notification) {
      const currentPayment = await PaymentModel.findById(payment._id);
      const [subscription, user] = await Promise.all([
        currentPayment?.subscriptionId
          ? SubscriptionModel.findById(currentPayment.subscriptionId)
          : null,
        UserModel.findById(payment.userId),
      ]);
      if (subscription && user)
        notification = {
          subscriptionId: subscription._id,
          telegramId: user.telegramId,
          planTitle: plan.title,
          amountMinor: plan.amountMinor,
          currentPeriodEnd: subscription.currentPeriodEnd ?? null,
          autoRenew: subscription.autoRenew,
          lifetime: subscription.lifetime,
          ...(currentPayment?.paymentUiMessageId
            ? { paymentUiMessageId: currentPayment.paymentUiMessageId }
            : {}),
          ...(currentPayment?.processingUiMessageId
            ? { processingUiMessageId: currentPayment.processingUiMessageId }
            : {}),
        };
    }
    return { status: 'succeeded', ...(notification ? { notification } : {}) };
  }
}
