import type { Api } from 'grammy';
import type { Logger } from 'pino';
import {
  InviteModel,
  PaymentModel,
  SubscriptionModel,
  UserModel,
} from '../infrastructure/db/models.js';
import { ConflictError, NotFoundError } from '../shared/errors.js';

const ACCESS_STATUSES = ['member', 'administrator', 'creator'] as const;

export class ChannelAccessService {
  constructor(
    private readonly api: Api,
    private readonly channelId: string,
    private readonly ttlMinutes: number,
    private readonly rateMinutes: number,
    private readonly logger: Logger,
  ) {}
  async issueInvite(telegramId: number, providerPaymentId?: string): Promise<string | null> {
    const user = await UserModel.findOne({ telegramId });
    if (!user) throw new NotFoundError('Пользователь не найден');
    const sub = await SubscriptionModel.findOne({
      userId: user._id,
      status: { $in: ['active', 'past_due'] },
    });
    if (!sub || (sub.status === 'past_due' && (!sub.graceUntil || sub.graceUntil <= new Date())))
      throw new ConflictError('Подписка неактивна');

    try {
      const member = await this.api.getChatMember(this.channelId, telegramId);
      if (ACCESS_STATUSES.includes(member.status as (typeof ACCESS_STATUSES)[number])) {
        this.logger.info({ event: 'channel.access.already_member', telegramId });
        return null;
      }
    } catch (error) {
      this.logger.warn({ event: 'channel.access.member_check_failed', telegramId, err: error });
    }

    const recent = await InviteModel.findOne({
      userId: user._id,
      subscriptionId: sub._id,
      channelId: this.channelId,
      revokedAt: null,
      usedAt: null,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });
    if (recent) return recent.inviteLink;
    const last = await InviteModel.findOne({ userId: user._id }).sort({ createdAt: -1 });
    if (last && last.createdAt.getTime() > Date.now() - this.rateMinutes * 60_000)
      throw new ConflictError('Новую ссылку можно запросить немного позже');
    const payment = providerPaymentId
      ? await PaymentModel.findOne({
          providerPaymentId,
          userId: user._id,
          subscriptionId: sub._id,
          status: 'succeeded',
        })
      : await PaymentModel.findOne({
          userId: user._id,
          subscriptionId: sub._id,
          status: 'succeeded',
        }).sort({ paidAt: -1 });
    if (!payment) throw new NotFoundError('Успешный платёж для подписки не найден');
    const name = `sub-${String(sub._id).slice(-8)}-${Date.now()}`;
    const expiresAt = new Date(Date.now() + this.ttlMinutes * 60_000);
    let link;
    try {
      link = await this.api.createChatInviteLink(this.channelId, {
        name,
        expire_date: Math.floor(expiresAt.getTime() / 1000),
        creates_join_request: true,
      });
    } catch (error) {
      this.logger.error({
        event: 'channel.access.permission_error',
        operation: 'create_invite',
        err: error,
      });
      throw error;
    }
    await InviteModel.create({
      userId: user._id,
      paymentId: payment._id,
      subscriptionId: sub._id,
      channelId: this.channelId,
      expectedTelegramId: telegramId,
      inviteLink: link.invite_link,
      telegramInviteName: name,
      expiresAt,
    });
    this.logger.info({
      event: 'channel.access.invite_created',
      userId: user.id,
      paymentId: payment.id,
      subscriptionId: sub.id,
      telegramId,
    });
    return link.invite_link;
  }
  async approveExpectedJoinRequest(telegramId: number, inviteLink: string) {
    const invite = await InviteModel.findOne({
      inviteLink,
      channelId: this.channelId,
    });
    const reject = async (event: string) => {
      try {
        await this.api.declineChatJoinRequest(this.channelId, telegramId);
      } catch (error) {
        this.logger.error({
          event: 'channel.access.permission_error',
          operation: 'decline_join',
          err: error,
        });
      }
      this.logger.warn({ event, telegramId });
      return false;
    };
    if (!invite) return reject('channel.access.rejected_invalid_invite');
    if (invite.expectedTelegramId !== telegramId)
      return reject('channel.access.rejected_wrong_user');
    if (invite.usedAt || invite.revokedAt || invite.expiresAt <= new Date())
      return reject('channel.access.rejected_inactive_invite');
    const [user, payment, sub] = await Promise.all([
      UserModel.findById(invite.userId),
      PaymentModel.findOne({
        _id: invite.paymentId,
        userId: invite.userId,
        subscriptionId: invite.subscriptionId,
        status: 'succeeded',
      }),
      SubscriptionModel.findOne({
        _id: invite.subscriptionId,
        userId: invite.userId,
        status: { $in: ['active', 'past_due'] },
      }),
    ]);
    if (!user || user.telegramId !== telegramId || !payment)
      return reject('channel.access.rejected_invalid_binding');
    if (!sub || (sub.status === 'past_due' && (!sub.graceUntil || sub.graceUntil <= new Date()))) {
      return reject('channel.access.rejected_inactive_subscription');
    }
    try {
      await this.api.approveChatJoinRequest(this.channelId, telegramId);
    } catch (error) {
      this.logger.error({
        event: 'channel.access.permission_error',
        operation: 'approve_join',
        err: error,
      });
      return false;
    }
    invite.usedAt = new Date();
    await invite.save();
    try {
      await this.api.revokeChatInviteLink(this.channelId, invite.inviteLink);
      invite.revokedAt = new Date();
      await invite.save();
    } catch (error) {
      this.logger.error({
        event: 'channel.access.permission_error',
        operation: 'revoke_invite',
        err: error,
      });
    }
    this.logger.info({ event: 'channel.access.approved', telegramId });
    return true;
  }
  async checkPermissions() {
    try {
      const me = await this.api.getMe();
      const member = await this.api.getChatMember(this.channelId, me.id);
      if (member.status !== 'administrator' || !member.can_invite_users)
        throw new Error('Bot must be a channel administrator with can_invite_users');
      return true;
    } catch (error) {
      this.logger.error({
        event: 'channel.access.permission_error',
        operation: 'startup_check',
        err: error,
      });
      return false;
    }
  }
  async removeMember(telegramId: number) {
    await this.api.banChatMember(this.channelId, telegramId);
    this.logger.info({ event: 'member.removed', telegramId });
  }
  async restoreEligibility(telegramId: number) {
    await this.api.unbanChatMember(this.channelId, telegramId, { only_if_banned: true });
  }
}
