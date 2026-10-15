import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { convertArchive, extract7zArchive } from '../src/lib/conversions/archive';
import { UnsafeArchiveError } from '../src/lib/conversions/archive-extraction-safety';
import {
  ArchivePasswordRequiredError,
  CorruptStreamError,
  DecompressionLimitError,
  InvalidArchivePasswordError,
  UnsupportedArchiveMethodError,
} from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { craftSevenZip } from './helpers/seven-zip-craft';
import { craftFolderArchive, type CraftedFolder } from './helpers/seven-zip-folders';
import { expectNoHangOnInput } from './helpers/timing';

/**
 * 7z folders with coder chains (BCJ, BCJ2, Delta, AES) are read against archives written by the reference 7-Zip: what
 * `7z x` writes is the oracle, and the reader's bytes must equal it file for file. The hostile folders (a coder count
 * past the limit, sizes that lie, a key derivation of 2^30 rounds, a CRC that does not match) are written byte by byte
 * and must end in a typed error, quickly, never in an empty list or in undecoded bytes.
 */
const TEST_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 60_000;
const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;
const PASSWORD = 'correct horse battery staple';
const ID_COPY = [0x00];
const ID_BCJ2 = [0x03, 0x03, 0x01, 0x1b];
const ID_BCJ = [0x03, 0x03, 0x01, 0x03];
const ID_LZMA = [0x03, 0x01, 0x01];
const ID_AES = [0x06, 0xf1, 0x07, 0x01];
const HTTP_UNPROCESSABLE = 422;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_BAD_REQUEST = 400;

