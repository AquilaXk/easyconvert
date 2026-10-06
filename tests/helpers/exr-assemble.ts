/**
 * Minimal OpenEXR container assembler for negative tests.
 *
 * Authored from the OpenEXR file layout specification. It lays out a magic number, version field,
 * typed attributes, a chunk offset table and caller-supplied chunk payloads. It does not encode or
 * compress pixels, so it can never serve as a pixel oracle; it only builds hostile containers
 * (empty channel list, oversized windows, forged offsets, decompression bombs) around bytes the
 * test chooses.
 */

const MAGIC = [0x76, 0x2f, 0x31, 0x01];
const VERSION_FIELD = 2;
const BYTES_PER_OFFSET = 8;
const BYTES_PER_INT32 = 4;

export const EXR_FLAG_TILED = 0x200;
export const EXR_FLAG_NON_IMAGE = 0x800;
export const EXR_FLAG_MULTIPART = 0x1000;

export const PIXEL_TYPE_UINT = 0;
export const PIXEL_TYPE_HALF = 1;
export const PIXEL_TYPE_FLOAT = 2;

export const COMPRESSION_CODES = { none: 0, rle: 1, zips: 2, zip: 3, piz: 4, pxr24: 5, b44: 6, b44a: 7, dwaa: 8, dwab: 9 } as const;

export interface AssembleChannel {
  name: string;
  pixelType: number;
  xSampling?: number;
  ySampling?: number;
}

export interface AssembleOptions {
  channels: readonly AssembleChannel[];
  compression: number;
  /** [xMin, yMin, xMax, yMax] */
  dataWindow: readonly [number, number, number, number];
  /** Version-field flag bits (tiled, deep, multipart). */
  flags?: number;
  /** Extra attributes appended to the header. */
  extraAttributes?: readonly { name: string; type: string; value: Buffer }[];
  /** Chunk payloads written after the offset table, in order, each including its own chunk header fields. */
  chunks: readonly Buffer[];
  /** Number of offset table entries; defaults to chunks.length. */
  offsetCount?: number;
  /** Replaces the computed offsets (index -> absolute file offset). */
  offsetOverrides?: Readonly<Record<number, number | bigint>>;
}

function int32(value: number): Buffer {
  const buf = Buffer.alloc(BYTES_PER_INT32);
  buf.writeInt32LE(value);
  return buf;
}

