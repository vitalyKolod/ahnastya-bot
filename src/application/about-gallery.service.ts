import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { InputFile } from 'grammy';
import type { InputRichBlockPhoto, InputRichBlockSlideshow, InputRichMessage, RichMessage } from 'grammy/types';

const IMAGE_NAME = /^(0[1-7])\.(png|jpe?g|webp)$/i;

export interface AboutSlide {
  number: number;
  path: string;
}

export class AboutGalleryService {
  private slides?: AboutSlide[];
  private photoFileIds: string[] | undefined;

  constructor(
    private readonly logger: Pick<Logger, 'warn'>,
    private readonly directory = path.resolve(process.cwd(), 'public', 'about'),
  ) {}

  async getSlides() {
    if (this.slides) return this.slides;
    let names: string[] = [];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      this.logger.warn({
        event: 'about_gallery.directory_unavailable',
        err: error,
        directory: this.directory,
      });
    }
    const byNumber = new Map<number, string>();
    for (const name of names) {
      const match = IMAGE_NAME.exec(name);
      if (match) byNumber.set(Number(match[1]), path.join(this.directory, name));
    }
    this.slides = [...byNumber]
      .sort(([a], [b]) => a - b)
      .map(([number, filePath]) => ({
        number,
        path: filePath,
      }));
    for (let number = 1; number <= 7; number++)
      if (!byNumber.has(number))
        this.logger.warn({ event: 'about_gallery.slide_missing', slide: number });
    return this.slides;
  }

  async count() {
    return (await this.getSlides()).length;
  }

  async getSlide(index: number) {
    const slides = await this.getSlides();
    return Number.isInteger(index) && index >= 0 && index < slides.length ? slides[index] : null;
  }

  async buildRichMessage(): Promise<InputRichMessage | null> {
    const slides = await this.getSlides();
    if (slides.length === 0) return null;
    const photos: InputRichBlockPhoto[] = slides.map((slide, index) => ({
      type: 'photo',
      photo: { type: 'photo', media: this.photoFileIds?.[index] ?? new InputFile(slide.path) },
    }));
    const mediaBlock: InputRichBlockPhoto | InputRichBlockSlideshow =
      photos.length === 1 ? photos[0]! : { type: 'slideshow', blocks: photos };
    return {
      blocks: [
        mediaBlock,
        {
          type: 'paragraph',
          text: [
            { type: 'bold', text: '🎬 Как выглядит кладовая?' },
            '\n\nИнформация выходит до 5 раз в неделю! Есть разовые форматы, еженедельные рубрики, туториалы, трендовые шрифты, уроки и личный опыт по сотрудничествам, идеи для постов, фото, reels и тд',

            '\n\nИ небольшой секрет — всех участниц канала ожидает ежемесячная рубрика по разбору профиля от меня🤫 ',
          ],
        },
      ],
    };
  }

  rememberUploadedPhotos(message: RichMessage) {
    const media = message.blocks[0];
    const photos = media?.type === 'slideshow' ? media.blocks : media ? [media] : [];
    if (photos.length !== this.slides?.length || !photos.every((block) => block.type === 'photo'))
      return;
    this.photoFileIds = photos.map((block) => block.type === 'photo' ? block.photo.at(-1)?.file_id ?? '' : '');
    if (this.photoFileIds.some((id) => !id)) this.photoFileIds = undefined;
  }
}
