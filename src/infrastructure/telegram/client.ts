import type { ApiClientOptions } from 'grammy';
import type { Env } from '../../config/env.js';

export function createTelegramClientOptions(
  env: Pick<Env, 'TELEGRAM_API_ROOT' | 'TELEGRAM_PROXY_SECRET'>,
  fetchImplementation: typeof fetch = globalThis.fetch,
): ApiClientOptions {
  if (!env.TELEGRAM_API_ROOT || !env.TELEGRAM_PROXY_SECRET) return {};

  const proxySecret = env.TELEGRAM_PROXY_SECRET;
  const proxyFetch: typeof fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('X-Proxy-Secret', proxySecret);
    return fetchImplementation(input, { ...init, headers });
  };
  return {
    apiRoot: env.TELEGRAM_API_ROOT,
    buildUrl: (apiRoot, _token, method) => `${apiRoot}/${method}`,
    fetch: proxyFetch,
  };
}
