import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { convertFont, decodeSfnt, decodeWoff2, decodeWoff2Async, encodeSfnt, encodeWoff2Async } from '../src/lib/conversions/font';
import { compressWithNativeWoff2, decompressWithNativeWoff2, woff2CompressProgram, woff2DecompressProgram } from '../src/lib/conversions/font-woff2-native';
import { Woff2FormatError, Woff2LimitError } from '../src/lib/conversions/font-woff2-primitives';
import { WOFF2_BROTLI_LARGE_FONT_QUALITY, WOFF2_BROTLI_MAX_QUALITY, WOFF2_BROTLI_MAX_QUALITY_BYTES } from '../src/lib/conversions/font-woff2';

const WOFF2_BROTLI_QUALITY_UP_TO_LIMIT = WOFF2_BROTLI_MAX_QUALITY;
import { captureError } from './helpers/capture-error';
import { readSfntTables } from './helpers/font-oracles';
import { skipUnless } from './helpers/strict-skip';
import { COLLECTION_FLAVOR, brotliFont, buildWoff2, collectionHeader, collectionTables, minimalTransformedFont } from './helpers/woff2-builder';

/**
 * The WOFF2 programs of google/woff2 write and read the file when the worker has them (font-woff2-native.ts). The wrapper is judged
 * with stand-in programs that record what they were given; the real programs, when installed, are judged against the in-process
 * codec (tables that must agree) and with hostile files.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'woff2');
const fixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURES, name));
const HEAD_ADJUSTMENT_AT = 8;
/** A run past this is a hang, not a slow program: the files below take milliseconds. */
const RUN_HANG_GUARD_MS = 20_000;

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

async function withPrograms<T>(programs: { compress?: string; decompress?: string }, body: () => Promise<T>): Promise<T> {
  const before = { compress: process.env.WOFF2_COMPRESS_PATH, decompress: process.env.WOFF2_DECOMPRESS_PATH };
  const set = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  // An empty value names no file: the program counts as not installed.
  set('WOFF2_COMPRESS_PATH', programs.compress ?? '');
  set('WOFF2_DECOMPRESS_PATH', programs.decompress ?? '');
  try {
    return await body();
  } finally {
    set('WOFF2_COMPRESS_PATH', before.compress);
    set('WOFF2_DECOMPRESS_PATH', before.decompress);
  }
}

/** A shell program: it copies the file it is given to `<name>.given`, runs `script` with $in and $out set (out: input.woff2 -> .ttf and back). */
function standIn(name: string, outExtension: string, script: string): { program: string; given: string } {
  const dir = tmpDir('woff2-standin-');
  const given = path.join(dir, `${name}.given`);
  const program = path.join(dir, name);
  fs.writeFileSync(program, `#!/bin/sh\nin="$1"\nout="\${in%.*}.${outExtension}"\ncp "$in" '${given}'\n${script}\n`, { mode: 0o755 });
  return { program, given };
}

const dejavu = () => fixture('dejavu-sans-latin.ttf');
const FAKE_WOFF2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(40, 7)]);

