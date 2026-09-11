import { startOfMonth } from 'date-fns';
import {
  AuditModel,
  PaymentModel,
  SubscriptionModel,
  UserModel,
} from '../infrastructure/db/models.js';
export class AdminService {
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
