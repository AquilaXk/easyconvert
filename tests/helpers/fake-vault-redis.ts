/**
 * The part of ioredis the credentials vault uses, over maps: strings (SET with PX and NX, SETEX, GET, MGET, DEL, EXISTS, SCAN one key at
 * a time, KEYS), sets (SADD, SREM, SMEMBERS, SISMEMBER) and pipelines. `state.down` makes every command fail, as a Redis that does not answer.
 */
export function fakeVaultRedis() {
  const data = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const state = { down: false };
  const guard = <T>(value: () => T): Promise<T> => (state.down ? Promise.reject(new Error('redis down')) : Promise.resolve(value()));

  const commands = {
    set: (key: string, value: string, ...flags: (string | number)[]) =>
      guard(() => {
        if (flags.includes('NX') && data.has(key)) return null;
        data.set(key, value);
        return 'OK';
      }),
    setex: (key: string, _ttl: number, value: string) => guard(() => (data.set(key, value), 'OK')),
    get: (key: string) => guard(() => data.get(key) ?? null),
    mget: (...keys: (string | string[])[]) => guard(() => keys.flat().map((key) => data.get(key) ?? null)),
    del: (...keys: string[]) => guard(() => keys.filter((key) => data.delete(key) || sets.delete(key)).length),
    exists: (...keys: string[]) => guard(() => keys.filter((key) => data.has(key) || sets.has(key)).length),
    keys: (pattern: string) => guard(() => [...data.keys()].filter((key) => key.startsWith(pattern.replace('*', '')))),
    scan: (cursor: string, _matchToken: string, pattern: string) =>
      guard(() => {
        const matching = [...data.keys()].filter((key) => key.startsWith(pattern.replace('*', '')));
        const index = Number(cursor);
        const next = index + 1 < matching.length ? String(index + 1) : '0';
        return [next, matching.slice(index, index + 1)] as [string, string[]];
      }),
    sadd: (key: string, ...members: string[]) =>
      guard(() => {
        const set = sets.get(key) ?? new Set<string>();
        sets.set(key, set);
        const before = set.size;
        for (const member of members) set.add(member);
        return set.size - before;
      }),
    srem: (key: string, ...members: string[]) =>
      guard(() => {
        const set = sets.get(key);
        const removed = members.filter((member) => set?.delete(member)).length;
        if (set?.size === 0) sets.delete(key);
        return removed;
      }),
    smembers: (key: string) => guard(() => [...(sets.get(key) ?? [])]),
    sismember: (key: string, member: string) => guard(() => (sets.get(key)?.has(member) ? 1 : 0)),
  };

  const pipeline = () => {
    const queued: (() => Promise<unknown>)[] = [];
    const chain: Record<string, unknown> = {
      get length() {
        return queued.length;
      },
      exec: async () => {
        const results: [Error | null, unknown][] = [];
        for (const run of queued) {
          try {
            results.push([null, await run()]);
          } catch (error) {
            results.push([error as Error, undefined]);
          }
        }
        return results;
      },
    };
    for (const [name, command] of Object.entries(commands)) {
      chain[name] = (...args: unknown[]) => {
        queued.push(() => (command as (...a: unknown[]) => Promise<unknown>)(...args));
        return chain;
      };
    }
    return chain;
  };

  const client = { status: 'ready', ...commands, pipeline };
  return { client, data, sets, state };
}
