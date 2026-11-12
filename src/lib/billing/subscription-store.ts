import type { UserTier } from '../auth/types';
import { redisUserStore, type RedisUserStore } from '../auth/redis-user-store';
import { failClosed } from '../auth/store-unavailable';
import { entitlementOf, isEntitlingStatus } from './entitlement';
import type { SubscriptionChange, SubscriptionRecord } from './types';

/**
 * Subscription records and the tier they give. The records live under the user store's key prefix, so one atomic script can
 * write the subscription, its index and the account's tier together (the prefix carries one hash tag for every key):
 *
 * - `billing:event:<event id>`        a marker that this event was applied, for `EVENT_ID_TTL_SECONDS`;
 * - `billing:sub:<user id>`           the account's subscription, as JSON;
 * - `billing:subindex:<provider id>`  the account a provider's subscription id belongs to.
 *
 * A step that fails throws `AuthStoreUnavailableError` and is never answered from memory when Redis is configured, as in the
 * user store: a process with its own copy would grant or withhold a plan from a stale state. Without Redis (development and
 * tests) the records live in this process.
 */

/**
 * How long an applied event id is remembered. The signature check already refuses an event older than a few seconds, so
 * this bounds the replay of a captured request; Paddle retries a failed delivery for days, and each retry is signed anew.
 */
export const EVENT_ID_TTL_SECONDS = 7 * 24 * 60 * 60;

export type ApplyResult = 'applied' | 'duplicate' | 'stale' | 'other_subscription' | 'unknown_user';

const APPLY_LUA = `
-- KEYS[1]: event marker, KEYS[2]: the account's subscription, KEYS[3]: the account's record, KEYS[4]: the subscription index
-- ARGV[1]: marker ttl seconds, ARGV[2]: subscription JSON, ARGV[3]: event time, ARGV[4]: new subscription id,
-- ARGV[5]: whether the new status can hold a plan (1 or 0), ARGV[6]: the tier, ARGV[7]: when the tier ends ('' for never),
-- ARGV[8]: user id, ARGV[9]: now
local rawUser = redis.call('GET', KEYS[3])
if not rawUser then return 'unknown_user' end
if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then return 'duplicate' end
local rawSub = redis.call('GET', KEYS[2])
if rawSub then
  local existing = cjson.decode(rawSub)
  if tonumber(existing.eventAt) > tonumber(ARGV[3]) then return 'stale' end
  if existing.providerSubscriptionId ~= ARGV[4] and ARGV[5] ~= '1' then return 'other_subscription' end
end
redis.call('SET', KEYS[2], ARGV[2])
redis.call('SET', KEYS[4], ARGV[8])
local user = cjson.decode(rawUser)
user.tier = ARGV[6]
if ARGV[7] == '' then user.tierUntil = nil else user.tierUntil = tonumber(ARGV[7]) end
user.updatedAt = tonumber(ARGV[9])
redis.call('SET', KEYS[3], cjson.encode(user))
return 'applied'
`;

export class SubscriptionStore {
  private readonly bySubscription = new Map<string, string>();
  private readonly byUser = new Map<string, SubscriptionRecord>();
  private readonly events = new Map<string, number>();

  constructor(private readonly users: RedisUserStore = redisUserStore) {}

  private key(...parts: string[]): string {
    return `${this.users.getKeyPrefix()}${parts.join(':')}`;
  }

  /**
   * Applies one event of the provider: the subscription it describes becomes the account's, and the account takes the tier it
   * gives. An event id applies once. An event older than the newest one applied is `stale`. An event about another
   * subscription than the account's current one is `other_subscription` unless its status can hold a plan, so the late
   * cancellation of an old subscription cannot cancel the plan of a new one. An account that no longer exists is `unknown_user`
   * and nothing is kept, so its event id is not used up.
   */
  async apply(change: SubscriptionChange, now: number = Date.now()): Promise<ApplyResult> {
    const record: SubscriptionRecord = { ...change.subscription, userId: change.userId, eventAt: change.eventAt };
    const { tier, until } = entitlementOf(record, now);
    const holdsPlan = isEntitlingStatus(record.status);
    const client = this.users.getRedisClient();
    if (client) {
      try {
        const result = await client.eval(
          APPLY_LUA,
          4,
          this.key('billing', 'event', change.eventId),
          this.key('billing', 'sub', change.userId),
          this.key(change.userId),
          this.key('billing', 'subindex', record.providerSubscriptionId),
          String(EVENT_ID_TTL_SECONDS),
          JSON.stringify(record),
          String(change.eventAt),
          record.providerSubscriptionId,
          holdsPlan ? '1' : '0',
          tier,
          until === undefined ? '' : String(until),
          change.userId,
          String(now)
        );
        return String(result) as ApplyResult;
      } catch (error) {
        return failClosed('SubscriptionStore', 'apply', error);
      }
    }
    return this.applyInMemory(change.eventId, record, holdsPlan, tier, until, now);
  }

  private async applyInMemory(eventId: string, record: SubscriptionRecord, holdsPlan: boolean, tier: UserTier, until: number | undefined, now: number): Promise<ApplyResult> {
    if (!(await this.users.findById(record.userId))) return 'unknown_user';
    if (this.events.has(eventId)) return 'duplicate';
    this.events.set(eventId, now + EVENT_ID_TTL_SECONDS * 1000);
    const existing = this.byUser.get(record.userId);
    if (existing && existing.eventAt > record.eventAt) return 'stale';
    if (existing && existing.providerSubscriptionId !== record.providerSubscriptionId && !holdsPlan) return 'other_subscription';
    this.byUser.set(record.userId, record);
    this.bySubscription.set(record.providerSubscriptionId, record.userId);
    await this.users.updateUser(record.userId, { tier, tierUntil: until });
    return 'applied';
  }

  async findByUser(userId: string): Promise<SubscriptionRecord | null> {
    const client = this.users.getRedisClient();
    if (!client) return this.byUser.get(userId) ?? null;
    try {
      const raw = await client.get(this.key('billing', 'sub', userId));
      return raw ? (JSON.parse(raw) as SubscriptionRecord) : null;
    } catch (error) {
      return failClosed('SubscriptionStore', 'findByUser', error);
    }
  }

  /** The account a provider's subscription belongs to, for an event that carries no account of its own. */
  async userOfSubscription(providerSubscriptionId: string): Promise<string | null> {
    const client = this.users.getRedisClient();
    if (!client) return this.bySubscription.get(providerSubscriptionId) ?? null;
    try {
      return await client.get(this.key('billing', 'subindex', providerSubscriptionId));
    } catch (error) {
      return failClosed('SubscriptionStore', 'userOfSubscription', error);
    }
  }

  /** Deletes the account's subscription and its index entry; the erasure of an account calls it before the account goes. */
  async forgetUser(userId: string): Promise<void> {
    const record = await this.findByUser(userId);
    const client = this.users.getRedisClient();
    if (client) {
      try {
        await client.del(this.key('billing', 'sub', userId), ...(record ? [this.key('billing', 'subindex', record.providerSubscriptionId)] : []));
      } catch (error) {
        return failClosed('SubscriptionStore', 'forgetUser', error);
      }
    }
    this.byUser.delete(userId);
    if (record) this.bySubscription.delete(record.providerSubscriptionId);
  }

  /** Forgets every record held in this process; for tests. */
  resetStore(): void {
    this.bySubscription.clear();
    this.byUser.clear();
    this.events.clear();
  }
}

export const subscriptionStore = new SubscriptionStore();
