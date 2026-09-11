import type { Api } from 'grammy';
import type { Logger } from 'pino';
import { UserModel } from '../infrastructure/db/models.js';
export class BroadcastService {
  constructor(
    private readonly api: Api,
    private readonly logger: Logger,
  ) {}
  async send(text: string) {
    let success = 0,
      failed = 0;
    const cursor = UserModel.find().select({ telegramId: 1 }).cursor();
    for await (const user of cursor) {
      try {
        await this.api.sendMessage(user.telegramId, text);
        success++;
      } catch (error) {
        failed++;
        this.logger.warn({ event: 'broadcast.delivery_failed', userId: user.id, err: error });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
    }
    this.logger.info({ event: 'broadcast.completed', success, failed });
    return { success, failed };
  }
}
