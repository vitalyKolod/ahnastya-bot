import { Schema, model, type InferSchemaType } from 'mongoose';
import {
  checkoutStatuses,
  paymentStatuses,
  purchaseIntentStatuses,
  subscriptionStatuses,
} from '../../domain/types.js';

const opts = { timestamps: true, versionKey: false } as const;
const userSchema = new Schema(
  {
    telegramId: { type: Number, required: true, unique: true },
    username: String,
    firstName: { type: String, required: true },
    lastName: String,
    languageCode: String,
    onboardingSeenAt: Date,
    uiMessageId: Number,
  },
  opts,
);
const checkoutSchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    planId: { type: String, required: true },
    amountMinor: { type: Number, required: true },
    currency: { type: String, required: true },
    status: { type: String, enum: checkoutStatuses, required: true, index: true },
    offerVersion: { type: String, required: true },
    offerAcceptedAt: Date,
    privacyAcceptedAt: Date,
    autoRenewAcceptedAt: Date,
    ip: String,
    userAgent: String,
    providerPaymentId: String,
    internalPaymentId: String,
    claimTokenHash: { type: String, unique: true, sparse: true },
    claimExpiresAt: Date,
    claimedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    claimedAt: Date,
    activeCheckoutKey: { type: String, unique: true, sparse: true },
    confirmationUrl: String,
  },
  opts,
);
const purchaseIntentSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    telegramId: { type: Number, required: true, index: true },
    planId: String,
    status: { type: String, enum: purchaseIntentStatuses, required: true, index: true },
    startedAt: { type: Date, required: true },
    lastActivityAt: { type: Date, required: true },
    reminderDueAt: { type: Date, required: true, index: true },
    reminderSentAt: Date,
    reminderClaimedAt: Date,
    checkoutSessionId: { type: Schema.Types.ObjectId, ref: 'CheckoutSession' },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment' },
  },
  opts,
);
purchaseIntentSchema.index({ reminderDueAt: 1, reminderSentAt: 1, status: 1 });
purchaseIntentSchema.index({ userId: 1, createdAt: -1 });
checkoutSchema.index({ status: 1, createdAt: 1 });
checkoutSchema.index({ claimTokenHash: 1, status: 1 });
const paymentSchema = new Schema(
  {
    internalId: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    checkoutSessionId: { type: Schema.Types.ObjectId, ref: 'CheckoutSession', required: true },
    subscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription' },
    provider: { type: String, enum: ['yookassa'], required: true },
    providerPaymentId: { type: String, unique: true, sparse: true },
    idempotenceKey: { type: String, required: true, unique: true },
    type: { type: String, enum: ['initial', 'renewal', 'manual_renewal'], required: true },
    planId: { type: String, required: true },
    amountMinor: { type: Number, required: true },
    currency: { type: String, required: true },
    status: { type: String, enum: paymentStatuses, required: true, index: true },
    paymentMethodId: String,
    providerStatus: String,
    paidAt: Date,
    successNotificationSentAt: Date,
    successUiSentAt: Date,
    processingNotificationSentAt: Date,
    processingUiMessageId: Number,
    accessNotificationSentAt: Date,
    paymentUiMessageId: Number,
    verificationPending: { type: Boolean, default: false, index: true },
    verificationAttempts: { type: Number, default: 0 },
    verificationStartedAt: Date,
    nextVerificationAt: { type: Date, index: true },
    verificationNoticeSentAt: Date,
  },
  opts,
);
paymentSchema.index({ status: 1, verificationPending: 1, nextVerificationAt: 1 });
const paymentReturnSessionSchema = new Schema(
  {
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', required: true, unique: true },
    internalPaymentId: { type: String, required: true, unique: true },
    returnTokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    consumedAt: Date,
  },
  opts,
);
paymentReturnSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const subscriptionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    planId: { type: String, required: true },
    status: { type: String, enum: subscriptionStatuses, required: true, index: true },
    startedAt: { type: Date, required: true },
    currentPeriodStart: { type: Date, required: true },
    currentPeriodEnd: { type: Date, default: null, index: true },
    lifetime: { type: Boolean, required: true, default: false, index: true },
    autoRenew: { type: Boolean, required: true },
    paymentMethodId: String,
    nextPaymentAt: { type: Date, index: true },
    graceUntil: { type: Date, index: true },
    cancelAtPeriodEnd: { type: Boolean, required: true, default: false },
    cancelledAt: Date,
    lastSuccessfulPaymentAt: Date,
  },
  opts,
);
subscriptionSchema.index({ status: 1, nextPaymentAt: 1 });
subscriptionSchema.index({ status: 1, graceUntil: 1 });
const notificationSchema = new Schema(
  {
    subscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription', required: true },
    periodEnd: { type: Date, default: null },
    type: { type: String, required: true },
    dedupKey: { type: String, required: true, unique: true },
    sentAt: Date,
    error: String,
    attemptCount: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, index: true },
    deliveryClaimedUntil: Date,
  },
  opts,
);
notificationSchema.index({ type: 1, sentAt: 1, nextAttemptAt: 1 });
const renewalSchema = new Schema(
  {
    subscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription', required: true },
    cycle: { type: Date, required: true },
    attemptNumber: { type: Number, required: true, default: 0 },
    status: {
      type: String,
      enum: ['pending', 'processing', 'succeeded', 'failed'],
      required: true,
    },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment' },
    lastError: String,
    nextRetryAt: Date,
  },
  opts,
);
renewalSchema.index({ subscriptionId: 1, cycle: 1 }, { unique: true });
renewalSchema.index({ status: 1, nextRetryAt: 1 });
const inviteSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    subscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription', required: true },
    expectedTelegramId: { type: Number, required: true },
    inviteLink: { type: String, required: true },
    telegramInviteName: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true, index: true },
    revokedAt: Date,
    usedAt: Date,
  },
  opts,
);
inviteSchema.index({ userId: 1, createdAt: -1 });
const lockSchema = new Schema(
  {
    _id: { type: String, required: true },
    owner: { type: String, required: true },
    leaseUntil: { type: Date, required: true, index: true },
  },
  { versionKey: false },
);
const auditSchema = new Schema(
  {
    adminTelegramId: { type: Number, required: true },
    action: { type: String, required: true },
    targetId: String,
    details: { type: Schema.Types.Mixed },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false },
);
export const UserModel = model('User', userSchema);
export const CheckoutModel = model('CheckoutSession', checkoutSchema);
export const PurchaseIntentModel = model('PurchaseIntent', purchaseIntentSchema);
export const PaymentModel = model('Payment', paymentSchema);
export const PaymentReturnSessionModel = model('PaymentReturnSession', paymentReturnSessionSchema);
export const SubscriptionModel = model('Subscription', subscriptionSchema);
export const NotificationModel = model('NotificationLog', notificationSchema);
export const RenewalModel = model('RenewalAttempt', renewalSchema);
export const InviteModel = model('InviteLink', inviteSchema);
export const LockModel = model('DistributedLock', lockSchema);
export const AuditModel = model('AdminAudit', auditSchema);
export type UserRecord = InferSchemaType<typeof userSchema>;
export type SubscriptionRecord = InferSchemaType<typeof subscriptionSchema>;
