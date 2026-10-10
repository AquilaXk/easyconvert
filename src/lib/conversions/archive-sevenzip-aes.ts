import crypto from 'node:crypto';
import { runCpuTask, yieldToEventLoop } from '../workers/cpu-pool';
import { ArchivePasswordRequiredError, UnsupportedArchiveMethodError } from '../types';
import { SevenZipStructureError } from './sevenzip-reader';

/**
 * The 7z AES-256 coder (method 06 F1 07 01): the key is the SHA-256 of `2^NumCyclesPower` repetitions of
 * salt + UTF-16LE password + an 8-byte little-endian round counter, and the data is AES-256-CBC with a zero-padded IV.
 *
 * The header states the power, and a non-solid archive repeats the coder for every file, so the derivation is the one
 * piece of work an archive can multiply at will. Three bounds keep it cheap: a power above the cap is refused before
 * any hashing; a derived key is kept for the whole archive (every folder with the same salt and power reuses it, as
 * 7-Zip's own key cache does); and the rounds of all distinct keys of one archive share a total budget. A derivation
 * that is large enough to be felt runs on a pool thread, so it never blocks the event loop.
 * 7-Zip itself writes a power of 19 (about half a million rounds, tens of milliseconds).
 */

/** 2^24 rounds: the largest power 7-Zip writes. Higher values are refused as hostile work, not decoded slowly. */
export const SEVENZIP_MAX_KDF_CYCLES_POWER = 24;
/** Rounds one archive may spend on all of its distinct keys together: four keys at the cap, 128 at 7-Zip's default. */
export const SEVENZIP_MAX_KDF_TOTAL_ROUNDS = 2 ** 26;
/** A derivation up to this many rounds (about 25 ms) is cheaper on the calling thread than a task on the pool. */
export const SEVENZIP_KDF_INLINE_ROUNDS = 2 ** 20;
/** The pool task kind that derives one key. */
export const SEVENZIP_KDF_TASK = 'sevenZipKdf';

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

/** What a key depends on besides the password. */
export interface AesKeyRequest {
  cyclesPower: number;
  salt: Buffer;
}

interface AesProperties extends AesKeyRequest {
  iv: Buffer;
}

function structure(detail: string): SevenZipStructureError {
  return new SevenZipStructureError(`Corrupted 7z archive: ${detail}`);
}

function readProperties(properties: Buffer): AesProperties {
  if (properties.length < 1) throw structure('the AES coder has no properties');
  const first = properties[0];
  let saltSize = 0;
  let ivSize = 0;
  let offset = 1;
  if ((first & (FLAG_SALT | FLAG_IV)) !== 0) {
    if (properties.length < 2) throw structure('the AES properties are truncated');
    const sizes = properties[1];
    saltSize = ((first & FLAG_SALT) !== 0 ? 1 : 0) + (sizes >>> NIBBLE_SHIFT);
    ivSize = ((first & FLAG_IV) !== 0 ? 1 : 0) + (sizes & NIBBLE_MASK);
    offset = 2;
  }
  if (ivSize > IV_BYTES || properties.length !== offset + saltSize + ivSize) {
    throw structure('the AES properties do not match their stated sizes');
  }
  const iv = Buffer.alloc(IV_BYTES);
  properties.copy(iv, 0, offset + saltSize, offset + saltSize + ivSize);
  return { cyclesPower: first & KDF_POWER_MASK, salt: properties.subarray(offset, offset + saltSize), iv };
}

/** The key parameters an AES coder states, refused when the derivation is above the cap. Needs no password. */
export function aesKeyRequestOf(properties: Buffer): AesKeyRequest {
  const { cyclesPower, salt } = readProperties(properties);
  if (cyclesPower !== KDF_RAW_KEY_POWER && cyclesPower > SEVENZIP_MAX_KDF_CYCLES_POWER) {
    throw new UnsupportedArchiveMethodError(
      `Unsupported 7z encryption: the key derivation runs 2^${cyclesPower} rounds; at most 2^${SEVENZIP_MAX_KDF_CYCLES_POWER} are accepted.`
    );
  }
  return { cyclesPower, salt };
}

function roundsOf(request: AesKeyRequest): number {
  return request.cyclesPower === KDF_RAW_KEY_POWER ? 0 : 2 ** request.cyclesPower;
}

