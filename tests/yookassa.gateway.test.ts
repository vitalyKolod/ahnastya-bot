import { afterEach, describe, expect, it, vi } from 'vitest';
import { YooKassaPaymentGateway } from '../src/infrastructure/payments/yookassa.gateway.js';

describe('YooKassa initial payment', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses redirect confirmation, server amount, saved method and idempotency', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'provider-payment',
          status: 'pending',
          paid: false,
          amount: { value: '1990.00', currency: 'RUB' },
          metadata: { internalPaymentId: 'internal-payment' },
          confirmation: { confirmation_url: 'https://yookassa.example/confirmation' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const gateway = new YooKassaPaymentGateway('shop', 'secret');

    const result = await gateway.createInitialPayment({
      idempotenceKey: 'initial:internal-payment',
      amountMinor: 199_000,
      currency: 'RUB',
      description: 'Test plan',
      returnUrl: 'https://app.example/payment/return',
      savePaymentMethod: true,
      metadata: { internalPaymentId: 'internal-payment' },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ 'Idempotence-Key': 'initial:internal-payment' });
    expect(typeof init.body).toBe('string');
    expect(JSON.parse(init.body as string)).toMatchObject({
      amount: { value: '1990.00', currency: 'RUB' },
      capture: true,
      confirmation: { type: 'redirect', return_url: 'https://app.example/payment/return' },
      save_payment_method: true,
      metadata: { internalPaymentId: 'internal-payment' },
    });
    expect(result.confirmationUrl).toBe('https://yookassa.example/confirmation');
  });
});

describe('YooKassa GET retry policy', () => {
  const payment = () =>
    new Response(
      JSON.stringify({
        id: 'provider-payment',
        status: 'succeeded',
        paid: true,
        amount: { value: '100.00', currency: 'RUB' },
        metadata: {},
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('retries a fetch timeout and succeeds on the second attempt', async () => {
    vi.useFakeTimers();
    const timeout = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
    });
    const fetchMock = vi.fn().mockRejectedValueOnce(timeout).mockResolvedValueOnce(payment());
    vi.stubGlobal('fetch', fetchMock);
    const resultPromise = new YooKassaPaymentGateway('shop', 'secret').getPayment(
      'provider-payment',
    );
    await vi.runAllTimersAsync();
    await expect(resultPromise).resolves.toMatchObject({ status: 'succeeded' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([429, 500, 502, 503, 504])('retries HTTP %s', async (status) => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status }))
      .mockResolvedValueOnce(payment());
    vi.stubGlobal('fetch', fetchMock);
    const resultPromise = new YooKassaPaymentGateway('shop', 'secret').getPayment(
      'provider-payment',
    );
    await vi.runAllTimersAsync();
    await resultPromise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404])('does not retry HTTP %s', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      new YooKassaPaymentGateway('shop', 'secret').getPayment('provider-payment'),
    ).rejects.toThrow(`YooKassa request failed (${status})`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
