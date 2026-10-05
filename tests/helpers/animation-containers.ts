/**
 * Hand-written readers and builders for animation container fields (GIF89a NETSCAPE2.0 loop extension,
 * WebP ANIM chunk, APNG acTL/fcTL/fdAT). They share no code with the converter or sharp.
 */

const NETSCAPE_SIGNATURE = 'NETSCAPE2.0';
const NETSCAPE_LOOP_SUBBLOCK_ID = 1;
const NETSCAPE_SUBBLOCK_HEADER_BYTES = 2;
const RIFF_HEADER_BYTES = 12;
const RIFF_CHUNK_HEADER_BYTES = 8;
const WEBP_ANIM_LOOP_OFFSET = 4;

/** Raw loop field of the GIF NETSCAPE2.0 extension (repeats after the first play; 0 means forever); undefined when absent. */
export function readGifLoopCount(gif: Buffer): number | undefined {
  const at = gif.indexOf(NETSCAPE_SIGNATURE, 0, 'latin1');
  if (at < 0) return undefined;
  const subBlock = at + NETSCAPE_SIGNATURE.length + 1; // skip the sub-block length byte
  if (gif[subBlock] !== NETSCAPE_LOOP_SUBBLOCK_ID) return undefined;
  return gif.readUInt16LE(subBlock + 1);
}

/** Loop count from the WebP ANIM chunk; 0 means forever; undefined when the file has no ANIM chunk. */
export function readWebpLoopCount(webp: Buffer): number | undefined {
  let pos = RIFF_HEADER_BYTES;
  while (pos + RIFF_CHUNK_HEADER_BYTES <= webp.length) {
    const type = webp.toString('latin1', pos, pos + 4);
    const length = webp.readUInt32LE(pos + 4);
    if (type === 'ANIM') return webp.readUInt16LE(pos + RIFF_CHUNK_HEADER_BYTES + WEBP_ANIM_LOOP_OFFSET);
    pos += RIFF_CHUNK_HEADER_BYTES + length + (length % 2);
  }
  return undefined;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHUNK_OVERHEAD = 12;

interface PngChunk {
  type: string;
  data: Buffer;
}

function readPngChunks(png: Buffer): PngChunk[] {
  const chunks: PngChunk[] = [];
  let pos = PNG_SIGNATURE.length;
  while (pos + PNG_CHUNK_OVERHEAD <= png.length) {
    const length = png.readUInt32BE(pos);
    chunks.push({ type: png.toString('latin1', pos + 4, pos + 8), data: png.subarray(pos + 8, pos + 8 + length) });
    pos += PNG_CHUNK_OVERHEAD + length;
  }
  return chunks;
}

const CRC_TABLE_SIZE = 256;
const CRC_POLYNOMIAL = 0xedb88320;
const CRC_TABLE = Array.from({ length: CRC_TABLE_SIZE }, (_unused, n) => {
  let c = n;
  for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? CRC_POLYNOMIAL ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** CRC-32 as PNG defines it (ISO 3309 / ITU-T V.42). */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function frameControl(sequence: number, width: number, height: number, delayCentiseconds: number): Buffer {
  const data = Buffer.alloc(26);
  data.writeUInt32BE(sequence, 0);
  data.writeUInt32BE(width, 4);
  data.writeUInt32BE(height, 8);
  // x/y offsets stay 0
  data.writeUInt16BE(delayCentiseconds, 20);
  data.writeUInt16BE(100, 22);
  // dispose_op 0 (none), blend_op 0 (source)
  return pngChunk('fcTL', data);
}

/**
 * Builds an APNG from same-sized still PNGs: the first PNG is the default image and frame 1, every later
 * PNG contributes its IDAT data as fdAT of the following frames (APNG 1.0 specification).
 */
export function buildApng(framePngs: Buffer[], delayCentiseconds = 10): Buffer {
  const [first, ...rest] = framePngs.map(readPngChunks);
  const ihdr = first.find((chunk) => chunk.type === 'IHDR');
  if (!ihdr) throw new Error('PNG without IHDR');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(framePngs.length, 0); // num_frames; num_plays 0 = forever
  const out: Buffer[] = [PNG_SIGNATURE, pngChunk('IHDR', ihdr.data), pngChunk('acTL', actl)];
  let sequence = 0;
  out.push(frameControl(sequence++, width, height, delayCentiseconds));
  first.filter((chunk) => chunk.type === 'IDAT').forEach((chunk) => out.push(pngChunk('IDAT', chunk.data)));
  rest.forEach((chunks) => {
    out.push(frameControl(sequence++, width, height, delayCentiseconds));
    chunks
      .filter((chunk) => chunk.type === 'IDAT')
      .forEach((chunk) => {
        const sequenceNumber = Buffer.alloc(4);
        sequenceNumber.writeUInt32BE(sequence++, 0);
        out.push(pngChunk('fdAT', Buffer.concat([sequenceNumber, chunk.data])));
      });
  });
  out.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(out);
}
