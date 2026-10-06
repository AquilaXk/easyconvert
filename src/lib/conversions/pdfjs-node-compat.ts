/**
 * Runtime features pdfjs-dist needs that Node.js 20 lacks, added when missing. Import this module before
 * the first `getDocument` call, in every thread that loads pdfjs.
 *
 * `ArrayBuffer.prototype.transferToFixedLength` is the one that matters most: without it pdfjs fails
 * inside `getOperatorList`, logs "ignoring errors" at a low verbosity and returns an operator list with no
 * glyphs, so word widths silently degrade to equal shares. `Promise.withResolvers` is needed to start a
 * document at all.
 */

const promiseConstructor = Promise as unknown as { withResolvers?: unknown };

if (typeof promiseConstructor.withResolvers === 'undefined') {
  promiseConstructor.withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

const bufferPrototype = ArrayBuffer.prototype as unknown as { transferToFixedLength?: unknown; transfer?: unknown };

if (typeof bufferPrototype.transferToFixedLength === 'undefined') {
  /** Moves the contents into a new buffer (detaching the old one) and resizes it, as the standard method does. */
  const transferToFixedLength = function transferToFixedLength(this: ArrayBuffer, newLength?: number): ArrayBuffer {
    const moved = structuredClone(this, { transfer: [this] });
    if (newLength === undefined || newLength === moved.byteLength) return moved;
    const resized = new ArrayBuffer(newLength);
    new Uint8Array(resized).set(new Uint8Array(moved, 0, Math.min(newLength, moved.byteLength)));
    return resized;
  };
  Object.defineProperty(bufferPrototype, 'transferToFixedLength', { value: transferToFixedLength, configurable: true, writable: true });
  if (typeof bufferPrototype.transfer === 'undefined') {
    Object.defineProperty(bufferPrototype, 'transfer', { value: transferToFixedLength, configurable: true, writable: true });
  }
}

export {};
