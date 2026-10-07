import type { IStorageBackend, StoredObject } from './oci-storage';

export interface ScopedStorage {
  /** The backend to use for the duration of one unit of work. */
  storage: IStorageBackend;
  /** Releases everything the scope read: removes scratch files a remote backend staged for it. */
  releaseAll(): Promise<void>;
}

/**
 * Wraps a backend so that every object read through it is released when the unit of work (one
 * job, one graph node) ends. A local backend's objects have nothing to release, so for it the
 * scope changes nothing; a remote backend stages large objects to a scratch file that the
 * `release` hook of the stored object removes.
 */
export function scopeStorageObjects(backend: IStorageBackend): ScopedStorage {
  const opened: StoredObject[] = [];
  const storage = new Proxy(backend, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property === 'getObject' && typeof value === 'function') {
        return async (key: string): Promise<StoredObject | undefined> => {
          const stored = await (value as IStorageBackend['getObject']).call(target, key);
          if (stored?.release) opened.push(stored);
          return stored;
        };
      }
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return {
    storage,
    async releaseAll(): Promise<void> {
      const pending = opened.splice(0);
      await Promise.all(pending.map((stored) => stored.release?.().catch(() => undefined)));
    },
  };
}
