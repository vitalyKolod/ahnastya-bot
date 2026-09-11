import { createHash, randomBytes, randomUUID } from 'node:crypto';
export const newId = () => randomUUID();
export const newToken = () => randomBytes(32).toString('base64url');
export const RETURN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const hashToken = (token: string, secret: string) =>
  createHash('sha256').update(`${secret}:${token}`).digest('hex');
export const escapeHtml = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
export const minorToRub = (n: number) =>
  `${(n / 100).toLocaleString('ru-RU', { minimumFractionDigits: n % 100 ? 2 : 0 })} ₽`;
