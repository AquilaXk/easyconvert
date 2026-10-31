import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { convertFont } from '../src/lib/conversions/font';
import { CpuTaskTimeoutError, ConversionFailedError, EngineUnavailableError, PayloadLimitError, UnprocessableFontInputError } from '../src/lib/types';
import { eot2ttfDirect, haveMtxOracles } from './helpers/eot2ttf-tool';
import { haveFontTools } from './helpers/fontforge-tool';
import { expectSameOutlines, readFontFacts, readFontTableFacts, type FontTableFacts } from './helpers/font-outline-oracle';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * EOT fonts compressed with MicroType Express (header flag 0x4), decompressed by libeot's `eot2ttf` in the worker sandbox
 * (src/lib/conversions/font-eot-mtx.ts). Two real files of the IBM Plex Sans Arabic build are converted, and fontTools, which shares no
 * code with the converter, reads every result. The pinned facts are those of the TrueType files the build was compressed from
 * (IBMPlexSansArabic-Light.ttf and -Bold.ttf of IBM/plex at 39276912, read by fontTools): 1,706 glyphs, 1,032 mapped characters,
 * the same character-to-glyph pairs in both weights. Without eot2ttf or fontTools a run that is not strict skips; ORACLE_STRICT_MODE=1 fails.
 */

const TIMEOUT_MS = 120_000;
const FLAGS_OFFSET = 12;
const FONT_DATA_SIZE_OFFSET = 4;
const TOTAL_SIZE_OFFSET = 0;
const MTX_FLAG = 0x4;
const XOR_FLAG = 0x10000000;
const XOR_KEY = 0x50;
const MTX_BLOCK2_OFFSET_AT = 4;
const MIB = 1024 * 1024;
const PROGRAM_VARIABLE = 'EOT2TTF_PATH';

const SHARED_CMAP_DIGEST = '3a684caf6f8f4dc57133b37ee4dfbf65cbb023abd350d8abff699bd672d3422e';
const SOURCE_FACTS = {
  'plex-ibmplexsansarabic-light.eot': { familyName: 'IBM Plex Sans Arabic Light', advanceSum: 986525, advanceOfA: 527 },
  'plex-ibmplexsansarabic-bold.eot': { familyName: 'IBM Plex Sans Arabic', advanceSum: 1059625, advanceOfA: 569 },
} as const;
type SampleId = keyof typeof SOURCE_FACTS;
const SAMPLE_IDS = Object.keys(SOURCE_FACTS) as SampleId[];

const scratch: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs `body` with EOT2TTF_PATH pointing at `program`, then restores the environment. */
async function withProgram<T>(program: string, body: () => Promise<T>): Promise<T> {
  const before = process.env[PROGRAM_VARIABLE];
  process.env[PROGRAM_VARIABLE] = program;
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env[PROGRAM_VARIABLE];
    else process.env[PROGRAM_VARIABLE] = before;
  }
}

