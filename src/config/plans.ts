import type { Env } from './env.js';
import { calculatePeriod } from '../domain/subscription/period.js';
import { PaymentModel, PlanModel, SubscriptionModel } from '../infrastructure/db/models.js';
export type PlanId = string;
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
export function createPlans(env: Env): Map<PlanId, Plan> {
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

export async function loadPlans(env: Env): Promise<Map<PlanId, Plan>> {
  if ((await PlanModel.countDocuments()) === 0)
    await PlanModel.insertMany([...createPlans(env).values()]);
  const stored = await PlanModel.find().lean();
  const plans = new Map<PlanId, Plan>(
    stored.map((p) => [
      p.id,
      {
        id: p.id,
        title: p.title,
        amountMinor: p.amountMinor,
        currency: 'RUB' as const,
        durationMonths: p.durationMonths ?? null,
        renewalPeriodMonths: p.renewalPeriodMonths ?? null,
        lifetime: p.lifetime,
        autoRenewSupported: p.autoRenewSupported,
        enabled: p.enabled,
      },
    ]),
  );
  const existing = await SubscriptionModel.find({
    status: { $in: ['active', 'past_due'] },
    renewalAmountMinor: { $exists: false },
  })
    .select({ _id: 1, planId: 1, lifetime: 1 })
    .lean();
  for (const sub of existing) {
    const payment = await PaymentModel.findOne({ subscriptionId: sub._id, status: 'succeeded' })
      .sort({ paidAt: -1 })
      .select({ amountMinor: 1 })
      .lean();
    const plan = plans.get(sub.planId);
    if (!payment || !plan) continue;
    await SubscriptionModel.updateOne(
      { _id: sub._id, renewalAmountMinor: { $exists: false } },
      {
        $set: {
          planTitle: plan.title,
          renewalAmountMinor: payment.amountMinor,
          ...(!sub.lifetime ? { renewalPeriodMonths: plan.renewalPeriodMonths } : {}),
        },
      },
    );
  }
  return plans;
}

export function planForCheckout(
  plan: Plan,
  checkout: {
    planTitle?: string | null;
    planDurationMonths?: number | null;
    planLifetime?: boolean | null;
    planAutoRenewSupported?: boolean | null;
  },
): Plan {
  const lifetime = checkout.planLifetime ?? plan.lifetime;
  const durationMonths = lifetime ? null : (checkout.planDurationMonths ?? plan.durationMonths);
  return {
    ...plan,
    title: checkout.planTitle ?? plan.title,
    durationMonths,
    renewalPeriodMonths: durationMonths,
    lifetime,
    autoRenewSupported: checkout.planAutoRenewSupported ?? plan.autoRenewSupported,
  };
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
