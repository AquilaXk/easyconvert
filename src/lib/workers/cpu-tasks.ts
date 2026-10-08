import { encodeBzip2Block, type BitStream } from '../conversions/bzip2';
import { encodeWoff2Container, type Woff2InputTable } from '../conversions/font-woff2';
import { assemblePng16, filterPng16Scanlines, PNG16_DEFAULT_LEVEL } from '../conversions/png16';
import { runDemosaicTiles, type DemosaicTilesPayload } from '../conversions/raw-demosaic-tiles';
import zlib from 'node:zlib';

/**
 * Handlers of the CPU pool: one function per task kind, run on a pool thread. The matching callers (`encode16BitPngAsync`,
 * `compressBzip2Async`, ...) build the payload, decide whether the work is large enough to leave the calling thread, and
 * join the result; the handler only does the encoding. A handler may return ArrayBuffers to transfer instead of copy.
 */

export interface HandlerResult {
  result: unknown;
  transfer?: ArrayBuffer[];
  /** No reply message is sent: the caller learns of completion by other means (shared memory) and holds no listener. */
  silent?: boolean;
}

export type CpuTaskHandler = (payload: unknown) => HandlerResult | Promise<HandlerResult>;

/** Uint8Array result whose buffer the thread can hand over without copying (and without detaching shared pool memory). */
export function transferableBytes(bytes: Uint8Array): HandlerResult {
  const exclusive = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer;
  const owned = exclusive ? bytes : bytes.slice();
  return { result: owned, transfer: [owned.buffer as ArrayBuffer] };
}

export interface Png16Payload {
  width: number;
  height: number;
  rgb16: Uint16Array;
  iccProfile?: Uint8Array;
  level?: number;
}

export interface Bzip2BlockPayload {
  /** The whole input, in memory shared with the calling thread. */
  data: Uint8Array;
  start: number;
  end: number;
}

export interface Bzip2BlockResult {
  stream: BitStream;
  crc: number;
}

export interface Woff2Payload {
  flavor: number;
  tables: Woff2InputTable[];
}

export const CPU_TASK_HANDLERS: Record<string, CpuTaskHandler> = {
  demosaicTiles: (raw): HandlerResult => {
    runDemosaicTiles(raw as DemosaicTilesPayload);
    return { result: null, silent: true };
  },

  woff2: (raw): HandlerResult => {
    const payload = raw as Woff2Payload;
    return transferableBytes(encodeWoff2Container(payload.flavor, payload.tables));
  },

  png16: (raw): HandlerResult => {
    const payload = raw as Png16Payload;
    const scanlines = filterPng16Scanlines(payload.width, payload.height, payload.rgb16);
    const idat = zlib.deflateSync(scanlines, { level: payload.level ?? PNG16_DEFAULT_LEVEL });
    return transferableBytes(assemblePng16(payload.width, payload.height, idat, payload.iccProfile));
  },

  bzip2Block: (raw): HandlerResult => {
    const payload = raw as Bzip2BlockPayload;
    const block = encodeBzip2Block(payload.data, { start: payload.start, end: payload.end });
    const result: Bzip2BlockResult = block;
    return { result, transfer: [block.stream.bytes.buffer as ArrayBuffer] };
  },
};
