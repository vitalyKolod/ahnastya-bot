import { SubscriptionModel } from '../infrastructure/db/models.js';
import { NotFoundError } from '../shared/errors.js';
export class SubscriptionService {
  async getForUser(userId: unknown) {
    return SubscriptionModel.findOne({ userId }).lean();
  }
  async cancelAutoRenew(userId: unknown) {
    const value = await SubscriptionModel.findOneAndUpdate(
      { userId, status: { $in: ['active', 'past_due'] }, lifetime: { $ne: true } },
      {
        $set: { autoRenew: false, cancelAtPeriodEnd: true, cancelledAt: new Date() },
        $unset: { nextPaymentAt: 1 },
      },
      { new: true },
    );
    if (!value) throw new NotFoundError('Активная подписка не найдена');
    return value;
  }
  async extendDays(userId: unknown, days: number) {
    const sub = await SubscriptionModel.findOne({ userId });
    if (!sub) throw new NotFoundError('Подписка не найдена');
    if (sub.lifetime || !sub.currentPeriodEnd) return sub;
    sub.currentPeriodEnd = new Date(sub.currentPeriodEnd.getTime() + days * 86_400_000);
    if (sub.autoRenew) sub.nextPaymentAt = sub.currentPeriodEnd;
    await sub.save();
    return sub;
  }
}
