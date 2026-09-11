import { describe, expect, it } from 'vitest';
import { addCalendarMonthsClamped, calculatePeriod } from '../src/domain/subscription/period.js';
describe('calendar subscription periods', () => {
  it.each([
    ['ordinary', '2026-04-09T10:00:00Z', 1, '2026-05-09T10:00:00.000Z'],
    ['31 January', '2025-01-31T10:00:00Z', 1, '2025-02-28T10:00:00.000Z'],
    ['leap year', '2024-01-31T10:00:00Z', 1, '2024-02-29T10:00:00.000Z'],
    ['February', '2025-02-28T10:00:00Z', 1, '2025-03-28T10:00:00.000Z'],
    ['three months', '2026-01-31T10:00:00Z', 3, '2026-04-30T10:00:00.000Z'],
  ])('%s', (_name, start, months, end) =>
    expect(addCalendarMonthsClamped(new Date(start), months).toISOString()).toBe(end),
  );
  it('renews active from current end', () => {
    const r = calculatePeriod(new Date('2026-01-01Z'), 1, new Date('2026-02-15Z'));
    expect(r.start.toISOString()).toBe('2026-02-15T00:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-03-15T00:00:00.000Z');
  });
  it('renews expired from now', () => {
    const r = calculatePeriod(new Date('2026-04-01Z'), 1, new Date('2026-02-15Z'));
    expect(r.start.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });
});
