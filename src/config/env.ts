import { z } from 'zod';

const bool = z
  .string()
  .default('false')
  .transform((v) => v === 'true');
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_BASE_URL: z.string().url(),
  BUSINESS_TIMEZONE: z.string().default('Europe/Moscow'),
  BOT_TOKEN: z.string().min(20),
  BOT_USERNAME: z
    .string()
    .min(3)
    .regex(/^[A-Za-z0-9_]+$/, 'BOT_USERNAME must be specified without @'),
  CHANNEL_ID: z.string().regex(/^-?\d+$/),
  ADMIN_IDS: z
    .string()
    .default('')
    .transform((v) => v.split(',').filter(Boolean).map(Number)),
  SUPPORT_URL: z.string().url(),
  MONGODB_URI: z.string().min(10),
  WELCOME_VIDEO_NOTE_FILE_ID: z.string().optional(),
  PROJECT_NAME: z.string().min(1),
  PROJECT_DESCRIPTION: z.string().min(1).default('Закрытое пространство'),
  OFFER_URL: z.string().url(),
  OFFER_VERSION: z.string().min(1),
  PRIVACY_URL: z.string().url(),
  PAYMENT_MODE: z.literal('yookassa_external'),
  YOOKASSA_SHOP_ID: z.string().min(1),
  YOOKASSA_SECRET_KEY: z.string().min(1),
  YOOKASSA_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(10_000),
  YOOKASSA_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(15_000),
  PLAN_MONTH_AMOUNT_RUB: z.string().regex(/^\d+(\.\d{1,2})?$/),
  PLAN_THREE_MONTH_AMOUNT_RUB: z.string().regex(/^\d+(\.\d{1,2})?$/),
  PLAN_LIFETIME_AMOUNT_RUB: z.string().regex(/^\d+(\.\d{1,2})?$/),
  CONSULTATION_URL: z.string().url().optional().or(z.literal('')).transform((v) => v || undefined),
  HOW_IT_LOOKS_MEDIA_FILE_ID: z.string().optional().transform((v) => v || undefined),
  CLAIM_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  INVITE_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  INVITE_RATE_LIMIT_MINUTES: z.coerce.number().int().positive().default(5),
  GRACE_PERIOD_DAYS: z.coerce.number().int().positive().default(3),
  RENEWAL_RETRY_OFFSETS_HOURS: z
    .string()
    .default('24,48,72')
    .transform((v) => v.split(',').map(Number))
    .pipe(z.array(z.number().positive()).min(1)),
  SCHEDULER_INTERVAL_MINUTES: z.coerce.number().int().positive().default(10),
  ABANDONED_CHECKOUT_DELAY_MINUTES: z.coerce.number().int().positive().default(60),
  ABANDONED_REMINDER_COOLDOWN_HOURS: z.coerce.number().int().positive().default(24),
  CHECKOUT_SECRET: z.string().min(32),
  TRUST_PROXY: bool,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});
export type Env = z.infer<typeof schema>;
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = schema.safeParse(source);
  if (!result.success)
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  const env = result.data;
  const appHost = new URL(env.APP_BASE_URL).hostname.toLowerCase();
  if (
    env.NODE_ENV === 'production' &&
    (appHost === 'example.com' || appHost.endsWith('.example.com'))
  )
    throw new Error(
      'Invalid environment configuration: APP_BASE_URL must not use example.com in production',
    );
  return env;
}