describe('the WOFF2 wrapper with stand-in programs', () => {
  it('writes the file the program writes, and hands the program the sfnt of the font', async () => {
    const compressor = standIn('woff2_compress', 'woff2', `printf '%s' '${FAKE_WOFF2.toString('latin1')}' > "$out"`);
    await withPrograms({ compress: compressor.program }, async () => {
      const result = await convertFont(dejavu(), 'ttf', 'woff2', {}, 'dejavu.ttf');
      expect(result.buffer.equals(FAKE_WOFF2)).toBe(true);
      expect(result.mimeType).toBe('font/woff2');
      const given = fs.readFileSync(compressor.given);
      expect(given.readUInt32BE(0)).toBe(0x00010000);
      const tables = readSfntTables(given);
      expect(tables.get('glyf')!.length).toBeGreaterThan(0);
    });
  });

  it('falls back to the in-process encoder when the program declines the font', async () => {
    const compressor = standIn('woff2_compress', 'woff2', 'exit 1');
    await withPrograms({ compress: compressor.program }, async () => {
      const result = await convertFont(dejavu(), 'ttf', 'woff2', {}, 'dejavu.ttf');
      expect(result.buffer.toString('latin1', 0, 4)).toBe('wOF2');
      expect(decodeWoff2(result.buffer, 'x').tables['glyf'].data.length).toBeGreaterThan(0);
    });
  });

  it('falls back to the in-process encoder when no program is installed or one writes nothing', async () => {
    const silent = standIn('woff2_compress', 'woff2', 'exit 0');
    await withPrograms({}, async () => {
      expect((await convertFont(dejavu(), 'ttf', 'woff2', {}, 'dejavu.ttf')).buffer.toString('latin1', 0, 4)).toBe('wOF2');
      expect(await compressWithNativeWoff2(dejavu(), 11)).toBeNull();
    });
    await withPrograms({ compress: silent.program }, async () => {
      expect((await convertFont(dejavu(), 'ttf', 'woff2', {}, 'dejavu.ttf')).buffer.toString('latin1', 0, 4)).toBe('wOF2');
    });
  });

  it('refuses the font with a typed error when the program is stopped by a signal', async () => {
    const aborting = standIn('woff2_compress', 'woff2', 'kill -ABRT $$');
    await withPrograms({ compress: aborting.program }, async () => {
      const error = await captureError(() => convertFont(dejavu(), 'ttf', 'woff2', {}, 'dejavu.ttf'));
      expect(error).toBeInstanceOf(Woff2FormatError);
      expect(error.message).toMatch(/stopped by SIGABRT/);
    });
  });

  it('reports a crash by SIGSEGV as the limit refusal the sandbox makes of it, since a C++ program faults on an allocation it could not make', async () => {
    const crashing = standIn('woff2_compress', 'woff2', 'kill -SEGV $$');
    await withPrograms({ compress: crashing.program }, async () => {
      const error = await captureError(() => convertFont(dejavu(), 'ttf', 'woff2', {}, 'dejavu.ttf'));
      expect(error).toBeInstanceOf(Woff2LimitError);
      expect(error.message).toMatch(/run out of memory .* or crash/);
    });
  });

  it('asks the program for the Brotli quality of entry 24: 11 up to 8 MiB of table data and 9 above', async () => {
    const font = decodeSfnt(dejavu(), 'big');
    const compressor = standIn('woff2_compress', 'woff2', `printf '%s' "$2" > '${path.join(tmpDir('woff2-quality-'), 'quality')}'; printf '%s' '${FAKE_WOFF2.toString('latin1')}' > "$out"`);
    const qualityFile = /> '([^']+)'/.exec(fs.readFileSync(compressor.program, 'utf8'))![1];
    await withPrograms({ compress: compressor.program }, async () => {
      await encodeWoff2Async(font);
      expect(fs.readFileSync(qualityFile, 'utf8')).toBe(String(WOFF2_BROTLI_QUALITY_UP_TO_LIMIT));
      font.tables['ZZZZ'] = { tag: 'ZZZZ', checkSum: 0, offset: 0, length: WOFF2_BROTLI_MAX_QUALITY_BYTES, data: Buffer.alloc(WOFF2_BROTLI_MAX_QUALITY_BYTES) };
      const encoded = await encodeWoff2Async(font);
      expect(encoded.equals(FAKE_WOFF2)).toBe(true);
      expect(fs.readFileSync(qualityFile, 'utf8')).toBe(String(WOFF2_BROTLI_LARGE_FONT_QUALITY));
    });
  });

  it('reads the font the decoder program writes, and reads a collection in process', async () => {
    const decoder = standIn('woff2_decompress', 'ttf', `cp '${path.join(FIXTURES, 'dejavu-sans-latin.ttf')}' "$out"`);
    await withPrograms({ decompress: decoder.program }, async () => {
      const font = await decodeWoff2Async(fixture('synthetic-triplets.reference.woff2'), 'x');
      // the stand-in returned the DejaVu font: it is what the wrapper read
      expect(font.tables['glyf'].data.equals(decodeSfnt(dejavu(), 'x').tables['glyf'].data)).toBe(true);
      expect(fs.readFileSync(decoder.given).equals(fixture('synthetic-triplets.reference.woff2'))).toBe(true);
      fs.rmSync(decoder.given);
      const first = await decodeWoff2Async(fixture('pair.reference.woff2'), 'x');
      expect(first.tables['glyf'].data.equals(decodeWoff2(fixture('pair.reference.woff2'), 'x').tables['glyf'].data)).toBe(true);
      expect(fs.existsSync(decoder.given)).toBe(false);
    });
  });

  it('decodes in process what the decoder program declines', async () => {
    const decoder = standIn('woff2_decompress', 'ttf', 'exit 1');
    await withPrograms({ decompress: decoder.program }, async () => {
      const woff2 = fixture('dejavu-sans-latin.reference.woff2');
      const font = await decodeWoff2Async(woff2, 'x');
      expect(font.tables['glyf'].data.equals(decodeWoff2(woff2, 'x').tables['glyf'].data)).toBe(true);
      expect(await decompressWithNativeWoff2(woff2)).toBeNull();
    });
  });

  it('answers a memory-limited run with a typed limit error', async () => {
    const decoder = standIn('woff2_decompress', 'ttf', 'kill -KILL $$');
    await withPrograms({ decompress: decoder.program }, async () => {
      const error = await captureError(() => decompressWithNativeWoff2(fixture('dejavu-sans-latin.reference.woff2')));
      expect(error).toBeInstanceOf(Woff2LimitError);
      expect(error.message).toMatch(/WOFF2 decoder run out of memory/);
    });
  });
});

