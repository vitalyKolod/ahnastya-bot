import { describe, expect, it } from 'vitest';
import { ru } from '../src/content/ru.js';
import { hasChannelAccess } from '../src/presentation/telegram/bot.js';

describe('subscription screen', () => {
  it.each([
    ['pending', 'ожидает оплаты'],
    ['active', 'активна ☑️'],
    ['past_due', 'просрочена'],
    ['expired', 'истекла'],
    ['cancelled', 'отменена'],
  ] as const)('shows %s status in Russian', (status, label) => {
    expect(ru.subscription(status, 'Месяц', null, '990 ₽', false, false)).toContain(
      `Статус: ${label}`,
    );
  });

  it('does not offer channel access for expired subscriptions or elapsed grace periods', () => {
    const now = new Date('2026-11-02T12:00:00Z');
    expect(hasChannelAccess({ status: 'active' }, now)).toBe(true);
    expect(hasChannelAccess({ status: 'past_due', graceUntil: new Date('2026-11-03') }, now)).toBe(true);
    expect(hasChannelAccess({ status: 'past_due', graceUntil: now }, now)).toBe(false);
    expect(hasChannelAccess({ status: 'expired' }, now)).toBe(false);
    expect(hasChannelAccess({ status: 'cancelled' }, now)).toBe(false);
  });
});
