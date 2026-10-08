import mongoose from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { SubscriptionService } from '../src/application/subscription.service.js';
import { PaymentModel, SubscriptionModel } from '../src/infrastructure/db/models.js';

describe('cancel auto renewal', () => {
  it('removes the saved payment method together with the next charge', async () => {
    const session = {} as mongoose.ClientSession;
    const transaction = vi.spyOn(mongoose.connection, 'transaction').mockImplementation((fn) => fn(session));
    const update = vi.spyOn(SubscriptionModel, 'findOneAndUpdate').mockResolvedValue({ id: 'sub-1' } as never);
    const paymentUpdate = vi.spyOn(PaymentModel, 'updateMany').mockResolvedValue({} as never);
    try {
      await new SubscriptionService().cancelAutoRenew('user-1');
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1' }),
        expect.objectContaining({
          $set: expect.objectContaining({ autoRenew: false }),
          $unset: { nextPaymentAt: 1, paymentMethodId: 1 },
        }),
        { new: true, session },
      );
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