const compressor = woff2CompressProgram();
const decompressor = woff2DecompressProgram();
const haveBoth = !skipUnless('woff2_compress and woff2_decompress', compressor !== null && decompressor !== null);

function withoutAdjustment(tables: Map<string, Buffer>): Map<string, Buffer> {
  const head = Buffer.from(tables.get('head')!);
  head.writeUInt32BE(0, HEAD_ADJUSTMENT_AT);
  return new Map(tables).set('head', head);
}

const SOURCES = ['dejavu-sans-latin.ttf', 'dejavu-serif-hinted-ascii.ttf', 'synthetic-triplets.ttf', 'synthetic-cff.otf'];
const WOFF2_FILES = [
  'dejavu-sans-latin.reference.woff2',
  'dejavu-serif-hinted-ascii.reference.woff2',
  'synthetic-triplets.reference.woff2',
  'synthetic-cff.reference.woff2',
  'dejavu-sans-latin.fonttools-hmtx.woff2',
  'synthetic-triplets.fonttools-hmtx.woff2',
];

describe.skipIf(!haveBoth)('the WOFF2 programs of google/woff2', () => {
  it.each(SOURCES)('write for %s the file woff2_compress writes for its sfnt, which the in-process reader decodes to the same tables', async (source) => {
    const font = decodeSfnt(fixture(source), source);
    const written = await encodeWoff2Async(font);
    const dir = tmpDir('woff2-real-');
    fs.writeFileSync(path.join(dir, 'font.ttf'), encodeSfnt(font));
    const run = spawnSync(compressor!, [path.join(dir, 'font.ttf')], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(written.equals(fs.readFileSync(path.join(dir, 'font.woff2')))).toBe(true);
    const decoded = decodeWoff2(written, source);
    for (const [tag, table] of Object.entries(font.tables)) {
      if (tag === 'DSIG' || tag === 'head' || tag === 'glyf' || tag === 'loca') continue;
      expect(decoded.tables[tag]?.data.equals(table.data), `${source} ${tag}`).toBe(true);
    }
    expect(decoded.tables['glyf'] === undefined).toBe(font.tables['glyf'] === undefined);
  });

  it.each(WOFF2_FILES)('decode %s to the tables the in-process reader reads, up to the checksum adjustment of the head table', async (name) => {
    const woff2 = fixture(name);
    const native = await decompressWithNativeWoff2(woff2);
    expect(native).not.toBeNull();
    const fromProgram = withoutAdjustment(readSfntTables(native!));
    const inProcess = decodeWoff2(woff2, name);
    expect([...fromProgram.keys()].sort()).toEqual(Object.keys(inProcess.tables).sort());
    for (const [tag, table] of Object.entries(inProcess.tables)) {
      const expected = tag === 'head' ? Buffer.from(table.data).fill(0, HEAD_ADJUSTMENT_AT, HEAD_ADJUSTMENT_AT + 4) : table.data;
      expect(fromProgram.get(tag)!.equals(expected), `${name} ${tag}`).toBe(true);
    }
    const parsed = await decodeWoff2Async(woff2, name);
    expect(Object.keys(parsed.tables).sort()).toEqual(Object.keys(inProcess.tables).sort());
  });

  it('declines a last block that is not padded to four bytes, which the Recommendation allows and the in-process reader accepts', async () => {
    const woff2 = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.woff2'));
    expect(woff2.length % 4).not.toBe(0);
    expect(await decompressWithNativeWoff2(woff2)).toBeNull();
    const parsed = await decodeWoff2Async(woff2, 'sample');
    expect(Object.keys(parsed.tables).sort()).toEqual(Object.keys(decodeWoff2(woff2, 'sample').tables).sort());
  });

  it('converts a font from WOFF2 to TrueType and back through the programs', async () => {
    const ttf = await convertFont(fixture('dejavu-serif-hinted-ascii.reference.woff2'), 'woff2', 'ttf', {}, 'serif.woff2');
    const again = await convertFont(ttf.buffer, 'ttf', 'woff2', {}, 'serif.ttf');
    const original = readSfntTables(fixture('dejavu-serif-hinted-ascii.ttf'));
    const decoded = decodeWoff2(again.buffer, 'serif');
    for (const tag of ['cmap', 'hmtx', 'fpgm', 'prep', 'cvt ', 'name']) {
      if (original.has(tag)) expect(decoded.tables[tag].data.equals(original.get(tag)!), tag).toBe(true);
    }
  });
});

/** A glyf transform header that claims `numGlyphs` glyphs and carries streams of the given sizes. */
function glyfClaim(numGlyphs: number): Buffer {
  const header = Buffer.alloc(36);
  header.writeUInt16BE(numGlyphs, 4);
  return header;
}

describe.skipIf(!haveBoth)('hostile files given to the programs', () => {
  const real = fixture('dejavu-sans-latin.reference.woff2');
  const expectOutcome = async (name: string, file: Buffer) => {
    const started = Date.now();
    const answer = await decompressWithNativeWoff2(file).then(
      (written) => ({ written }),
      (error: unknown) => ({ error })
    );
    expect(Date.now() - started, `${name} took too long`).toBeLessThan(RUN_HANG_GUARD_MS);
    // Declined (null), or a typed refusal: never a crash that the sandbox reports as a signal of the program.
    if ('error' in answer) expect(answer.error, name).toBeInstanceOf(Woff2LimitError);
    else if (answer.written !== null && answer.written.toString('latin1', 0, 4) !== 'ttcf') expect(decodeSfnt(answer.written, name).numTables).toBeGreaterThan(0);
    return answer;
  };

  const header = (patch: (view: Buffer) => void): Buffer => {
    const copy = Buffer.from(real);
    patch(copy);
    return copy;
  };

  const files: Array<[string, Buffer]> = [
    ['an empty file', Buffer.alloc(0)],
    ['the signature alone', Buffer.from('wOF2')],
    ['a header cut at 40 bytes', real.subarray(0, 40)],
    ['a file cut inside the table directory', real.subarray(0, 60)],
    ['a file cut inside the compressed data', real.subarray(0, real.length - 40)],
    ['a length field that is not the file length', header((b) => b.writeUInt32BE(real.length + 4, 8))],
    ['zero tables', header((b) => b.writeUInt16BE(0, 12))],
    ['65535 tables', header((b) => b.writeUInt16BE(0xffff, 12))],
    ['a total size of 4 GiB', header((b) => b.writeUInt32BE(0xffffffff, 16))],
    ['a compressed size past the file', header((b) => b.writeUInt32BE(0x7fffffff, 20))],
    ['a metadata block past the file', header((b) => { b.writeUInt32BE(real.length - 8, 28); b.writeUInt32BE(0xffffff, 32); })],
    ['a private block past the file', header((b) => { b.writeUInt32BE(real.length - 8, 40); b.writeUInt32BE(0xffffff, 44); })],
    ['a signature that is not WOFF2', header((b) => b.write('wOFF', 0, 'latin1'))],
    [
      'a table of 4 GiB announced by a file of a few hundred bytes',
      buildWoff2({ tables: [{ tag: 'name', data: Buffer.alloc(8), origLength: 0xfffffff0 }], totalSfntSize: 0xffffffff }),
    ],
    [
      'a Brotli stream of 64 MiB of zeros behind a directory of a few bytes',
      buildWoff2({ tables: minimalTransformedFont(), compressed: brotliFont(Buffer.alloc(64 * 1024 * 1024)) }),
    ],
    [
      'a glyf transform of 65535 glyphs with empty streams',
      buildWoff2({ tables: [{ tag: 'glyf', data: glyfClaim(0xffff), version: 0, origLength: 1 << 20, transformLength: 36 }, { tag: 'loca', data: Buffer.alloc(0), version: 0, origLength: 4, transformLength: 0 }] }),
    ],
    [
      'an end-of-stream base-128 number that never ends',
      buildWoff2({ tables: [{ tag: 'name', data: Buffer.alloc(4), rawEntry: [5, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01] }] }),
    ],
    [
      'a collection that lists a table that does not exist',
      buildWoff2({ flavor: COLLECTION_FLAVOR, tables: collectionTables(), afterDirectory: collectionHeader([{ indices: [0, 1, 2, 3, 4, 99] }]) }),
    ],
    [
      'a collection of 255 fonts that share one set of tables',
      buildWoff2({ flavor: COLLECTION_FLAVOR, tables: collectionTables(), afterDirectory: collectionHeader(Array.from({ length: 255 }, () => ({ indices: [0, 1, 2, 3, 4, 5] }))) }),
    ],
  ];

  it.each(files)('stay inside the limits for %s', async (name, file) => {
    await expectOutcome(name, file);
  });

  it('refuse the same files through the conversion, with the typed error of the in-process reader or a font', async () => {
    for (const [name, file] of files) {
      const outcome = await convertFont(file, 'woff2', 'ttf', {}, 'hostile.woff2').then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      );
      if ('error' in outcome) expect(outcome.error, name).toBeInstanceOf(Error);
      else expect(outcome.result.buffer.readUInt32BE(0), name).toBe(0x00010000);
    }
  }, 120_000);

  it('survive 150 files with a damaged byte, each of which the sandbox runs to its end', async () => {
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 150; i++) {
      const copy = Buffer.from(real);
      const at = next() % copy.length;
      copy[at] = next() & 0xff;
      await expectOutcome(`byte ${at} of the DejaVu file`, copy);
    }
  }, 180_000);

  it('refuse a font with a damaged sfnt the program cannot encode, by declining it', async () => {
    const damaged = Buffer.from(encodeSfnt(decodeSfnt(dejavu(), 'x')));
    damaged.writeUInt16BE(0x7fff, 4);
    expect(await compressWithNativeWoff2(damaged, 11)).toBeNull();
  });
});

