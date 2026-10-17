import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { convertFont } from '../src/lib/conversions/font';
import { CpuTaskTimeoutError, EngineMissingError, EngineUnavailableError, UnprocessableFontInputError } from '../src/lib/types';
import { buildOtf, cs } from './helpers/cff-font-builder';
import { buildPfa, buildPfb, circleGlyph, rectangleGlyph, type Type1Glyph } from './helpers/type1-builder';

/**
 * The wrapper around FontForge (src/lib/conversions/font-fontforge.ts), tested with stand-in programs that stand for a converter failing
 * in each way a real one can. What the real program writes is judged in font-type1-conversion.test.ts. A missing program is a typed
 * error: no other path reads a Type 1 font, so nothing may answer in its place.
 */

const GLYPHS: Type1Glyph[] = [rectangleGlyph('.notdef', 500, 50, 400, 700), rectangleGlyph('A', 600, 40, 300, 650), circleGlyph('O', 700, 300), { name: 'space', width: 250, steps: [] }];
const FIXED_TIMEOUT_MS = 400;
const FIXED_PATH_ENV = 'FONTFORGE_PATH';

const scratch: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs `body` with FONTFORGE_PATH pointing at `program`, then restores the environment. */
async function withProgram<T>(program: string, body: () => Promise<T>): Promise<T> {
  const before = process.env[FIXED_PATH_ENV];
  process.env[FIXED_PATH_ENV] = program;
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env[FIXED_PATH_ENV];
    else process.env[FIXED_PATH_ENV] = before;
  }
}

