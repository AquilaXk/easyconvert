import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { convertFont, decodeSfnt, decodeWoff2, encodeSfnt, encodeWoff2Async } from '../src/lib/conversions/font';
import { compressWithNativeWoff2, woff2CompressProgram } from '../src/lib/conversions/font-woff2-native';
import { WOFF2_BROTLI_LARGE_FONT_QUALITY, WOFF2_BROTLI_MAX_QUALITY, WOFF2_BROTLI_MAX_QUALITY_BYTES } from '../src/lib/conversions/font-woff2';
import { Woff2FormatError, Woff2LimitError } from '../src/lib/conversions/font-woff2-primitives';
import { captureError } from './helpers/capture-error';
import { readSfntTables } from './helpers/font-oracles';
import { skipUnless } from './helpers/strict-skip';
import { pinnedWoff2Program } from './helpers/woff2-programs';
import { readWoff2Reference } from './helpers/woff2-reference';

/**
 * `woff2_compress` of google/woff2 writes the WOFF2 file when the worker has it (font-woff2-native.ts). The wrapper is judged with
 * stand-in programs that record what they were given; the real program, when installed, is judged against the in-process codec (tables
 * that must agree), on the Brotli quality, the transforms and the bounds of its input, and with damaged fonts. The reading of a WOFF2
 * file stays in process: tests/font-woff2-decoder-program.test.ts judges the pinned decoder program as the second reader.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'woff2');
const fixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURES, name));
const WOFF2_BROTLI_QUALITY_UP_TO_LIMIT = WOFF2_BROTLI_MAX_QUALITY;
/** A run past this is a hang, not a slow program: the fonts below take milliseconds. */
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

async function withProgram<T>(compress: string | undefined, body: () => Promise<T>): Promise<T> {
  const before = process.env.WOFF2_COMPRESS_PATH;
  // An empty value names no file: the program counts as not installed.
  process.env.WOFF2_COMPRESS_PATH = compress ?? '';
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env.WOFF2_COMPRESS_PATH;
    else process.env.WOFF2_COMPRESS_PATH = before;
  }
}

/** A shell program: it copies the file it is given to `<name>.given` and runs `script` with $in and $out set (out: input.ttf -> input.woff2). */
function standIn(name: string, script: string): { program: string; given: string } {
  const dir = tmpDir('woff2-standin-');
  const given = path.join(dir, `${name}.given`);
  const program = path.join(dir, name);
  fs.writeFileSync(program, `#!/bin/sh\nin="$1"\nout="\${in%.*}.woff2"\ncp "$in" '${given}'\n${script}\n`, { mode: 0o755 });
  return { program, given };
}

const dejavu = () => fixture('dejavu-sans-latin.ttf');
const FAKE_WOFF2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(40, 7)]);

describe('the WOFF2 encoder wrapper with stand-in programs', () => {
  it('writes the file the program writes, and hands the program the sfnt of the font', async () => {
    const compressor = standIn('woff2_compress', `printf '%s' '${FAKE_WOFF2.toString('latin1')}' > "$out"`);
    await withProgram(compressor.program, async () => {
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
    const compressor = standIn('woff2_compress', 'exit 1');
    await withProgram(compressor.program, async () => {
      const result = await convertFont(dejavu(), 'ttf', 'woff2', {}, 'dejavu.ttf');
      expect(result.buffer.toString('latin1', 0, 4)).toBe('wOF2');
      expect(decodeWoff2(result.buffer, 'x').tables['glyf'].data.length).toBeGreaterThan(0);
    });
  });

  it('falls back to the in-process encoder when no program is installed or one writes nothing', async () => {
    const silent = standIn('woff2_compress', 'exit 0');
    await withProgram(undefined, async () => {
      expect((await convertFont(dejavu(), 'ttf', 'woff2', {}, 'dejavu.ttf')).buffer.toString('latin1', 0, 4)).toBe('wOF2');
      expect(await compressWithNativeWoff2(dejavu(), 11)).toBeNull();
    });
    await withProgram(silent.program, async () => {
      expect((await convertFont(dejavu(), 'ttf', 'woff2', {}, 'dejavu.ttf')).buffer.toString('latin1', 0, 4)).toBe('wOF2');
    });
  });

  it('refuses the font with a typed error when the program is stopped by a signal', async () => {
    const aborting = standIn('woff2_compress', 'kill -ABRT $$');
    await withProgram(aborting.program, async () => {
      const error = await captureError(() => convertFont(dejavu(), 'ttf', 'woff2', {}, 'dejavu.ttf'));
      expect(error).toBeInstanceOf(Woff2FormatError);
      expect(error.message).toMatch(/stopped by SIGABRT/);
    });
  });

  it('reports a crash by SIGSEGV as the limit refusal the sandbox makes of it, since a C++ program faults on an allocation it could not make', async () => {
    const crashing = standIn('woff2_compress', 'kill -SEGV $$');
    await withProgram(crashing.program, async () => {
      const error = await captureError(() => convertFont(dejavu(), 'ttf', 'woff2', {}, 'dejavu.ttf'));
      expect(error).toBeInstanceOf(Woff2LimitError);
      expect(error.message).toMatch(/run out of memory .* or crash/);
    });
  });

  it('asks the program for the Brotli quality of entry 24: 11 up to 8 MiB of table data and 9 above', async () => {
    const font = decodeSfnt(dejavu(), 'big');
    const compressor = standIn('woff2_compress', `printf '%s' "$2" > '${path.join(tmpDir('woff2-quality-'), 'quality')}'; printf '%s' '${FAKE_WOFF2.toString('latin1')}' > "$out"`);
    const qualityFile = /> '([^']+)'/.exec(fs.readFileSync(compressor.program, 'utf8'))![1];
    await withProgram(compressor.program, async () => {
      await encodeWoff2Async(font);
      expect(fs.readFileSync(qualityFile, 'utf8')).toBe(String(WOFF2_BROTLI_QUALITY_UP_TO_LIMIT));
      font.tables['ZZZZ'] = { tag: 'ZZZZ', checkSum: 0, offset: 0, length: WOFF2_BROTLI_MAX_QUALITY_BYTES, data: Buffer.alloc(WOFF2_BROTLI_MAX_QUALITY_BYTES) };
      const encoded = await encodeWoff2Async(font);
      expect(encoded.equals(FAKE_WOFF2)).toBe(true);
      expect(fs.readFileSync(qualityFile, 'utf8')).toBe(String(WOFF2_BROTLI_LARGE_FONT_QUALITY));
    });
  });
});

