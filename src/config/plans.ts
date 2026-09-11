import type { Env } from './env.js';
import { calculatePeriod } from '../domain/subscription/period.js';
export type PlanId = 'month' | 'three_months' | 'lifetime';
export interface Plan {
  id: PlanId;
  title: string;
  amountMinor: number;
  currency: 'RUB';
  durationMonths: number | null;
  renewalPeriodMonths: number | null;
  lifetime: boolean;
  autoRenewSupported: boolean;
  enabled: boolean;
}
export function rubToMinor(value: string): number {
  const [whole = '0', fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
export function createPlans(env: Env): ReadonlyMap<PlanId, Plan> {
  return new Map([
    [
      'month',
      {
        id: 'month',
        title: '1 месяц',
        amountMinor: rubToMinor(env.PLAN_MONTH_AMOUNT_RUB),
        currency: 'RUB',
        durationMonths: 1,
        renewalPeriodMonths: 1,
        lifetime: false,
        autoRenewSupported: true,
        enabled: true,
      },
    ],
    [
      'three_months',
      {
        id: 'three_months',
        title: '3 месяца',
        amountMinor: rubToMinor(env.PLAN_THREE_MONTH_AMOUNT_RUB),
        currency: 'RUB',
        durationMonths: 3,
        renewalPeriodMonths: 3,
        lifetime: false,
        autoRenewSupported: true,
        enabled: true,
      },
    ],
    [
      'lifetime',
      {
        id: 'lifetime',
        title: 'Навсегда ♾️',
        amountMinor: rubToMinor(env.PLAN_LIFETIME_AMOUNT_RUB),
        currency: 'RUB',
        durationMonths: null,
        renewalPeriodMonths: null,
        lifetime: true,
        autoRenewSupported: false,
        enabled: true,
      },
    ],
  ]);
}

export function subscriptionTerms(
  plan: Plan,
  now: Date,
  previousEnd: Date | undefined,
  savedPaymentMethod: boolean,
  autoRenewConsent: boolean,
) {
  if (plan.lifetime)
    return {
      currentPeriodStart: now,
      currentPeriodEnd: null,
      lifetime: true,
      autoRenew: false,
      nextPaymentAt: null,
    } as const;
  const period = calculatePeriod(now, plan.durationMonths!, previousEnd);
  const autoRenew = plan.autoRenewSupported && savedPaymentMethod && autoRenewConsent;
  return {
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
    lifetime: false,
    autoRenew,
    nextPaymentAt: autoRenew ? period.end : null,
  } as const;
}
