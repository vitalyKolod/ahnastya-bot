import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { Logger } from 'pino';
import type { Env } from '../../config/env.js';
import type { Plan, PlanId } from '../../config/plans.js';
import { ru } from '../../content/ru.js';
import { UserModel } from '../../infrastructure/db/models.js';
import { escapeHtml, minorToRub } from '../../shared/utils.js';
import { formatUserDate } from '../../shared/date.js';
import type { ChannelAccessService } from '../../application/channel-access.service.js';
import type { CheckoutService } from '../../application/checkout.service.js';
import type { SubscriptionService } from '../../application/subscription.service.js';
import type { AdminService } from '../../application/admin.service.js';
import type { BroadcastService } from '../../application/broadcast.service.js';
import type { PaymentService } from '../../application/payment.service.js';
import type { AboutGalleryService } from '../../application/about-gallery.service.js';
import type { PurchaseIntentService } from '../../application/purchase-intent.service.js';
import { shouldStartPurchaseIntent } from '../../application/purchase-intent.service.js';

const fmt = formatUserDate;
const isNotModified = (error: unknown) =>
  error instanceof Error && error.message.toLowerCase().includes('message is not modified');
export const aboutGalleryKeyboard = () =>
  new InlineKeyboard().text('❤️ ХОЧУ В КЛАДОВУЮ', 'plans').row().text('← НАЗАД', 'welcome');
export async function acknowledgeCallback(
  ctx: Pick<Context, 'answerCallbackQuery'>,
  next: () => Promise<void>,
) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  await next();
}

