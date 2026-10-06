import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';

/**
 * Writes a RAR 5.0 archive whose entries are stored (no compression) and AES-256 encrypted, following
 * the RAR 5.0 technical note: an 8-byte signature, then blocks of CRC32, header size (vint) and header
 * (type, flags, optional extra-area and data sizes, type fields, extra area), each followed by its data.
 * Authored for the tests, separately from the archive engine under test; the `unrar` CLI is the judge
 * of every fixture.
 *
 * Key derivation is PBKDF2-HMAC-SHA256 over the UTF-8 password and a 16-byte salt with 2^count
 * iterations. The password check value is the same PBKDF2 run for 32 more iterations, XOR-folded to
 * 8 bytes and followed by the first 4 bytes of its SHA-256, so a wrong password is detected before
 * any data is decrypted (the "Incorrect password" exit status 11 path of unrar).
 *
 * With `headerEncrypted` every block after the encryption header is AES-256-CBC encrypted under a
 * fresh IV (as with `rar a -hp`), so even the entry names need the password.
 */
export interface Rar5Entry {
  name: string;
  data: Buffer;
}

export interface Rar5Options {
  password: string;
  /** Encrypts the headers too, not only the entry data. */
  headerEncrypted?: boolean;
}

const SIGNATURE = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
const HEAD_MAIN = 1;
const HEAD_FILE = 2;
const HEAD_CRYPT = 4;
const HEAD_END = 5;
/** Common header flag: an extra area follows the type fields. */
const FLAG_EXTRA_AREA = 0x01;
/** Common header flag: a data area follows the header. */
const FLAG_DATA_AREA = 0x02;
/** File flag: the CRC32 of the unpacked data is present. */
const FILE_FLAG_CRC32 = 0x04;
const FILE_ATTRIBUTES = 0x20;
/** Compression info 0: version 0, not solid, method 0 (store), smallest dictionary. */
const COMPRESSION_STORE = 0;
const HOST_OS_UNIX = 1;
/** Extra record type of the file encryption record. */
const EXTRA_FILE_ENCRYPTION = 1;
const ENCRYPTION_VERSION_AES256 = 0;
/** Encryption flag: a password check value follows the salt. */
const ENCRYPTION_FLAG_PASSWORD_CHECK = 0x01;
/** PBKDF2 iterations are 2^this; unrar accepts 15, the smallest cost that stays realistic. */
const KDF_COUNT_LOG2 = 15;
const KDF_KEY_BYTES = 32;
const CHECK_EXTRA_ITERATIONS = 32;
const SALT_BYTES = 16;
const IV_BYTES = 16;
const AES_BLOCK_BYTES = 16;
const CHECK_VALUE_BYTES = 8;
const CHECK_SUM_BYTES = 4;
const VINT_PAYLOAD_BITS = 7;
const VINT_PAYLOAD_MASK = 0x7f;
const VINT_CONTINUATION = 0x80;
/** CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320), the checksum RAR 5.0 uses for headers and data. */
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

function vint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  do {
    const payload = rest % (VINT_PAYLOAD_MASK + 1);
    rest = Math.floor(rest / (VINT_PAYLOAD_MASK + 1));
    bytes.push(rest > 0 ? payload | VINT_CONTINUATION : payload);
  } while (rest > 0);
  return Buffer.from(bytes);
}

/** Deterministic bytes so fixtures are byte-stable: SHA-256 of a label, cut to `length`. */
function fixedBytes(label: string, length: number): Buffer {
  return createHash('sha256').update(label).digest().subarray(0, length);
}

interface Rar5Keys {
  key: Buffer;
  checkValue: Buffer;
}

function deriveKeys(password: string, salt: Buffer): Rar5Keys {
  const iterations = 2 ** KDF_COUNT_LOG2;
  const secret = Buffer.from(password, 'utf-8');
  const key = pbkdf2Sync(secret, salt, iterations, KDF_KEY_BYTES, 'sha256');
  const checkSource = pbkdf2Sync(secret, salt, iterations + CHECK_EXTRA_ITERATIONS, KDF_KEY_BYTES, 'sha256');
  const folded = Buffer.alloc(CHECK_VALUE_BYTES);
  checkSource.forEach((byte, index) => {
    folded[index % CHECK_VALUE_BYTES] ^= byte;
  });
  const checksum = createHash('sha256').update(folded).digest().subarray(0, CHECK_SUM_BYTES);
  return { key, checkValue: Buffer.concat([folded, checksum]) };
}