/** A shell script that stands in for eot2ttf: $1 is the EOT file it reads and $2 the font it writes. */
function standIn(body: string): string {
  const file = path.join(tmpDir('eot2ttf-standin-'), 'eot2ttf');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

async function failureOf(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the conversion to fail');
}

/** The bytes before the font data, and the MTX stream: its version byte, copy limit, block offsets and the three LZCOMP blocks. */
function split(eot: Buffer): { header: Buffer; stream: Buffer } {
  const size = eot.readUInt32LE(FONT_DATA_SIZE_OFFSET);
  return { header: eot.subarray(0, eot.length - size), stream: eot.subarray(eot.length - size) };
}

/** An EOT file with the header of `eot` around `stream`, the sizes of the header made to fit. */
function withStream(eot: Buffer, stream: Buffer): Buffer {
  const { header } = split(eot);
  const rebuilt = Buffer.concat([header, stream]);
  rebuilt.writeUInt32LE(rebuilt.length, TOTAL_SIZE_OFFSET);
  rebuilt.writeUInt32LE(stream.length, FONT_DATA_SIZE_OFFSET);
  return rebuilt;
}

function expectFactsOfSource(facts: FontTableFacts, id: SampleId): void {
  const pinned = SOURCE_FACTS[id];
  expect(facts.glyphCount).toBe(1706);
  expect(facts.cmapSize).toBe(1032);
  expect(facts.cmapDigest).toBe(SHARED_CMAP_DIGEST);
  expect(facts.unitsPerEm).toBe(1000);
  expect([facts.ascent, facts.descent]).toEqual([1085, -415]);
  expect(facts.familyName).toBe(pinned.familyName);
  expect(facts.advanceSum).toBe(pinned.advanceSum);
  expect(facts.advanceOfA).toBe(pinned.advanceOfA);
  // libeot 0.01 (the Debian package) leaves six composite glyphs of each file with misplaced instruction bytes; the pinned build of scripts/install-libeot.sh does not.
  expect(facts.undecodableGlyphPrograms).toBe(0);
}

describe.skipIf(!haveMtxOracles)('EOT fonts compressed with MicroType Express, decompressed by eot2ttf', () => {
  for (const id of SAMPLE_IDS) {
    describe(`real sample ${id}`, () => {
      for (const target of ['ttf', 'woff', 'woff2', 'otf'] as const) {
        it(`converts to ${target} with the glyphs, the character map and the metrics of the font it was compressed from`, { timeout: TIMEOUT_MS }, async (ctx) => {
          const { bytes } = await requireRealworldSample(ctx, id);
          expect(bytes.readUInt32LE(FLAGS_OFFSET) & MTX_FLAG).toBe(MTX_FLAG);
          const result = await convertFont(bytes, 'eot', target, {}, id);
          expect(result.filename).toBe(`${id.replace(/\.[^.]+$/, '')}.${target}`);
          const facts = readFontTableFacts(result.buffer, target);
          expect(facts.flavor).toBe(target === 'otf' ? 'OTTO' : '\u0000\u0001\u0000\u0000');
          expectFactsOfSource(facts, id);
        });
      }

      it('converts to svg with a glyph for every mapped character but U+0000, which an XML attribute cannot hold', { timeout: TIMEOUT_MS }, async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const result = await convertFont(bytes, 'eot', 'svg', {}, id);
        const text = result.buffer.toString('utf-8');
        expect(result.mimeType).toBe('image/svg+xml');
        expect(text).toContain('<font');
        expect(text.match(/<glyph /g)?.length ?? 0).toBe(1031);
      });

      it('writes the outlines the reference decoder writes, glyph by glyph', { timeout: TIMEOUT_MS }, async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const truth = readFontFacts('sfnt', eot2ttfDirect(bytes), 'ttf');
        const result = await convertFont(bytes, 'eot', 'ttf', {}, id);
        expect(truth.glyphCount).toBe(1706);
        expectSameOutlines(readFontFacts('sfnt', result.buffer, 'ttf'), truth, { area: 0, units: 0 });
      });

      it('reads the file the same when its extension says something else, because the signature decides', { timeout: TIMEOUT_MS }, async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const named = await convertFont(bytes, 'eot', 'ttf', {}, id);
        const spoofed = await convertFont(bytes, 'ttf', 'ttf', {}, 'photo.ttf');
        expect(spoofed.buffer.equals(named.buffer)).toBe(true);
      });
    });
  }

  it('reads a file whose data is both compressed and XOR-encrypted', { timeout: TIMEOUT_MS }, async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'plex-ibmplexsansarabic-light.eot');
    const hidden = Buffer.from(bytes);
    const { header } = split(bytes);
    for (let at = header.length; at < hidden.length; at += 1) hidden[at] ^= XOR_KEY;
    hidden.writeUInt32LE(bytes.readUInt32LE(FLAGS_OFFSET) | XOR_FLAG, FLAGS_OFFSET);
    const plain = await convertFont(bytes, 'eot', 'ttf', {}, 'plain.eot');
    const result = await convertFont(hidden, 'eot', 'ttf', {}, 'hidden.eot');
    expect(result.buffer.equals(plain.buffer)).toBe(true);
  });

  describe('data that is cut short, damaged or hostile is refused with a typed error', () => {
    const LIGHT = 'plex-ibmplexsansarabic-light.eot';

    it('refuses a file cut inside its font data, where the header still declares the whole stream', { timeout: TIMEOUT_MS }, async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, LIGHT);
      const failure = await failureOf(() => convertFont(bytes.subarray(0, bytes.length - 5000), 'eot', 'ttf', {}, 'cut.eot'));
      expect(failure).toBeInstanceOf(ConversionFailedError);
      expect(failure.message).toMatch(/does not fit in the file/);
    });

    it('refuses a stream whose third block is cut short, which makes the C decoder crash, as a 422 and not a crash of the worker', { timeout: TIMEOUT_MS }, async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, LIGHT);
      const { stream } = split(bytes);
      const failure = await failureOf(() => convertFont(withStream(bytes, stream.subarray(0, stream.length - 5000)), 'eot', 'ttf', {}, 'cut.eot'));
      expect(failure).toBeInstanceOf(UnprocessableFontInputError);
      expect((failure as UnprocessableFontInputError).status).toBe(422);
      expect(failure.message).toMatch(/^eot2ttf (could not convert this font|ran out of memory or crashed on this font)/);
    });

    it('refuses a stream cut inside its own header before any program runs', { timeout: TIMEOUT_MS }, async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, LIGHT);
      const { stream } = split(bytes);
      const failure = await failureOf(() => convertFont(withStream(bytes, stream.subarray(0, 9)), 'eot', 'ttf', {}, 'cut.eot'));
      expect(failure).toBeInstanceOf(ConversionFailedError);
      expect(failure.message).toMatch(/does not fit in the file/);
    });

    it('refuses an offset of the second block that lies inside the stream header, which the decoder reads as a block of four billion bytes', { timeout: TIMEOUT_MS }, async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, LIGHT);
      const { stream } = split(bytes);
      const damaged = Buffer.from(stream);
      damaged.writeUIntBE(2, MTX_BLOCK2_OFFSET_AT, 3);
      const failure = await failureOf(() => convertFont(withStream(bytes, damaged), 'eot', 'ttf', {}, 'offsets.eot'));
      expect(failure).toBeInstanceOf(ConversionFailedError);
      expect(failure.message).toMatch(/blocks of its MicroType Express data do not lie inside it/);
    });

    it('refuses blocks that state the largest decompressed size (16 MiB) and hold no data, as a 422, within the sandbox limits', { timeout: TIMEOUT_MS }, async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, LIGHT);
      const { stream } = split(bytes);
      const bomb = Buffer.concat([stream.subarray(0, 10), Buffer.alloc(2000, 0xff)]);
      bomb.writeUIntBE(10 + 700, MTX_BLOCK2_OFFSET_AT, 3);
      bomb.writeUIntBE(10 + 1400, MTX_BLOCK2_OFFSET_AT + 3, 3);
      const failure = await failureOf(() => convertFont(withStream(bytes, bomb), 'eot', 'ttf', {}, 'bomb.eot'));
      expect(failure).toBeInstanceOf(UnprocessableFontInputError);
      expect(failure.message).toMatch(/^eot2ttf (could not convert this font|ran out of memory or crashed on this font)/);
    });
  });

  it('answers 413 for font data past the three 24-bit blocks of the format, before any program runs', async () => {
    const eot = Buffer.alloc(48 * MIB + 1024);
    eot.writeUInt32LE(eot.length, TOTAL_SIZE_OFFSET);
    eot.writeUInt32LE(48 * MIB + 1, FONT_DATA_SIZE_OFFSET);
    eot.writeUInt32LE(0x00020002, 8);
    eot.writeUInt32LE(MTX_FLAG, FLAGS_OFFSET);
    eot.writeUInt16LE(0x504c, 34);
    const failure = await failureOf(() => convertFont(eot, 'eot', 'ttf', {}, 'huge.eot'));
    expect(failure).toBeInstanceOf(PayloadLimitError);
    expect((failure as PayloadLimitError).status).toBe(413);
  });
});

