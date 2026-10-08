import { startOfMonth } from 'date-fns';
import { randomUUID } from 'node:crypto';
import type { Plan, PlanId } from '../config/plans.js';
import {
  AuditModel,
  PaymentModel,
  PlanModel,
  SubscriptionModel,
  UserModel,
} from '../infrastructure/db/models.js';
import { NotFoundError, ValidationError } from '../shared/errors.js';

export type MemberGroup = 'active' | 'leads' | 'expiring';
export interface MemberRow {
  telegramId: number;
  firstName: string;
  username?: string | null | undefined;
  currentPeriodEnd?: Date | null | undefined;
}
export class AdminService {
  constructor(private readonly plans: Map<PlanId, Plan>) {}

  listPlans() {
    return [...this.plans.values()];
  }

  getPlan(id: string) {
    return this.plans.get(id);
  }

  async savePlan(input: {
    id?: string;
    title: string;
    amountMinor: number;
    durationMonths: number | null;
  }) {
    const title = input.title.trim();
    if (!title || title.length > 60 || /[\r\n]/.test(title))
      throw new ValidationError('Название должно содержать от 1 до 60 символов в одной строке');
    if (
      !Number.isInteger(input.amountMinor) ||
      input.amountMinor < 100 ||
      input.amountMinor > 100_000_000
    )
      throw new ValidationError('Цена должна быть от 1 до 1 000 000 ₽');
    if (
      input.durationMonths !== null &&
      (!Number.isInteger(input.durationMonths) ||
        input.durationMonths < 1 ||
        input.durationMonths > 120)
    )
      throw new ValidationError('Срок должен быть от 1 до 120 месяцев');
    const previous = input.id ? this.plans.get(input.id) : null;
    if (input.id && !previous) throw new NotFoundError('Тариф не найден');
    const lifetime = input.durationMonths === null;
    const plan: Plan = {
      id: input.id ?? `p_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      title,
      amountMinor: input.amountMinor,
      currency: 'RUB',
      durationMonths: input.durationMonths,
      renewalPeriodMonths: input.durationMonths,
      lifetime,
      autoRenewSupported: !lifetime,
      enabled: previous?.enabled ?? true,
    };
    await PlanModel.findOneAndUpdate({ id: plan.id }, { $set: plan }, { upsert: true, new: true });
    this.plans.set(plan.id, plan);
    return plan;
  }

  async setPlanEnabled(id: string, enabled: boolean) {
    const previous = this.plans.get(id);
    if (!previous) throw new NotFoundError('Тариф не найден');
    await PlanModel.updateOne({ id }, { $set: { enabled } });
    const plan = { ...previous, enabled };
    this.plans.set(id, plan);
    return plan;
  }

  async members(
    group: MemberGroup,
    page: number,
    days = 7,
  ): Promise<{ rows: MemberRow[]; total: number }> {
    const skip = page * 5;
    if (group === 'leads') {
      const [result] = await UserModel.aggregate<{
        rows: MemberRow[];
        count: { total: number }[];
      }>([
        {
          $lookup: {
            from: 'payments',
            let: { user: '$_id' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [{ $eq: ['$userId', '$$user'] }, { $eq: ['$status', 'succeeded'] }],
                  },
                },
              },
              { $limit: 1 },
            ],
            as: 'paid',
          },
        },
        {
          $lookup: {
            from: 'subscriptions',
            localField: '_id',
            foreignField: 'userId',
            as: 'subscriptions',
          },
        },
        { $match: { paid: { $size: 0 }, subscriptions: { $size: 0 } } },
        {
          $facet: {
            rows: [
              { $sort: { onboardingSeenAt: -1, _id: -1 } },
              { $skip: skip },
              { $limit: 5 },
              { $project: { telegramId: 1, firstName: 1, username: 1 } },
            ],
            count: [{ $count: 'total' }],
          },
        },
      ]);
      return { rows: result?.rows ?? [], total: result?.count[0]?.total ?? 0 };
    }
    const now = new Date();
    const filter =
      group === 'active'
        ? { status: 'active' }
        : {
            status: 'active',
            lifetime: { $ne: true },
            currentPeriodEnd: { $gt: now, $lte: new Date(now.getTime() + days * 86_400_000) },
          };
    const [subscriptions, total] = await Promise.all([
      SubscriptionModel.find(filter)
        .sort(group === 'expiring' ? { currentPeriodEnd: 1, _id: 1 } : { _id: -1 })
        .skip(skip)
        .limit(5)
        .lean(),
      SubscriptionModel.countDocuments(filter),
    ]);
    const users = await UserModel.find({ _id: { $in: subscriptions.map((s) => s.userId) } }).lean();
    const byId = new Map(users.map((user) => [String(user._id), user]));
    return {
      rows: subscriptions.flatMap((sub) => {
        const user = byId.get(String(sub.userId));
        return user
          ? [
              {
                telegramId: user.telegramId,
                firstName: user.firstName,
                username: user.username,
                currentPeriodEnd: sub.currentPeriodEnd,
              },
            ]
          : [];
      }),
      total,
    };
  }
  async stats() {
    const month = startOfMonth(new Date());
    const [users, active, pastDue, expired, autoRenew, revenue] = await Promise.all([
      UserModel.countDocuments(),
      SubscriptionModel.countDocuments({ status: 'active' }),
      SubscriptionModel.countDocuments({ status: 'past_due' }),
      SubscriptionModel.countDocuments({ status: 'expired' }),
      SubscriptionModel.countDocuments({ autoRenew: true }),
      PaymentModel.aggregate<{ total: number }>([
        { $match: { status: 'succeeded', paidAt: { $gte: month } } },
        { $group: { _id: null, total: { $sum: '$amountMinor' } } },
      ]),
    ]);
    return { users, active, pastDue, expired, autoRenew, revenueMinor: revenue[0]?.total ?? 0 };
  }
  async audit(adminTelegramId: number, action: string, targetId?: string, details?: unknown) {
    await AuditModel.create({ adminTelegramId, action, targetId, details });
  }
}