/** The decoder program under a 96 MiB address space: a buffer sized from the header alone cannot be allocated. */
// skip-ok: prlimit is part of util-linux (Linux only); the sandbox of the worker needs the same program
const prlimit = spawnSync('prlimit', ['--version']).status === 0;
describe.skipIf(!haveBoth || !prlimit)('the decoder program checks the header before it allocates', () => {
  const real = fixture('dejavu-sans-latin.reference.woff2');
  const AS_BYTES = 96 * 1024 * 1024;
  function run(file: Buffer): { status: number | null; stderr: string; ttf: Buffer | null } {
    const dir = tmpDir('woff2-header-');
    const input = path.join(dir, 'input.woff2');
    fs.writeFileSync(input, file);
    const result = spawnSync('prlimit', [`--as=${AS_BYTES}`, '--', decompressor!, input], { encoding: 'utf8' });
    const output = path.join(dir, 'input.ttf');
    return { status: result.status, stderr: result.stderr, ttf: fs.existsSync(output) ? fs.readFileSync(output) : null };
  }
  const withHeader = (patch: (copy: Buffer) => void): Buffer => {
    const copy = Buffer.from(real);
    patch(copy);
    return copy;
  };

  it('declines a header that announces more than the decoder may write, without a 128 MiB buffer', () => {
    const answer = run(withHeader((b) => b.writeUInt32BE(0xffffffff, 16)));
    expect(answer.status).toBe(1);
    expect(answer.stderr).toMatch(/not that of a font this decoder reads/);
  });

  it('declines more tables than the in-process reader allows', () => {
    const answer = run(withHeader((b) => b.writeUInt16BE(4097, 12)));
    expect(answer.status).toBe(1);
    expect(answer.stderr).toMatch(/not that of a font this decoder reads/);
  });

  it('declines a length field that is not the size of the file', () => {
    const answer = run(withHeader((b) => b.writeUInt32BE(real.length + 1, 8)));
    expect(answer.status).toBe(1);
    expect(answer.stderr).toMatch(/not that of a font this decoder reads/);
  });

  it('does not size the buffer from a total size that the file cannot back, and reads the font', () => {
    // 112 MiB announced by a file of 20 KiB: the decoder does not believe the field, and neither does the buffer.
    const answer = run(withHeader((b) => b.writeUInt32BE(112 * 1024 * 1024, 16)));
    expect(answer.status).toBe(0);
    expect(answer.ttf?.equals(run(real).ttf ?? Buffer.alloc(0))).toBe(true);
  });
});

