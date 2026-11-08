import type Redis from 'ioredis';
import type { UserConversionFile } from './types';

/**
 * The history of the files a user converted, kept in Redis next to the other account data (`RedisKeyStore`): the records of one
 * user are one JSON value each, `user_file:{<userId>}:<fileId>`, that expires with the retention of the result, and a sorted set
 * `user_files:{<userId>}` of their ids scored by the time they expire. Every key carries the `{<userId>}` tag, so one script
 * stays in one cluster slot and `erase-account` finds them as it finds the rest of the account's keys.
 */

/** Most records a user keeps; the one that expires first goes when a new one would pass it. */
export const MAX_FILE_HISTORY_PER_USER = 500;

/**
 * Stores a record, drops the records that expired and those beyond the cap, and keeps the set at least as long as this record.
 * KEYS[1]: the set of the user  KEYS[2]: the record  ARGV: id, JSON, ttl ms, expiry time ms, now ms, cap, key prefix of the user's records.
 */
const RECORD_FILE_LUA_SCRIPT = `
redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3])
redis.call('ZADD', KEYS[1], ARGV[4], ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[5])
local over = redis.call('ZCARD', KEYS[1]) - tonumber(ARGV[6])
if over > 0 then
  for _, id in ipairs(redis.call('ZRANGE', KEYS[1], 0, over - 1)) do
    redis.call('DEL', ARGV[7] .. id)
  end
  redis.call('ZREMRANGEBYRANK', KEYS[1], 0, over - 1)
end
if redis.call('PTTL', KEYS[1]) < tonumber(ARGV[3]) then
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
end
return 1
`;

/** Removes a record and its id from the set, and answers how many records it removed. KEYS[1]: the set  KEYS[2]: the record  ARGV[1]: id. */
const REMOVE_FILE_LUA_SCRIPT = `
local removed = redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[1], ARGV[1])
return removed
`;

function parseRecord(raw: string | null): UserConversionFile | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as UserConversionFile;
    return typeof parsed?.id === 'string' && typeof parsed.userId === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export class RedisUserFileHistory {
  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix: string,
    private readonly cap: number = MAX_FILE_HISTORY_PER_USER
  ) {}

  private indexKey(userId: string): string {
    return `${this.keyPrefix}user_files:{${userId}}`;
  }

  private recordKeyPrefix(userId: string): string {
    return `${this.keyPrefix}user_file:{${userId}}:`;
  }

  /** Keeps `file` until it expires. Recording the same id again replaces the record. */
  async record(file: UserConversionFile, now: number = Date.now()): Promise<void> {
    // PX and PEXPIRE take whole milliseconds; a fractional retention would make Redis refuse the write.
    const ttlMs = Math.max(1, Math.ceil(file.expiresAt - now));
    await this.redis.eval(
      RECORD_FILE_LUA_SCRIPT,
      2,
      this.indexKey(file.userId),
      this.recordKeyPrefix(file.userId) + file.id,
      file.id,
      JSON.stringify(file),
      String(ttlMs),
      String(Math.ceil(file.expiresAt)),
      String(now),
      String(this.cap),
      this.recordKeyPrefix(file.userId)
    );
  }

  /** The unexpired records of `userId`, newest first. */
  async list(userId: string, now: number = Date.now()): Promise<UserConversionFile[]> {
    const index = this.indexKey(userId);
    const ids = await this.redis.zrangebyscore(index, now, '+inf');
    if (ids.length === 0) return [];
    const prefix = this.recordKeyPrefix(userId);
    const raws = await this.redis.mget(ids.map((id) => prefix + id));
    const files: UserConversionFile[] = [];
    const gone: string[] = [];
    raws.forEach((raw, position) => {
      const file = parseRecord(raw);
      if (file?.userId === userId && file.expiresAt >= now) files.push(file);
      else gone.push(ids[position]);
    });
    // An id whose record is gone (it expired before the set did, or was removed by another process) leaves the set.
    if (gone.length > 0) await this.redis.zrem(index, ...gone).catch(() => undefined);
    return files.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** The record `fileId` of `userId`, or undefined. The key names the user, so no one reaches another user's record. */
  async find(userId: string, fileId: string, now: number = Date.now()): Promise<UserConversionFile | undefined> {
    const file = parseRecord(await this.redis.get(this.recordKeyPrefix(userId) + fileId));
    return file?.userId === userId && file.expiresAt >= now ? file : undefined;
  }

  async remove(userId: string, fileId: string): Promise<boolean> {
    const removed = await this.redis.eval(REMOVE_FILE_LUA_SCRIPT, 2, this.indexKey(userId), this.recordKeyPrefix(userId) + fileId, fileId);
    return Number(removed) > 0;
  }

  /** Removes every record of `userId` and answers them. */
  async forget(userId: string): Promise<UserConversionFile[]> {
    const index = this.indexKey(userId);
    const ids = await this.redis.zrange(index, '0', '-1');
    const prefix = this.recordKeyPrefix(userId);
    const keys = ids.map((id) => prefix + id);
    const files = keys.length > 0 ? (await this.redis.mget(keys)).flatMap((raw) => parseRecord(raw) ?? []) : [];
    await this.redis.del(index, ...keys);
    return files;
  }
}
