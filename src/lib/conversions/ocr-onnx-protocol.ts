import type { OcrResult } from './ocr-pdf-combiner';

/**
 * The frames of the ONNX OCR helper (ocr-onnx-child.ts), spoken over its standard input and output. A frame is two 32-bit
 * big-endian lengths (header, payload), the header as JSON, and the payload bytes. The host sends one request at a time and
 * the helper answers it before it reads the next, so a frame is never interleaved with another.
 */

export const FRAME_PREFIX_BYTES = 8;
/** A reply holds the lines and words of one page (at most 2000 boxes), which is a few hundred kilobytes of JSON. */
export const MAX_HEADER_BYTES = 8 * 1024 * 1024;
/** Pixels of a page: the full-size copy (at most 16 megapixels) and the detector copy (at most 2016 x 2016), three bytes each. */
export const MAX_PAGE_PIXELS = 16_000_000;
export const MAX_DETECTOR_PIXELS = 2048 * 2048;
export const MAX_PAYLOAD_BYTES = 3 * (MAX_PAGE_PIXELS + MAX_DETECTOR_PIXELS);

export interface OnnxRunRequest {
  type: 'run';
  id: number;
  width: number;
  height: number;
  detector: { width: number; height: number };
  language: string;
  recoverSpaces: boolean;
}

export type OnnxFailureKind = 'unavailable' | 'failed';

export type OnnxReply =
  | { type: 'ready' }
  | { type: 'result'; id: number; result: OcrResult }
  | { type: 'error'; id: number; kind: OnnxFailureKind; message: string };

export function encodeFrame(header: OnnxRunRequest | OnnxReply, payload?: Buffer): Buffer[] {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(FRAME_PREFIX_BYTES);
  prefix.writeUInt32BE(json.length, 0);
  prefix.writeUInt32BE(payload?.length ?? 0, 4);
  return payload ? [prefix, json, payload] : [prefix, json];
}

export class OnnxProtocolError extends Error {}

export interface Frame<T> {
  header: T;
  payload: Buffer;
}

/** Reassembles frames from the chunks of a pipe; throws OnnxProtocolError for a length past the limits or a header that is not JSON. */
export class FrameReader<T> {
  private chunks: Buffer[] = [];
  private buffered = 0;

  constructor(private readonly maxPayload: number = MAX_PAYLOAD_BYTES) {}

  push(chunk: Buffer): Frame<T>[] {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    const frames: Frame<T>[] = [];
    for (;;) {
      if (this.buffered < FRAME_PREFIX_BYTES) break;
      // The lengths are read from the first bytes without joining the chunks: a page arrives in many small ones, and joining them at
      // every push would copy the page over and over.
      const prefix = this.chunks[0].length >= FRAME_PREFIX_BYTES ? this.chunks[0] : Buffer.concat(this.chunks, this.buffered).subarray(0, FRAME_PREFIX_BYTES);
      const headerBytes = prefix.readUInt32BE(0);
      const payloadBytes = prefix.readUInt32BE(4);
      if (headerBytes > MAX_HEADER_BYTES || payloadBytes > this.maxPayload) throw new OnnxProtocolError('A frame is longer than the protocol allows.');
      const total = FRAME_PREFIX_BYTES + headerBytes + payloadBytes;
      if (this.buffered < total) break;
      const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.buffered);
      let header: T;
      try {
        header = JSON.parse(all.toString('utf8', FRAME_PREFIX_BYTES, FRAME_PREFIX_BYTES + headerBytes)) as T;
      } catch {
        throw new OnnxProtocolError('A frame header is not JSON.');
      }
      frames.push({ header, payload: all.subarray(FRAME_PREFIX_BYTES + headerBytes, total) });
      const rest = all.subarray(total);
      this.chunks = rest.length > 0 ? [rest] : [];
      this.buffered = rest.length;
    }
    return frames;
  }
}

/** Whether a request names sizes the helper accepts and a payload of exactly the pixels they describe. */
export function validateRunRequest(request: OnnxRunRequest, payloadBytes: number): string | null {
  const whole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1;
  if (request.type !== 'run' || !whole(request.id) || !whole(request.width) || !whole(request.height)) return 'the request is malformed';
  if (!request.detector || !whole(request.detector.width) || !whole(request.detector.height)) return 'the request is malformed';
  if (typeof request.language !== 'string' || request.language.length > 64 || typeof request.recoverSpaces !== 'boolean') return 'the request is malformed';
  if (request.width * request.height > MAX_PAGE_PIXELS) return 'the page has too many pixels';
  if (request.detector.width * request.detector.height > MAX_DETECTOR_PIXELS) return 'the detector input has too many pixels';
  if (payloadBytes !== 3 * (request.width * request.height + request.detector.width * request.detector.height)) return 'the payload does not match the sizes';
  return null;
}
