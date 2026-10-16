import type { Api } from 'grammy';
import type { Logger } from 'pino';
import { UserModel } from '../infrastructure/db/models.js';
export class BroadcastService {
  constructor(
    private readonly api: Api,
    private readonly logger: Logger,
  ) {}
  async send(messageIds: number[], fromChatId: number) {
    let success = 0,
      failed = 0;
    const cursor = UserModel.find().select({ telegramId: 1 }).cursor();
    for await (const user of cursor) {
      try {
        if (messageIds.length === 1)
          await this.api.copyMessage(user.telegramId, fromChatId, messageIds[0]!);
        else await this.api.copyMessages(user.telegramId, fromChatId, messageIds);
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
