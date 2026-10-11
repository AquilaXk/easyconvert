import { crc32 } from 'node:zlib';

/**
 * The metadata blocks a PNG carries besides its pixels, for the image benchmark's reference encoders. A decoded copy of a
 * picture (the one the metrics read) has none, and the original file cannot be given to the encoders as it is: they read its
 * `gAMA` chunk and change the pixels (`cwebp` applies it), so the reference would encode another picture than the one it is
 * scored against. The reference is therefore given the decoded pixels with the EXIF block, the XMP packet and the ICC profile of
 * the original: the reference tools keep all three by default (`cwebp` when asked), where the product keeps the first two and
 * applies the profile to the pixels without writing it, which makes its files of a tagged picture smaller by the profile
 * (3 kB for the sRGB profile of the photographs, 4.5 kB for the grey profile of the radiograph) for the same displayed colours.
 * The rows still score the pixels against the unconverted samples, so a profile that is not sRGB costs the product a little
 * similarity that a viewer applying the profile to the reference's pixels does not see.
 */

const PNG_SIGNATURE_BYTES = 8;
const CHUNK_HEADER_BYTES = 8;
const CHUNK_CRC_BYTES = 4;
/** Keywords of the text chunks that hold an XMP packet or an EXIF block: the standard one and the two ImageMagick writes. */
const METADATA_KEYWORDS: ReadonlySet<string> = new Set(['XML:com.adobe.xmp', 'Raw profile type xmp', 'Raw profile type exif']);
const TEXT_CHUNK_TYPES: ReadonlySet<string> = new Set(['iTXt', 'zTXt', 'tEXt']);

interface Chunk {
  type: string;
  /** The whole chunk: length, type, data and CRC. */
  bytes: Buffer;
  data: Buffer;
}

function chunksOf(png: Buffer): Chunk[] {
  const chunks: Chunk[] = [];
  for (let at = PNG_SIGNATURE_BYTES; at + CHUNK_HEADER_BYTES + CHUNK_CRC_BYTES <= png.length; ) {
    const length = png.readUInt32BE(at);
    const end = at + CHUNK_HEADER_BYTES + length + CHUNK_CRC_BYTES;
    if (end > png.length) break;
    chunks.push({ type: png.toString('latin1', at + 4, at + 8), bytes: png.subarray(at, end), data: png.subarray(at + CHUNK_HEADER_BYTES, end - CHUNK_CRC_BYTES) });
    at = end;
  }
  return chunks;
}

/** An EXIF chunk, an ICC profile, or a text chunk whose keyword says it holds an XMP packet or an EXIF block. */
function isMetadataChunk(chunk: Chunk): boolean {
  if (chunk.type === 'eXIf' || chunk.type === 'iCCP') return true;
  if (!TEXT_CHUNK_TYPES.has(chunk.type)) return false;
  const end = chunk.data.indexOf(0);
  return end > 0 && METADATA_KEYWORDS.has(chunk.data.toString('latin1', 0, end));
}

export function metadataChunksOf(original: Buffer): Buffer[] {
  return chunksOf(original).filter(isMetadataChunk).map((chunk) => chunk.bytes);
}

/** The chunks a picture cannot be read without: header, palette, transparency, pixels and the end. Everything else (profile, gamma, density, text) is ancillary. */
const CRITICAL_CHUNK_TYPES: ReadonlySet<string> = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);

/**
 * The pixels of `decoded` with the EXIF, XMP and ICC chunks of `original` before its first `IDAT`, and none of the ancillary
 * chunks of `decoded` itself (a decoder may carry some of the input's into the copy it writes, or change them; gamma and
 * density chunks would change what an encoder reads).
 */
export function withMetadataOf(decoded: Buffer, original: Buffer): Buffer {
  const copied = metadataChunksOf(original);
  const parts: Buffer[] = [decoded.subarray(0, PNG_SIGNATURE_BYTES)];
  let placed = false;
  for (const chunk of chunksOf(decoded)) {
    if (!CRITICAL_CHUNK_TYPES.has(chunk.type)) continue;
    if (chunk.type === 'IDAT' && !placed) {
      parts.push(...copied);
      placed = true;
    }
    parts.push(chunk.bytes);
  }
  return Buffer.concat(parts);
}

/** Whether every chunk of `png` has the CRC its type and data give; the benchmark refuses to hand an encoder a damaged picture. */
export function hasValidChunkChecksums(png: Buffer): boolean {
  return chunksOf(png).every((chunk) => crc32(chunk.bytes.subarray(CHUNK_CRC_BYTES, chunk.bytes.length - CHUNK_CRC_BYTES)) === chunk.bytes.readUInt32BE(chunk.bytes.length - CHUNK_CRC_BYTES));
}
