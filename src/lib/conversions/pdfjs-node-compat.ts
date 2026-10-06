/**
 * Runtime features pdfjs-dist needs that Node.js 20 lacks, added when missing. Import this module before
 * the first `getDocument` call, in every thread that loads pdfjs.
 *
 * `ArrayBuffer.prototype.transferToFixedLength` is the one that matters most: without it pdfjs fails
 * inside `getOperatorList`, logs "ignoring errors" at a low verbosity and returns an operator list with no
 * glyphs, so word widths silently degrade to equal shares. `Promise.withResolvers` is needed to start a
 * document at all. Both follow ECMAScript 2024; pdfjs calls no other transfer method.
 */

interface PromiseStatics {
  withResolvers?: unknown;
}

interface ArrayBufferMethods {
  transferToFixedLength?: unknown;
}

const byteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get;
const sliceBuffer = ArrayBuffer.prototype.slice;

function defineMethod(target: object, name: string, method: unknown): void {
  Object.defineProperty(target, name, { value: method, configurable: true, writable: true, enumerable: false });
}

/** ToIndex: undefined is the default, NaN is 0, fractions truncate, negative or unsafe values are a RangeError. */
function toIndex(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const number = Math.trunc(Number(value));
  if (Number.isNaN(number)) return 0;
  if (number < 0 || number > Number.MAX_SAFE_INTEGER) throw new RangeError(`Invalid array buffer length: ${String(value)}`);
  return number;
}

/** The byte length of an ArrayBuffer receiver; a TypeError for anything else, including a SharedArrayBuffer. */
function receiverLength(receiver: unknown): number {
  if (byteLengthGetter === undefined) throw new TypeError('ArrayBuffer is not available');
  return byteLengthGetter.call(receiver) as number;
}

/** Node 20 has no `detached` getter and transfers a detached buffer without complaint; slicing one throws a TypeError. */
function requireAttached(buffer: ArrayBuffer): void {
  sliceBuffer.call(buffer, 0, 0);
}

if ((Promise as unknown as PromiseStatics).withResolvers === undefined) {
  const promiseWithResolvers = function withResolvers<T>(this: PromiseConstructor): PromiseWithResolvers<T> {
    if (typeof this !== 'function') throw new TypeError('Promise.withResolvers called on a non-constructor');
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new this<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  defineMethod(Promise, 'withResolvers', promiseWithResolvers);
}

if ((ArrayBuffer.prototype as unknown as ArrayBufferMethods).transferToFixedLength === undefined) {
  /** Moves the contents into a new fixed-length buffer of `newLength` bytes (zero-filled when larger) and detaches the receiver. */
  const bufferTransferToFixedLength = function transferToFixedLength(this: ArrayBuffer, newLength?: unknown): ArrayBuffer {
    const length = toIndex(newLength, receiverLength(this));
    requireAttached(this);
    const moved = structuredClone(this, { transfer: [this] });
    if (length === moved.byteLength && !moved.resizable) return moved;
    const fixed = new ArrayBuffer(length);
    new Uint8Array(fixed).set(new Uint8Array(moved, 0, Math.min(length, moved.byteLength)));
    return fixed;
  };
  defineMethod(ArrayBuffer.prototype, 'transferToFixedLength', bufferTransferToFixedLength);
}

export {};