export function attribute(name: string, type: string, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${name}\0${type}\0`, 'latin1'), int32(value.length), value]);
}

export function channelList(channels: readonly AssembleChannel[]): Buffer {
  const entries = channels.map((channel) =>
    Buffer.concat([
      Buffer.from(`${channel.name}\0`, 'latin1'),
      int32(channel.pixelType),
      Buffer.from([0, 0, 0, 0]),
      int32(channel.xSampling ?? 1),
      int32(channel.ySampling ?? 1),
    ])
  );
  return Buffer.concat([...entries, Buffer.from([0])]);
}

/** A scanline chunk: y, payload size, payload. */
export function scanlineChunk(y: number, payload: Buffer): Buffer {
  return Buffer.concat([int32(y), int32(payload.length), payload]);
}

/** A tile chunk: tileX, tileY, levelX, levelY, payload size, payload. */
export function tileChunk(tileX: number, tileY: number, levelX: number, levelY: number, payload: Buffer): Buffer {
  return Buffer.concat([int32(tileX), int32(tileY), int32(levelX), int32(levelY), int32(payload.length), payload]);
}

export function assembleExr(options: AssembleOptions): Buffer {
  const [xMin, yMin, xMax, yMax] = options.dataWindow;
  const window = Buffer.concat([int32(xMin), int32(yMin), int32(xMax), int32(yMax)]);
  const versionField = Buffer.alloc(BYTES_PER_INT32);
  versionField.writeUInt32LE((VERSION_FIELD | (options.flags ?? 0)) >>> 0);
  const header = Buffer.concat([
    Buffer.from(MAGIC),
    versionField,
    attribute('channels', 'chlist', channelList(options.channels)),
    attribute('compression', 'compression', Buffer.from([options.compression])),
    attribute('dataWindow', 'box2i', window),
    attribute('displayWindow', 'box2i', window),
    ...(options.extraAttributes ?? []).map((extra) => attribute(extra.name, extra.type, extra.value)),
    Buffer.from([0]),
  ]);

  const offsetCount = options.offsetCount ?? options.chunks.length;
  const tableBytes = offsetCount * BYTES_PER_OFFSET;
  const table = Buffer.alloc(tableBytes);
  let cursor = header.length + tableBytes;
  options.chunks.forEach((chunk, index) => {
    if (index < offsetCount) table.writeBigUInt64LE(BigInt(cursor), index * BYTES_PER_OFFSET);
    cursor += chunk.length;
  });
  for (const [index, value] of Object.entries(options.offsetOverrides ?? {})) {
    table.writeBigUInt64LE(BigInt(value), Number(index) * BYTES_PER_OFFSET);
  }
  return Buffer.concat([header, table, ...options.chunks]);
}

/** Byte offset just past the header terminator, i.e. where the chunk offset table starts. */
export function exrOffsetTableStart(file: Buffer): number {
  const PREAMBLE_BYTES = 8;
  let pos = PREAMBLE_BYTES;
  while (file[pos] !== 0) {
    const nameEnd = file.indexOf(0, pos);
    const typeEnd = file.indexOf(0, nameEnd + 1);
    const size = file.readUInt32LE(typeEnd + 1);
    pos = typeEnd + 1 + BYTES_PER_INT32 + size;
  }
  return pos + 1;
}

/** Reads `count` absolute chunk offsets from the offset table of a well-formed file. */
export function exrChunkOffsets(file: Buffer, count: number): number[] {
  const start = exrOffsetTableStart(file);
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) offsets.push(Number(file.readBigUInt64LE(start + i * BYTES_PER_OFFSET)));
  return offsets;
}

/** Overwrites one offset table entry in a copy of the file. */
export function withChunkOffset(file: Buffer, index: number, value: number | bigint): Buffer {
  const copy = Buffer.from(file);
  copy.writeBigUInt64LE(BigInt(value), exrOffsetTableStart(file) + index * BYTES_PER_OFFSET);
  return copy;
}


/**
 * Copy of the file with its dataWindow and displayWindow moved to the origin (same size, patched in
 * place). Scanline chunk line numbers are rebased too; tile coordinates are already window-relative.
 */
export function withWindowMovedToOrigin(file: Buffer, scanline: boolean): Buffer {
  const copy = Buffer.from(file);
  const values = new Map<string, number>();
  let pos = 8;
  while (copy[pos] !== 0) {
    const nameEnd = copy.indexOf(0, pos);
    const typeEnd = copy.indexOf(0, nameEnd + 1);
    const size = copy.readUInt32LE(typeEnd + 1);
    values.set(copy.toString('latin1', pos, nameEnd), typeEnd + 1 + BYTES_PER_INT32);
    pos = typeEnd + 1 + BYTES_PER_INT32 + size;
  }
  const data = values.get('dataWindow');
  const display = values.get('displayWindow');
  if (data === undefined || display === undefined) throw new Error('file has no dataWindow/displayWindow');
  const [xMin, yMin, xMax, yMax] = [0, 4, 8, 12].map((delta) => copy.readInt32LE(data + delta));
  for (const at of [data, display]) {
    copy.writeInt32LE(0, at);
    copy.writeInt32LE(0, at + 4);
    copy.writeInt32LE(xMax - xMin, at + 8);
    copy.writeInt32LE(yMax - yMin, at + 12);
  }
  if (scanline) {
    const tableStart = pos + 1;
    const count = (Number(copy.readBigUInt64LE(tableStart)) - tableStart) / BYTES_PER_OFFSET;
    for (let i = 0; i < count; i++) {
      const at = Number(copy.readBigUInt64LE(tableStart + i * BYTES_PER_OFFSET));
      copy.writeInt32LE(copy.readInt32LE(at) - yMin, at);
    }
  }
  return copy;
}
