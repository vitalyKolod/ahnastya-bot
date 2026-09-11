import type { Api } from 'grammy';
import type { Logger } from 'pino';
import { InviteModel, SubscriptionModel, UserModel } from '../infrastructure/db/models.js';
import { ConflictError, NotFoundError } from '../shared/errors.js';
export class ChannelAccessService {
  constructor(
    private readonly api: Api,
    private readonly channelId: string,
    private readonly ttlMinutes: number,
    private readonly rateMinutes: number,
    private readonly logger: Logger,
  ) {}
  async issueInvite(telegramId: number) {
    const user = await UserModel.findOne({ telegramId });
    if (!user) throw new NotFoundError('Пользователь не найден');
    const sub = await SubscriptionModel.findOne({
      userId: user._id,
      status: { $in: ['active', 'past_due'] },
    });
    if (!sub || (sub.status === 'past_due' && (!sub.graceUntil || sub.graceUntil <= new Date())))
      throw new ConflictError('Подписка неактивна');
    const recent = await InviteModel.findOne({
      userId: user._id,
      revokedAt: null,
      usedAt: null,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });
    if (recent) return recent.inviteLink;
    const last = await InviteModel.findOne({ userId: user._id }).sort({ createdAt: -1 });
    if (last && last.createdAt.getTime() > Date.now() - this.rateMinutes * 60_000)
      throw new ConflictError('Новую ссылку можно запросить немного позже');
    const name = `sub-${String(sub._id).slice(-8)}-${Date.now()}`;
    const expiresAt = new Date(Date.now() + this.ttlMinutes * 60_000);
    const link = await this.api.createChatInviteLink(this.channelId, {
      name,
      expire_date: Math.floor(expiresAt.getTime() / 1000),
      creates_join_request: true,
    });
    await InviteModel.create({
      userId: user._id,
      subscriptionId: sub._id,
      expectedTelegramId: telegramId,
      inviteLink: link.invite_link,
      telegramInviteName: name,
      expiresAt,
    });
    this.logger.info({ event: 'invite.created', userId: user.id, subscriptionId: sub.id });
    return link.invite_link;
  }
  async approveExpectedJoinRequest(telegramId: number, inviteLink: string) {
    const invite = await InviteModel.findOne({
      inviteLink,
      expectedTelegramId: telegramId,
      usedAt: null,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    });
    if (!invite) {
      await this.api.declineChatJoinRequest(this.channelId, telegramId);
      this.logger.warn({ event: 'join.declined', telegramId });
      return false;
    }
    const sub = await SubscriptionModel.findOne({
      _id: invite.subscriptionId,
      status: { $in: ['active', 'past_due'] },
    });
    if (!sub || (sub.status === 'past_due' && (!sub.graceUntil || sub.graceUntil <= new Date()))) {
      await this.api.declineChatJoinRequest(this.channelId, telegramId);
      return false;
    }
    await this.api.approveChatJoinRequest(this.channelId, telegramId);
    await this.api.revokeChatInviteLink(this.channelId, invite.inviteLink);
    invite.usedAt = new Date();
    invite.revokedAt = new Date();
    await invite.save();
    this.logger.info({ event: 'join.approved', telegramId });
    return true;
  }
  async removeMember(telegramId: number) {
    await this.api.banChatMember(this.channelId, telegramId);
    this.logger.info({ event: 'member.removed', telegramId });
  }
  async restoreEligibility(telegramId: number) {
    await this.api.unbanChatMember(this.channelId, telegramId, { only_if_banned: true });
  }
}
