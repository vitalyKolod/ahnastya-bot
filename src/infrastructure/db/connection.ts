import mongoose from 'mongoose';
import type { Logger } from 'pino';
export async function connectDatabase(uri: string, logger: Logger): Promise<void> {
  // Query objects are constructed exclusively by repositories/application services.
  // Never pass req.query, req.body, or other user-owned objects to Mongoose filters.
  // Global sanitizeFilter cannot be enabled here because it also escapes our trusted
  // scheduler operators ($lte, $in, $gt), turning them into values and causing CastError.
  mongoose.set('strictQuery', true);
  mongoose.connection.on('disconnected', () => logger.warn({ event: 'mongodb.disconnected' }));
  mongoose.connection.on('error', (err) => logger.error({ event: 'mongodb.error', err }));
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  logger.info({ event: 'mongodb.connected' });
}
export const closeDatabase = () => mongoose.disconnect();
