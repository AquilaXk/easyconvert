import crypto from 'node:crypto';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import type { UserTier } from '@/lib/auth/types';

export interface BundleTicketFile {
  key: string;
  name: string;
}

export interface BundleTicketRecord {
  files: BundleTicketFile[];
  archiveName: string;
  callerUserId: string;
  callerTier: UserTier;
  createdAt: number;
}

export const BUNDLE_TICKET_TTL_SECONDS = 60;
export const MAX_LOCAL_BUNDLE_TICKETS = 4096;

const BUNDLE_TICKET_TTL_MS = BUNDLE_TICKET_TTL_SECONDS * 1000;
const TICKET_HEX_PATTERN = /^[0-9a-f]{64}$/;
const CONSUME_BUNDLE_TICKET_LUA_SCRIPT =
  "local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]); end; return v";

const GLOBAL_STORE_SYMBOL = Symbol.for('easyconvert.bundleTicketStore');

function localStore(): Map<string, BundleTicketRecord> {
  const g = globalThis as unknown as Record<symbol, Map<string, BundleTicketRecord> | undefined>;
  if (!g[GLOBAL_STORE_SYMBOL]) {
    g[GLOBAL_STORE_SYMBOL] = new Map<string, BundleTicketRecord>();
  }
  return g[GLOBAL_STORE_SYMBOL];
}

function ticketRedisKey(ticket: string): string {
  return `${redisKeyStore.getPrefix()}bundle_ticket:${ticket}`;
}

function sweepLocalStore(store: Map<string, BundleTicketRecord>, now: number): void {
  for (const [id, entry] of store) {
    if (now - entry.createdAt > BUNDLE_TICKET_TTL_MS) {
      store.delete(id);
    }
  }
  while (store.size >= MAX_LOCAL_BUNDLE_TICKETS) {
    const oldest = store.keys().next().value;
    if (!oldest) break;
    store.delete(oldest);
  }
}

function isValidTicketRecord(value: unknown): value is BundleTicketRecord {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Partial<BundleTicketRecord>;
  return (
    Array.isArray(rec.files) &&
    typeof rec.archiveName === 'string' &&
    typeof rec.callerUserId === 'string' &&
    (rec.callerTier === 'free' || rec.callerTier === 'paid') &&
    typeof rec.createdAt === 'number'
  );
}

export async function createBundleTicket(
  record: Omit<BundleTicketRecord, 'createdAt'> & { createdAt?: number }
): Promise<string> {
  const ticket = crypto.randomBytes(32).toString('hex');
  const payload: BundleTicketRecord = {
    files: record.files.map((file) => ({ key: file.key, name: file.name })),
    archiveName: record.archiveName,
    callerUserId: record.callerUserId,
    callerTier: record.callerTier,
    createdAt: record.createdAt ?? Date.now(),
  };

  const redis = redisKeyStore.getRedisClient();
  if (redis) {
    await redis.set(ticketRedisKey(ticket), JSON.stringify(payload), 'EX', BUNDLE_TICKET_TTL_SECONDS);
    return ticket;
  }

  const store = localStore();
  sweepLocalStore(store, Date.now());
  store.set(ticket, payload);
  return ticket;
}

export async function consumeBundleTicket(ticket: string): Promise<BundleTicketRecord | null> {
  if (!TICKET_HEX_PATTERN.test(ticket)) return null;

  const redis = redisKeyStore.getRedisClient();
  if (redis) {
    const raw = await redis.eval(CONSUME_BUNDLE_TICKET_LUA_SCRIPT, 1, ticketRedisKey(ticket));
    if (typeof raw !== 'string' || !raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isValidTicketRecord(parsed)) return null;
      if (Date.now() - parsed.createdAt > BUNDLE_TICKET_TTL_MS) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  const store = localStore();
  const entry = store.get(ticket);
  if (!entry) return null;
  store.delete(ticket);
  if (Date.now() - entry.createdAt > BUNDLE_TICKET_TTL_MS) return null;
  return entry;
}

export function resetLocalBundleTicketsForTests(): void {
  localStore().clear();
}
