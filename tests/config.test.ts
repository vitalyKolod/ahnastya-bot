import { describe, expect, it } from 'vitest';
import { rubToMinor } from '../src/config/plans.js';
import { hashToken, newToken } from '../src/shared/utils.js';
describe('money and tokens', () => {
  it('converts RUB without float arithmetic', () => {
    expect(rubToMinor('1990')).toBe(199000);
    expect(rubToMinor('10.05')).toBe(1005);
  });
  it('creates opaque token and stable non-raw hash', () => {
    const token = newToken();
    expect(token.length).toBeGreaterThan(30);
    expect(hashToken(token, 'x')).toBe(hashToken(token, 'x'));
    expect(hashToken(token, 'x')).not.toContain(token);
    expect(`pay_${token}`).toHaveLength(47);
    expect(`pay_${token}`.length).toBeLessThanOrEqual(64);
  });
});
