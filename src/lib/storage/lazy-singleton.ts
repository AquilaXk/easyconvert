/**
 * A module-level singleton that is built on first use instead of on import. The local-disk
 * backends create directories and start sweepers when constructed, which a deployment on an
 * object store must never do just because the storage module was imported.
 *
 * Every operation is forwarded to the real instance, so `instanceof`, spies and property writes
 * behave as they do on the instance itself. `this` stays the proxy inside methods, which keeps
 * later property lookups on the same forwarding path.
 */
export function lazySingleton<T extends object>(prototype: object, create: () => T): T {
  let instance: T | undefined;
  const resolve = (): T => {
    instance ??= create();
    return instance;
  };
  return new Proxy({} as T, {
    get: (_target, property) => Reflect.get(resolve(), property),
    set: (_target, property, value) => Reflect.set(resolve(), property, value),
    has: (_target, property) => Reflect.has(resolve(), property),
    deleteProperty: (_target, property) => Reflect.deleteProperty(resolve(), property),
    defineProperty: (_target, property, descriptor) => Reflect.defineProperty(resolve(), property, descriptor),
    getOwnPropertyDescriptor: (_target, property) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(resolve(), property);
      if (descriptor) descriptor.configurable = true;
      return descriptor;
    },
    ownKeys: () => Reflect.ownKeys(resolve()),
    getPrototypeOf: () => prototype,
  });
}
