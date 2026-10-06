import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Node 20 lacks ArrayBuffer.prototype.transferToFixedLength, which pdfjs calls while reading glyph data;
 * without it getOperatorList silently returns no glyphs and word boxes lose their real widths. These tests
 * remove the natives, load the compatibility module and check the result against ECMAScript 2024
 * (ArrayBuffer.prototype.transferToFixedLength, Promise.withResolvers) with hand-written expectations.
 */

interface BufferMethods {
  transferToFixedLength?: (this: ArrayBuffer, length?: unknown) => ArrayBuffer;
  transfer?: unknown;
}

const bufferPrototype = ArrayBuffer.prototype as unknown as BufferMethods;
const promiseConstructor = Promise as unknown as { withResolvers?: unknown };

const nativeTransferToFixedLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'transferToFixedLength');
const nativeTransfer = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'transfer');
const nativeWithResolvers = Object.getOwnPropertyDescriptor(Promise, 'withResolvers');

function restore(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

async function loadWithoutNatives(): Promise<void> {
  Reflect.deleteProperty(ArrayBuffer.prototype, 'transferToFixedLength');
  Reflect.deleteProperty(ArrayBuffer.prototype, 'transfer');
  Reflect.deleteProperty(Promise, 'withResolvers');
  vi.resetModules();
  await import('../src/lib/conversions/pdfjs-node-compat');
}

function transferToFixedLength(buffer: unknown, ...args: unknown[]): ArrayBuffer {
  const method = bufferPrototype.transferToFixedLength;
  if (typeof method !== 'function') throw new Error('transferToFixedLength was not defined');
  return method.apply(buffer as ArrayBuffer, args as [unknown?]);
}

function bytesOf(buffer: ArrayBuffer): number[] {
  return [...new Uint8Array(buffer)];
}

describe('pdfjs runtime compatibility (Node 20)', () => {
  beforeEach(loadWithoutNatives);
  afterEach(() => {
    restore(ArrayBuffer.prototype, 'transferToFixedLength', nativeTransferToFixedLength);
    restore(ArrayBuffer.prototype, 'transfer', nativeTransfer);
    restore(Promise, 'withResolvers', nativeWithResolvers);
  });

  describe('ArrayBuffer.prototype.transferToFixedLength', () => {
    it('moves the bytes to a new buffer and detaches the source', () => {
      const source = new Uint8Array([1, 2, 3, 4]).buffer;
      const moved = transferToFixedLength(source);
      expect(bytesOf(moved)).toEqual([1, 2, 3, 4]);
      expect(source.byteLength).toBe(0);
      expect(() => transferToFixedLength(source)).toThrow(TypeError);
    });

    it('grows with zero fill and shrinks by truncating', () => {
      expect(bytesOf(transferToFixedLength(new Uint8Array([1, 2, 3]).buffer, 5))).toEqual([1, 2, 3, 0, 0]);
      expect(bytesOf(transferToFixedLength(new Uint8Array([1, 2, 3]).buffer, 2))).toEqual([1, 2]);
      expect(bytesOf(transferToFixedLength(new Uint8Array([1, 2, 3]).buffer, 0))).toEqual([]);
    });

    it('converts the length like ToIndex: undefined keeps it, NaN is 0, strings and fractions truncate', () => {
      expect(transferToFixedLength(new ArrayBuffer(4), undefined).byteLength).toBe(4);
      expect(transferToFixedLength(new ArrayBuffer(4), Number.NaN).byteLength).toBe(0);
      expect(transferToFixedLength(new ArrayBuffer(4), '3').byteLength).toBe(3);
      expect(transferToFixedLength(new ArrayBuffer(4), 2.9).byteLength).toBe(2);
      expect(() => transferToFixedLength(new ArrayBuffer(4), -1)).toThrow(RangeError);
    });

    it('returns a fixed-length buffer even for a resizable source', () => {
      const source = new ArrayBuffer(4, { maxByteLength: 16 });
      new Uint8Array(source).set([9, 8, 7, 6]);
      const moved = transferToFixedLength(source);
      expect(bytesOf(moved)).toEqual([9, 8, 7, 6]);
      expect(moved.resizable).toBe(false);
    });

    it('throws a TypeError for a receiver that is not an ArrayBuffer', () => {
      expect(() => transferToFixedLength(new SharedArrayBuffer(4))).toThrow(TypeError);
      expect(() => transferToFixedLength({ byteLength: 4 })).toThrow(TypeError);
      expect(() => transferToFixedLength(undefined)).toThrow(TypeError);
      expect(() => transferToFixedLength(new Uint8Array(4))).toThrow(TypeError);
    });

    it('is defined as a non-enumerable method and does not add an unrelated transfer method', () => {
      const descriptor = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'transferToFixedLength');
      expect(descriptor?.enumerable).toBe(false);
      expect(descriptor?.writable).toBe(true);
      expect(descriptor?.configurable).toBe(true);
      expect(Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'transfer')).toBeUndefined();
    });

    it('leaves a native implementation alone', async () => {
      const marker = function transferToFixedLength(): ArrayBuffer {
        return new ArrayBuffer(0);
      };
      Object.defineProperty(ArrayBuffer.prototype, 'transferToFixedLength', { value: marker, configurable: true, writable: true });
      vi.resetModules();
      await import('../src/lib/conversions/pdfjs-node-compat');
      expect(bufferPrototype.transferToFixedLength).toBe(marker);
    });
  });

  describe('Promise.withResolvers', () => {
    it('returns a promise with its resolve and reject functions', async () => {
      const { promise, resolve, reject } = Promise.withResolvers<number>();
      expect(typeof reject).toBe('function');
      resolve(7);
      await expect(promise).resolves.toBe(7);
      const second = Promise.withResolvers<number>();
      second.reject(new Error('no'));
      await expect(second.promise).rejects.toThrow('no');
    });

    it('is a non-enumerable own property named withResolvers', () => {
      const descriptor = Object.getOwnPropertyDescriptor(Promise, 'withResolvers');
      expect(descriptor?.enumerable).toBe(false);
      expect(Object.keys(Promise)).not.toContain('withResolvers');
      expect(Promise.withResolvers.name).toBe('withResolvers');
      expect(Promise.withResolvers).toHaveLength(0);
    });

    it('constructs the promise with the receiver, so subclasses get their own type', () => {
      class Tracked extends Promise<number> {}
      const { promise } = Tracked.withResolvers<number>();
      expect(promise).toBeInstanceOf(Tracked);
    });

    it('throws a TypeError when the receiver is not a constructor', () => {
      const detached = Promise.withResolvers as (this: unknown) => unknown;
      expect(() => detached.call(undefined)).toThrow(TypeError);
      expect(() => detached.call({})).toThrow(TypeError);
    });
  });
});