describe('the wrapper around eot2ttf never lets a missing or failing program pass for a conversion', () => {
  /** An EOT file the reader takes for MTX compressed: a valid header around a stream whose blocks lie inside it. */
  function mtxEot(): Buffer {
    const stream = Buffer.alloc(64);
    stream.writeUIntBE(32, MTX_BLOCK2_OFFSET_AT, 3);
    stream.writeUIntBE(48, MTX_BLOCK2_OFFSET_AT + 3, 3);
    const eot = Buffer.alloc(100 + stream.length);
    eot.writeUInt32LE(eot.length, TOTAL_SIZE_OFFSET);
    eot.writeUInt32LE(stream.length, FONT_DATA_SIZE_OFFSET);
    eot.writeUInt32LE(0x00020002, 8);
    eot.writeUInt32LE(MTX_FLAG, FLAGS_OFFSET);
    eot.writeUInt16LE(0x504c, 34);
    stream.copy(eot, 100);
    return eot;
  }
  const convert = () => convertFont(mtxEot(), 'eot', 'ttf', {}, 'face.eot');

  it('answers a typed engine-unavailable error (503, retried on another worker) when the program is not installed', async () => {
    await withProgram('/nonexistent/eot2ttf', async () => {
      const failure = await failureOf(convert);
      expect(failure).toBeInstanceOf(EngineUnavailableError);
      expect((failure as EngineUnavailableError).engineName).toBe('eot2ttf');
    });
  });

  it('answers 422 with the program message, without the path of its scratch directory, when it cannot read the data', async () => {
    await withProgram(standIn('echo "The font file appears corrupt: $1" >&2; exit 1'), async () => {
      const failure = await failureOf(convert);
      expect(failure).toBeInstanceOf(UnprocessableFontInputError);
      expect(failure.message).toContain('exited with status 1');
      expect(failure.message).toContain('The font file appears corrupt: <tmp>/input.eot');
      expect(failure.message).not.toContain(os.tmpdir());
    });
  });

  it('answers 422 when the program is killed by a signal (the crash of a C decoder on cut data)', async () => {
    await withProgram(standIn('kill -SEGV $$'), async () => {
      const failure = await failureOf(convert);
      expect(failure).toBeInstanceOf(UnprocessableFontInputError);
      expect(failure.message).toMatch(/^eot2ttf (could not convert this font: it was stopped by SIG[A-Z]+|ran out of memory or crashed on this font)\.?$/);
    });
  });

  it('answers 422 when the program exits 0 without writing a font, or writes an empty file', async () => {
    await withProgram(standIn('exit 0'), async () => expect((await failureOf(convert)).message).toBe('eot2ttf wrote no font from this file.'));
    await withProgram(standIn(': > "$2"'), async () => expect((await failureOf(convert)).message).toBe('eot2ttf wrote an empty file.'));
  });

  it('answers 422 when the program writes something that is not a font', async () => {
    await withProgram(standIn('echo "not a font" > "$2"'), async () => {
      const failure = await failureOf(convert);
      expect(failure).toBeInstanceOf(UnprocessableFontInputError);
      expect(failure.message).toBe('eot2ttf wrote something that is not a font with a glyph count.');
    });
  });

  it('answers 422 that the font is too large when the program decompresses past the output limit', async () => {
    // 150 MB against the 128 MB limit: the sandbox stops the program with SIGXFSZ where it limits file sizes, and the size check catches the file otherwise.
    await withProgram(standIn('exec head -c 150000000 /dev/zero > "$2"'), async () => {
      const failure = await failureOf(convert);
      expect(failure).toBeInstanceOf(UnprocessableFontInputError);
      expect(failure.message).toBe('The font is larger than eot2ttf may write.');
    });
  });

  it('answers a typed timeout when the program overruns its time', async () => {
    await withProgram(standIn('exec sleep 30'), async () => {
      const failure = await failureOf(() => convertFont(mtxEot(), 'eot', 'ttf', { timeoutMs: 400 }, 'face.eot'));
      expect(failure).toBeInstanceOf(CpuTaskTimeoutError);
      expect(failure.message).toBe('The eot2ttf task exceeded its 400 ms time limit');
    });
  });

  it('never reads a file that has no EOT signature as MTX, whatever its name says', async () => {
    const photo = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
    await withProgram(standIn('echo ran >&2; exit 1'), async () => {
      const failure = await failureOf(() => convertFont(photo, 'eot', 'ttf', {}, 'photo.eot'));
      expect(failure).toBeInstanceOf(ConversionFailedError);
      expect(failure).not.toBeInstanceOf(UnprocessableFontInputError);
      expect(failure.message).toBe('Invalid EOT font: missing LP signature at offset 34.');
    });
  });

  it('does not send a file that is a WOFF by its signature to the MTX decoder', async () => {
    const woff = mtxEot();
    woff.write('wOFF', 0, 'latin1');
    await withProgram(standIn('echo ran >&2; exit 1'), async () => {
      const failure = await failureOf(() => convertFont(woff, 'eot', 'ttf', {}, 'face.eot'));
      expect(failure.message).not.toMatch(/eot2ttf/);
    });
  });
});

