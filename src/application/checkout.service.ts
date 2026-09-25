import mongoose from 'mongoose';
import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import { subscriptionTerms, type Plan, type PlanId } from '../config/plans.js';
import {
  CheckoutModel,
  PaymentModel,
  PaymentReturnSessionModel,
  PurchaseIntentModel,
  SubscriptionModel,
  UserModel,
} from '../infrastructure/db/models.js';
import type { PaymentGateway } from '../infrastructure/payments/payment-gateway.js';
import { ConflictError, NotFoundError, PaymentError, ValidationError } from '../shared/errors.js';
import { hashToken, newId, newToken } from '../shared/utils.js';
export class CheckoutService {
  private readonly inFlight = new Map<
    string,
    Promise<{ publicId: string; confirmationUrl: string }>
  >();
  constructor(
    private readonly env: Env,
    private readonly plans: ReadonlyMap<PlanId, Plan>,
    private readonly gateway: PaymentGateway,
    private readonly logger: Logger,
  ) {}
  create(
    planId: PlanId,
    userId: mongoose.Types.ObjectId,
    consent: {
      offer: boolean;
      privacy: boolean;
      personalDataConsentAcceptedAt?: Date;
      personalDataConsentUrl?: string;
      autoRenew: boolean;
      ip?: string;
      userAgent?: string;
    },
  ) {
    const key = `${String(userId)}:${planId}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const operation = this.createUnlocked(planId, userId, consent).finally(() =>
      this.inFlight.delete(key),
    );
    this.inFlight.set(key, operation);
    return operation;
  }

  private async createUnlocked(
    planId: PlanId,
    userId: mongoose.Types.ObjectId,
    consent: {
      offer: boolean;
      privacy: boolean;
      personalDataConsentAcceptedAt?: Date;
      personalDataConsentUrl?: string;
      autoRenew: boolean;
      ip?: string;
      userAgent?: string;
    },
  ) {
    const plan = this.plans.get(planId);
    if (!plan?.enabled) throw new ValidationError('Тариф недоступен');
    if (!consent.offer || !consent.privacy || (plan.autoRenewSupported && !consent.autoRenew))
      throw new ValidationError('Необходимо принять все условия');
    const now = new Date();
    const activeCheckoutKey = `initial:${String(userId)}:${planId}`;
    const freshAfter = new Date(now.getTime() - this.env.CLAIM_TOKEN_TTL_MINUTES * 60_000);
    await CheckoutModel.updateMany(
      {
        activeCheckoutKey,
        status: { $in: ['created', 'payment_pending'] },
        createdAt: { $lte: freshAfter },
      },
      { $set: { status: 'expired' }, $unset: { activeCheckoutKey: 1 } },
    );
    const existing = await CheckoutModel.findOne({
      activeCheckoutKey,
      status: { $in: ['created', 'payment_pending'] },
      createdAt: { $gt: freshAfter },
    });
    if (existing?.confirmationUrl)
      return { publicId: existing.publicId, confirmationUrl: existing.confirmationUrl };
    const publicId = newId();
    let checkout;
    try {
      checkout = await CheckoutModel.create({
        publicId,
        userId,
        planId,
        amountMinor: plan.amountMinor,
        currency: plan.currency,
        status: 'created',
        activeCheckoutKey,
        offerVersion: this.env.OFFER_VERSION,
        offerAcceptedAt: now,
        privacyAcceptedAt: now,
        personalDataConsentAcceptedAt: consent.personalDataConsentAcceptedAt,
        personalDataConsentUrl: consent.personalDataConsentUrl,
        ...(plan.autoRenewSupported ? { autoRenewAcceptedAt: now } : {}),
        ip: consent.ip,
        userAgent: consent.userAgent,
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: number }).code === 11000
      ) {
        let concurrent = await CheckoutModel.findOne({ activeCheckoutKey });
        // The winner may still be waiting for YooKassa. Briefly poll the local record only.
        for (
          let attempt = 0;
          concurrent && !concurrent.confirmationUrl && attempt < 20;
          attempt++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          concurrent = await CheckoutModel.findOne({ activeCheckoutKey });
        }
        if (concurrent?.confirmationUrl)
          return { publicId: concurrent.publicId, confirmationUrl: concurrent.confirmationUrl };
        throw new ConflictError('Платёж уже создаётся. Попробуйте ещё раз через несколько секунд.');
      }
      throw error;
    }
    const internalId = newId(),
      idempotenceKey = `initial:${internalId}`;
    const payment = await PaymentModel.create({
      internalId,
      userId,
      checkoutSessionId: checkout._id,
      provider: 'yookassa',
      idempotenceKey,
      type: 'initial',
      planId,
      amountMinor: plan.amountMinor,
      currency: plan.currency,
      status: 'pending',
    });
    try {
      const [user, purchaseIntent] = await Promise.all([
        UserModel.findById(userId).select({ telegramId: 1 }).lean(),
        PurchaseIntentModel.findOne({
          userId,
          planId,
          status: { $in: ['browsing', 'payment_created'] },
        })
          .sort({ createdAt: -1 })
          .select({ _id: 1 })
          .lean(),
      ]);
      if (!user) throw new NotFoundError('Payment user not found');
      const returnToken = newToken();
      await PaymentReturnSessionModel.create({
        paymentId: payment._id,
        internalPaymentId: internalId,
        returnTokenHash: hashToken(returnToken, this.env.CHECKOUT_SECRET),
        expiresAt: new Date(now.getTime() + this.env.CLAIM_TOKEN_TTL_MINUTES * 60_000),
      });
      const returnUrl = new URL('/payment/return', this.env.APP_BASE_URL);
      returnUrl.searchParams.set('token', returnToken);
      const provider = await this.gateway.createInitialPayment({
        idempotenceKey,
        amountMinor: plan.amountMinor,
        currency: 'RUB',
        description: `${this.env.PROJECT_NAME}: ${plan.title}`,
        returnUrl: returnUrl.toString(),
        // savePaymentMethod: plan.autoRenewSupported,
        savePaymentMethod: false,

        metadata: {
          paymentId: internalId,
          checkoutSessionId: String(checkout._id),
          planId,
          planCode: planId,
          internalPaymentId: internalId,
          userId: String(userId),
          telegramId: String(user.telegramId),
          ...(purchaseIntent ? { purchaseIntentId: String(purchaseIntent._id) } : {}),
        },
      });
      await PaymentModel.updateOne(
        { _id: payment._id },
        { $set: { providerPaymentId: provider.id, providerStatus: provider.status } },
      );
      await CheckoutModel.updateOne(
        { _id: checkout._id },
        {
          $set: {
            status: 'payment_pending',
            providerPaymentId: provider.id,
            internalPaymentId: internalId,
            confirmationUrl: provider.confirmationUrl,
          },
        },
      );
      if (!provider.confirmationUrl)
        throw new PaymentError('Provider did not return confirmation URL');
      this.logger.info({ event: 'checkout.created', checkoutId: publicId, paymentId: internalId });
      return { publicId, confirmationUrl: provider.confirmationUrl };
    } catch (error) {
      await PaymentModel.updateOne({ _id: payment._id }, { $set: { status: 'failed' } });
      await CheckoutModel.updateOne({ _id: checkout._id }, { $unset: { activeCheckoutKey: 1 } });
      throw error;
    }
  }

  async savePaymentUiMessage(publicId: string, messageId: number) {
    const checkout = await CheckoutModel.findOne({ publicId });
    if (!checkout?.internalPaymentId) return;
    await PaymentModel.updateOne(
      { internalId: checkout.internalPaymentId },
      { $set: { paymentUiMessageId: messageId } },
    );
  }
  async getPublic(publicId: string) {
    const c = await CheckoutModel.findOne({ publicId }).lean();
    if (!c) throw new NotFoundError('Checkout не найден');
    return c;
  }
  async getClaimLink(publicId: string, rawToken: string) {
    const checkout = await CheckoutModel.findOne({
      publicId,
      claimTokenHash: hashToken(rawToken, this.env.CHECKOUT_SECRET),
      status: 'paid',
      claimExpiresAt: { $gt: new Date() },
    }).lean();
    if (!checkout) throw new ConflictError('Платёж ещё не подтверждён или ссылка истекла');
    return `https://t.me/${this.env.BOT_USERNAME}?start=claim_${rawToken}`;
  }
  async claim(
    rawToken: string,
    tg: {
      telegramId: number;
      username?: string;
      firstName: string;
      lastName?: string;
      languageCode?: string;
    },
  ) {
    const tokenHash = hashToken(rawToken, this.env.CHECKOUT_SECRET);
    return mongoose.connection.transaction(async (session) => {
      const now = new Date();
      const checkout = await CheckoutModel.findOneAndUpdate(
        {
          claimTokenHash: tokenHash,
          status: 'paid',
          claimExpiresAt: { $gt: now },
          claimedByUserId: null,
        },
        { $set: { status: 'claimed', claimedAt: now } },
        { new: true, session },
      );
      if (!checkout)
        throw new ConflictError('Ссылка недействительна, истекла или уже использована');
      const user = await UserModel.findOneAndUpdate(
        { telegramId: tg.telegramId },
        { $set: { ...tg }, $setOnInsert: { onboardingSeenAt: now } },
        { upsert: true, new: true, session },
      );
      checkout.claimedByUserId = user._id;
      await checkout.save({ session });
      const payment = await PaymentModel.findOneAndUpdate(
        { checkoutSessionId: checkout._id, status: 'succeeded', userId: null },
        { $set: { userId: user._id } },
        { new: true, session },
      );
      if (!payment) throw new ConflictError('Платёж уже привязан');
      const plan = this.plans.get(checkout.planId as PlanId);
      if (!plan) throw new NotFoundError('Тариф не найден');
      let subscription = await SubscriptionModel.findOne({ userId: user._id }).session(session);
      const previousEnd = subscription?.currentPeriodEnd ?? undefined;
      const terms = subscriptionTerms(
        plan,
        now,
        previousEnd,
        Boolean(payment.paymentMethodId),
        true,
      );
      if (subscription) {
        subscription.set({
          planId: plan.id,
          status: 'active',
          currentPeriodStart: terms.currentPeriodStart,
          currentPeriodEnd: terms.currentPeriodEnd,
          lifetime: terms.lifetime,
          autoRenew: terms.autoRenew,
          paymentMethodId: payment.paymentMethodId,
          nextPaymentAt: terms.nextPaymentAt ?? undefined,
          graceUntil: undefined,
          cancelAtPeriodEnd: false,
          lastSuccessfulPaymentAt: now,
        });
        await subscription.save({ session });
      } else {
        subscription = await SubscriptionModel.create(
          [
            {
              userId: user._id,
              planId: plan.id,
              status: 'active',
              startedAt: now,
              currentPeriodStart: terms.currentPeriodStart,
              currentPeriodEnd: terms.currentPeriodEnd,
              lifetime: terms.lifetime,
              autoRenew: terms.autoRenew,
              paymentMethodId: payment.paymentMethodId,
              nextPaymentAt: terms.nextPaymentAt ?? undefined,
              cancelAtPeriodEnd: false,
              lastSuccessfulPaymentAt: now,
            },
          ],
          { session },
        ).then(([v]) => v!);
      }
      if (!subscription) throw new ConflictError('Не удалось создать подписку');
      payment.subscriptionId = subscription._id;
      await payment.save({ session });
      this.logger.info({
        event: 'subscription.activated',
        subscriptionId: subscription.id,
        userId: user.id,
      });
      return { user, subscription, plan };
    });
  }
}
