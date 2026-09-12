import type { Api } from 'grammy';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelAccessService } from '../src/application/channel-access.service.js';
import {
  InviteModel,
  PaymentModel,
  SubscriptionModel,
  UserModel,
} from '../src/infrastructure/db/models.js';

const channelId = '-1001234567890';
const query = <T>(value: T) => ({
  sort: vi.fn().mockResolvedValue(value),
  then: (resolve: (result: T) => unknown) => Promise.resolve(value).then(resolve),
});

function harness() {
  const api = {
    getChatMember: vi.fn().mockResolvedValue({ status: 'left' }),
    getMe: vi.fn().mockResolvedValue({ id: 99 }),
    createChatInviteLink: vi.fn().mockResolvedValue({ invite_link: 'https://t.me/+personal' }),
    approveChatJoinRequest: vi.fn().mockResolvedValue(true),
    declineChatJoinRequest: vi.fn().mockResolvedValue(true),
    revokeChatInviteLink: vi.fn().mockResolvedValue({}),
  };
  const logger = pino({ level: 'silent' });
  return {
    api,
    logger,
    service: new ChannelAccessService(api as unknown as Api, channelId, 30, 5, logger),
  };
}

describe('personal channel access', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates a join-request invite bound to user, payment, subscription, and channel', async () => {
    const h = harness();
    const user = { _id: 'user-1', id: 'user-1', telegramId: 42 };
    const subscription = { _id: 'subscription-1', id: 'subscription-1', status: 'active' };
    const payment = { _id: 'payment-1', id: 'payment-1' };
    vi.spyOn(UserModel, 'findOne').mockResolvedValue(user);
    vi.spyOn(SubscriptionModel, 'findOne').mockResolvedValue(subscription);
    vi.spyOn(InviteModel, 'findOne')
      .mockReturnValueOnce(query(null) as never)
      .mockReturnValueOnce(query(null) as never);
    vi.spyOn(PaymentModel, 'findOne').mockResolvedValue(payment);
    const create = vi.spyOn(InviteModel, 'create').mockResolvedValue({} as never);

    await expect(h.service.issueInvite(42, 'provider-1')).resolves.toBe('https://t.me/+personal');

    expect(h.api.createChatInviteLink).toHaveBeenCalledWith(
      channelId,
      expect.objectContaining({ creates_join_request: true }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        paymentId: 'payment-1',
        subscriptionId: 'subscription-1',
        channelId,
        expectedTelegramId: 42,
      }),
    );
  });

  it('does not issue a link when the paid user is already in the channel', async () => {
    const h = harness();
    h.api.getChatMember.mockResolvedValue({ status: 'member' });
    vi.spyOn(UserModel, 'findOne').mockResolvedValue({ _id: 'user-1' });
    vi.spyOn(SubscriptionModel, 'findOne').mockResolvedValue({ status: 'active' });
    const create = vi.spyOn(InviteModel, 'create');

    await expect(h.service.issueInvite(42, 'provider-1')).resolves.toBeNull();
    expect(h.api.createChatInviteLink).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('approves only the exact paid user, consumes the invite, and revokes it', async () => {
    const h = harness();
    const invite = {
      userId: 'user-1',
      paymentId: 'payment-1',
      subscriptionId: 'subscription-1',
      expectedTelegramId: 42,
      inviteLink: 'https://t.me/+personal',
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: undefined,
      revokedAt: undefined,
      save: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(InviteModel, 'findOne').mockResolvedValue(invite);
    vi.spyOn(UserModel, 'findById').mockResolvedValue({ telegramId: 42 });
    vi.spyOn(PaymentModel, 'findOne').mockResolvedValue({ status: 'succeeded' });
    vi.spyOn(SubscriptionModel, 'findOne').mockResolvedValue({ status: 'active' });

    await expect(h.service.approveExpectedJoinRequest(42, invite.inviteLink)).resolves.toBe(true);

    expect(h.api.approveChatJoinRequest).toHaveBeenCalledWith(channelId, 42);
    expect(h.api.revokeChatInviteLink).toHaveBeenCalledWith(channelId, invite.inviteLink);
    expect(invite.usedAt).toBeInstanceOf(Date);
    expect(invite.revokedAt).toBeInstanceOf(Date);
  });

  it('declines a forwarded invite without consuming it', async () => {
    const h = harness();
    const invite = {
      expectedTelegramId: 42,
      inviteLink: 'https://t.me/+personal',
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: undefined,
      revokedAt: undefined,
    };
    vi.spyOn(InviteModel, 'findOne').mockResolvedValue(invite);

    await expect(h.service.approveExpectedJoinRequest(999, invite.inviteLink)).resolves.toBe(false);

    expect(h.api.declineChatJoinRequest).toHaveBeenCalledWith(channelId, 999);
    expect(h.api.approveChatJoinRequest).not.toHaveBeenCalled();
    expect(h.api.revokeChatInviteLink).not.toHaveBeenCalled();
    expect(invite.usedAt).toBeUndefined();
  });

  it('declines the expected user when the subscription is inactive', async () => {
    const h = harness();
    const invite = {
      userId: 'user-1',
      paymentId: 'payment-1',
      subscriptionId: 'subscription-1',
      expectedTelegramId: 42,
      inviteLink: 'https://t.me/+personal',
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: undefined,
      revokedAt: undefined,
    };
    vi.spyOn(InviteModel, 'findOne').mockResolvedValue(invite);
    vi.spyOn(UserModel, 'findById').mockResolvedValue({ telegramId: 42 });
    vi.spyOn(PaymentModel, 'findOne').mockResolvedValue({ status: 'succeeded' });
    vi.spyOn(SubscriptionModel, 'findOne').mockResolvedValue(null);

    await expect(h.service.approveExpectedJoinRequest(42, invite.inviteLink)).resolves.toBe(false);
    expect(h.api.declineChatJoinRequest).toHaveBeenCalledWith(channelId, 42);
    expect(h.api.approveChatJoinRequest).not.toHaveBeenCalled();
  });
});
