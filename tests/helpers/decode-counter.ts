import { createRequire } from 'node:module';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Counts the bytes that inflaters hand out while it is installed, so a test can prove how much a reader decoded without
 * a wall-clock bound. It covers the two decoders the readers use: Node's zlib (streams, which the callback and promise
 * forms run on, and the sync calls, for deflate, gzip and brotli) and the pako that JSZip inflates ZIP entries with.
 * Install it before the code under test is loaded: a module that already holds a reference to an unpatched function
 * is not counted.
 */

type Chunked = { prototype: { push: (chunk: unknown, encoding?: unknown) => boolean } };
type NodeFunction = (...args: unknown[]) => unknown;

const STREAM_CLASSES = ['Inflate', 'InflateRaw', 'Gunzip', 'Unzip', 'BrotliDecompress'] as const;
const SYNC_FUNCTIONS = ['inflateSync', 'inflateRawSync', 'gunzipSync', 'unzipSync', 'brotliDecompressSync'] as const;

export interface DecodeCounter {
  /** Bytes the inflaters have produced since the counter was installed. */
  bytes(): number;
}

let installed: { total: number } | null = null;

export function installDecodeCounter(): DecodeCounter {
  if (installed) return { bytes: () => installed!.total };
  const state = { total: 0 };
  const zlibExports = zlib as unknown as Record<string, NodeFunction & Chunked>;

  for (const name of STREAM_CLASSES) {
    const prototype = zlibExports[name].prototype;
    const push = prototype.push;
    prototype.push = function counted(this: unknown, chunk: unknown, encoding?: unknown): boolean {
      if (chunk !== null && chunk !== undefined) state.total += (chunk as Uint8Array).length;
      return push.call(this, chunk, encoding);
    };
  }
  for (const name of SYNC_FUNCTIONS) {
    const original = zlibExports[name];
    zlibExports[name] = ((...args: unknown[]) => {
      const out = original(...args) as Uint8Array;
      state.total += out.length;
      return out;
    }) as NodeFunction & Chunked;
  }
  // JSZip builds `new pako.Inflate(...)` per entry and assigns its onData handler, which receives every decoded chunk.
  const pako = createRequire(path.join(process.cwd(), 'package.json'))('pako') as { Inflate: new (options: object) => { onData: (chunk: Uint8Array) => void } };
  const Inflate = pako.Inflate;
  pako.Inflate = function CountedInflate(options: object) {
    const inflate = new Inflate(options);
    let handler = inflate.onData;
    Object.defineProperty(inflate, 'onData', {
      configurable: true,
      get: () => handler,
      set: (next: (chunk: Uint8Array) => void) => {
        handler = (chunk: Uint8Array) => {
          state.total += chunk.length;
          next.call(inflate, chunk);
        };
      },
    });
    return inflate;
  } as unknown as typeof Inflate;

  installed = state;
  return { bytes: () => state.total };
}
