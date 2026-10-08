import mongoose from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { SubscriptionService } from '../src/application/subscription.service.js';
import { PaymentModel, SubscriptionModel } from '../src/infrastructure/db/models.js';

describe('cancel auto renewal', () => {
  it('removes the saved payment method together with the next charge', async () => {
    const session = {} as mongoose.ClientSession;
    const transaction = vi.spyOn(mongoose.connection, 'transaction').mockImplementation((fn) => fn(session));
    const update = vi.spyOn(SubscriptionModel, 'findOneAndUpdate').mockResolvedValue({ id: 'sub-1' });
    const paymentUpdate = vi.spyOn(PaymentModel, 'updateMany').mockResolvedValue({ acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null });
    try {
      await new SubscriptionService().cancelAutoRenew('user-1');
      const [filter, changes, options] = update.mock.calls[0]!;
      expect(filter).toHaveProperty('userId', 'user-1');
      expect(changes).toHaveProperty('$set.autoRenew', false);
      expect(changes).toHaveProperty('$unset.nextPaymentAt', 1);
      expect(changes).toHaveProperty('$unset.paymentMethodId', 1);
      expect(options).toEqual({ new: true, session });
      expect(paymentUpdate).toHaveBeenCalledWith(
        { userId: 'user-1' },
        { $unset: { paymentMethodId: 1 } },
        { session },
      );
    } finally {
      transaction.mockRestore();
      update.mockRestore();
      paymentUpdate.mockRestore();
    }
  });
});