const compressor = woff2CompressProgram();
const installed = pinnedWoff2Program('woff2_compress') !== null && compressor !== null;
const haveProgram = !skipUnless('the pinned woff2_compress', installed);

const SOURCES = ['dejavu-sans-latin.ttf', 'dejavu-serif-hinted-ascii.ttf', 'synthetic-triplets.ttf', 'synthetic-cff.otf'];

describe.skipIf(!haveProgram)('the encoder program of google/woff2', () => {
  it.each(SOURCES)('writes for %s the file woff2_compress writes for its sfnt, which the in-process reader decodes to the same tables', async (source) => {
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

  it('converts a font from TrueType to WOFF2 and from WOFF2 back to TrueType', async () => {
    const woff2 = await convertFont(fixture('dejavu-serif-hinted-ascii.ttf'), 'ttf', 'woff2', {}, 'serif.ttf');
    expect(woff2.mimeType).toBe('font/woff2');
    const ttf = await convertFont(woff2.buffer, 'woff2', 'ttf', {}, 'serif.woff2');
    const original = readSfntTables(fixture('dejavu-serif-hinted-ascii.ttf'));
    const back = readSfntTables(ttf.buffer);
    for (const tag of ['cmap', 'hmtx', 'fpgm', 'prep', 'cvt ', 'name']) {
      if (original.has(tag)) expect(back.get(tag)!.equals(original.get(tag)!), tag).toBe(true);
    }
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

describe.skipIf(!haveProgram)('the encoder program takes the Brotli quality and checks the font before it allocates', () => {
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

describe.skipIf(!haveProgram)('the encoder program stores the hmtx table in its transformed form (section 5.4 of the Recommendation)', () => {
  function compressFile(name: string): Buffer {
    const dir = tmpDir('woff2-hmtx-');
    const input = path.join(dir, 'input.ttf');
    fs.writeFileSync(input, fixture(name));
    const run = spawnSync(compressor!, [input], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    return fs.readFileSync(path.join(dir, 'input.woff2'));
  }
  const hmtxRow = (woff2: Buffer) => readWoff2Reference(woff2).directory.find((row) => row.tag === 'hmtx');

  it.each(['dejavu-sans-latin.ttf', 'dejavu-serif-hinted-ascii.ttf', 'synthetic-triplets.ttf'])('transforms the hmtx table of %s, which the in-process reader reads back to the source table', (name) => {
    const woff2 = compressFile(name);
    expect(hmtxRow(woff2)?.version).toBe(1);
    expect(hmtxRow(woff2)?.transformLength).toBeLessThan(hmtxRow(woff2)!.origLength);
    const source = readSfntTables(fixture(name));
    expect(decodeWoff2(woff2, name).tables['hmtx'].data.equals(source.get('hmtx')!)).toBe(true);
  });

  it('writes a smaller file than the reference encoder does for the same font', () => {
    expect(compressFile('dejavu-sans-latin.ttf').length).toBeLessThan(fixture('dejavu-sans-latin.reference.woff2').length);
    expect(compressFile('dejavu-serif-hinted-ascii.ttf').length).toBeLessThan(fixture('dejavu-serif-hinted-ascii.reference.woff2').length);
  });

  it('stores the hmtx table as it is when a glyph without outlines has a left side bearing other than zero (section 5.4)', async () => {
    const font = decodeSfnt(fixture('dejavu-sans-latin.ttf'), 'empty-lsb');
    const loca = font.tables['loca'].data;
    const longOffsets = font.tables['head'].data.readInt16BE(50) === 1;
    const offsetAt = (glyph: number): number => (longOffsets ? loca.readUInt32BE(glyph * 4) : loca.readUInt16BE(glyph * 2) * 2);
    const glyphCount = font.tables['maxp'].data.readUInt16BE(4);
    const numHMetrics = font.tables['hhea'].data.readUInt16BE(34);
    let empty = -1;
    for (let glyph = 0; glyph < Math.min(glyphCount, numHMetrics) && empty < 0; glyph++) if (offsetAt(glyph) === offsetAt(glyph + 1)) empty = glyph;
    expect(empty, 'the fixture has an empty glyph among the proportional ones').toBeGreaterThanOrEqual(0);
    const hmtx = Buffer.from(font.tables['hmtx'].data);
    hmtx.writeInt16BE(123, empty * 4 + 2);
    font.tables['hmtx'] = { ...font.tables['hmtx'], data: hmtx };
    const written = await encodeWoff2Async(font);
    expect(decodeWoff2(written, 'empty-lsb').tables['hmtx'].data.equals(hmtx)).toBe(true);
    const decoder = pinnedWoff2Program('woff2_decompress');
    if (decoder !== null) {
      const dir = tmpDir('woff2-empty-lsb-');
      fs.writeFileSync(path.join(dir, 'input.woff2'), written);
      expect(spawnSync(decoder, [path.join(dir, 'input.woff2')]).status).toBe(0);
      expect(readSfntTables(fs.readFileSync(path.join(dir, 'input.ttf'))).get('hmtx')!.equals(hmtx)).toBe(true);
    }
  });

  it('leaves the hmtx table of a font without outlines in glyf as it is', () => {
    expect(hmtxRow(compressFile('synthetic-cff.otf'))?.version).toBe(0);
  });

  it('leaves the tables of a collection as they are, where the transform of shared glyf and loca tables is not implemented', () => {
    const woff2 = compressFile('pair.ttc');
    expect(readWoff2Reference(woff2).directory.every((row) => row.tag !== 'hmtx' || row.version === 0)).toBe(true);
    expect(decodeWoff2(woff2, 'pair').tables['hmtx'].data.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!haveProgram)('damaged fonts given to the encoder program', () => {
  const sfnt = () => Buffer.from(encodeSfnt(decodeSfnt(dejavu(), 'x')));
  const patched = (patch: (copy: Buffer) => void): Buffer => {
    const copy = sfnt();
    patch(copy);
    return copy;
  };
  const fonts: Array<[string, Buffer]> = [
    ['an empty file', Buffer.alloc(0)],
    ['the sfnt version alone', Buffer.from([0, 1, 0, 0])],
    ['a header with no tables', patched((b) => b.writeUInt16BE(0, 4))],
    ['65535 tables', patched((b) => b.writeUInt16BE(0xffff, 4))],
    ['4097 tables', patched((b) => b.writeUInt16BE(4097, 4))],
    ['a table that starts past the end of the file', patched((b) => b.writeUInt32BE(0xfffffff0, 12 + 8))],
    ['a table of 4 GiB', patched((b) => b.writeUInt32BE(0xffffffff, 12 + 12))],
    ['a file cut in the middle of the glyf table', sfnt().subarray(0, 40_000)],
    ['a file cut in the table directory', sfnt().subarray(0, 100)],
    ['a version that is not a font', patched((b) => b.write('wOF2', 0, 'latin1'))],
  ];

  it.each(fonts)('stops inside the limits for %s', async (name, font) => {
    const started = Date.now();
    const answer = await compressWithNativeWoff2(font, 11).then(
      (written) => ({ written }),
      (error: unknown) => ({ error })
    );
    expect(Date.now() - started, `${name} took too long`).toBeLessThan(RUN_HANG_GUARD_MS);
    // Declined (null) or written; a program stopped by a signal is a Woff2FormatError that names it.
    if ('error' in answer) expect(String((answer.error as Error).message), name).not.toMatch(/stopped by/);
    else if (answer.written !== null) expect(answer.written.toString('latin1', 0, 4), name).toBe('wOF2');
  });

  it('survives 100 fonts with a damaged byte in the directory or the head of the glyf table', async () => {
    let seed = 987654;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    const base = sfnt();
    for (let i = 0; i < 100; i++) {
      const copy = Buffer.from(base);
      const at = next() % 400;
      copy[at] = next() & 0xff;
      const answer = await compressWithNativeWoff2(copy, 11).then(
        (written) => ({ written }),
        (error: unknown) => ({ error })
      );
      if ('error' in answer) expect(String((answer.error as Error).message), `byte ${at}`).not.toMatch(/stopped by/);
    }
  }, 180_000);
});
