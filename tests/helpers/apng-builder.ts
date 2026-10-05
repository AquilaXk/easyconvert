import zlib from 'node:zlib';

/**
 * Hand-written PNG and APNG 1.0 writer for the decoder tests. It shares no code with the converter or with
 * sharp: pixels are deflated with node:zlib, chunks carry a CRC-32 computed by the table below (ISO 3309 /
 * ITU-T V.42), and every chunk of a built file can be mutated before serialisation to model malformed input.
 */

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE_SIZE = 256;
const CRC_POLYNOMIAL = 0xedb88320;
const CRC_TABLE = Array.from({ length: CRC_TABLE_SIZE }, (_unused, n) => {
  let c = n;
  for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? CRC_POLYNOMIAL ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface Chunk {
  type: string;
  data: Buffer;
  /** Overrides the CRC written for this chunk (to model corruption). */
  crc?: number;
  /** Overrides the length field written for this chunk (to model corruption). */
  declaredLength?: number;
}

export function serializeChunks(chunks: Chunk[], signature: Buffer = PNG_SIGNATURE): Buffer {
  const parts: Buffer[] = [signature];
  for (const chunk of chunks) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(chunk.declaredLength ?? chunk.data.length, 0);
    head.write(chunk.type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(chunk.crc ?? crc32(Buffer.concat([head.subarray(4), chunk.data])), 0);
    parts.push(head, chunk.data, crc);
  }
  return Buffer.concat(parts);
}

export const COLOUR_TYPE = { gray: 0, rgb: 2, palette: 3, grayAlpha: 4, rgba: 6 } as const;
const SAMPLES_PER_PIXEL: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export interface PngImage {
  width: number;
  height: number;
  colourType: number;
  bitDepth: 8 | 16;
  /** Unfiltered scanlines, rows concatenated, `samples * bitDepth / 8` bytes per pixel. */
  pixels: Buffer;
  palette?: Buffer;
  transparency?: Buffer;
}

function deflateScanlines(image: PngImage): Buffer {
  const bytesPerPixel = (SAMPLES_PER_PIXEL[image.colourType] * image.bitDepth) / 8;
  const rowBytes = image.width * bytesPerPixel;
  const filtered = Buffer.alloc((rowBytes + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    image.pixels.copy(filtered, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  return zlib.deflateSync(filtered);
}

export function ihdrOf(image: PngImage): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = image.bitDepth;
  ihdr[9] = image.colourType;
  return ihdr;
}

export function encodePng(image: PngImage): Buffer {
  const chunks: Chunk[] = [{ type: 'IHDR', data: ihdrOf(image) }];
  if (image.palette) chunks.push({ type: 'PLTE', data: image.palette });
  if (image.transparency) chunks.push({ type: 'tRNS', data: image.transparency });
  chunks.push({ type: 'IDAT', data: deflateScanlines(image) }, { type: 'IEND', data: Buffer.alloc(0) });
  return serializeChunks(chunks);
}

/** Solid or patterned 8-bit RGBA image from a per-pixel function. */
export function rgbaImage(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number, number]
): PngImage {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) pixels.set(pixel(x, y), (y * width + x) * 4);
  }
  return { width, height, colourType: COLOUR_TYPE.rgba, bitDepth: 8, pixels };
}

export interface ApngFrameSpec {
  image: PngImage;
  x?: number;
  y?: number;
  delayNum?: number;
  delayDen?: number;
  /** 0 none, 1 background, 2 previous. */
  dispose?: number;
  /** 0 source, 1 over. */
  blend?: number;
}

export interface ApngSpec {
  width: number;
  height: number;
  plays?: number;
  frames: ApngFrameSpec[];
  /** Pixels of a default image that is not part of the animation (no fcTL before IDAT). */
  hiddenDefault?: PngImage;
  /** Palette and tRNS shared by every frame, for palette frames. */
  palette?: Buffer;
  transparency?: Buffer;
}

function frameControl(sequence: number, frame: ApngFrameSpec): Chunk {
  const data = Buffer.alloc(26);
  data.writeUInt32BE(sequence, 0);
  data.writeUInt32BE(frame.image.width, 4);
  data.writeUInt32BE(frame.image.height, 8);
  data.writeUInt32BE(frame.x ?? 0, 12);
  data.writeUInt32BE(frame.y ?? 0, 16);
  data.writeUInt16BE(frame.delayNum ?? 1, 20);
  data.writeUInt16BE(frame.delayDen ?? 10, 22);
  data[24] = frame.dispose ?? 0;
  data[25] = frame.blend ?? 0;
  return { type: 'fcTL', data };
}

/** The chunk list of an APNG 1.0 file (IHDR ... IEND), ready to be mutated and serialised. */
export function apngChunks(spec: ApngSpec): Chunk[] {
  const base = spec.hiddenDefault ?? spec.frames[0].image;
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(spec.frames.length, 0);
  actl.writeUInt32BE(spec.plays ?? 0, 4);
  const chunks: Chunk[] = [{ type: 'IHDR', data: ihdrOf({ ...base, width: spec.width, height: spec.height }) }];
  chunks.push({ type: 'acTL', data: actl });
  if (spec.palette) chunks.push({ type: 'PLTE', data: spec.palette });
  if (spec.transparency) chunks.push({ type: 'tRNS', data: spec.transparency });
  let sequence = 0;
  if (spec.hiddenDefault) {
    chunks.push({ type: 'IDAT', data: deflateScanlines(spec.hiddenDefault) });
  }
  spec.frames.forEach((frame, index) => {
    chunks.push(frameControl(sequence, frame));
    sequence += 1;
    const compressed = deflateScanlines(frame.image);
    if (index === 0 && !spec.hiddenDefault) {
      chunks.push({ type: 'IDAT', data: compressed });
    } else {
      const sequenceNumber = Buffer.alloc(4);
      sequenceNumber.writeUInt32BE(sequence, 0);
      sequence += 1;
      chunks.push({ type: 'fdAT', data: Buffer.concat([sequenceNumber, compressed]) });
    }
  });
  chunks.push({ type: 'IEND', data: Buffer.alloc(0) });
  return chunks;
}

export function buildApngFile(spec: ApngSpec, mutate?: (chunks: Chunk[]) => void): Buffer {
  const chunks = apngChunks(spec);
  mutate?.(chunks);
  return serializeChunks(chunks);
}
