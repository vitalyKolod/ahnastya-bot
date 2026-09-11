import mongoose from 'mongoose';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { CheckoutService } from '../src/application/checkout.service.js';
import { acknowledgeCallback } from '../src/presentation/telegram/bot.js';

describe('callback and checkout concurrency UX', () => {
  it('acknowledges the callback before starting the operation', async () => {
    const order: string[] = [];
    const ctx = {
      answerCallbackQuery: vi.fn(() => { order.push('ack'); return Promise.resolve(true as const); }),
    };
    await acknowledgeCallback(ctx, () => { order.push('operation'); return Promise.resolve(); });
    expect(order).toEqual(['ack', 'operation']);
  });

  it('shares one payment creation for concurrent double clicks', async () => {
    const service = new CheckoutService(
      {} as never, new Map() as never, {} as never, pino({ level: 'silent' }),
    );
    const createProviderPayment = vi.fn(async () => {
      await Promise.resolve();
      return { publicId: 'checkout-1', confirmationUrl: 'https://pay.test/1' };
    });
    vi.spyOn(service as never, 'createUnlocked' as never).mockImplementation(createProviderPayment);
    const userId = new mongoose.Types.ObjectId();
    const consent = { offer: true, privacy: true, autoRenew: true };
    const [first, second] = await Promise.all([
      service.create('month', userId, consent),
      service.create('month', userId, consent),
    ]);
    expect(createProviderPayment).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });
});
