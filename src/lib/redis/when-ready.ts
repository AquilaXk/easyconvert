import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';

/** Longest a command waits for the connection; ioredis's first connection attempt falls well inside it. */
export const REDIS_READY_WAIT_MS = 2_000;
/** After a wait ran out, commands go out at once for this long, so an outage fails every call quickly instead of waiting each time. */
export const REDIS_UNREACHABLE_HOLD_MS = 5_000;

/** Calls that build a pipeline or manage the connection and must not wait for it. */
const UNGATED_METHODS = new Set<string | symbol>([
  'constructor',
  'connect',
  'disconnect',
  'quit',
  'duplicate',
  'pipeline',
  'multi',
  'defineCommand',
]);

interface ReadyGate {
  wait?: Promise<void>;
  unreachableUntil: number;
}

const gates = new WeakMap<Redis, ReadyGate>();

function noop(): void {}

function gateOf(client: Redis): ReadyGate {
  let gate = gates.get(client);
  if (!gate) {
    gate = { unreachableUntil: 0 };
    gates.set(client, gate);
  }
  return gate;
}

function waitForReady(client: Redis, gate: ReadyGate): Promise<void> {
  return new Promise<void>((resolve) => {
    const finish = (connected: boolean): void => {
      clearTimeout(timer);
      client.off('ready', onReady);
      gate.wait = undefined;
      if (!connected) gate.unreachableUntil = Date.now() + REDIS_UNREACHABLE_HOLD_MS;
      resolve();
    };
    const onReady = (): void => finish(true);
    const timer = setTimeout(() => finish(false), REDIS_READY_WAIT_MS);
    client.once('ready', onReady);
    if (client.status === 'wait') client.connect().catch(noop);
  });
}

/**
 * Resolves when the client is ready, or after REDIS_READY_WAIT_MS. It never rejects: a command sent after a wait that
 * ran out fails by itself, so each caller keeps its own handling of an unreachable Redis. All callers of a client share
 * one wait and one `ready` listener.
 */
export function whenReady(client: Redis): Promise<void> {
  if (client.status === 'ready' || client.status === 'end') return Promise.resolve();
  const gate = gateOf(client);
  if (Date.now() < gate.unreachableUntil) return Promise.resolve();
  gate.wait ??= waitForReady(client, gate);
  return gate.wait;
}

/**
 * A client built with `enableOfflineQueue: false` refuses every command sent before the connection is ready, which
 * includes the first commands after the process starts. This connects the client now, keeps a connection error from
 * becoming an unhandled event (it surfaces on the command that needs Redis), and returns the client with every command
 * waiting for `whenReady` first. Redis that is really down still fails fast: one wait, then immediate failures.
 */
export function readyGatedRedis(client: Redis): Redis {
  client.on('error', noop);
  if (client.status === 'wait') client.connect().catch(noop);
  return new Proxy(client, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (UNGATED_METHODS.has(property) || property in EventEmitter.prototype) return value.bind(target);
      return (...args: unknown[]) => whenReady(target).then(() => value.apply(target, args));
    },
  });
}
