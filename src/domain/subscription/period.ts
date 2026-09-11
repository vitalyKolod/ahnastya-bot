import { isAfter } from 'date-fns';
export function addCalendarMonthsClamped(start: Date, months: number): Date {
  if (months < 1 || !Number.isInteger(months)) throw new Error('months must be a positive integer');
  const day = start.getUTCDate();
  const target = new Date(
    Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth() + months,
      1,
      start.getUTCHours(),
      start.getUTCMinutes(),
      start.getUTCSeconds(),
      start.getUTCMilliseconds(),
    ),
  );
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target;
}
export function calculatePeriod(
  now: Date,
  months: number,
  currentEnd?: Date,
): { start: Date; end: Date } {
  const start = currentEnd && isAfter(currentEnd, now) ? currentEnd : now;
  return { start, end: addCalendarMonthsClamped(start, months) };
}
export const addGrace = (from: Date, days: number) => new Date(from.getTime() + days * 86_400_000);
