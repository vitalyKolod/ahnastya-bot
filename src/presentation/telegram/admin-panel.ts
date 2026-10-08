import { InlineKeyboard, type Bot, type Context } from 'grammy';
import type { Env } from '../../config/env.js';
import { rubToMinor } from '../../config/plans.js';
import { AdminService, type MemberGroup } from '../../application/admin.service.js';
import { formatUserDate } from '../../shared/date.js';
import { escapeHtml, minorToRub } from '../../shared/utils.js';

type Field = 'title' | 'amount' | 'duration';
type Draft = {
  id?: string | undefined;
  field?: Field;
  title?: string;
  amountMinor?: number;
  durationMonths?: number | null;
  step: Field | 'confirm';
};

export function registerAdminPanel(
  bot: Bot,
  env: Env,
  admin: AdminService,
  render: (ctx: Context, text: string, keyboard: InlineKeyboard) => Promise<void>,
) {
  const drafts = new Map<number, Draft>();
  const allowed = (ctx: Context) =>
    Boolean(ctx.from && ctx.chat?.type === 'private' && env.ADMIN_IDS.includes(ctx.from.id));
  const price = (value: string) => {
    const normalized = value.trim().replace(',', '.');
    if (!/^\d+(?:\.\d{1,2})?$/.test(normalized))
      throw new Error('Введите цену в рублях, например 990 или 990,50.');
    return rubToMinor(normalized);
  };
  const duration = (value: string) => {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'навсегда') return null;
    if (!/^\d+$/.test(normalized))
      throw new Error('Введите число месяцев от 1 до 120 или «навсегда».');
    const months = Number(normalized);
    if (months < 1 || months > 120) throw new Error('Срок должен быть от 1 до 120 месяцев.');
    return months;
  };
  const summary = (p: { title: string; amountMinor: number; durationMonths: number | null }) =>
    `<b>${escapeHtml(p.title)}</b>\nЦена: ${minorToRub(p.amountMinor)}\nСрок: ${p.durationMonths === null ? 'навсегда' : `${p.durationMonths} мес.`}`;

  async function dashboard(ctx: Context) {
    if (!allowed(ctx)) return;
    drafts.delete(ctx.from!.id);
    const stats = await admin.stats();
    await render(
      ctx,
      `<b>Привет, Настя! Это твоя админ-панель 👋</b>\n\nПользователей: ${stats.users}\nАктивных подписок: ${stats.active}\nПросрочено: ${stats.pastDue}\nИстекло: ${stats.expired}\nАвтопродление: ${stats.autoRenew}\nВыручка месяца: ${minorToRub(stats.revenueMinor)}\n\nРассылка: <code>/broadcast текст</code>`,
      new InlineKeyboard()
        .text('💳 Тарифы', 'adm:plans:0')
        .row()
        .text('👥 Участники', 'adm:members')
        .row()
        .text('← В меню бота', 'welcome'),
    );
  }

  async function plansPage(ctx: Context, page: number) {
    if (!allowed(ctx)) return;
    drafts.delete(ctx.from!.id);
    const items = admin.listPlans();
    const maxPage = Math.max(0, Math.ceil(items.length / 5) - 1);
    const current = Math.min(page, maxPage);
    const keyboard = new InlineKeyboard();
    for (const plan of items.slice(current * 5, current * 5 + 5))
      keyboard
        .text(
          `${plan.enabled ? '✅' : '🚫'} ${plan.title} — ${minorToRub(plan.amountMinor)}`,
          `adm:plan:${plan.id}`,
        )
        .row();
    if (current > 0) keyboard.text('←', `adm:plans:${current - 1}`);
    if (current < maxPage) keyboard.text('→', `adm:plans:${current + 1}`);
    if (current > 0 || current < maxPage) keyboard.row();
    keyboard.text('➕ Добавить тариф', 'adm:new').row().text('← Админ-панель', 'adm:home');
    await render(
      ctx,
      `<b>Тарифы</b> · страница ${current + 1}/${maxPage + 1}\n\nИзменения цены и срока применяются к новым покупкам.`,
      keyboard,
    );
  }

  async function planPage(ctx: Context, id: string) {
    if (!allowed(ctx)) return;
    drafts.delete(ctx.from!.id);
    const plan = admin.getPlan(id);
    if (!plan) return plansPage(ctx, 0);
    const keyboard = new InlineKeyboard()
      .text('✏️ Название', `adm:edit:${id}:title`)
      .row()
      .text('💰 Цена', `adm:edit:${id}:amount`)
      .row()
      .text('📅 Срок', `adm:edit:${id}:duration`)
      .row()
      .text(
        plan.enabled ? '🗑 Удалить тариф' : '↩️ Восстановить тариф',
        plan.enabled ? `adm:delete:${id}` : `adm:restore:${id}`,
      )
      .row()
      .text('← Тарифы', 'adm:plans:0');
    await render(
      ctx,
      `${summary(plan)}\nСтатус: ${plan.enabled ? 'доступен' : 'удалён из продажи'}`,
      keyboard,
    );
  }

  async function ask(ctx: Context, draft: Draft, error = '') {
    const prompts: Record<Field, string> = {
      title: 'Отправьте название тарифа (до 60 символов).',
      duration: 'Отправьте срок в месяцах (1–120) или слово «навсегда».',
      amount: 'Отправьте цену в рублях, например 990.',
    };
    await render(
      ctx,
      `${error ? `${escapeHtml(error)}\n\n` : ''}<b>${draft.id ? 'Изменение тарифа' : 'Новый тариф'}</b>\n\n${prompts[draft.step as Field]}`,
      new InlineKeyboard().text('Отменить', 'adm:abort'),
    );
  }

  async function preview(ctx: Context, draft: Draft) {
    const current = draft.id ? admin.getPlan(draft.id) : null;
    if (draft.id && !current) return plansPage(ctx, 0);
    const candidate = {
      title: draft.title ?? current?.title ?? '',
      amountMinor: draft.amountMinor ?? current?.amountMinor ?? 0,
      durationMonths:
        draft.durationMonths !== undefined
          ? draft.durationMonths
          : (current?.durationMonths ?? null),
    };
    await render(
      ctx,
      `<b>Проверьте тариф перед сохранением</b>\n\n${summary(candidate)}\n\nПосле подтверждения новая цена появится в боте и будет передаваться ЮKassa при создании новых платежей.`,
      new InlineKeyboard()
        .text('✅ Подтвердить', 'adm:confirm')
        .row()
        .text('Отменить', 'adm:abort'),
    );
  }

  bot.callbackQuery('adm:home', dashboard);
  bot.callbackQuery(/^adm:plans:(\d+)$/, (ctx) => plansPage(ctx, Number(ctx.match[1])));
  bot.callbackQuery(/^adm:plan:([a-z0-9_]{1,32})$/, (ctx) => planPage(ctx, ctx.match[1]!));
  bot.callbackQuery('adm:new', async (ctx) => {
    if (!allowed(ctx)) return;
    const draft: Draft = { step: 'title' };
    drafts.set(ctx.from.id, draft);
    await ask(ctx, draft);
  });
  bot.callbackQuery(/^adm:edit:([a-z0-9_]{1,32}):(title|amount|duration)$/, async (ctx) => {
    if (!allowed(ctx) || !admin.getPlan(ctx.match[1]!)) return;
    const field = ctx.match[2] as Field;
    const draft: Draft = { id: ctx.match[1], field, step: field };
    drafts.set(ctx.from.id, draft);
    await ask(ctx, draft);
  });
  bot.on('message:text', async (ctx, next) => {
    if (!allowed(ctx)) return next();
    if (ctx.message.text.startsWith('/')) return next();
    const draft = drafts.get(ctx.from.id);
    if (!draft || draft.step === 'confirm') return next();
    await ctx.deleteMessage().catch(() => undefined);
    try {
      const value = ctx.message.text.trim();
      if (draft.step === 'title') {
        if (!value || value.length > 60 || /[\r\n]/.test(value))
          throw new Error('Название должно содержать от 1 до 60 символов в одной строке.');
        draft.title = value;
        draft.step = draft.id ? 'confirm' : 'duration';
      } else if (draft.step === 'duration') {
        draft.durationMonths = duration(value);
        draft.step = draft.id ? 'confirm' : 'amount';
      } else {
        draft.amountMinor = price(value);
        if (draft.amountMinor < 100 || draft.amountMinor > 100_000_000)
          throw new Error('Цена должна быть от 1 до 1 000 000 ₽.');
        draft.step = 'confirm';
      }
      if (draft.step === 'confirm') await preview(ctx, draft);
      else await ask(ctx, draft);
    } catch (error) {
      await ask(ctx, draft, error instanceof Error ? error.message : 'Некорректное значение.');
    }
  });
  bot.callbackQuery('adm:confirm', async (ctx) => {
    if (!allowed(ctx)) return;
    const draft = drafts.get(ctx.from.id);
    if (!draft || draft.step !== 'confirm') return plansPage(ctx, 0);
    const current = draft.id ? admin.getPlan(draft.id) : null;
    if (draft.id && !current) return plansPage(ctx, 0);
    const saved = await admin.savePlan({
      ...(draft.id ? { id: draft.id } : {}),
      title: draft.title ?? current?.title ?? '',
      amountMinor: draft.amountMinor ?? current?.amountMinor ?? 0,
      durationMonths:
        draft.durationMonths !== undefined
          ? draft.durationMonths
          : (current?.durationMonths ?? null),
    });
    drafts.delete(ctx.from.id);
    await admin.audit(ctx.from.id, draft.id ? 'plan.updated' : 'plan.created', saved.id, {
      title: saved.title,
      amountMinor: saved.amountMinor,
      durationMonths: saved.durationMonths,
    });
    await planPage(ctx, saved.id);
  });
  bot.callbackQuery('adm:abort', async (ctx) => {
    if (!allowed(ctx)) return;
    drafts.delete(ctx.from.id);
    await plansPage(ctx, 0);
  });
  bot.callbackQuery(/^adm:delete:([a-z0-9_]{1,32})$/, async (ctx) => {
    if (!allowed(ctx)) return;
    const plan = admin.getPlan(ctx.match[1]!);
    if (!plan) return plansPage(ctx, 0);
    await render(
      ctx,
      `Убрать тариф <b>${escapeHtml(plan.title)}</b> из продажи? Уже оформленные подписки сохранятся.`,
      new InlineKeyboard()
        .text('Да, удалить', `adm:delete_confirm:${plan.id}`)
        .row()
        .text('Отмена', `adm:plan:${plan.id}`),
    );
  });
  bot.callbackQuery(/^adm:delete_confirm:([a-z0-9_]{1,32})$/, async (ctx) => {
    if (!allowed(ctx)) return;
    const plan = await admin.setPlanEnabled(ctx.match[1]!, false);
    await admin.audit(ctx.from.id, 'plan.disabled', plan.id);
    await planPage(ctx, plan.id);
  });
  bot.callbackQuery(/^adm:restore:([a-z0-9_]{1,32})$/, async (ctx) => {
    if (!allowed(ctx)) return;
    const plan = await admin.setPlanEnabled(ctx.match[1]!, true);
    await admin.audit(ctx.from.id, 'plan.enabled', plan.id);
    await planPage(ctx, plan.id);
  });

  bot.callbackQuery('adm:members', async (ctx) => {
    if (!allowed(ctx)) return;
    await render(
      ctx,
      '<b>Участники</b>\n\nВыберите группу. В списках по пять человек на страницу; кнопка участника открывает его профиль Telegram.',
      new InlineKeyboard()
        .text('✅ Активные', 'adm:members:active:0')
        .row()
        .text('🌱 Лиды', 'adm:members:leads:0')
        .row()
        .text('⏳ Скоро заканчивается', 'adm:members:expiring:0')
        .row()
        .text('← Админ-панель', 'adm:home'),
    );
  });
  bot.callbackQuery(/^adm:members:(active|leads|expiring):(\d+)$/, async (ctx) => {
    if (!allowed(ctx)) return;
    const group = ctx.match[1] as MemberGroup;
    const requested = Math.min(Number(ctx.match[2]), 100_000);
    const first = await admin.members(group, requested);
    const page = Math.min(requested, Math.max(0, Math.ceil(first.total / 5) - 1));
    const result = page === requested ? first : await admin.members(group, page);
    const descriptions: Record<MemberGroup, string> = {
      active: 'Активные — люди с действующей подпиской.',
      leads: 'Лиды — запустили бота, но ещё не оплатили.',
      expiring: 'Скоро заканчивается — доступ истечёт в ближайшие 7 дней.',
    };
    const keyboard = new InlineKeyboard();
    for (const user of result.rows) {
      const label =
        `${user.firstName || 'Пользователь'}${user.username ? ` @${user.username}` : ` · ${user.telegramId}`}`.slice(
          0,
          60,
        );
      keyboard.url(label, `tg://user?id=${user.telegramId}`).row();
    }
    if (page > 0) keyboard.text('←', `adm:members:${group}:${page - 1}`);
    if ((page + 1) * 5 < result.total) keyboard.text('→', `adm:members:${group}:${page + 1}`);
    if (page > 0 || (page + 1) * 5 < result.total) keyboard.row();
    keyboard.text('← Участники', 'adm:members');
    await render(
      ctx,
      `<b>${descriptions[group]}</b>\nВсего: ${result.total} · страница ${page + 1}/${Math.max(1, Math.ceil(result.total / 5))}${group === 'expiring' && result.rows.length ? `\n\nБлижайшее окончание: ${formatUserDate(result.rows[0]!.currentPeriodEnd!, env.BUSINESS_TIMEZONE)}` : ''}`,
      keyboard,
    );
  });
  return dashboard;
}
