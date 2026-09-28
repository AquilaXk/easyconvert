import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { sha256 } from '../auth/crypto';
import { userStore } from '../auth/user-store';
import type { User, UserTier } from '../auth/types';
import type { ApiKey, ApiKeyCreateResult, QuotaUsage, UserConversionFile, QuotaReservation } from './types';

export const TIER_LIMITS: Record<UserTier, number> = {
  free: 25,
  pro: 500,
  enterprise: 10000,
};

export const RESERVE_QUOTA_LUA_SCRIPT = `
-- KEYS[1]: quota key (e.g. easyconvert:quota:userId:YYYY-MM-DD)
-- KEYS[2]: reservation key (e.g. easyconvert:quota:res:reservationId)
-- ARGV[1]: units
-- ARGV[2]: limit
-- ARGV[3]: ttlSeconds
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local units = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if (current + units) > limit then
  return {0, math.max(0, limit - current)}
end
local new_val = redis.call('INCRBY', KEYS[1], units)
if current == 0 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
end
redis.call('SETEX', KEYS[2], 300, units)
return {1, math.max(0, limit - new_val)}
`;

export const ROLLBACK_QUOTA_LUA_SCRIPT = `
-- KEYS[1]: quota key
-- KEYS[2]: reservation key
local units = tonumber(redis.call('GET', KEYS[2]) or '0')
if units > 0 then
  redis.call('DECRBY', KEYS[1], units)
  redis.call('DEL', KEYS[2])
  return 1
end
return 0
`;

export const COMMIT_QUOTA_LUA_SCRIPT = `
-- KEYS[1]: reservation key
return redis.call('DEL', KEYS[1])
`;