/** The AES-256 key for a password and the parameters of the coder. Pure CPU work, up to 2^24 rounds of SHA-256. */
export function deriveSevenZipKey(password: string, { cyclesPower, salt }: AesKeyRequest): Buffer {
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

/** Raised by a cache that must not derive on the calling thread when a key it does not hold is asked for. */
export class AesKeyMissingError extends Error {
  constructor(readonly request: AesKeyRequest) {
    super('A 7z AES key has not been derived yet.');
    this.name = 'AesKeyMissingError';
  }
}

/**
 * The keys of one archive read, for one password. A key is derived once per distinct salt and power, and the rounds of
 * all of them are charged to one budget before any hashing starts. In deferred mode a missing key raises
 * `AesKeyMissingError` instead of being derived on the calling thread, so an async reader can derive it on the pool and
 * read again.
 */
export class AesKeyCache {
  private readonly keys = new Map<string, Buffer>();
  private spentRounds = 0;
  deferred = false;

  constructor(readonly password: string | undefined) {}

  private static idOf(request: AesKeyRequest): string {
    return `${request.cyclesPower}:${request.salt.toString('hex')}`;
  }

  has(request: AesKeyRequest): boolean {
    return this.keys.has(AesKeyCache.idOf(request));
  }

  private reserve(requests: AesKeyRequest[]): void {
    const rounds = requests.reduce((sum, request) => sum + roundsOf(request), 0);
    if (this.spentRounds + rounds > SEVENZIP_MAX_KDF_TOTAL_ROUNDS) {
      throw new UnsupportedArchiveMethodError(
        `Unsupported 7z encryption: the archive's keys need more than 2^${Math.log2(SEVENZIP_MAX_KDF_TOTAL_ROUNDS)} rounds of key derivation in total.`
      );
    }
    this.spentRounds += rounds;
  }

  /** The key for a request, derived on the calling thread unless the cache is deferred. Needs a password. */
  keyFor(request: AesKeyRequest): Buffer {
    const id = AesKeyCache.idOf(request);
    const known = this.keys.get(id);
    if (known !== undefined) return known;
    if (this.deferred) throw new AesKeyMissingError(request);
    if (this.password === undefined || this.password === '') {
      throw new ArchivePasswordRequiredError('The 7z archive is password protected. A password is required to extract.');
    }
    this.reserve([request]);
    const key = deriveSevenZipKey(this.password, request);
    this.keys.set(id, key);
    return key;
  }

  /**
   * Derives the keys the requests need that the cache does not hold yet, without blocking the event loop: a large
   * derivation runs on a pool thread (stopped when `signal` aborts), a small one in slices on this thread. The
   * whole set is charged to the budget first, so a hostile set is refused before any hashing.
   */
  async prepare(requests: AesKeyRequest[], signal?: AbortSignal): Promise<void> {
    const password = this.password;
    if (password === undefined || password === '') return;
    const distinct = new Map<string, AesKeyRequest>();
    for (const request of requests) {
      const id = AesKeyCache.idOf(request);
      if (!this.keys.has(id)) distinct.set(id, request);
    }
    this.reserve([...distinct.values()]);
    for (const [id, request] of distinct) {
      signal?.throwIfAborted();
      if (roundsOf(request) <= SEVENZIP_KDF_INLINE_ROUNDS) {
        this.keys.set(id, deriveSevenZipKey(password, request));
        await yieldToEventLoop();
        continue;
      }
      const key = await runCpuTask<Uint8Array>(SEVENZIP_KDF_TASK, { password, cyclesPower: request.cyclesPower, salt: request.salt }, { signal });
      this.keys.set(id, Buffer.from(key));
    }
  }
}

/**
 * Decrypts one AES coder stream. `outputSize` is what the coder declares: the encrypted stream is padded to whole
 * blocks and the padding is cut off. A wrong password gives no error here; the CRC check that follows reveals it.
 */
export function decryptSevenZipAes(encrypted: Buffer, properties: Buffer, keys: AesKeyCache, outputSize: number): Buffer {
  const request = aesKeyRequestOf(properties);
  if (keys.password === undefined || keys.password === '') {
    throw new ArchivePasswordRequiredError('The 7z archive is password protected. A password is required to extract.');
  }
  if (encrypted.length % AES_BLOCK_BYTES !== 0 || encrypted.length < outputSize) {
    throw structure('the encrypted stream is not a whole number of AES blocks or is shorter than its declared size');
  }
  const parsed = readProperties(properties);
  const decipher = crypto.createDecipheriv('aes-256-cbc', keys.keyFor(request), parsed.iv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).subarray(0, outputSize);
}
