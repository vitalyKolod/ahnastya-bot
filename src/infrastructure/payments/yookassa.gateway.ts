import { z } from 'zod';
import {
  ExternalServiceError,
  TransientExternalServiceError,
  ValidationError,
} from '../../shared/errors.js';
import type {
  CreatePaymentInput,
  NormalizedWebhook,
  PaymentGateway,
  ProviderPayment,
} from './payment-gateway.js';
const providerSchema = z.object({
  id: z.string(),
  status: z.string(),
  paid: z.boolean().default(false),
  amount: z.object({ value: z.string(), currency: z.string() }),
  metadata: z.record(z.string(), z.string()).default({}),
  payment_method: z.object({ id: z.string(), saved: z.boolean().default(false) }).optional(),
  captured_at: z.string().optional(),
  confirmation: z.object({ confirmation_url: z.string().url() }).optional(),
});
const webhookSchema = z.object({ event: z.string(), object: z.object({ id: z.string() }) });
export class YooKassaPaymentGateway implements PaymentGateway {
  constructor(
    private readonly shopId: string,
    private readonly secret: string,
    connectTimeoutMs = 10_000,
    private readonly requestTimeoutMs = 15_000,
  ) {
    // Native fetch exposes one abort deadline; keep the separately validated value
    // in the adapter signature so a dispatcher-level connect timeout can be added later.
    void connectTimeoutMs;
  }
  private isTransientNetworkError(error: unknown) {
    if (!(error instanceof Error)) return false;
    const code =
      (error as Error & { code?: string; cause?: { code?: string } }).code ??
      (error as Error & { cause?: { code?: string } }).cause?.code;
    return (
      [
        'ETIMEDOUT',
        'ECONNRESET',
        'EAI_AGAIN',
        'ENETUNREACH',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_SOCKET',
      ].includes(code ?? '') ||
      /fetch failed|connect.*timeout|socket.*timeout|network/i.test(error.message)
    );
  }
  private async sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
  private async request(
    path: string,
    init: RequestInit,
    idempotenceKey?: string,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${this.shopId}:${this.secret}`).toString('base64')}`,
      'Content-Type': 'application/json',
    };
    if (idempotenceKey) headers['Idempotence-Key'] = idempotenceKey;
    const delays = init.method === 'GET' ? [0, 1_000, 3_000] : [0];
    let lastError: unknown;
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (delays[attempt]) await this.sleep(delays[attempt]!);
      try {
        const timeout = this.requestTimeoutMs;
        const response = await fetch(`https://api.yookassa.ru/v3${path}`, {
          ...init,
          headers,
          signal: AbortSignal.timeout(timeout),
        });
        if (response.ok) return response.json();
        if ([429, 500, 502, 503, 504].includes(response.status))
          throw new TransientExternalServiceError(`YooKassa request failed (${response.status})`);
        throw new ExternalServiceError(`YooKassa request failed (${response.status})`);
      } catch (error) {
        const transient =
          error instanceof TransientExternalServiceError ||
          (error instanceof DOMException && error.name === 'TimeoutError') ||
          this.isTransientNetworkError(error);
        if (!transient) throw error;
        lastError = error;
        if (attempt === delays.length - 1)
          throw error instanceof TransientExternalServiceError
            ? error
            : new TransientExternalServiceError('YooKassa request temporarily unavailable', error);
      }
    }
    throw lastError;
  }
  private map(raw: unknown): ProviderPayment {
    const p = providerSchema.parse(raw);
    return {
      id: p.id,
      status: p.status,
      paid: p.paid,
      amountMinor: Math.round(Number(p.amount.value) * 100),
      currency: p.amount.currency,
      metadata: p.metadata,
      ...(p.payment_method ? { paymentMethod: p.payment_method } : {}),
      ...(p.captured_at ? { paidAt: new Date(p.captured_at) } : {}),
      ...(p.confirmation ? { confirmationUrl: p.confirmation.confirmation_url } : {}),
    };
  }
  private body(i: CreatePaymentInput, recurring: boolean) {
    const body = {
      amount: {
        value: (i.amountMinor / 100).toFixed(2),
        currency: i.currency,
      },
      capture: true,
      description: i.description,
      metadata: i.metadata,
      ...(recurring
        ? { payment_method_id: i.paymentMethodId }
        : {
            confirmation: {
              type: 'redirect',
              return_url: i.returnUrl,
            },
            save_payment_method: i.savePaymentMethod,
          }),
    };

    console.log('YOOKASSA BODY:', JSON.stringify(body));

    return JSON.stringify(body);
  }
  async createInitialPayment(i: CreatePaymentInput) {
    return this.map(
      await this.request(
        '/payments',
        { method: 'POST', body: this.body(i, false) },
        i.idempotenceKey,
      ),
    );
  }
  async createRecurringPayment(i: CreatePaymentInput) {
    if (!i.paymentMethodId) throw new ValidationError('Saved payment method is required');
    return this.map(
      await this.request(
        '/payments',
        { method: 'POST', body: this.body(i, true) },
        i.idempotenceKey,
      ),
    );
  }
  async getPayment(id: string) {
    return this.map(await this.request(`/payments/${encodeURIComponent(id)}`, { method: 'GET' }));
  }
  async refundPayment(id: string, amountMinor: number, key: string) {
    await this.request(
      '/refunds',
      {
        method: 'POST',
        body: JSON.stringify({
          payment_id: id,
          amount: { value: (amountMinor / 100).toFixed(2), currency: 'RUB' },
        }),
      },
      key,
    );
  }
  normalizeWebhookEvent(payload: unknown): NormalizedWebhook {
    const p = webhookSchema.safeParse(payload);
    if (!p.success) throw new ValidationError('Invalid YooKassa webhook');
    const type =
      p.data.event === 'payment.succeeded'
        ? 'succeeded'
        : p.data.event === 'payment.canceled'
          ? 'canceled'
          : p.data.event.startsWith('refund.')
            ? 'refund'
            : 'ignored';
    return { type, providerPaymentId: p.data.object.id };
  }
}
