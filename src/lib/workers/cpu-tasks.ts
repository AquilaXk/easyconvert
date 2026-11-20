import { decompressBzip2, encodeBzip2Block, type BitStream, type Bzip2DecodePayload } from '../conversions/bzip2';
import { encodeFlacStream, type FlacTaskPayload } from '../conversions/flac-encoder';
import { compressLzma, compressLzma2, type LzmaCompressOptions } from '../conversions/lzma-encoder';
import { encodeWoff2Container, type Woff2InputTable } from '../conversions/font-woff2';
import { encodePngBand, type PngBandPayload } from '../conversions/png-photo-bands';
import { assemblePng16, filterPng16Scanlines, PNG16_DEFAULT_LEVEL } from '../conversions/png16';
import { runDemosaicTiles, type DemosaicTilesPayload } from '../conversions/raw-demosaic-tiles';
import {
  dispatchDemosaicOnSupervisor,
  shutdownSupervisedTilePool,
  type DemosaicDispatchPayload,
} from '../conversions/raw-demosaic-threads';
import { deriveSevenZipKey, SEVENZIP_KDF_TASK, type AesKeyRequest } from '../conversions/archive-sevenzip-aes';
import {
  quantizeTaskTransfer,
  runMapStripe,
  runPaletteTask,
  runQuantizeTask,
  runRepairStripes,
  type PaletteMapTask,
  type PaletteTaskPayload,
  type QuantizeTaskPayload,
} from '../conversions/color-quantizer';
import { PLAIN_TEXT_PDF_TASK, drawPlainTextPdfOnThread, type PlainTextPdfPayload } from '../conversions/text-pdf-render';
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
  // Uint8Array.prototype.slice copies; Buffer#slice would only view the same (pooled) memory.
  const owned = exclusive ? bytes : Uint8Array.prototype.slice.call(bytes);
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

export interface CompressPayload<O> {
  /** The whole input, in memory shared with the calling thread. */
  data: Uint8Array;
  options: O;
}

/** What an LZMA task hands back; the caller wraps the byte arrays as Buffers. */
export interface LzmaTaskResult {
  buffer: Uint8Array;
  props: Uint8Array;
  uncompressedSize: number;
}

function lzmaTaskResult(encoded: { buffer: Buffer; props: Buffer; uncompressedSize: number }): HandlerResult {
  const stream = transferableBytes(encoded.buffer);
  const result: LzmaTaskResult = { buffer: stream.result as Uint8Array, props: encoded.props, uncompressedSize: encoded.uncompressedSize };
  return { result, transfer: stream.transfer };
}

export interface SevenZipKdfPayload extends AesKeyRequest {
  password: string;
}

export const CPU_TASK_HANDLERS: Record<string, CpuTaskHandler> = {
  [SEVENZIP_KDF_TASK]: (raw): HandlerResult => {
    const payload = raw as SevenZipKdfPayload;
    return transferableBytes(deriveSevenZipKey(payload.password, { cyclesPower: payload.cyclesPower, salt: Buffer.from(payload.salt) }));
  },

  demosaicTiles: (raw): HandlerResult => {
    runDemosaicTiles(raw as DemosaicTilesPayload);
    return { result: null, silent: true };
  },

  demosaicDispatch: (raw): HandlerResult => {
    dispatchDemosaicOnSupervisor(raw as DemosaicDispatchPayload);
    return { result: null, silent: true };
  },

  demosaicShutdown: (): HandlerResult => {
    shutdownSupervisedTilePool();
    setImmediate(() => process.exit(0));
    return { result: null, silent: true };
  },

  quantize: (raw): HandlerResult => {
    const result = runQuantizeTask(raw as QuantizeTaskPayload);
    return { result, transfer: quantizeTaskTransfer(result) };
  },

  quantizePalette: (raw): HandlerResult => ({ result: runPaletteTask(raw as PaletteTaskPayload) }),

  mapStripe: (raw): HandlerResult => {
    const { task, from, to } = raw as { task: PaletteMapTask; from: number; to: number };
    runMapStripe(task, { from, to });
    return { result: null };
  },

  mapRepair: (raw): HandlerResult => {
    const { task, starts } = raw as { task: PaletteMapTask; starts: number[] };
    runRepairStripes(task, starts);
    return { result: null };
  },

  flac: (raw): HandlerResult => {
    const payload = raw as FlacTaskPayload;
    return transferableBytes(encodeFlacStream(payload.samples, payload.sampleRate, payload.channels, payload.options));
  },

  lzma: (raw): HandlerResult => {
    const payload = raw as CompressPayload<LzmaCompressOptions>;
    return lzmaTaskResult(compressLzma(payload.data, payload.options));
  },

  lzma2: (raw): HandlerResult => {
    const payload = raw as CompressPayload<LzmaCompressOptions>;
    return lzmaTaskResult(compressLzma2(payload.data, payload.options));
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

  [PLAIN_TEXT_PDF_TASK]: async (raw): Promise<HandlerResult> => {
    const outcome = await drawPlainTextPdfOnThread(raw as PlainTextPdfPayload);
    if (!('pdf' in outcome)) return { result: outcome };
    const pdf = transferableBytes(outcome.pdf);
    return { result: { ...outcome, pdf: pdf.result }, transfer: pdf.transfer };
  },

  // Loaded when the first data task arrives: the data converters pull in the office writers, which no other task of the pool needs.
  dataConversion: (raw): Promise<HandlerResult> => {
    const { runDataTask } = require('../conversions/data-task-thread') as typeof import('../conversions/data-task-thread');
    return runDataTask(raw);
  },

  pngBand: (raw): HandlerResult => {
    const band = encodePngBand(raw as PngBandPayload);
    const deflate = transferableBytes(band.deflate);
    return { result: { ...band, deflate: deflate.result }, transfer: deflate.transfer };
  },

  bzip2Decode: (raw): HandlerResult => {
    const payload = raw as Bzip2DecodePayload;
    const decoded = decompressBzip2(Buffer.from(payload.data.buffer, payload.data.byteOffset, payload.data.byteLength), payload.maxOutputBytes);
    // The output buffer grows by doubling, so the view is shorter than its buffer: hand over the buffer and keep the view, with no copy.
    return { result: decoded, transfer: [decoded.buffer as ArrayBuffer] };
  },

  bzip2Block: (raw): HandlerResult => {
    const payload = raw as Bzip2BlockPayload;
    const block = encodeBzip2Block(payload.data, { start: payload.start, end: payload.end });
    const result: Bzip2BlockResult = block;
    return { result, transfer: [block.stream.bytes.buffer as ArrayBuffer] };
  },
};
