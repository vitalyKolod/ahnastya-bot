import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AboutGalleryService } from '../src/application/about-gallery.service.js';
import { aboutGalleryKeyboard } from '../src/presentation/telegram/bot.js';
import { shouldStartPurchaseIntent } from '../src/application/purchase-intent.service.js';
import { readFile } from 'node:fs/promises';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true }))));

describe('about gallery', () => {
  it('orders 01 through 07 and accepts case-insensitive supported extensions', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gallery-'));
    dirs.push(dir);
    for (const name of ['07.WEBP', '02.jpg', '01.PNG', '03.JPEG']) await writeFile(path.join(dir, name), 'x');
    const service = new AboutGalleryService({ warn: vi.fn() } as never, dir);
    expect((await service.getSlides()).map((slide) => slide.number)).toEqual([1, 2, 3, 7]);
  });

  it('does not crash when slides are missing and returns an empty fallback state', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gallery-'));
    dirs.push(dir);
    const warn = vi.fn();
    const service = new AboutGalleryService({ warn } as never, dir);
    expect(await service.getSlides()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(7);
  });

  it('turns multiple photos into one native slideshow block', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gallery-'));
    dirs.push(dir);
    for (let number = 1; number <= 7; number++)
      await writeFile(path.join(dir, `${String(number).padStart(2, '0')}.PNG`), 'x');
    const rich = await new AboutGalleryService({ warn: vi.fn() } as never, dir).buildRichMessage();
    expect(rich?.blocks?.[0]).toMatchObject({ type: 'slideshow' });
    expect((rich?.blocks?.[0] as { blocks: unknown[] }).blocks).toHaveLength(7);
  });

  it('uses a single native photo block when only one image exists', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gallery-'));
    dirs.push(dir);
    await writeFile(path.join(dir, '01.webp'), 'x');
    const rich = await new AboutGalleryService({ warn: vi.fn() } as never, dir).buildRichMessage();
    expect(rich?.blocks?.[0]).toMatchObject({ type: 'photo' });
  });

  it('keeps only plans CTA and back in the inline keyboard', () => {
    expect(aboutGalleryKeyboard().inline_keyboard).toEqual([
      [{ text: '❤️ ХОЧУ В КЛАДОВУЮ', callback_data: 'plans' }],
      [{ text: '← НАЗАД', callback_data: 'welcome' }],
    ]);
  });

  it('does not start a purchase intent for an active or lifetime-active user', () => {
    expect(shouldStartPurchaseIntent('active')).toBe(false);
    expect(shouldStartPurchaseIntent('expired')).toBe(true);
  });

  it('does not contain the old manual carousel callbacks or editMessageMedia', async () => {
    const source = await readFile(path.resolve('src/presentation/telegram/bot.ts'), 'utf8');
    expect(source).not.toContain('about:prev');
    expect(source).not.toContain('about:next');
    expect(source).not.toContain('editMessageMedia');
  });
});