let workDir = '';

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seven-zip-chains-'));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function sevenZip(args: string[], cwd?: string): string {
  return execFileSync(requireOracleTool('7z'), args, { encoding: 'utf-8', timeout: COMMAND_TIMEOUT_MS, cwd });
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function failureOf(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

/** A deterministic pseudo-random stream (xorshift32), so every run builds the same fixtures. */
function randomWords(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

type PayloadMaker = (size: number, seed: number) => Buffer;

/** x86-like code: call, jump and conditional-jump opcodes with 32-bit displacements whose top byte is 00 or FF. */
const x86Code: PayloadMaker = (size, seed) => {
  const next = randomWords(seed);
  const out = Buffer.alloc(size);
  let pos = 0;
  while (pos < size) {
    const r = next();
    const kind = r & 7;
    const displacement = (r >>> 8) & 0x00ffffff;
    const top = (r & 0x8) === 0 ? 0x00 : 0xff;
    if (kind < 3 && pos + 5 <= size) {
      out[pos] = kind === 0 ? 0xe9 : 0xe8;
      out.writeUInt32LE(((top << 24) | (kind === 2 ? displacement & 0xffff : displacement)) >>> 0, pos + 1);
      pos += 5;
    } else if (kind === 3 && pos + 6 <= size) {
      out[pos] = 0x0f;
      out[pos + 1] = 0x80 | ((r >>> 4) & 0xf);
      out.writeUInt32LE(((top << 24) | (displacement & 0xffff)) >>> 0, pos + 2);
      pos += 6;
    } else {
      out[pos] = (r >>> 16) & 0xff;
      pos += 1;
    }
  }
  // A call opcode in the last bytes, where no displacement follows, must survive the filter untouched.
  out[size - 1] = 0xe8;
  return out;
};

/** 32-bit words, little endian: roughly a quarter are calls, an eighth page-relative address loads, the rest noise. */
function wordCode(littleEndian: boolean, shape: (r: number) => number): PayloadMaker {
  return (size, seed) => {
    const next = randomWords(seed);
    const out = Buffer.alloc(size - (size % 4));
    for (let pos = 0; pos < out.length; pos += 4) {
      const word = shape(next()) >>> 0;
      if (littleEndian) out.writeUInt32LE(word, pos);
      else out.writeUInt32BE(word, pos);
    }
    return Buffer.concat([out, Buffer.from([0xeb, 0x00, 0x00])]);
  };
}

const armCode = wordCode(true, (r) => ((r & 3) === 0 ? 0xeb000000 | (r >>> 8) : r));
const arm64Code = wordCode(true, (r) => {
  if ((r & 3) === 0) return 0x94000000 | ((r >>> 6) & 0x03ffffff);
  if ((r & 7) === 1) return 0x90000000 | ((r >>> 7) & 0x60000000) | (((r >>> 10) & 0x3ffff) << 5) | (r & 0x1f);
  return r;
});
const ppcCode = wordCode(false, (r) => ((r & 3) === 0 ? 0x48000001 | ((r >>> 8) & 0x03fffffc) : r));
const sparcCode = wordCode(false, (r) => {
  if ((r & 3) === 0) return 0x40000000 | ((r >>> 8) & 0x003fffff);
  if ((r & 3) === 1) return 0x7fc00000 | ((r >>> 8) & 0x003fffff);
  return r;
});

/** ARM Thumb: pairs of halfwords of the BL encoding (F000 + 11 bits, F800 + 11 bits). */
const thumbCode: PayloadMaker = (size, seed) => {
  const next = randomWords(seed);
  const out = Buffer.alloc(size - (size % 2));
  for (let pos = 0; pos + 4 <= out.length; pos += 2) {
    const r = next();
    if ((r & 3) === 0) {
      out.writeUInt16LE(0xf000 | ((r >>> 8) & 0x7ff), pos);
      out.writeUInt16LE(0xf800 | ((r >>> 19) & 0x7ff), pos + 2);
      pos += 2;
    } else {
      out.writeUInt16LE(r & 0xffff, pos);
    }
  }
  return out;
};

/** IA-64: 16-byte bundles whose template carries branch slots, with slot bits drawn at random. */
const itaniumCode: PayloadMaker = (size, seed) => {
  const next = randomWords(seed);
  const templates = [0x10, 0x11, 0x12, 0x13, 0x16, 0x17, 0x18, 0x19, 0x1c, 0x1d];
  const out = Buffer.alloc(size - (size % 16));
  for (let pos = 0; pos < out.length; pos += 16) {
    for (let index = 0; index < 16; index += 4) out.writeUInt32LE(next(), pos + index);
    out[pos] = (out[pos] & 0xe0) | templates[next() % templates.length];
    // Steer the slots towards the branch opcode (4 bits = 5 at bit 37, three zero bits at bit 9) so the filter has work.
    for (let slot = 0; slot < 3; slot += 1) {
      if ((next() & 1) === 0) continue;
      const bitPos = 5 + slot * 41;
      const bytePos = bitPos >> 3;
      const shift = bitPos & 7;
      let instruction = 0n;
      for (let j = 0; j < 6; j += 1) instruction |= BigInt(out[pos + bytePos + j]) << BigInt(8 * j);
      let normal = instruction >> BigInt(shift);
      normal &= ~(0xfn << 37n);
      normal |= 0x5n << 37n;
      normal &= ~(0x7n << 9n);
      instruction = (instruction & ((1n << BigInt(shift)) - 1n)) | (normal << BigInt(shift));
      for (let j = 0; j < 6; j += 1) out[pos + bytePos + j] = Number((instruction >> BigInt(8 * j)) & 0xffn);
    }
  }
  return out;
};

/** Smooth sampled data, the case the Delta filter is for. */
const sampled: PayloadMaker = (size, seed) => {
  const next = randomWords(seed);
  const out = Buffer.alloc(size);
  let level = 0;
  for (let pos = 0; pos < size; pos += 1) {
    level = (level + (next() % 7) - 3) & 0xff;
    out[pos] = level;
  }
  return out;
};

interface FixtureFile {
  name: string;
  bytes: Buffer;
}

/** Writes the fixture tree: two payload files in different directories, an empty file and an empty directory. */
function writeTree(dir: string, maker: PayloadMaker): FixtureFile[] {
  fs.mkdirSync(path.join(dir, 'sub', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'emptydir'));
  const files: FixtureFile[] = [
    { name: 'first.bin', bytes: maker(150_001, 7) },
    { name: 'sub/second.bin', bytes: maker(40_000, 11) },
    { name: 'sub/deep/third.bin', bytes: maker(4_099, 13) },
    { name: 'empty.dat', bytes: Buffer.alloc(0) },
  ];
  for (const file of files) fs.writeFileSync(path.join(dir, file.name), file.bytes);
  return files;
}

interface MadeArchive {
  archive: Buffer;
  archivePath: string;
  files: FixtureFile[];
  /** sha256 of every file as `7z x` writes it, by name: the oracle. */
  oracle: Map<string, string>;
  listing: string;
}

function makeArchive(label: string, maker: PayloadMaker, options: string[], password?: string): MadeArchive {
  const dir = path.join(workDir, label);
  const source = path.join(dir, 'source');
  fs.mkdirSync(source, { recursive: true });
  const files = writeTree(source, maker);
  const archivePath = path.join(dir, 'fixture.7z');
  sevenZip(['a', '-t7z', '-y', ...(password === undefined ? [] : [`-p${password}`]), ...options, archivePath, '.'], source);
  const outDir = path.join(dir, 'oracle');
  sevenZip(['x', '-y', `-o${outDir}`, ...(password === undefined ? [] : [`-p${password}`]), archivePath]);
  const oracle = new Map<string, string>();
  for (const file of files) oracle.set(file.name, sha256(fs.readFileSync(path.join(outDir, file.name))));
  const listing = sevenZip(['l', '-slt', ...(password === undefined ? [] : [`-p${password}`]), archivePath]);
  return { archive: fs.readFileSync(archivePath), archivePath, files, oracle, listing };
}

function extractedHashes(extracted: { filename: string; buffer: Buffer }[]): Map<string, string> {
  return new Map(extracted.map((entry) => [entry.filename, sha256(entry.buffer)]));
}

function expectSameAsOracle(made: MadeArchive, extracted: { filename: string; buffer: Buffer }[]): void {
  const hashes = extractedHashes(extracted);
  expect([...hashes.keys()].sort()).toEqual([...made.oracle.keys()].sort());
  for (const [name, digest] of made.oracle) expect(hashes.get(name), name).toBe(digest);
  // The oracle is itself checked against what went into the archive.
  for (const file of made.files) expect(made.oracle.get(file.name), `${file.name} as 7-Zip extracts it`).toBe(sha256(file.bytes));
}

describe('7z folders with filter chains match the reference 7-Zip', () => {
  const filters: { label: string; method: RegExp; options: string[]; maker: PayloadMaker }[] = [
    { label: 'x86 BCJ', method: /BCJ(?!2)/, options: ['-mf=BCJ'], maker: x86Code },
    { label: 'ARM', method: /ARM(?!64|T)/, options: ['-mf=ARM'], maker: armCode },
    { label: 'ARM Thumb', method: /ARMT/, options: ['-mf=ARMT'], maker: thumbCode },
    { label: 'ARM64', method: /ARM64/, options: ['-mf=ARM64'], maker: arm64Code },
    { label: 'PowerPC', method: /PPC/, options: ['-mf=PPC'], maker: ppcCode },
    { label: 'SPARC', method: /SPARC/, options: ['-mf=SPARC'], maker: sparcCode },
    { label: 'IA-64', method: /IA64/, options: ['-mf=IA64'], maker: itaniumCode },
    { label: 'BCJ2 with its four streams', method: /BCJ2/, options: ['-mf=BCJ2'], maker: x86Code },
    { label: 'Delta:4', method: /Delta:4/, options: ['-m0=Delta:4', '-m1=LZMA2'], maker: sampled },
    { label: 'Delta:1 then BCJ', method: /Delta:1[\s\S]*BCJ|BCJ[\s\S]*Delta:1/, options: ['-m0=Delta:1', '-m1=BCJ', '-m2=LZMA2'], maker: x86Code },
  ];
  for (const { label, method, options, maker } of filters) {
    for (const solid of [false, true]) {
      oracleTest(
        `${label}, ${solid ? 'solid' : 'one folder per file'}: every file equals what 7z x writes`,
        ['7z'],
        () => {
          const made = makeArchive(`${label.replace(/\W+/g, '-')}-${solid ? 'solid' : 'plain'}`, maker, [...options, solid ? '-ms=on' : '-ms=off']);
          expect(made.listing, 'the fixture must really use the filter').toMatch(method);
          expectSameAsOracle(made, extract7zArchive(made.archive));
        },
        TEST_TIMEOUT_MS
      );
    }
  }

  oracleTest(
    'the single-coder methods still match: Copy, Deflate, BZip2, LZMA and LZMA2',
    ['7z'],
    () => {
      for (const method of ['Copy', 'Deflate', 'BZip2', 'LZMA', 'LZMA2']) {
        const made = makeArchive(`single-${method}`, x86Code, [`-m0=${method}`, '-mf=off']);
        expectSameAsOracle(made, extract7zArchive(made.archive));
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'the entry filter selects files inside a filtered folder',
    ['7z'],
    () => {
      const made = makeArchive('entries-bcj', x86Code, ['-mf=BCJ', '-ms=on']);
      const selected = extract7zArchive(made.archive, { entries: ['sub/**'] });
      expect(selected.map((file) => file.filename).sort()).toEqual(['sub/deep/third.bin', 'sub/second.bin']);
      for (const file of selected) expect(sha256(file.buffer)).toBe(made.oracle.get(file.filename));
    },
    TEST_TIMEOUT_MS
  );
});

describe('methods the reader does not decode fail with a typed 422', () => {
  oracleTest(
    'PPMd, which 7-Zip writes and this engine does not read',
    ['7z'],
    () => {
      const made = makeArchive('ppmd', x86Code, ['-m0=PPMd']);
      const failure = failureOf(() => extract7zArchive(made.archive));
      expect(failure).toBeInstanceOf(UnsupportedArchiveMethodError);
      expect((failure as UnsupportedArchiveMethodError).status).toBe(HTTP_UNPROCESSABLE);
      expect((failure as Error).message).toMatch(/030401/);
    },
    TEST_TIMEOUT_MS
  );

  function copyFolderWithMethod(id: number[], properties?: Buffer): Buffer {
    const data = Buffer.from('payload bytes that must never be returned as they are');
    return craftFolderArchive([
      { name: 'a.bin', coders: [{ id, properties }], bindPairs: [], packStreams: [data], outSizes: [data.length], crc: zlib.crc32(data) },
    ]);
  }

  it.each([
    ['an unassigned method id', [0x7f, 0x7f, 0x7f]],
    ['Deflate64, which Deflate decoding would misread', [0x04, 0x01, 0x09]],
    ['the RISC-V branch filter', [0x0b]],
  ])('%s', (_label, id) => {
    const failure = failureOf(() => extract7zArchive(copyFolderWithMethod(id)));
    expect(failure).toBeInstanceOf(UnsupportedArchiveMethodError);
    expect((failure as UnsupportedArchiveMethodError).status).toBe(HTTP_UNPROCESSABLE);
    expect((failure as Error).message).toMatch(/^Unsupported 7z compression method 0x[0-9a-f]+: /);
  });

  it('a branch filter with properties it does not define', () => {
    const failure = failureOf(() => extract7zArchive(copyFolderWithMethod(ID_BCJ, Buffer.from([1, 2, 3]))));
    expect(failure).toBeInstanceOf(UnsupportedArchiveMethodError);
    expect((failure as Error).message).toMatch(/the BCJ x86 filter has properties it does not define/);
  });
});

describe('AES-256 7z archives', () => {
  for (const headerMode of ['-mhe=off', '-mhe=on']) {
    oracleTest(
      `decrypt with the right password (${headerMode}), BCJ-filtered`,
      ['7z'],
      () => {
        const made = makeArchive(`aes-${headerMode}`, x86Code, ['-mf=BCJ', headerMode, '-ms=on'], PASSWORD);
        expectSameAsOracle(made, extract7zArchive(made.archive, { password: PASSWORD }));
      },
      TEST_TIMEOUT_MS
    );

    oracleTest(
      `refuse a missing password (${headerMode}) with the password-required error`,
      ['7z'],
      () => {
        const made = makeArchive(`aes-missing-${headerMode}`, x86Code, [headerMode], PASSWORD);
        for (const options of [{}, { password: '' }]) {
          const failure = failureOf(() => extract7zArchive(made.archive, options));
          expect(failure).toBeInstanceOf(ArchivePasswordRequiredError);
          expect((failure as Error).message).toMatch(/password protected\. A password is required/);
        }
      },
      TEST_TIMEOUT_MS
    );

    oracleTest(
      `refuse a wrong password (${headerMode}) with the invalid-password error`,
      ['7z'],
      () => {
        const made = makeArchive(`aes-wrong-${headerMode}`, x86Code, ['-mf=BCJ', headerMode], PASSWORD);
        const failure = failureOf(() => extract7zArchive(made.archive, { password: `${PASSWORD}!` }));
        expect(failure).toBeInstanceOf(InvalidArchivePasswordError);
        expect((failure as Error).message).not.toContain(PASSWORD);
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'an archive converted through convertArchive keeps the typed password errors',
    ['7z'],
    async () => {
      const made = makeArchive('aes-convert', x86Code, ['-mhe=on'], PASSWORD);
      await expect(convertArchive(made.archive, '7z', 'zip', {}, 'secret.7z')).rejects.toBeInstanceOf(ArchivePasswordRequiredError);
      await expect(convertArchive(made.archive, '7z', 'zip', { password: 'nope' }, 'secret.7z')).rejects.toBeInstanceOf(InvalidArchivePasswordError);
      const converted = await convertArchive(made.archive, '7z', 'zip', { password: PASSWORD }, 'secret.7z');
      const zipPath = path.join(workDir, 'converted.zip');
      fs.writeFileSync(zipPath, converted.buffer);
      const outDir = path.join(workDir, 'converted-out');
      // A request with a password writes the converted archive encrypted with the same password.
      sevenZip(['x', '-y', `-p${PASSWORD}`, `-o${outDir}`, zipPath]);
      for (const file of made.files) expect(sha256(fs.readFileSync(path.join(outDir, file.name)))).toBe(made.oracle.get(file.name));
    },
    TEST_TIMEOUT_MS
  );

  function aesProperties(cyclesPower: number): Buffer {
    // Bit 7 and bit 6: a salt and an IV are present; the second byte holds their sizes minus the flag bit.
    return Buffer.concat([Buffer.from([0xc0 | cyclesPower, 0x00]), Buffer.alloc(1, 0x5a), Buffer.alloc(1, 0xa5)]);
  }

  function aesFolder(cyclesPower: number): Buffer {
    const sealed = Buffer.alloc(32, 0x42);
    return craftFolderArchive([
      {
        name: 'locked.bin',
        coders: [{ id: ID_AES, properties: aesProperties(cyclesPower) }],
        bindPairs: [],
        packStreams: [sealed],
        outSizes: [sealed.length],
        // A CRC the random bytes cannot match: the only way to notice a wrong key.
        crc: 0x12345678,
      },
    ]);
  }

  it.each([['with'], ['without']])('a key derivation of 2^30 rounds is refused %s a password, at once and typed', async (mode) => {
    const archive = aesFolder(30);
    const options = mode === 'with' ? { password: PASSWORD } : {};
    const { largeResult } = await expectNoHangOnInput('2^30 key derivation rounds', (input: Buffer) => failureOf(() => extract7zArchive(input, options)), archive, 2_000);
    expect(largeResult).toBeInstanceOf(UnsupportedArchiveMethodError);
    expect((largeResult as UnsupportedArchiveMethodError).status).toBe(HTTP_UNPROCESSABLE);
    expect((largeResult as Error).message).toMatch(/2\^30/);
  });

  it('a key derivation power just past the cap is refused, one at the cap is attempted', () => {
    const pastCap = failureOf(() => extract7zArchive(aesFolder(25), { password: PASSWORD }));
    expect(pastCap).toBeInstanceOf(UnsupportedArchiveMethodError);
    expect((pastCap as Error).message).toMatch(/2\^25 rounds; at most 2\^24 are accepted/);
    // Power 0 is one round: the folder is accepted and fails later because the password cannot open random bytes.
    const atFloor = failureOf(() => extract7zArchive(aesFolder(0), { password: PASSWORD }));
    expect(atFloor).toBeInstanceOf(InvalidArchivePasswordError);
    expect((atFloor as Error).message).toBe('Invalid password for the encrypted 7z archive.');
  });
});

describe('structural defects of an encrypted folder are malformed input, not a wrong password', () => {
  const AES_PROPERTIES = Buffer.concat([Buffer.from([0xc0, 0x00]), Buffer.alloc(1, 0x5a), Buffer.alloc(1, 0xa5)]);
  const DECLARED_BLOCKS = 16;

  function aesStream(packLength: number, declared: number): Buffer {
    return craftFolderArchive([
      {
        name: 'locked.bin',
        coders: [{ id: ID_AES, properties: AES_PROPERTIES }],
        bindPairs: [],
        packStreams: [Buffer.alloc(packLength, 0x42)],
        outSizes: [declared],
        crc: 0x12345678,
      },
    ]);
  }

  it.each([
    ['a pack stream of 17 bytes, which is not whole AES blocks', 17, DECLARED_BLOCKS],
    ['a pack stream of 16 bytes under a declared size of 32', 16, 2 * DECLARED_BLOCKS],
    ['a pack stream of 32 bytes under a declared size of 33', 32, 33],
  ])('%s', (_label, packLength, declared) => {
    const failure = failureOf(() => extract7zArchive(aesStream(packLength, declared), { password: PASSWORD }));
    expect(failure).toBeInstanceOf(CorruptStreamError);
    expect(failure).not.toBeInstanceOf(InvalidArchivePasswordError);
    expect((failure as CorruptStreamError).status).toBe(HTTP_BAD_REQUEST);
    expect((failure as Error).message).toMatch(/not a whole number of AES blocks or is shorter than its declared size/);
  });

  it('AES properties that do not parse are malformed input as well', () => {
    const archive = craftFolderArchive([
      { name: 'locked.bin', coders: [{ id: ID_AES, properties: Buffer.from([0xc0]) }], bindPairs: [], packStreams: [Buffer.alloc(16)], outSizes: [16], crc: 1 },
    ]);
    const failure = failureOf(() => extract7zArchive(archive, { password: PASSWORD }));
    expect(failure).toBeInstanceOf(CorruptStreamError);
    expect(failure).not.toBeInstanceOf(InvalidArchivePasswordError);
    expect((failure as Error).message).toMatch(/the AES properties are truncated/);
  });

  it('a coder graph that loops in an encrypted folder is a 400, not a 422 wrong password', () => {
    // The AES coder and a stored coder feed each other; a third coder reads the pack stream and nothing reads the first two.
    const folder: CraftedFolder = {
      name: 'a',
      coders: [{ id: ID_AES, properties: AES_PROPERTIES }, { id: ID_COPY }, { id: ID_COPY }],
      bindPairs: [
        [0, 1],
        [1, 0],
      ],
      packStreams: [Buffer.alloc(16)],
      outSizes: [16, 16, 16],
      crc: 0x12345678,
    };
    const failure = failureOf(() => extract7zArchive(craftFolderArchive([folder]), { password: PASSWORD }));
    expect(failure).toBeInstanceOf(CorruptStreamError);
    expect(failure).not.toBeInstanceOf(InvalidArchivePasswordError);
    expect((failure as CorruptStreamError).status).toBe(HTTP_BAD_REQUEST);
    expect((failure as Error).message).toMatch(/a coder of the folder feeds nothing/);
  });
});

describe('every coder stops at the size it declares', () => {
  const ID_LZMA2 = [0x21];
  const LZMA2_DICTIONARY_PROPERTY = Buffer.from([0x18]);
  const ZEROS_BYTES = 100 * MIB;
  const DECLARED_BYTES = 1000;
  const RSS_BUDGET_BYTES = 60 * MIB;

  /** An LZMA2 stream of 100 MB of zeros (about 14 KB), written by the reference 7-Zip and read back out of its archive. */
  function zerosLzma2Stream(): Buffer {
    const dir = path.join(workDir, 'zeros');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'zeros.bin'), Buffer.alloc(ZEROS_BYTES));
    const archivePath = path.join(dir, 'zeros.7z');
    // An uncompressed header and no filter: the pack stream is the bytes right after the 32-byte start header.
    sevenZip(['a', '-t7z', '-y', '-m0=LZMA2', '-mhc=off', '-mf=off', archivePath, 'zeros.bin'], dir);
    const packedSize = Number(/Packed Size = (\d+)/.exec(sevenZip(['l', '-slt', archivePath]))?.[1]);
    expect(packedSize).toBeGreaterThan(0);
    return fs.readFileSync(archivePath).subarray(32, 32 + packedSize);
  }

  oracleTest(
    'an LZMA2 stream of 100 MB under a declared size of 1000 bytes stops at 1000 bytes',
    ['7z'],
    () => {
      const stream = zerosLzma2Stream();
      const archive = craftFolderArchive([
        { name: 'z', coders: [{ id: ID_LZMA2, properties: LZMA2_DICTIONARY_PROPERTY }], bindPairs: [], packStreams: [stream], outSizes: [DECLARED_BYTES] },
      ]);
      const before = process.memoryUsage().rss;
      const failure = failureOf(() => extract7zArchive(archive));
      expect(failure).toBeInstanceOf(CorruptStreamError);
      expect((failure as Error).message).toMatch(/an LZMA2 stream holds more than the 1000 bytes its coder declares/);
      expect(process.memoryUsage().rss - before).toBeLessThan(RSS_BUDGET_BYTES);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'the three LZMA2 inputs of a BCJ2 coder are bounded by their own declared sizes',
    ['7z'],
    () => {
      const stream = zerosLzma2Stream();
      const lzma2 = { id: ID_LZMA2, properties: LZMA2_DICTIONARY_PROPERTY };
      const folder: CraftedFolder = {
        name: 'code.bin',
        coders: [{ id: ID_BCJ2, inStreams: 4, outStreams: 1 }, lzma2, lzma2, lzma2],
        // BCJ2 inputs 0, 1 and 2 (main, call, jump) read the outputs of the three LZMA2 coders; input 3 is the range coder.
        bindPairs: [
          [0, 1],
          [1, 2],
          [2, 3],
        ],
        packedInStreams: [4, 5, 6, 3],
        packStreams: [stream, stream, stream, Buffer.alloc(5)],
        outSizes: [4096, DECLARED_BYTES, DECLARED_BYTES, DECLARED_BYTES],
      };
      const before = process.memoryUsage().rss;
      const failure = failureOf(() => extract7zArchive(craftFolderArchive([folder])));
      expect(failure).toBeInstanceOf(CorruptStreamError);
      expect((failure as Error).message).toMatch(/holds more than the 1000 bytes its coder declares/);
      expect(process.memoryUsage().rss - before).toBeLessThan(RSS_BUDGET_BYTES);
    },
    TEST_TIMEOUT_MS
  );

  it('a coder that declares two output streams is malformed input, not a crash', () => {
    // The first coder has two outputs, so the unbound output (index 2) is not the index of any coder.
    const folder: CraftedFolder = {
      name: 'a',
      coders: [{ id: ID_COPY, inStreams: 2, outStreams: 2 }, { id: ID_COPY }],
      bindPairs: [
        [0, 1],
        [1, 0],
      ],
      packStreams: [Buffer.alloc(8)],
      outSizes: [8, 8, 8],
    };
    const failure = failureOf(() => extract7zArchive(craftFolderArchive([folder])));
    expect(failure).toBeInstanceOf(CorruptStreamError);
    expect((failure as CorruptStreamError).status).toBe(HTTP_BAD_REQUEST);
    expect((failure as Error).message).toMatch(/a coder with 2 output streams/);
  });
});

describe('hostile folders end in a typed error', () => {
  it('more coders than a folder may hold is a corrupt header', async () => {
    const coders = Array.from({ length: 33 }, () => ({ id: ID_COPY }));
    const bindPairs: [number, number][] = Array.from({ length: 32 }, (_, index) => [index, index + 1]);
    const folder: CraftedFolder = { name: 'a', coders, bindPairs, packStreams: [Buffer.alloc(8)], outSizes: Array(33).fill(8) };
    const { largeResult } = await expectNoHangOnInput('33 coders', (input: Buffer) => failureOf(() => extract7zArchive(input)), craftFolderArchive([folder]));
    expect(largeResult).toBeInstanceOf(CorruptStreamError);
    expect((largeResult as CorruptStreamError).status).toBe(HTTP_BAD_REQUEST);
  });

  it('a coder graph with a cycle is a corrupt header', () => {
    // Coders A and B feed each other and C reads the pack stream: the main output comes from C and A and B are never read.
    const folder: CraftedFolder = {
      name: 'a',
      coders: [{ id: ID_COPY }, { id: ID_COPY }, { id: ID_COPY }],
      bindPairs: [
        [0, 1],
        [1, 0],
      ],
      packStreams: [Buffer.alloc(8)],
      outSizes: [8, 8, 8],
    };
    const failure = failureOf(() => extract7zArchive(craftFolderArchive([folder])));
    expect(failure).toBeInstanceOf(CorruptStreamError);
    expect((failure as Error).message).toMatch(/a coder of the folder feeds nothing/);
  });

  it('a bind pair that points past the coders is a corrupt header', () => {
    const folder: CraftedFolder = {
      name: 'a',
      coders: [{ id: ID_COPY }, { id: ID_COPY }],
      bindPairs: [[0, 9]],
      packStreams: [Buffer.alloc(8)],
      outSizes: [8, 8],
    };
    const failure = failureOf(() => extract7zArchive(craftFolderArchive([folder])));
    expect(failure).toBeInstanceOf(CorruptStreamError);
    expect((failure as Error).message).toMatch(/a bind pair names a stream the coders do not have/);
  });

  it('a folder that declares 4 GiB from 10 KiB is refused with 413 before anything is allocated', async () => {
    const stored = crypto.randomBytes(10 * KIB);
    const archive = craftFolderArchive([{ name: 'bomb', coders: [{ id: ID_COPY }], bindPairs: [], packStreams: [stored], outSizes: [4 * GIB] }]);
    const before = process.memoryUsage().rss;
    const { largeResult } = await expectNoHangOnInput('4 GiB declared', (input: Buffer) => failureOf(() => extract7zArchive(input)), archive);
    expect(largeResult).toBeInstanceOf(DecompressionLimitError);
    expect((largeResult as DecompressionLimitError).status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    expect(process.memoryUsage().rss - before).toBeLessThan(50 * MIB);
  });

  it('an inner coder that declares 4 GiB under a small final size is refused too', () => {
    // BCJ over LZMA: the filter's output is small but the LZMA stage claims 4 GiB.
    const folder: CraftedFolder = {
      name: 'inner',
      coders: [{ id: ID_BCJ }, { id: ID_LZMA, properties: Buffer.from([0x5d, 0, 0, 1, 0]) }],
      bindPairs: [[0, 1]],
      packStreams: [crypto.randomBytes(KIB)],
      outSizes: [KIB, 4 * GIB],
    };
    const failure = failureOf(() => extract7zArchive(craftFolderArchive([folder])));
    expect(failure).toBeInstanceOf(DecompressionLimitError);
    expect((failure as DecompressionLimitError).status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    expect((failure as Error).message).toMatch(/Archive bomb detected/);
  });

  it('a stored folder whose pack stream is longer than its declared size is corrupt', () => {
    const data = Buffer.alloc(200, 1);
    const archive = craftFolderArchive([{ name: 'a', coders: [{ id: ID_COPY }], bindPairs: [], packStreams: [data], outSizes: [100], crc: zlib.crc32(data.subarray(0, 100)) }]);
    const failure = failureOf(() => extract7zArchive(archive));
    expect(failure).toBeInstanceOf(CorruptStreamError);
    expect((failure as Error).message).toMatch(/a stored stream holds 200 bytes where the header declares 100/);
  });

  it('a flipped data byte fails the CRC check with a 400 and returns nothing', () => {
    const first = Buffer.from('first member of the archive, stored');
    const second = Buffer.from('second member of the archive, stored');
    const archive = craftSevenZip([
      { name: 'one.txt', data: first },
      { name: 'two.txt', data: second },
    ]);
    const damaged = Buffer.from(archive);
    damaged[32 + first.length + 3] ^= 0x01;
    const failure = failureOf(() => extract7zArchive(damaged));
    expect(failure).toBeInstanceOf(CorruptStreamError);
    expect((failure as CorruptStreamError).status).toBe(HTTP_BAD_REQUEST);
    expect((failure as Error).message).toMatch(/CRC/);
  });

  oracleTest(
    'a flipped byte in a filtered, compressed folder is a typed 400 as well',
    ['7z'],
    () => {
      const made = makeArchive('flip-bcj', x86Code, ['-mf=BCJ', '-m0=Copy', '-ms=on']);
      const damaged = Buffer.from(made.archive);
      damaged[32 + 1000] ^= 0x10;
      const failure = failureOf(() => extract7zArchive(damaged));
      expect(failure).toBeInstanceOf(CorruptStreamError);
      expect((failure as CorruptStreamError).status).toBe(HTTP_BAD_REQUEST);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'truncation at 25, 50 and 75 percent of a filtered archive never returns a file list',
    ['7z'],
    () => {
      const made = makeArchive('truncate-bcj', x86Code, ['-mf=BCJ', '-ms=on']);
      for (const fraction of [0.25, 0.5, 0.75]) {
        const failure = failureOf(() => extract7zArchive(made.archive.subarray(0, Math.floor(made.archive.length * fraction))));
        expect(failure, `cut at ${fraction * 100}%`).toBeInstanceOf(CorruptStreamError);
        expect((failure as Error).message, `cut at ${fraction * 100}%`).toMatch(/^(Corrupted|Invalid) 7z archive/);
      }
    },
    TEST_TIMEOUT_MS
  );

  describe('BCJ2 streams', () => {
    function bcj2Folder(streams: { main: Buffer; call: Buffer; jump: Buffer; rc: Buffer }, outSize: number): CraftedFolder {
      return {
        name: 'code.bin',
        coders: [{ id: ID_BCJ2, inStreams: 4, outStreams: 1 }],
        bindPairs: [],
        packedInStreams: [0, 1, 2, 3],
        packStreams: [streams.main, streams.call, streams.jump, streams.rc],
        outSizes: [outSize],
      };
    }

    it('a branch that needs a call address the call stream does not hold is corrupt', async () => {
      // A range coder whose first answer is "converted" over a main stream of calls, with a call stream of two addresses.
      const main = Buffer.alloc(4096, 0xe8);
      const rc = Buffer.concat([Buffer.from([0x00, 0x80, 0x00, 0x00, 0x00]), Buffer.alloc(64)]);
      const archive = craftFolderArchive([bcj2Folder({ main, call: Buffer.alloc(8), jump: Buffer.alloc(0), rc }, 8192)]);
      const { largeResult } = await expectNoHangOnInput('BCJ2 starved call stream', (input: Buffer) => failureOf(() => extract7zArchive(input)), archive);
      expect(largeResult).toBeInstanceOf(CorruptStreamError);
      expect((largeResult as Error).message).toMatch(/BCJ2 (call|jump) stream ends early|BCJ2 main stream ends before/);
    });

    it('a range coder that does not start with a zero byte is corrupt', () => {
      const archive = craftFolderArchive([bcj2Folder({ main: Buffer.alloc(16, 0x90), call: Buffer.alloc(0), jump: Buffer.alloc(0), rc: Buffer.from([1, 0, 0, 0, 0]) }, 16)]);
      const failure = failureOf(() => extract7zArchive(archive));
      expect(failure).toBeInstanceOf(CorruptStreamError);
      expect((failure as Error).message).toMatch(/range coder stream does not start with a zero byte/);
    });

    it('a main stream shorter than the declared size is corrupt', () => {
      const archive = craftFolderArchive([bcj2Folder({ main: Buffer.alloc(10, 0x90), call: Buffer.alloc(0), jump: Buffer.alloc(0), rc: Buffer.alloc(5) }, 4096)]);
      const failure = failureOf(() => extract7zArchive(archive));
      expect(failure).toBeInstanceOf(CorruptStreamError);
      expect((failure as Error).message).toMatch(/main stream ends before the declared size/);
    });
  });
});

describe('members that are not regular files', () => {
  oracleTest(
    'a symlink is not followed or extracted: refused by default, left out and reported with skipLinks',
    ['7z'],
    async () => {
      const dir = path.join(workDir, 'symlink');
      const source = path.join(dir, 'source');
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, 'real.txt'), 'the real file');
      fs.symlinkSync('/etc/passwd', path.join(source, 'link.txt'));
      const archivePath = path.join(dir, 'links.7z');
      sevenZip(['a', '-t7z', '-y', '-snl', archivePath, '.'], source);
      const archive = fs.readFileSync(archivePath);

      const refused = failureOf(() => extract7zArchive(archive));
      expect(refused).toBeInstanceOf(UnsafeArchiveError);
      expect((refused as UnsafeArchiveError).reason).toBe('link-entry');

      const skipped: string[][] = [];
      const kept = extract7zArchive(archive, { skipLinks: true, onSkippedLinks: (names) => skipped.push(names) });
      expect(kept.map((file) => file.filename)).toEqual(['real.txt']);
      expect(skipped).toEqual([['link.txt']]);

      await expect(convertArchive(archive, '7z', 'zip', {}, 'links.7z')).rejects.toBeInstanceOf(UnsafeArchiveError);
      const converted = await convertArchive(archive, '7z', 'zip', { skipLinks: true }, 'links.7z');
      expect(converted.skippedLinks).toEqual(['link.txt']);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'empty files and directories appear with the names and sizes 7z l -slt reports',
    ['7z'],
    () => {
      const made = makeArchive('empties', x86Code, ['-mf=BCJ', '-ms=on']);
      const names = made.listing
        .split(/\r?\n/)
        .filter((line) => line.startsWith('Path = '))
        .map((line) => line.slice('Path = '.length))
        .filter((name) => name !== made.archivePath);
      const extracted = extract7zArchive(made.archive);
      // Directories are not files: every listed name that is not a directory comes back, in the listing's order.
      const directories = new Set(['sub', 'sub/deep', 'emptydir']);
      expect(extracted.map((file) => file.filename).sort()).toEqual(names.filter((name) => !directories.has(name)).sort());
      expect(extracted.find((file) => file.filename === 'empty.dat')?.buffer.length).toBe(0);
    },
    TEST_TIMEOUT_MS
  );
});
