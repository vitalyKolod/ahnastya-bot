import { describe, expect, it } from 'vitest';
import { isAbandonedReminderEligible, isReminderCooldownActive, reminderCta } from '../src/application/purchase-intent.service.js';

const now = new Date('2026-09-11T10:00:00Z');
const due = (overrides: Record<string, unknown> = {}) => ({
  now,
  reminderDueAt: new Date('2026-09-11T09:00:00Z'),
  startedAt: new Date('2026-09-11T08:00:00Z'),
  status: 'browsing',
  ...overrides,
});

describe('abandoned checkout policy', () => {
  it('makes an unpaid intent eligible after 60 minutes', () => expect(isAbandonedReminderEligible(due())).toBe(true));
  it('does not remind before 60 minutes', () => expect(isAbandonedReminderEligible(due({ reminderDueAt: new Date('2026-09-11T10:01:00Z') }))).toBe(false));
  it('does not remind after succeeded payment', () => expect(isAbandonedReminderEligible(due({ paymentStatus: 'succeeded' }))).toBe(false));
  it('does not remind an active subscriber', () => expect(isAbandonedReminderEligible(due({ hasActiveSubscription: true }))).toBe(false));
  it('does not remind a lifetime subscriber', () => expect(isAbandonedReminderEligible(due({ lifetime: true }))).toBe(false));
  it('sends only once', () => expect(isAbandonedReminderEligible(due({ reminderSentAt: now }))).toBe(false));
  it('only keeps one worker-claimable state', () => expect(isAbandonedReminderEligible(due({ status: 'abandoned' }))).toBe(false));
  it('reuses a pending checkout URL', () => expect(reminderCta({ paymentStatus: 'pending', confirmationUrl: 'https://pay.example', planId: 'month' })).toMatchObject({ type: 'url', url: 'https://pay.example' }));
  it('never creates payment for a canceled provider payment', () => expect(reminderCta({ paymentStatus: 'canceled', planId: 'month' }).type).toBe('callback'));
  it('completed intent is ineligible after reminder', () => expect(isAbandonedReminderEligible(due({ status: 'paid', reminderSentAt: now }))).toBe(false));
  it('payment won immediately before sending is ineligible', () => expect(isAbandonedReminderEligible(due({ paymentStatus: 'succeeded' }))).toBe(false));
  it('enforces cooldown', () => expect(isReminderCooldownActive(new Date('2026-09-11T09:00:00Z'), now, 24)).toBe(true));
  it('offers plan selection before a plan is chosen', () => expect(reminderCta({}).label).toContain('ВЫБРАТЬ ТАРИФ'));
});
