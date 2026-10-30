/**
 * Decompression of the RTF stored in an Outlook message (`PR_RTF_COMPRESSED`), written from [MS-OXRTFCP] 2.1: a 16-byte header
 * (compressed size, raw size, type, CRC-32 of the contents), then runs of eight tokens led by a flag byte (bit 0 first; a 0 bit is
 * a literal byte, a 1 bit a big-endian reference of a 12-bit dictionary offset and a 4-bit length less two) over a 4,096-byte
 * circular dictionary that starts with the 207 bytes below. A reference to the write position ends the data.
 */

const HEADER_BYTES = 16;
const HEADER_SIZE_FIELD_BYTES = 4;
const TYPE_COMPRESSED = 0x75465a4c;
const TYPE_UNCOMPRESSED = 0x414c454d;
const DICTIONARY_BYTES = 4096;
const DICTIONARY_MASK = DICTIONARY_BYTES - 1;
const MIN_REFERENCE_LENGTH = 2;
/** The largest raw size accepted: the RTF reader holds the text in memory. */
export const MAX_COMPRESSED_RTF_RAW_BYTES = 64 * 1024 * 1024;

const CRC_POLYNOMIAL = 0xedb88320;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ CRC_POLYNOMIAL : value >>> 1;
  return value >>> 0;
});

/** The checksum of [MS-OXRTFCP] 2.2: the CRC-32 polynomial of zlib, started at zero and not inverted at the end. */
export function rtfChecksum(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
  return crc;
}

const INITIAL_DICTIONARY = Buffer.from(
  '{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript \\fdecor MS Sans SerifSymbolArialTimes New RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx',
  'latin1'
);

/** The RTF bytes, or undefined when the stream is not valid compressed RTF (a bad header, size or checksum, or a cut-off run). */
export function decompressRtf(stream: Buffer): Buffer | undefined {
  if (stream.length < HEADER_BYTES) return undefined;
  const compressedSize = stream.readUInt32LE(0);
  const rawSize = stream.readUInt32LE(HEADER_SIZE_FIELD_BYTES);
  const type = stream.readUInt32LE(2 * HEADER_SIZE_FIELD_BYTES);
  const checksum = stream.readUInt32LE(3 * HEADER_SIZE_FIELD_BYTES);
  const contentEnd = Math.min(stream.length, HEADER_SIZE_FIELD_BYTES + compressedSize);
  if (compressedSize < HEADER_BYTES - HEADER_SIZE_FIELD_BYTES || rawSize > MAX_COMPRESSED_RTF_RAW_BYTES) return undefined;
  const contents = stream.subarray(HEADER_BYTES, contentEnd);
  if (type === TYPE_UNCOMPRESSED) return contents.subarray(0, rawSize);
  if (type !== TYPE_COMPRESSED || rtfChecksum(contents) !== checksum) return undefined;
  const dictionary = Buffer.alloc(DICTIONARY_BYTES, 0x20);
  INITIAL_DICTIONARY.copy(dictionary);
  let write = INITIAL_DICTIONARY.length;
  const out = Buffer.alloc(rawSize);
  let produced = 0;
  let at = 0;
  const emit = (byte: number): boolean => {
    if (produced >= rawSize) return false;
    out[produced++] = byte;
    dictionary[write] = byte;
    write = (write + 1) & DICTIONARY_MASK;
    return true;
  };
  while (at < contents.length) {
    const flags = contents[at++];
    for (let bit = 0; bit < 8 && at < contents.length; bit += 1) {
      if ((flags & (1 << bit)) === 0) {
        if (!emit(contents[at++])) return out.subarray(0, produced);
        continue;
      }
      if (at + 2 > contents.length) return undefined;
      const token = contents.readUInt16BE(at);
      at += 2;
      const offset = token >> 4;
      if (offset === write) return out.subarray(0, produced);
      const length = (token & 0xf) + MIN_REFERENCE_LENGTH;
      for (let step = 0; step < length; step += 1) {
        if (!emit(dictionary[(offset + step) & DICTIONARY_MASK])) return out.subarray(0, produced);
      }
    }
  }
  return produced === rawSize ? out : undefined;
}