/** A shell script that stands in for FontForge: the arguments are $1 -lang=ff, $2 -c, $3 the script, $4 the input and $5 the output. */
function standIn(body: string): string {
  const file = path.join(tmpDir('fontforge-standin-'), 'fontforge');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

/** A stand-in that writes an OpenType font of `glyphCount` glyphs to its output, as a converter that read that many would. */
function standInWritingGlyphs(glyphCount: number): string {
  const font = path.join(tmpDir('fontforge-output-'), 'font.otf');
  fs.writeFileSync(font, buildOtf({ family: 'Stand In', glyphs: Array.from({ length: glyphCount }, () => ({ charstring: cs('endchar'), advance: 500, lsb: 0 })), codePoints: [65] }));
  return standIn(`cp ${font} "$5"`);
}

async function failureOf(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the conversion to fail');
}

const convertPfa = (options = {}, name = 'face.pfa') => convertFont(buildPfa(GLYPHS), 'pfa', 'otf', options, name);

describe('a missing or failing FontForge never passes for a conversion', () => {
  it('answers a typed engine-unavailable error (503, retried on another worker) when the program is not installed', async () => {
    await withProgram('/nonexistent/fontforge', async () => {
      for (const target of ['otf', 'ttf', 'woff', 'woff2']) {
        const failure = await failureOf(() => convertFont(buildPfb(GLYPHS), 'pfb', target, {}, 'face.pfb'));
        expect(failure, target).toBeInstanceOf(EngineUnavailableError);
        expect(failure, target).toBeInstanceOf(EngineMissingError);
        expect((failure as EngineUnavailableError).engineName).toBe('fontforge');
      }
    });
  });

  it('answers 422 with the program message, without the path of its scratch directory, when it cannot read the font', async () => {
    const program = standIn('echo "Open: Failed to open: $4" >&2; exit 1');
    await withProgram(program, async () => {
      const failure = await failureOf(() => convertPfa());
      expect(failure).toBeInstanceOf(UnprocessableFontInputError);
      expect(failure).not.toBeInstanceOf(EngineMissingError);
      expect((failure as UnprocessableFontInputError).status).toBe(422);
      expect(failure.message).toContain('exited with status 1');
      expect(failure.message).toContain('Open: Failed to open: <tmp>/input.pfb');
      expect(failure.message).not.toContain(os.tmpdir());
    });
  });

  it('answers 422 when the program exits 0 without writing a font', async () => {
    await withProgram(standIn('exit 0'), async () => {
      const failure = await failureOf(() => convertPfa());
      expect(failure).toBeInstanceOf(UnprocessableFontInputError);
      expect(failure.message).toBe('FontForge wrote no font from this file.');
    });
  });

  it('answers 422 when the program writes an empty file', async () => {
    await withProgram(standIn(': > "$5"'), async () => {
      const failure = await failureOf(() => convertPfa());
      expect(failure).toBeInstanceOf(UnprocessableFontInputError);
      expect(failure.message).toBe('FontForge wrote an empty file.');
    });
  });

  it('answers 422 when the program writes something that is not an OpenType font', async () => {
    await withProgram(standIn('echo "not a font" > "$5"'), async () => {
      const failure = await failureOf(() => convertPfa());
      expect(failure).toBeInstanceOf(UnprocessableFontInputError);
      expect(failure.message).toMatch(/not an OpenType font/);
    });
  });

  it('answers 422 that names both counts when FontForge read fewer glyphs than the file holds', async () => {
    await withProgram(standInWritingGlyphs(1), async () => {
      const failure = await failureOf(() => convertPfa());
      expect(failure).toBeInstanceOf(UnprocessableFontInputError);
      expect(failure.message).toBe('FontForge read 1 of the 4 glyphs of this font, so the result would lose glyphs.');
    });
  });

  it('accepts a result with all the glyphs of the font', async () => {
    await withProgram(standInWritingGlyphs(GLYPHS.length), async () => {
      const result = await convertPfa();
      expect(result.mimeType).toBe('font/otf');
      expect(result.filename).toBe('face.otf');
    });
  });

  it('answers 422 when the program is killed by a signal (a crash on a damaged font)', async () => {
    await withProgram(standIn('kill -SEGV $$'), async () => {
      const failure = await failureOf(() => convertPfa());
      expect(failure).toBeInstanceOf(UnprocessableFontInputError);
      expect(failure).not.toBeInstanceOf(EngineMissingError);
      expect(failure.message).toMatch(/^FontForge (could not convert this font: it was stopped by SIG[A-Z]+|ran out of memory or crashed on this font)\.?$/);
    });
  });

  it.each([
    [127, 'a program the shell did not find'],
    [126, 'a program the shell could not execute'],
  ])('answers the engine-unavailable error (503, retried on another worker), not a 422, when the program exits %i (%s)', async (status) => {
    await withProgram(standIn(`exit ${status}`), async () => {
      const failure = await failureOf(() => convertPfa());
      expect(failure).toBeInstanceOf(EngineUnavailableError);
      expect(failure).not.toBeInstanceOf(UnprocessableFontInputError);
      expect(failure.message).toBe("Engine 'fontforge' is unavailable: FontForge could not be started");
    });
  });

  it('answers a typed timeout when the program overruns its time', async () => {
    await withProgram(standIn('sleep 30'), async () => {
      const failure = await failureOf(() => convertPfa({ timeoutMs: FIXED_TIMEOUT_MS }));
      expect(failure).toBeInstanceOf(CpuTaskTimeoutError);
      expect(failure.message).toContain(`${FIXED_TIMEOUT_MS}`);
    });
  });
});

describe('what the wrapper asks FontForge for', () => {
  /** A stand-in that records its arguments with the two paths reduced to their names, then writes a font of four glyphs. */
  function recordingProgram(): { program: string; recorded: () => string } {
    const dir = tmpDir('fontforge-args-');
    const font = path.join(dir, 'font.otf');
    fs.writeFileSync(font, buildOtf({ family: 'Stand In', glyphs: Array.from({ length: GLYPHS.length }, () => ({ charstring: cs('endchar'), advance: 500, lsb: 0 })), codePoints: [65] }));
    const record = path.join(dir, 'arguments.txt');
    const program = standIn(`printf '%s\\n' "$1" "$2" "$3" "$(basename "$4")" "$(basename "$5")" > ${record}\ncp ${font} "$5"`);
    return { program, recorded: () => fs.readFileSync(record, 'utf8') };
  }

  it.each([
    ['pfa', 'otf'],
    ['pfb', 'ttf'],
  ])('reads the font as input.pfb and writes output.otf for a .%s converted to .%s, with the script text fixed and no file name in it', async (source, target) => {
    const { program, recorded } = recordingProgram();
    await withProgram(program, async () => {
      await convertFont(source === 'pfa' ? buildPfa(GLYPHS) : buildPfb(GLYPHS), source, target, {}, "evil';Quit();'.pfa");
    });
    expect(recorded()).toBe('-lang=ff\n-c\nOpen($1); Generate($2)\ninput.pfb\noutput.otf\n');
  });
});