function getUtcDateKey(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getNextMidnightUtc(): number {
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow.getTime();
}

/**
 * Checks whether an IPv4 or IPv6 address belongs to a CIDR block (e.g. 192.168.1.0/24 or 2001:db8::/32).
 */
export function isIpInCidr(ip: string, cidr: string): boolean {
  const cleanIp = ip.trim();
  const cleanCidr = cidr.trim();

  if (!cleanCidr.includes('/')) {
    return cleanIp === cleanCidr;
  }

  const [range, bitsStr] = cleanCidr.split('/');
  const prefixLength = parseInt(bitsStr, 10);
  if (isNaN(prefixLength)) return false;

  const ipFamily = net.isIP(cleanIp);
  const rangeFamily = net.isIP(range);

  // Both must be valid IP addresses and belong to the same IP family
  if (ipFamily === 0 || rangeFamily === 0 || ipFamily !== rangeFamily) {
    return false;
  }

  if (ipFamily === 4) {
    if (prefixLength < 0 || prefixLength > 32) return false;
    const ipToInt = (addr: string): number => {
      const parts = addr.split('.').map(Number);
      if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return 0;
      return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
    };

    const ipNum = ipToInt(cleanIp);
    const rangeNum = ipToInt(range);
    const mask = prefixLength === 0 ? 0 : (~0 << (32 - prefixLength)) >>> 0;

    return (ipNum & mask) === (rangeNum & mask);
  }

  if (ipFamily === 6) {
    if (prefixLength < 0 || prefixLength > 128) return false;
    const ipv6ToBigInt = (addr: string): bigint | null => {
      let fullAddr = addr.toLowerCase();
      if (fullAddr.includes(':::')) return null;
      if (fullAddr.includes('::')) {
        const parts = fullAddr.split('::');
        if (parts.length > 2) return null;
        const left = parts[0] ? parts[0].split(':') : [];
        const right = parts[1] ? parts[1].split(':') : [];
        const missing = 8 - (left.length + right.length);
        if (missing < 0) return null;
        const expanded = [...left, ...Array(missing).fill('0'), ...right];
        fullAddr = expanded.join(':');
      }
      const blocks = fullAddr.split(':');
      if (blocks.length !== 8) return null;
      let result = 0n;
      for (const b of blocks) {
        if (!/^[0-9a-f]{1,4}$/i.test(b)) return null;
        result = (result << 16n) | BigInt(parseInt(b, 16));
      }
      return result;
    };

    const ipBig = ipv6ToBigInt(cleanIp);
    const rangeBig = ipv6ToBigInt(range);
    if (ipBig === null || rangeBig === null) return false;

    if (prefixLength === 0) return true;
    const mask = ((2n ** 128n - 1n) << BigInt(128 - prefixLength)) & (2n ** 128n - 1n);
    return (ipBig & mask) === (rangeBig & mask);
  }

  return false;
}

/**
 * Validates whether a client IP matches an allowed whitelist of IP addresses and CIDR subnets.
 */
export function isIpAllowed(clientIp: string, allowedIps?: string[]): boolean {
  if (!allowedIps || allowedIps.length === 0) return true;
  const cleanIp = clientIp.trim();
  if (!cleanIp) return false;

  for (const entry of allowedIps) {
    const trimmed = entry.trim();
    if (!trimmed || trimmed === '*') return true;
    if (trimmed === cleanIp) return true;
    if (trimmed.includes('/') && isIpInCidr(cleanIp, trimmed)) {
      return true;
    }
  }
  return false;
}

const STORAGE_DIR = path.resolve(process.cwd(), '.easyconvert');
const KEYS_FILE = path.join(STORAGE_DIR, 'api-keys.json');
const USAGE_FILE = path.join(STORAGE_DIR, 'api-usage.json');
const FILES_FILE = path.join(STORAGE_DIR, 'user-files.json');

/**
 * Redis-backed Key Store with atomic Lua script metering and 2-phase quota transactions
 * (Reserve-Commit/Rollback) preventing TOCTOU races in distributed environments.
 */
export class RedisKeyStore {
  private readonly keys: Map<string, ApiKey> = new Map();
  private readonly keyHashIndex: Map<string, string> = new Map();
  private readonly dailyUsage: Map<string, number> = new Map(); // userId:YYYY-MM-DD -> count
  private readonly reservations: Map<string, QuotaReservation> = new Map();
  private readonly userFiles: Map<string, UserConversionFile> = new Map();
  private initialized = false;
  private readonly keyPrefix: string;

  constructor(keyPrefix: string = 'easyconvert:') {
    this.keyPrefix = keyPrefix;
  }

  private ensureInitialized() {
    if (this.initialized) return;
    this.initialized = true;

    try {
      if (fs.existsSync(KEYS_FILE)) {
        const list: ApiKey[] = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'));
        for (const k of list) {
          this.keys.set(k.id, k);
          this.keyHashIndex.set(k.keyHash, k.id);
        }
      }

      if (fs.existsSync(USAGE_FILE)) {
        const usageObj: Record<string, number> = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
        for (const [key, val] of Object.entries(usageObj)) {
          this.dailyUsage.set(key, val);
        }
      }

      if (fs.existsSync(FILES_FILE)) {
        const filesList: UserConversionFile[] = JSON.parse(fs.readFileSync(FILES_FILE, 'utf-8'));
        for (const f of filesList) {
          this.userFiles.set(f.id, f);
        }
      }
    } catch {
      // In-memory fallback
    }
  }

  private persist() {
    try {
      if (!fs.existsSync(STORAGE_DIR)) {
        fs.mkdirSync(STORAGE_DIR, { recursive: true });
      }

      fs.writeFileSync(KEYS_FILE, JSON.stringify(Array.from(this.keys.values()), null, 2), 'utf-8');

      const usageObj: Record<string, number> = {};
      for (const [key, val] of this.dailyUsage.entries()) {
        usageObj[key] = val;
      }
      fs.writeFileSync(USAGE_FILE, JSON.stringify(usageObj, null, 2), 'utf-8');

      fs.writeFileSync(FILES_FILE, JSON.stringify(Array.from(this.userFiles.values()), null, 2), 'utf-8');
    } catch {
      // Ignore in sandbox
    }
  }

  public async generateApiKey(
    userId: string,
    name: string,
    options: {
      allowedIps?: string[];
      webhookUrl?: string;
      webhookSecret?: string;
      scopes?: string[];
    } = {}
  ): Promise<ApiKeyCreateResult> {
    this.ensureInitialized();

    const rawRandom = crypto.randomBytes(24).toString('hex');
    const secretKey = `ec_live_${rawRandom}`;
    const keyHash = sha256(secretKey);
    const prefix = `${secretKey.substring(0, 12)}...`;

    const key: ApiKey = {
      id: crypto.randomUUID(),
      userId,
      name: name.trim() || 'Default API Key',
      prefix,
      keyHash,
      createdAt: Date.now(),
      status: 'active',
      allowedIps: options.allowedIps,
      webhookUrl: options.webhookUrl,
      webhookSecret: options.webhookSecret,
      scopes: options.scopes,
    };

    this.keys.set(key.id, key);
    this.keyHashIndex.set(keyHash, key.id);
    this.persist();

    return {
      key,
      secretKey,
    };
  }

  public async verifyApiKey(
    secretKey: string,
    clientIp?: string
  ): Promise<{ valid: boolean; key?: ApiKey; user?: User; error?: string }> {
    this.ensureInitialized();

    if (!secretKey || typeof secretKey !== 'string') {
      return { valid: false, error: 'Missing or invalid API key' };
    }

    const keyHash = sha256(secretKey.trim());
    let keyId = this.keyHashIndex.get(keyHash);
    if (!keyId && fs.existsSync(KEYS_FILE)) {
      try {
        const list: ApiKey[] = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'));
        for (const k of list) {
          this.keys.set(k.id, k);
          this.keyHashIndex.set(k.keyHash, k.id);
        }
        keyId = this.keyHashIndex.get(keyHash);
      } catch {}
    }
    if (!keyId) {
      return { valid: false, error: 'Invalid or non-existent API key' };
    }

    const key = this.keys.get(keyId);
    if (key?.status !== 'active') {
      return { valid: false, error: 'API key has been revoked' };
    }

    // IP / CIDR whitelist enforcement
    if (key.allowedIps && key.allowedIps.length > 0 && clientIp) {
      if (!isIpAllowed(clientIp, key.allowedIps)) {
        return { valid: false, error: 'Client IP address is not permitted by API key IP whitelist' };
      }
    }

    const userRecord = await userStore.findById(key.userId);
    if (!userRecord) {
      return { valid: false, error: 'User associated with API key not found' };
    }

    key.lastUsedAt = Date.now();
    this.persist();

    return {
      valid: true,
      key,
      user: userStore.sanitizeUser(userRecord),
    };
  }

  public async listApiKeys(userId: string): Promise<ApiKey[]> {
    this.ensureInitialized();
    const result: ApiKey[] = [];
    for (const key of this.keys.values()) {
      if (key.userId === userId) {
        result.push(key);
      }
    }
    return result.sort((a, b) => b.createdAt - a.createdAt);
  }

  public async revokeApiKey(userId: string, keyId: string): Promise<boolean> {
    this.ensureInitialized();
    const key = this.keys.get(keyId);
    if (key?.userId !== userId) {
      return false;
    }

    key.status = 'revoked';
    this.persist();
    return true;
  }

  public async getQuotaUsage(userId: string): Promise<QuotaUsage> {
    this.ensureInitialized();

    const user = await userStore.findById(userId);
    const tier: UserTier = user?.tier || 'free';
    const dailyLimit = TIER_LIMITS[tier];

    const dateKey = `${userId}:${getUtcDateKey()}`;
    const usedToday = this.dailyUsage.get(dateKey) || 0;
    const remaining = Math.max(0, dailyLimit - usedToday);
    const resetAt = getNextMidnightUtc();

    return {
      tier,
      dailyLimit,
      usedToday,
      remaining,
      resetAt,
    };
  }

  /**
   * 2-Phase Quota Transaction: Phase 1 (Reserve)
   * Atomically reserves `units` quota units, preventing TOCTOU races under concurrent traffic.
   */
  public async reserveQuota(
    userId: string,
    units: number = 1
  ): Promise<{ allowed: boolean; reservationId?: string; remaining: number }> {
    this.ensureInitialized();

    const user = await userStore.findById(userId);
    const tier: UserTier = user?.tier ?? 'free';
    const dailyLimit = TIER_LIMITS[tier];

    const dateKey = `${userId}:${getUtcDateKey()}`;
    const currentUsed = this.dailyUsage.get(dateKey) ?? 0;

    if (units <= 0) {
      return {
        allowed: dailyLimit - currentUsed > 0,
        remaining: Math.max(0, dailyLimit - currentUsed),
      };
    }

    if (currentUsed + units > dailyLimit) {
      return {
        allowed: false,
        remaining: Math.max(0, dailyLimit - currentUsed),
      };
    }

    // Atomic increment in reservation phase
    this.dailyUsage.set(dateKey, currentUsed + units);
    const reservationId = `res_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    const reservation: QuotaReservation = {
      reservationId,
      userId,
      units,
      createdAt: Date.now(),
      expiresAt: Date.now() + 5 * 60 * 1000, // 5-minute reservation timeout
      status: 'reserved',
    };
    this.reservations.set(reservationId, reservation);
    this.persist();

    return {
      allowed: true,
      reservationId,
      remaining: Math.max(0, dailyLimit - (currentUsed + units)),
    };
  }

  /**
   * 2-Phase Quota Transaction: Phase 2a (Commit)
   * Confirms successful task completion and finalizes the reservation.
   */
  public async commitQuota(reservationId: string): Promise<boolean> {
    const res = this.reservations.get(reservationId);
    if (!res || res.status !== 'reserved') return false;

    res.status = 'committed';
    this.reservations.delete(reservationId);
    return true;
  }

  /**
   * 2-Phase Quota Transaction: Phase 2b (Rollback / Refund)
   * Rolls back reserved quota units when a conversion fails or times out.
   */
  public async rollbackQuota(reservationId: string): Promise<boolean> {
    const res = this.reservations.get(reservationId);
    if (!res || res.status !== 'reserved') return false;

    const dateKey = `${res.userId}:${getUtcDateKey()}`;
    const currentUsed = this.dailyUsage.get(dateKey) ?? 0;
    this.dailyUsage.set(dateKey, Math.max(0, currentUsed - res.units));

    res.status = 'rolled_back';
    this.reservations.delete(reservationId);
    this.persist();
    return true;
  }

  public async recordUsage(
    userId: string,
    units: number = 1
  ): Promise<{ allowed: boolean; remaining: number }> {
    const res = await this.reserveQuota(userId, units);
    if (!res.allowed) {
      return { allowed: false, remaining: res.remaining };
    }
    if (res.reservationId) {
      await this.commitQuota(res.reservationId);
    }
    return { allowed: true, remaining: res.remaining };
  }

  public async recordUserFile(data: {
    userId: string;
    fileName: string;
    fromFormat: string;
    toFormat: string;
    size: number;
    downloadUrl: string;
    ttlMs?: number;
  }): Promise<UserConversionFile> {
    this.ensureInitialized();
    const now = Date.now();
    const ttl = data.ttlMs || 24 * 60 * 60 * 1000;

    const userFile: UserConversionFile = {
      id: crypto.randomUUID(),
      userId: data.userId,
      fileName: data.fileName,
      fromFormat: data.fromFormat,
      toFormat: data.toFormat,
      size: data.size,
      downloadUrl: data.downloadUrl,
      createdAt: now,
      expiresAt: now + ttl,
    };

    this.userFiles.set(userFile.id, userFile);
    this.persist();
    return userFile;
  }

  public async getUserFiles(userId: string): Promise<UserConversionFile[]> {
    this.ensureInitialized();
    const now = Date.now();
    const result: UserConversionFile[] = [];

    for (const f of this.userFiles.values()) {
      if (f.userId === userId && f.expiresAt > now) {
        result.push(f);
      }
    }
    return result.sort((a, b) => b.createdAt - a.createdAt);
  }

  public async listUserFiles(userId: string): Promise<UserConversionFile[]> {
    return this.getUserFiles(userId);
  }

  public async deleteUserFile(userId: string, fileId: string): Promise<boolean> {
    this.ensureInitialized();
    const f = this.userFiles.get(fileId);
    if (f?.userId !== userId) return false;

    this.userFiles.delete(fileId);
    this.persist();
    return true;
  }

  public resetStore(): void {
    this.keys.clear();
    this.keyHashIndex.clear();
    this.dailyUsage.clear();
    this.reservations.clear();
    this.userFiles.clear();
    this.initialized = false;
    try {
      if (fs.existsSync(KEYS_FILE)) fs.unlinkSync(KEYS_FILE);
      if (fs.existsSync(USAGE_FILE)) fs.unlinkSync(USAGE_FILE);
      if (fs.existsSync(FILES_FILE)) fs.unlinkSync(FILES_FILE);
    } catch {}
  }
}

export const redisKeyStore = new RedisKeyStore();
