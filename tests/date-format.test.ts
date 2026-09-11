import { describe, expect, it } from 'vitest';
import { formatUserDate } from '../src/shared/date.js';

describe('Russian user date formatter', () => {
  it('uses a Russian genitive month name', () => {
    expect(formatUserDate(new Date('2026-10-10T12:00:00Z'), 'Europe/Moscow')).toBe(
      '10 октября 2026 г.',
    );
  });

  it('respects the business timezone at a date boundary', () => {
    const instant = new Date('2026-10-09T21:30:00Z');
    expect(formatUserDate(instant, 'Europe/Moscow')).toBe('10 октября 2026 г.');
    expect(formatUserDate(instant, 'UTC')).toBe('9 октября 2026 г.');
  });
});
