import { randomUUID } from 'node:crypto';
import { LockModel } from './models.js';
export class MongoLease {
  private readonly owner = randomUUID();
  constructor(
    private readonly name: string,
    private readonly ttlMs: number,
  ) {}
  async run<T>(work: () => Promise<T>): Promise<T | undefined> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + this.ttlMs);
    try {
      const lock = await LockModel.findOneAndUpdate(
        { _id: this.name, $or: [{ leaseUntil: { $lte: now } }, { owner: this.owner }] },
        { $set: { owner: this.owner, leaseUntil } },
        { upsert: true, new: true },
      );
      if (lock.owner !== this.owner) return undefined;
      return await work();
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: number }).code === 11000
      )
        return undefined;
      throw error;
    } finally {
      await LockModel.updateOne(
        { _id: this.name, owner: this.owner },
        { $set: { leaseUntil: new Date(0) } },
      );
    }
  }
}
