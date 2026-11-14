import type Redis from 'ioredis';
import { describe, expect, it } from 'vitest';
import { RedisReservationLedger, reservationIdOf } from '../src/lib/api-keys/reservation-ledger';
import { clusterKeySlot } from './helpers/redis-cluster-slot';

/**
 * On Redis Cluster a command or script that names keys of two slots is refused (CROSSSLOT). Every key of an account carries its hash
 * tag, so the commands of the credit ledger stay in one slot; the payment index (`credits:txnowner:<transaction>`) has no owner in its
 * name, so the erasure of an account deletes each of those keys by itself.
 */

interface Call {
  command: string;
  keys: string[];
}

/** A client that records the keys each command names and answers what the ledger reads back. */
function recordingRedis(calls: Call[]): Redis {
  const answer: Record<string, unknown> = { hkeys: ['txn_one', 'txn_two'], eval: [1, 0, 0] };
  return new Proxy({}, {
    get: (_target, property) => {
      if (property === 'then') return undefined;
      return async (...args: unknown[]) => {
        const command = String(property);
        const keys = command === 'eval' ? (args.slice(2, 2 + Number(args[1])) as string[]) : (args.filter((arg) => typeof arg === 'string') as string[]);
        calls.push({ command, keys });
        return answer[command] ?? 1;
      };
    },
  }) as unknown as Redis;
}

describe('the credit ledger on Redis Cluster', () => {
  const OWNER = 'user_cluster';
  const slotsOf = (call: Call) => new Set(call.keys.map(clusterKeySlot));

  it('names the keys of one slot in each script, whichever window the script is given', async () => {
    const calls: Call[] = [];
    const ledger = new RedisReservationLedger(recordingRedis(calls), 'prefix:');
    const reservationId = reservationIdOf(OWNER, 'b1795000000000');

    await ledger.reserve({ owner: OWNER, day: '2026-11-13', dayLeftMs: 1000, reservationId, units: 2, limit: 10, leaseMs: 90_000 });
    await ledger.used(OWNER, 'b1795000000000');
    await ledger.commit(reservationId);
    await ledger.renew(reservationId, 90_000);
    await ledger.extend(reservationId, 'ext', 1, 10);
    await ledger.revokePackage(OWNER, { transactionId: 'txn', adjustmentId: 'adj', amount: '1', full: true });
    await ledger.packageStanding(OWNER);

    const scripts = calls.filter((call) => call.command === 'eval');
    expect(scripts).toHaveLength(7);
    for (const call of scripts) expect(slotsOf(call).size, call.keys.join(' ')).toBe(1);
  });

  it('deletes the payment index keys of an account apart from the keys of its slot when its credits are forgotten', async () => {
    const calls: Call[] = [];
    await new RedisReservationLedger(recordingRedis(calls), 'prefix:').forgetPackages(OWNER);

    const deletes = calls.filter((call) => call.command === 'del');
    expect(deletes.flatMap((call) => call.keys).sort()).toEqual(
      [
        'prefix:credits:txnowner:txn_one',
        'prefix:credits:txnowner:txn_two',
        `prefix:credits:{${OWNER}}`,
        `prefix:credits:{${OWNER}}:adj`,
        `prefix:credits:{${OWNER}}:debt`,
        `prefix:credits:{${OWNER}}:log`,
        `prefix:credits:{${OWNER}}:pholds`,
        `prefix:credits:{${OWNER}}:plist`,
        `prefix:credits:{${OWNER}}:txns`,
      ].sort()
    );
    for (const call of deletes) expect(slotsOf(call).size, call.keys.join(' ')).toBe(1);
  });
});