/** Bytes that compress to about a fifth, so that the table passes the expansion limit of the in-process reader: 8 noise bytes in each 64. */
function sparseNoise(length: number): Buffer {
  const data = Buffer.alloc(length);
  let state = 2463534242;
  for (let at = 0; at < length; at += 64) {
    for (let i = 0; i < 8 && at + i < length; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      data[at + i] = state & 0xff;
    }
  }
  return data;
}

describe.skipIf(!haveBoth)('the encoder program takes the Brotli quality and checks the font before it allocates', () => {
  const sfnt = (name: string) => fixture(name);
  function compress(file: Buffer, args: string[] = []): { status: number | null; stderr: string; woff2: Buffer | null } {
    const dir = tmpDir('woff2-compress-');
    const input = path.join(dir, 'input.ttf');
    fs.writeFileSync(input, file);
    const result = spawnSync(compressor!, [input, ...args], { encoding: 'utf8' });
    const output = path.join(dir, 'input.woff2');
    return { status: result.status, stderr: result.stderr, woff2: fs.existsSync(output) ? fs.readFileSync(output) : null };
  }

  it('writes a larger file at a lower quality and the same file at quality 11 as without the argument', () => {
    const font = sfnt('dejavu-sans-latin.ttf');
    const best = compress(font);
    const same = compress(font, ['11']);
    const fast = compress(font, ['0']);
    expect(best.status).toBe(0);
    expect(same.woff2?.equals(best.woff2 ?? Buffer.alloc(0))).toBe(true);
    expect(fast.status).toBe(0);
    expect(fast.woff2!.length).toBeGreaterThan(best.woff2!.length);
  });

  it.each(['12', '-1', 'x', '9x', ''])('declines the quality %j', (quality) => {
    const answer = compress(sfnt('dejavu-sans-latin.ttf'), [quality]);
    expect(answer.status).toBe(1);
    expect(answer.stderr).toMatch(/quality must be a number from 0 to 11/);
    expect(answer.woff2).toBeNull();
  });

  it('declines a font of more than 4096 tables and a file that is not a font, before it allocates the output', () => {
    const tooMany = Buffer.from(sfnt('dejavu-sans-latin.ttf'));
    tooMany.writeUInt16BE(4097, 4);
    const many = compress(tooMany);
    expect(many.status).toBe(1);
    expect(many.stderr).toMatch(/not a font this encoder reads/);
    const short = compress(Buffer.from('OTTO'));
    expect(short.status).toBe(1);
    expect(short.stderr).toMatch(/not a font this encoder reads/);
  });

  it('writes for a font of more than 8 MiB of table data the file the program writes at quality 9', async () => {
    const font = decodeSfnt(dejavu(), 'big');
    font.tables['ZZZZ'] = { tag: 'ZZZZ', checkSum: 0, offset: 0, length: WOFF2_BROTLI_MAX_QUALITY_BYTES, data: sparseNoise(WOFF2_BROTLI_MAX_QUALITY_BYTES) };
    const written = await encodeWoff2Async(font);
    const reference = compress(encodeSfnt(font), [String(WOFF2_BROTLI_LARGE_FONT_QUALITY)]);
    expect(reference.status).toBe(0);
    expect(written.equals(reference.woff2 ?? Buffer.alloc(0))).toBe(true);
    expect(decodeWoff2(written, 'big').tables['ZZZZ'].data.length).toBe(WOFF2_BROTLI_MAX_QUALITY_BYTES);
  }, 60_000);
});