function encryptAes256Cbc(plain: Buffer, key: Buffer, iv: Buffer): Buffer {
  const padded = Buffer.alloc(Math.ceil(plain.length / AES_BLOCK_BYTES) * AES_BLOCK_BYTES);
  plain.copy(padded);
  // The RAR 5.0 spec mandates AES-256-CBC without padding.
  const cipher = createCipheriv('aes-256-cbc', key, iv); // NOSONAR S5542: RAR 5.0 header and data encryption is AES-256-CBC without padding by specification; this generates a decryption fixture, not a protection
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

/** CRC32, header size and header, the block layout shared by every RAR 5.0 header. */
function sealBlock(fields: Buffer): Buffer {
  const size = vint(fields.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32LE(crc32(Buffer.concat([size, fields])));
  return Buffer.concat([crc, size, fields]);
}

function fileBlock(entry: Rar5Entry, password: string, index: number): { header: Buffer; data: Buffer } {
  const salt = fixedBytes(`salt:${index}`, SALT_BYTES);
  const iv = fixedBytes(`iv:${index}`, IV_BYTES);
  const entryKeys = deriveKeys(password, salt);
  const encrypted = encryptAes256Cbc(entry.data, entryKeys.key, iv);
  const record = Buffer.concat([
    vint(ENCRYPTION_VERSION_AES256),
    vint(ENCRYPTION_FLAG_PASSWORD_CHECK),
    Buffer.from([KDF_COUNT_LOG2]),
    salt,
    iv,
    entryKeys.checkValue,
  ]);
  const extra = Buffer.concat([vint(1 + record.length), vint(EXTRA_FILE_ENCRYPTION), record]);
  const name = Buffer.from(entry.name, 'utf-8');
  const crc = Buffer.alloc(4);
  crc.writeUInt32LE(crc32(entry.data));
  const typeFields = Buffer.concat([
    vint(FILE_FLAG_CRC32),
    vint(entry.data.length),
    vint(FILE_ATTRIBUTES),
    crc,
    vint(COMPRESSION_STORE),
    vint(HOST_OS_UNIX),
    vint(name.length),
    name,
  ]);
  const header = sealBlock(
    Buffer.concat([
      vint(HEAD_FILE),
      vint(FLAG_EXTRA_AREA | FLAG_DATA_AREA),
      vint(extra.length),
      vint(encrypted.length),
      typeFields,
      extra,
    ])
  );
  return { header, data: encrypted };
}

export function buildEncryptedRar5(entries: readonly Rar5Entry[], options: Rar5Options): Buffer {
  const blocks: Array<{ header: Buffer; data: Buffer }> = [
    { header: sealBlock(Buffer.concat([vint(HEAD_MAIN), vint(0), vint(0)])), data: Buffer.alloc(0) },
    ...entries.map((entry, index) => fileBlock(entry, options.password, index)),
    { header: sealBlock(Buffer.concat([vint(HEAD_END), vint(0), vint(0)])), data: Buffer.alloc(0) },
  ];
  if (!options.headerEncrypted) {
    return Buffer.concat([SIGNATURE, ...blocks.flatMap((block) => [block.header, block.data])]);
  }

  const headerSalt = fixedBytes('header-salt', SALT_BYTES);
  const headerKeys = deriveKeys(options.password, headerSalt);
  const cryptBlock = sealBlock(
    Buffer.concat([
      vint(HEAD_CRYPT),
      vint(0),
      vint(ENCRYPTION_VERSION_AES256),
      vint(ENCRYPTION_FLAG_PASSWORD_CHECK),
      Buffer.from([KDF_COUNT_LOG2]),
      headerSalt,
      headerKeys.checkValue,
    ])
  );
  const sealed = blocks.flatMap((block, index) => {
    const iv = fixedBytes(`header-iv:${index}`, IV_BYTES);
    return [iv, encryptAes256Cbc(block.header, headerKeys.key, iv), block.data];
  });
  return Buffer.concat([SIGNATURE, cryptBlock, ...sealed]);
}