export function createBot(
  env: Env,
  plans: ReadonlyMap<PlanId, Plan>,
  checkout: CheckoutService,
  subscriptions: SubscriptionService,
  channel: ChannelAccessService,
  admin: AdminService,
  broadcast: BroadcastService,
  payments: PaymentService,
  gallery: AboutGalleryService,
  purchaseIntents: PurchaseIntentService,
  logger: Logger,
) {
  const bot = new Bot(env.BOT_TOKEN);
  const pendingBroadcasts = new Map<number, string>();

  async function identify(ctx: Context) {
    if (!ctx.from) return null;
    return UserModel.findOneAndUpdate(
      { telegramId: ctx.from.id },
      {
        $set: {
          username: ctx.from.username,
          firstName: ctx.from.first_name,
          lastName: ctx.from.last_name,
          languageCode: ctx.from.language_code,
        },
        $setOnInsert: { onboardingSeenAt: new Date() },
      },
      { upsert: true, new: true },
    );
  }

  async function render(ctx: Context, text: string, keyboard: InlineKeyboard) {
    const user = await identify(ctx);
    const options = { parse_mode: 'HTML' as const, reply_markup: keyboard };
    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(text, options);
        if (user) {
          user.uiMessageId = ctx.callbackQuery.message.message_id;
          await user.save();
        }
        return;
      } catch (error) {
        if (isNotModified(error)) return;
        logger.warn({ event: 'telegram.screen_edit_failed', err: error });
        await ctx.deleteMessage().catch(() => undefined);
      }
    } else if (user?.uiMessageId && ctx.chat) {
      await ctx.api.deleteMessage(ctx.chat.id, user.uiMessageId).catch(() => undefined);
    }
    const sent = await ctx.reply(text, options);
    if (user) {
      user.uiMessageId = sent.message_id;
      await user.save();
    }
  }

  const addConsultation = (keyboard: InlineKeyboard, label = '💌 ХОЧУ НА КОНСУЛЬТАЦИЮ') => {
    if (env.CONSULTATION_URL) keyboard.url(label, env.CONSULTATION_URL).row();
    return keyboard;
  };
  const welcomeKeyboard = () => {
    const keyboard = new InlineKeyboard()
      .text('❤️ ПРИСОЕДИНИТЬСЯ', 'plans')
      .row()
      .text('🖇️ ПОДПИСКА', 'subscription')
      .text('🎬 КАК ЭТО ВЫГЛЯДИТ', 'how_it_looks')
      .row();
    return addConsultation(keyboard);
  };
  const showWelcome = (ctx: Context) => render(ctx, ru.welcome, welcomeKeyboard());
  async function showPlans(ctx: Context) {
    const user = await identify(ctx);
    if (user) {
      const sub = await subscriptions.getForUser(user._id);
      if (!shouldStartPurchaseIntent(sub?.status)) return showSubscription(ctx);
      await purchaseIntents.start(user._id, user.telegramId);
    }
    const keyboard = new InlineKeyboard();
    for (const plan of plans.values())
      if (plan.enabled)
        keyboard.text(`${plan.title} — ${minorToRub(plan.amountMinor)}`, `plan:${plan.id}`).row();
    keyboard.text('← Назад', 'welcome');
    await render(ctx, ru.plans, keyboard);
  }
  async function showGallery(ctx: Context) {
    const richMessage = await gallery.buildRichMessage();
    if (!richMessage) {
      await render(
        ctx,
        ru.howItLooks,
        new InlineKeyboard().text('❤️ ХОЧУ В КЛАДОВУЮ', 'plans').row().text('← Назад', 'welcome'),
      );
      return;
    }
    if (ctx.callbackQuery?.message) await ctx.deleteMessage().catch(() => undefined);
    const sent = await ctx.api.sendRichMessage(ctx.chat!.id, richMessage, {
      reply_markup: aboutGalleryKeyboard(),
    });
    const user = await identify(ctx);
    if (user)
      await UserModel.updateOne({ _id: user._id }, { $set: { uiMessageId: sent.message_id } });
  }
  async function showSubscription(ctx: Context) {
    const user = await identify(ctx);
    if (!user) return;
    const sub = await subscriptions.getForUser(user._id);
    if (!sub) {
      await render(
        ctx,
        'Активной подписки пока нет.',
        new InlineKeyboard().text('Выбрать тариф', 'plans').row().text('← Назад', 'welcome'),
      );
      return;
    }
    const plan = plans.get(sub.planId as PlanId);
    const keyboard = new InlineKeyboard().text('📲 ПЕРЕЙТИ В КАНАЛ', 'invite').row();
    if (sub.autoRenew && !sub.lifetime) keyboard.text('Отключить автосписания', 'cancel').row();
    addConsultation(keyboard, '💌 КОНСУЛЬТАЦИЯ');
    keyboard.text('← Назад', 'welcome');
    await render(
      ctx,
      ru.subscription(
        sub.status,
        plan?.title ?? sub.planId,
        sub.currentPeriodEnd ? fmt(sub.currentPeriodEnd, env.BUSINESS_TIMEZONE) : null,
        plan ? minorToRub(plan.amountMinor) : '—',
        sub.autoRenew,
        sub.lifetime,
      ),
      keyboard,
    );
  }

  async function showReturnedPayment(ctx: Context, paymentToken: string) {
    if (!ctx.from) return;
    logger.info({ event: 'telegram.payment_return.received', telegramId: ctx.from.id });
    const result = await payments.checkReturnedPayment(paymentToken, ctx.from.id);
    if (result.status === 'pending') {
      await render(
        ctx,
        ru.paymentPending,
        new InlineKeyboard().text('🔄 ПРОВЕРИТЬ СТАТУС', `paycheck:${paymentToken}`),
      );
      return;
    }
    if (result.status === 'canceled') {
      await render(
        ctx,
        ru.paymentCanceled,
        new InlineKeyboard()
          .text('💳 ПОПРОБОВАТЬ СНОВА', 'plans')
          .row()
          .text('← В меню', 'welcome'),
      );
      return;
    }
    await channel.restoreEligibility(ctx.from.id);
    await render(
      ctx,
      ru.paymentSuccess(
        result.planTitle,
        result.currentPeriodEnd ? fmt(result.currentPeriodEnd, env.BUSINESS_TIMEZONE) : null,
        result.autoRenew,
        result.lifetime,
      ),
      new InlineKeyboard().text('🔐 ВСТУПИТЬ В КАНАЛ', 'invite'),
    );
  }

  bot.on('callback_query:data', async (ctx, next) => {
    await acknowledgeCallback(ctx, next);
  });
  bot.command('start', async (ctx) => {
    if (!ctx.from) return;
    const paymentToken = ctx.match.startsWith('pay_') ? ctx.match.slice(4) : null;
    if (paymentToken) {
      await identify(ctx);
      await showReturnedPayment(ctx, paymentToken);
      return;
    }
    const claim = ctx.match.startsWith('claim_') ? ctx.match.slice(6) : null;
    if (claim) {
      const result = await checkout.claim(claim, {
        telegramId: ctx.from.id,
        ...(ctx.from.username ? { username: ctx.from.username } : {}),
        firstName: ctx.from.first_name,
        ...(ctx.from.last_name ? { lastName: ctx.from.last_name } : {}),
        ...(ctx.from.language_code ? { languageCode: ctx.from.language_code } : {}),
      });
      await channel.restoreEligibility(ctx.from.id);
      await render(
        ctx,
        ru.claimSuccess(
          result.plan.title,
          result.subscription.currentPeriodEnd
            ? fmt(result.subscription.currentPeriodEnd, env.BUSINESS_TIMEZONE)
            : null,
          result.subscription.autoRenew,
          result.subscription.lifetime,
        ),
        new InlineKeyboard().text('🔐 ПОЛУЧИТЬ ДОСТУП', 'invite'),
      );
      return;
    }
    const user = await identify(ctx);
    const sub = user ? await subscriptions.getForUser(user._id) : null;
    if (sub?.status === 'active') {
      const plan = plans.get(sub.planId as PlanId);
      await render(
        ctx,
        ru.active(
          escapeHtml(ctx.from.first_name),
          plan?.title ?? sub.planId,
          sub.currentPeriodEnd ? fmt(sub.currentPeriodEnd, env.BUSINESS_TIMEZONE) : null,
          sub.autoRenew,
          sub.lifetime,
        ),
        addConsultation(
          new InlineKeyboard()
            .text('📲 ПЕРЕЙТИ В КАНАЛ', 'invite')
            .row()
            .text('🖇️ МОЯ ПОДПИСКА', 'subscription')
            .row(),
        ),
      );
      return;
    }
    if (env.WELCOME_VIDEO_NOTE_FILE_ID)
      await ctx
        .replyWithVideoNote(env.WELCOME_VIDEO_NOTE_FILE_ID)
        .catch((error) => logger.warn({ event: 'welcome.video_note_failed', err: error }));
    await showWelcome(ctx);
  });

  bot.command('subscription', showSubscription);
  bot.command('support', (ctx) =>
    ctx.reply(ru.support, {
      reply_markup: new InlineKeyboard().url('💬 ПОДДЕРЖКА', env.SUPPORT_URL),
    }),
  );
  bot.command('terms', (ctx) =>
    ctx.reply('Оферта:', {
      reply_markup: new InlineKeyboard().url('Открыть оферту', env.OFFER_URL),
    }),
  );
  bot.command('privacy', (ctx) =>
    ctx.reply('Политика конфиденциальности:', {
      reply_markup: new InlineKeyboard().url('Открыть политику', env.PRIVACY_URL),
    }),
  );
  bot.command('admin', async (ctx) => {
    if (!ctx.from || !env.ADMIN_IDS.includes(ctx.from.id)) return;
    const s = await admin.stats();
    await ctx.reply(
      `<b>Панель администратора</b>\n\nПользователей: ${s.users}\nАктивных: ${s.active}\nPast due: ${s.pastDue}\nExpired: ${s.expired}\nАвтопродление: ${s.autoRenew}\nВыручка месяца: ${minorToRub(s.revenueMinor)}\n\nРассылка: <code>/broadcast текст</code>`,
      { parse_mode: 'HTML' },
    );
  });
  bot.command('broadcast', async (ctx) => {
    if (!ctx.from || !env.ADMIN_IDS.includes(ctx.from.id)) return;
    const text = ctx.match.trim();
    if (!text) return void (await ctx.reply('Добавьте текст после команды.'));
    await admin.audit(ctx.from.id, 'broadcast.started', undefined, { length: text.length });
    await ctx.reply(`Предпросмотр:\n\n${text}`, {
      reply_markup: new InlineKeyboard().text('Подтвердить рассылку', `broadcast:${text.length}`),
    });
    pendingBroadcasts.set(ctx.from.id, text);
  });
  bot.callbackQuery(/^broadcast:(\d+)$/, async (ctx) => {
    if (!env.ADMIN_IDS.includes(ctx.from.id)) return;
    const text = pendingBroadcasts.get(ctx.from.id);
    if (!text || text.length !== Number(ctx.match[1]))
      return void (await ctx.reply('Предпросмотр истёк.'));
    pendingBroadcasts.delete(ctx.from.id);
    const result = await broadcast.send(text);
    await admin.audit(ctx.from.id, 'broadcast.completed', undefined, result);
    await ctx.reply(`Рассылка завершена: ${result.success} успешно, ${result.failed} ошибок.`);
  });
  bot.callbackQuery('welcome', showWelcome);
  bot.callbackQuery('plans', showPlans);
  bot.callbackQuery(/^plan:(month|three_months|lifetime)$/, async (ctx) => {
    const plan = plans.get(ctx.match[1] as PlanId);
    if (!plan?.enabled) return void (await showPlans(ctx));
    const user = await identify(ctx);
    if (user) await purchaseIntents.selectPlan(user._id, plan.id);
    await render(
      ctx,
      ru.planDetails(plan.title, minorToRub(plan.amountMinor), plan.lifetime),
      new InlineKeyboard()
        .url('Оферта', env.OFFER_URL)
        .url('Конфиденциальность', env.PRIVACY_URL)
        .row()
        .text(' ПРИНИМАЮ УСЛОВИЯ', `accept:${plan.id}`)
        .row()
        .text('← Назад', 'plans'),
    );
  });
  bot.callbackQuery(/^accept:(month|three_months|lifetime)$/, async (ctx) => {
    const planId = ctx.match[1] as PlanId;
    const plan = plans.get(planId);
    const user = await identify(ctx);
    if (!plan?.enabled || !user) return;
    await render(ctx, ru.paymentCreating, new InlineKeyboard());
    const payment = await checkout.create(planId, user._id, {
      offer: true,
      privacy: true,
      autoRenew: plan.autoRenewSupported,
    });
    await purchaseIntents.attachPayment(user._id, payment.publicId);
    await render(
      ctx,
      ru.paymentReady(plan.title, minorToRub(plan.amountMinor)),
      new InlineKeyboard()
        .url('💳 ПЕРЕЙТИ К ОПЛАТЕ', payment.confirmationUrl)
        .row()
        .text('← Назад', `plan:${plan.id}`),
    );
    const messageId = ctx.callbackQuery.message?.message_id;
    if (messageId) await checkout.savePaymentUiMessage(payment.publicId, messageId);
  });
  bot.callbackQuery('subscription', showSubscription);
  bot.callbackQuery(/^paycheck:([A-Za-z0-9_-]{43})$/, async (ctx) => {
    const token = ctx.match[1]!;
    await showReturnedPayment(ctx, token);
  });
  bot.callbackQuery('inside', (ctx) =>
    render(
      ctx,
      ru.inside,
      new InlineKeyboard().text('✨ ПРИСОЕДИНИТЬСЯ', 'plans').row().text('← Назад', 'welcome'),
    ),
  );
  bot.callbackQuery('how_it_looks', async (ctx) => {
    await showGallery(ctx);
  });
  bot.callbackQuery('abandoned:cancel', async (ctx) => {
    const user = await identify(ctx);
    if (user) await purchaseIntents.cancel(user._id);
  });
  bot.callbackQuery('abandoned:resume', async (ctx) => {
    const user = await identify(ctx);
    if (user) await purchaseIntents.resume(user._id);
    await showPlans(ctx);
  });
  bot.callbackQuery('faq', (ctx) =>
    render(ctx, ru.faq, new InlineKeyboard().text('← Назад', 'welcome')),
  );
  bot.callbackQuery('invite', async (ctx) => {
    await channel.restoreEligibility(ctx.from.id);
    const link = await channel.issueInvite(ctx.from.id);
    await render(
      ctx,
      'Персональная ссылка действует ограниченное время:',
      new InlineKeyboard()
        .url('Присоединиться к каналу', link)
        .row()
        .text('← Назад', 'subscription'),
    );
  });
  bot.callbackQuery('cancel', async (ctx) => {
    const user = await identify(ctx);
    const sub = user ? await subscriptions.getForUser(user._id) : null;
    if (sub)
      await render(
        ctx,
        ru.cancelConfirm(
          sub.currentPeriodEnd
            ? fmt(sub.currentPeriodEnd, env.BUSINESS_TIMEZONE)
            : 'конца оплаченного периода',
        ),
        new InlineKeyboard()
          .text('Да, отменить', 'cancel_confirm')
          .text('Оставить подписку', 'subscription'),
      );
  });
  bot.callbackQuery('cancel_confirm', async (ctx) => {
    const user = await identify(ctx);
    if (user) {
      const sub = await subscriptions.cancelAutoRenew(user._id);
      logger.info({ event: 'subscription.cancel_at_period_end', subscriptionId: sub.id });
    }
    await render(ctx, ru.cancelDone, new InlineKeyboard().text('← Моя подписка', 'subscription'));
  });
  bot.on('chat_join_request', async (ctx) => {
    if (String(ctx.chat.id) !== env.CHANNEL_ID) return;
    await channel.approveExpectedJoinRequest(
      ctx.chatJoinRequest.from.id,
      ctx.chatJoinRequest.invite_link?.invite_link ?? '',
    );
  });
  bot.catch(({ error, ctx }) => {
    logger.error({ event: 'telegram.handler_error', updateId: ctx.update.update_id, err: error });
    void ctx.reply(ru.genericError).catch(() => undefined);
  });
  return bot;
}