describe('an EOT font that is not compressed does not need the program', () => {
  const sourceFont = fs.readFileSync(path.join(__dirname, 'fixtures', 'woff2', 'dejavu-sans-latin.reference.woff2'));

  it('converts with the program missing, to the same font as the plain path', async () => {
    const eot = (await convertFont(sourceFont, 'woff2', 'eot', {}, 'dejavu.woff2')).buffer;
    const direct = (await convertFont(sourceFont, 'woff2', 'ttf', {}, 'dejavu.woff2')).buffer;
    await withProgram('/nonexistent/eot2ttf', async () => {
      const result = await convertFont(eot, 'eot', 'ttf', {}, 'dejavu.eot');
      expect(result.buffer.equals(direct)).toBe(true);
    });
  });

  it.skipIf(!haveFontTools)('converts the real uncompressed file fa-fontawesome-webfont.eot with the program missing, to the font inside it', { timeout: TIMEOUT_MS }, async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'fa-fontawesome-webfont.eot');
    expect(bytes.readUInt32LE(FLAGS_OFFSET) & MTX_FLAG).toBe(0);
    const inside = bytes.subarray(bytes.length - bytes.readUInt32LE(FONT_DATA_SIZE_OFFSET));
    await withProgram('/nonexistent/eot2ttf', async () => {
      const result = await convertFont(bytes, 'eot', 'ttf', {}, 'fa.eot');
      const facts = readFontTableFacts(result.buffer, 'ttf');
      const truth = readFontTableFacts(inside, 'ttf');
      expect(facts.glyphCount).toBe(truth.glyphCount);
      expect(facts.cmapDigest).toBe(truth.cmapDigest);
      expect(facts.advanceSum).toBe(truth.advanceSum);
    });
  });
});
