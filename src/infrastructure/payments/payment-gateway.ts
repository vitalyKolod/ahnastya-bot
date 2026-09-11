export interface CreatePaymentInput {
  idempotenceKey: string;
  amountMinor: number;
  currency: 'RUB';
  description: string;
  returnUrl: string;
  savePaymentMethod: boolean;
  metadata: Record<string, string>;
  paymentMethodId?: string;
}
export interface ProviderPayment {
  id: string;
  status: string;
  paid: boolean;
  amountMinor: number;
  currency: string;
  metadata: Record<string, string>;
  paymentMethod?: { id: string; saved: boolean };
  paidAt?: Date;
  confirmationUrl?: string;
}
export interface NormalizedWebhook {
  type: 'succeeded' | 'canceled' | 'refund' | 'ignored';
  providerPaymentId: string;
}
export interface PaymentGateway {
  createInitialPayment(input: CreatePaymentInput): Promise<ProviderPayment>;
  getPayment(id: string): Promise<ProviderPayment>;
  createRecurringPayment(input: CreatePaymentInput): Promise<ProviderPayment>;
  refundPayment(id: string, amountMinor: number, idempotenceKey: string): Promise<void>;
  normalizeWebhookEvent(payload: unknown): NormalizedWebhook;
}
