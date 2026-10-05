import { createCipheriv, createHash } from 'node:crypto';

/**
 * Writes a RAR 4.x archive whose entries are stored (method 0x30, no compression), following the RAR
 * 4.x technical note: a 7-byte marker block, a main header (type 0x73), one file header (type 0x74)
 * followed by the entry bytes per file, and an end-of-archive block (type 0x7b). Every header starts
 * with the low 16 bits of the CRC-32 of the header from its type byte on. Authored for the tests,
 * separately from the archive engine under test.
 *
 * With a password, each entry is encrypted the way RAR 3.x/4.x does: the file header carries the
 * password flag and an 8-byte salt, the key and IV come from 2^18 rounds of SHA-1 over the UTF-16LE
 * password and the salt, and the zero-padded data is AES-128-CBC encrypted.
 */
export interface StoredRarEntry {
  name: string;
  data: Buffer;
}

export interface StoredRarOptions {
  /** Encrypts every entry with this password. Header names stay readable (as with `rar a -p`). */
  password?: string;
}

const MARKER = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
const HEAD_MAIN = 0x73;
const HEAD_FILE = 0x74;
const HEAD_END = 0x7b;
/** File header flag: the block carries data (ADD_SIZE) after the header. */
const FLAG_LONG_BLOCK = 0x8000;
/** End-of-archive flag: no further volume follows. */
const FLAG_END_NO_NEXT_VOLUME = 0x4000;
const MAIN_HEADER_BYTES = 13;
const END_HEADER_BYTES = 7;
/** Bytes of a file header before its name. */
const FILE_HEADER_FIXED_BYTES = 32;
const HOST_OS_UNIX = 3;
const UNPACK_VERSION_2_9 = 29;
const METHOD_STORE = 0x30;
/** MS-DOS date/time of 2024-01-01 00:00:00, so archives are byte-stable. */
const DOS_TIME = ((2024 - 1980) << 25) | (1 << 21) | (1 << 16);
/** Unix mode 0100644 (regular file, rw-r--r--). */
const UNIX_REGULAR_FILE_MODE = 0o100644;
const CRC16_MASK = 0xffff;
/** File header flag: the entry data is encrypted. */
const FLAG_PASSWORD = 0x0004;
/** File header flag: an 8-byte encryption salt follows the file name. */
const FLAG_SALT = 0x0400;
const SALT_BYTES = 8;
/** Fixed salt keeps encrypted fixtures byte-stable. */
const FIXED_SALT = Buffer.from([0x45, 0x61, 0x73, 0x79, 0x43, 0x6f, 0x6e, 0x76]);
const AES_BLOCK_BYTES = 16;
/** RAR 3.x/4.x key derivation hashes the password and salt this many times. */
const KDF_ROUNDS = 0x40000;
/** One IV byte is sampled every ROUNDS / 16 rounds. */
const IV_SAMPLE_INTERVAL = KDF_ROUNDS / AES_BLOCK_BYTES;
const SHA1_DIGEST_BYTES = 20;
const SHA1_WORD_BYTES = 4;
/** CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320), the checksum RAR 4.x uses for headers and data. */
const CRC32_POLYNOMIAL = 0xedb88320;
const CRC32_TABLE = Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ CRC32_POLYNOMIAL : value >>> 1;
  return value >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function sealHeader(header: Buffer): Buffer {
  header.writeUInt16LE(crc32(header.subarray(2)) & CRC16_MASK, 0);
  return header;
}

function deriveRar4Key(password: string, salt: Buffer): { key: Buffer; iv: Buffer } {
  const raw = Buffer.concat([Buffer.from(password, 'utf16le'), salt]);
  const hash = createHash('sha1');
  const iv = Buffer.alloc(AES_BLOCK_BYTES);
  for (let round = 0; round < KDF_ROUNDS; round += 1) {
    hash.update(raw);
    hash.update(Buffer.from([round & 0xff, (round >>> 8) & 0xff, (round >>> 16) & 0xff]));
    if (round % IV_SAMPLE_INTERVAL === 0) iv[round / IV_SAMPLE_INTERVAL] = hash.copy().digest()[SHA1_DIGEST_BYTES - 1];
  }
  const digest = hash.digest();
  const key = Buffer.alloc(AES_BLOCK_BYTES);
  for (let word = 0; word < AES_BLOCK_BYTES / SHA1_WORD_BYTES; word += 1) {
    // The key is the first four SHA-1 state words, each written little-endian.
    for (let byte = 0; byte < SHA1_WORD_BYTES; byte += 1) {
      key[word * SHA1_WORD_BYTES + byte] = digest[word * SHA1_WORD_BYTES + SHA1_WORD_BYTES - 1 - byte];
    }
  }
  return { key, iv };
}

function encryptEntry(data: Buffer, password: string): Buffer {
  const { key, iv } = deriveRar4Key(password, FIXED_SALT);
  const padded = Buffer.alloc(Math.ceil(data.length / AES_BLOCK_BYTES) * AES_BLOCK_BYTES);
  data.copy(padded);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

export function buildStoredRar4(entries: readonly StoredRarEntry[], options: StoredRarOptions = {}): Buffer {
  const main = Buffer.alloc(MAIN_HEADER_BYTES);
  main.writeUInt8(HEAD_MAIN, 2);
  main.writeUInt16LE(0, 3);
  main.writeUInt16LE(MAIN_HEADER_BYTES, 5);
  const blocks: Buffer[] = [MARKER, sealHeader(main)];

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'latin1');
    const encrypted = options.password === undefined ? undefined : encryptEntry(entry.data, options.password);
    const stored = encrypted ?? entry.data;
    const saltBytes = encrypted ? SALT_BYTES : 0;
    const header = Buffer.alloc(FILE_HEADER_FIXED_BYTES + name.length + saltBytes);
    header.writeUInt8(HEAD_FILE, 2);
    header.writeUInt16LE(FLAG_LONG_BLOCK | (encrypted ? FLAG_PASSWORD | FLAG_SALT : 0), 3);
    header.writeUInt16LE(header.length, 5);
    header.writeUInt32LE(stored.length, 7);
    header.writeUInt32LE(entry.data.length, 11);
    header.writeUInt8(HOST_OS_UNIX, 15);
    header.writeUInt32LE(crc32(entry.data), 16);
    header.writeUInt32LE(DOS_TIME >>> 0, 20);
    header.writeUInt8(UNPACK_VERSION_2_9, 24);
    header.writeUInt8(METHOD_STORE, 25);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt32LE(UNIX_REGULAR_FILE_MODE, 28);
    name.copy(header, FILE_HEADER_FIXED_BYTES);
    if (encrypted) FIXED_SALT.copy(header, FILE_HEADER_FIXED_BYTES + name.length);
    blocks.push(sealHeader(header), stored);
  }

  const end = Buffer.alloc(END_HEADER_BYTES);
  end.writeUInt8(HEAD_END, 2);
  end.writeUInt16LE(FLAG_END_NO_NEXT_VOLUME, 3);
  end.writeUInt16LE(END_HEADER_BYTES, 5);
  blocks.push(sealHeader(end));
  return Buffer.concat(blocks);
}
