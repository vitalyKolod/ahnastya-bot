export const subscriptionStatuses = [
  'pending',
  'active',
  'past_due',
  'expired',
  'cancelled',
] as const;
export type SubscriptionStatus = (typeof subscriptionStatuses)[number];
export const paymentStatuses = ['pending', 'succeeded', 'canceled', 'failed', 'refunded'] as const;
export type PaymentStatus = (typeof paymentStatuses)[number];
export const checkoutStatuses = [
  'created',
  'payment_pending',
  'paid',
  'claimed',
  'expired',
  'canceled',
] as const;
export type CheckoutStatus = (typeof checkoutStatuses)[number];
export type PaymentType = 'initial' | 'renewal' | 'manual_renewal';
export const purchaseIntentStatuses = [
  'browsing',
  'payment_created',
  'paid',
  'abandoned',
  'canceled',
] as const;
