import crypto from 'node:crypto';
import { ArchivePasswordRequiredError, CorruptStreamError, UnsupportedArchiveMethodError } from '../types';

/**
 * The 7z AES-256 coder (method 06 F1 07 01): the key is the SHA-256 of `2^NumCyclesPower` repetitions of
 * salt + UTF-16LE password + an 8-byte little-endian round counter, and the data is AES-256-CBC with a zero-padded IV.
 * The header states the power, so a hostile archive picks how long the derivation runs; it is refused above the cap
 * before any hashing starts. 7-Zip itself writes 19 (about half a million rounds, tens of milliseconds).
 */

/** 2^24 rounds: the largest power 7-Zip writes. Higher values are refused as hostile work, not decoded slowly. */
export const SEVENZIP_MAX_KDF_CYCLES_POWER = 24;
/** The power value that selects the legacy "no hashing" key: salt and password bytes, zero padded. */
const KDF_RAW_KEY_POWER = 0x3f;
const KDF_POWER_MASK = 0x3f;
const KEY_BYTES = 32;
const IV_BYTES = 16;
const AES_BLOCK_BYTES = 16;
const COUNTER_BYTES = 8;
const ROUNDS_PER_HASH_UPDATE = 256;
const FLAG_SALT = 0x80;
const FLAG_IV = 0x40;
const NIBBLE_SHIFT = 4;
const NIBBLE_MASK = 0x0f;

interface AesProperties {
  cyclesPower: number;
  salt: Buffer;
  iv: Buffer;
}

function readProperties(properties: Buffer): AesProperties {
  if (properties.length < 1) throw new CorruptStreamError('Corrupted 7z archive: the AES coder has no properties');
  const first = properties[0];
  let saltSize = 0;
  let ivSize = 0;
  let offset = 1;
  if ((first & (FLAG_SALT | FLAG_IV)) !== 0) {
    if (properties.length < 2) throw new CorruptStreamError('Corrupted 7z archive: the AES properties are truncated');
    const sizes = properties[1];
    saltSize = ((first & FLAG_SALT) !== 0 ? 1 : 0) + (sizes >>> NIBBLE_SHIFT);
    ivSize = ((first & FLAG_IV) !== 0 ? 1 : 0) + (sizes & NIBBLE_MASK);
    offset = 2;
  }
  if (ivSize > IV_BYTES || properties.length !== offset + saltSize + ivSize) {
    throw new CorruptStreamError('Corrupted 7z archive: the AES properties do not match their stated sizes');
  }
  const iv = Buffer.alloc(IV_BYTES);
  properties.copy(iv, 0, offset + saltSize, offset + saltSize + ivSize);
  return { cyclesPower: first & KDF_POWER_MASK, salt: properties.subarray(offset, offset + saltSize), iv };
}

/** Refuses a key derivation above the cap. Called with the properties alone, so it needs no password. */
export function assertAesCostAcceptable(properties: Buffer): void {
  const { cyclesPower } = readProperties(properties);
  if (cyclesPower !== KDF_RAW_KEY_POWER && cyclesPower > SEVENZIP_MAX_KDF_CYCLES_POWER) {
    throw new UnsupportedArchiveMethodError(
      `Unsupported 7z encryption: the key derivation runs 2^${cyclesPower} rounds; at most 2^${SEVENZIP_MAX_KDF_CYCLES_POWER} are accepted.`
    );
  }
}

function deriveKey(password: string, { cyclesPower, salt }: AesProperties): Buffer {
  const passwordBytes = Buffer.from(password, 'utf16le');
  if (cyclesPower === KDF_RAW_KEY_POWER) {
    const key = Buffer.alloc(KEY_BYTES);
    Buffer.concat([salt, passwordBytes]).copy(key, 0, 0, KEY_BYTES);
    return key;
  }
  const unit = Buffer.concat([salt, passwordBytes, Buffer.alloc(COUNTER_BYTES)]);
  const rounds = 2 ** cyclesPower;
  const batchRounds = Math.min(rounds, ROUNDS_PER_HASH_UPDATE);
  const batch = Buffer.alloc(unit.length * batchRounds);
  for (let slot = 0; slot < batchRounds; slot += 1) unit.copy(batch, slot * unit.length);
  const counterOffset = unit.length - COUNTER_BYTES;
  const hash = crypto.createHash('sha256');
  for (let round = 0; round < rounds; round += batchRounds) {
    for (let slot = 0; slot < batchRounds; slot += 1) {
      const counter = round + slot;
      const at = slot * unit.length + counterOffset;
      batch.writeUInt32LE(counter % 0x100000000, at);
      batch.writeUInt32LE(Math.floor(counter / 0x100000000), at + 4);
    }
    hash.update(batch);
  }
  return hash.digest();
}

/**
 * Decrypts one AES coder stream. `outputSize` is what the coder declares: the encrypted stream is padded to whole
 * blocks and the padding is cut off. A wrong password gives no error here; the CRC check that follows reveals it.
 */
export function decryptSevenZipAes(encrypted: Buffer, properties: Buffer, password: string | undefined, outputSize: number): Buffer {
  assertAesCostAcceptable(properties);
  if (password === undefined || password === '') {
    throw new ArchivePasswordRequiredError('The 7z archive is password protected. A password is required to extract.');
  }
  if (encrypted.length % AES_BLOCK_BYTES !== 0 || encrypted.length < outputSize) {
    throw new CorruptStreamError('Corrupted 7z archive: the encrypted stream is not a whole number of AES blocks');
  }
  const parsed = readProperties(properties);
  const decipher = crypto.createDecipheriv('aes-256-cbc', deriveKey(password, parsed), parsed.iv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).subarray(0, outputSize);
}
