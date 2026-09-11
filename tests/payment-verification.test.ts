import { describe, expect, it } from 'vitest';
import { assertVerifiedPayment } from '../src/application/payment.service.js';
import type { Plan } from '../src/config/plans.js';
import type { ProviderPayment } from '../src/infrastructure/payments/payment-gateway.js';

const plan: Plan = {
  id: 'month',
  title: 'Месяц',
  amountMinor: 10000,
  currency: 'RUB',
  durationMonths: 1,
  renewalPeriodMonths: 1,
  lifetime: false,
  autoRenewSupported: true,
  enabled: true,
};
const expected = {
  providerPaymentId: 'provider-1',
  internalPaymentId: 'internal-1',
  checkoutSessionId: 'checkout-1',
  planId: 'month',
  amountMinor: 10000,
  currency: 'RUB',
};
const remote: ProviderPayment = {
  id: 'provider-1',
  status: 'succeeded',
  paid: true,
  amountMinor: 10000,
  currency: 'RUB',
  metadata: {
    internalPaymentId: 'internal-1',
    checkoutSessionId: 'checkout-1',
    planId: 'month',
  },
};

describe('authoritative YooKassa payment verification', () => {
  it('accepts matching succeeded payment data', () => {
    expect(() => assertVerifiedPayment(remote, expected, plan)).not.toThrow();
  });

  it.each([
    ['wrong amount', { amountMinor: 9999 }],
    ['wrong currency', { currency: 'USD' }],
    ['token/session bound to another payment', { id: 'provider-2' }],
    ['wrong plan', { metadata: { ...remote.metadata, planId: 'three_months' } }],
    ['wrong internal payment id', { metadata: { ...remote.metadata, internalPaymentId: 'internal-2' } }],
    ['wrong checkout session id', { metadata: { ...remote.metadata, checkoutSessionId: 'checkout-2' } }],
  ])('rejects %s', (_name, override) => {
    expect(() => assertVerifiedPayment({ ...remote, ...override }, expected, plan)).toThrow(
      'Verified payment data mismatch',
    );
  });
});
