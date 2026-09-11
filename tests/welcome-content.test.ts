import { describe, expect, it } from 'vitest';
import { ru } from '../src/content/ru.js';

describe('welcome content', () => {
  it('contains all configured Telegram custom emoji IDs', () => {
    for (const id of ['5334952914731436840', '5357503593274418135', '5334681721906432448', '5332277390624200444'])
      expect(ru.welcome).toContain(`<tg-emoji emoji-id="${id}">`);
  });
});
