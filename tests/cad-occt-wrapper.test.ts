import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { convertCadWithOcct } from '../src/lib/conversions/cad-occt';
import { convertVectorCad } from '../src/lib/conversions/vector-cad';
import { CpuTaskTimeoutError, EngineMissingError, EngineUnavailableError, UnprocessableCadInputError } from '../src/lib/types';

/**
 * The wrapper around `cad-convert` (src/lib/conversions/cad-occt.ts), tested with stand-in programs that stand for a converter
 * failing in each way a real one can. What the real program writes is judged in cad-occt-real-samples.test.ts. A missing
 * program is a typed error: STEP and IGES have no other reader, so nothing may answer in its place.
 */

const STEP_BYTES = Buffer.from('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n');
const FIXED_TIMEOUT_MS = 400;

const scratch: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs `body` with CAD_CONVERT_PATH pointing at `program`, then restores the environment. */
async function withProgram<T>(program: string, body: () => Promise<T>): Promise<T> {
  const before = process.env.CAD_CONVERT_PATH;
  process.env.CAD_CONVERT_PATH = program;
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env.CAD_CONVERT_PATH;
    else process.env.CAD_CONVERT_PATH = before;
  }
}

/** A shell script that stands in for the program: the arguments are $1 (--from) $2 format $3 (--to) $4 format $5 (--unit) $6 unit $7 input $8 output. */
function standIn(body: string): string {
  const file = path.join(tmpDir('cad-standin-'), 'cad-convert');
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

/** One binary STL triangle: the 80-byte header, the count 1, and the 50 bytes of the facet. */
function oneTriangleStl(): Buffer {
  const stl = Buffer.alloc(84 + 50);
  stl.writeUInt32LE(1, 80);
  const corners = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  corners.forEach((value, i) => stl.writeFloatLE(value, 84 + 12 + 4 * i));
  return stl;
}

describe('a missing or failing converter never passes for a conversion', () => {
  it('answers a typed engine-unavailable error (503, retried on another worker) when the program is not installed', async () => {
    await withProgram('/nonexistent/cad-convert', async () => {
      for (const target of ['stl', 'obj', 'step', 'iges', 'dxf']) {
        const failure = await failureOf(() => convertVectorCad(STEP_BYTES, 'step', target, {}, 'part.step'));
        expect(failure, target).toBeInstanceOf(EngineUnavailableError);
        expect(failure, target).toBeInstanceOf(EngineMissingError);
        expect((failure as EngineUnavailableError).engineName).toBe('cad-convert');
      }
    });
  });

  it('answers 422 with the program message, without the path of its scratch directory, when the file is unreadable', async () => {
    const program = standIn('echo "cad-convert: error: unreadable: cannot read $7" >&2; exit 3');
    await withProgram(program, async () => {
      const failure = await failureOf(() => convertCadWithOcct(STEP_BYTES, 'step', 'stl'));
      expect(failure).toBeInstanceOf(UnprocessableCadInputError);
      expect(failure).not.toBeInstanceOf(EngineMissingError);
      expect((failure as UnprocessableCadInputError).status).toBe(422);
      expect(failure.message).toContain('exited with status 3 (unreadable: cannot read <tmp>/input.step)');
      expect(failure.message).not.toContain(os.tmpdir());
    });
  });

  it('answers 422 when the program exits 0 without writing a file', async () => {
    await withProgram(standIn('exit 0'), async () => {
      const failure = await failureOf(() => convertCadWithOcct(STEP_BYTES, 'step', 'stl'));
      expect(failure).toBeInstanceOf(UnprocessableCadInputError);
      expect(failure.message).toBe('The CAD converter wrote no model from this file.');
    });
  });

  it('answers 422 when the program writes an empty file', async () => {
    await withProgram(standIn('shift 7; : > "$1"'), async () => {
      const failure = await failureOf(() => convertCadWithOcct(STEP_BYTES, 'step', 'stl'));
      expect(failure).toBeInstanceOf(UnprocessableCadInputError);
      expect(failure.message).toBe('The CAD converter wrote an empty file.');
    });
  });

  it('answers 422 when the program is killed by a signal (a crash on a damaged file)', async () => {
    await withProgram(standIn('kill -SEGV $$'), async () => {
      const failure = await failureOf(() => convertCadWithOcct(STEP_BYTES, 'step', 'stl'));
      expect(failure).toBeInstanceOf(UnprocessableCadInputError);
      expect(failure).not.toBeInstanceOf(EngineMissingError);
      expect(failure.message).toMatch(/^The CAD converter (could not convert this model: it was stopped by SIG[A-Z]+|ran out of memory or crashed on this model)\.?$/);
    });
  });

  it('answers a typed timeout when the program overruns its time', async () => {
    await withProgram(standIn('sleep 30'), async () => {
      const failure = await failureOf(() => convertCadWithOcct(STEP_BYTES, 'step', 'stl', { timeoutMs: FIXED_TIMEOUT_MS }));
      expect(failure).toBeInstanceOf(CpuTaskTimeoutError);
      expect(failure.message).toContain(`${FIXED_TIMEOUT_MS}`);
    });
  });

  it('refuses a pair the program does not convert before it starts', async () => {
    const marker = path.join(tmpDir('cad-marker-'), 'started');
    await withProgram(standIn(`touch ${marker}`), async () => {
      const failure = await failureOf(() => convertCadWithOcct(STEP_BYTES, 'stl', 'step'));
      expect(failure).toBeInstanceOf(UnprocessableCadInputError);
    });
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('what the wrapper asks the converter for', () => {
  const ARGUMENTS_FILE = 'arguments.txt';

  /** A stand-in that records the arguments it got (the paths reduced to their names) and writes a binary STL. */
  function recordingProgram(): { program: string; recorded: () => string } {
    const dir = tmpDir('cad-args-');
    const stl = path.join(dir, 'triangle.stl');
    fs.writeFileSync(stl, oneTriangleStl());
    const program = standIn(`printf '%s %s %s %s %s %s %s %s' "$1" "$2" "$3" "$4" "$5" "$6" "$(basename "$7")" "$(basename "$8")" > ${path.join(dir, ARGUMENTS_FILE)}\ncp ${stl} "$8"`);
    return { program, recorded: () => fs.readFileSync(path.join(dir, ARGUMENTS_FILE), 'utf8') };
  }

  it.each([
    ['step', 'stl', '--from step --to stl --unit mm input.step output.stl'],
    ['stp', 'obj', '--from step --to obj --unit mm input.stp output.obj'],
    ['iges', 'step', '--from iges --to step --unit mm input.iges output.step'],
    ['igs', 'stp', '--from iges --to step --unit mm input.igs output.stp'],
    ['step', 'igs', '--from step --to iges --unit mm input.step output.igs'],
  ])('converts .%s to .%s as %s', async (source, target, expected) => {
    const { program, recorded } = recordingProgram();
    await withProgram(program, async () => {
      await convertCadWithOcct(STEP_BYTES, source, target);
    });
    expect(recorded()).toBe(expected);
  });

  it.each(['mm', 'cm', 'm', 'in'] as const)('asks for the %s unit named by the outputUnit option', async (unit) => {
    const { program, recorded } = recordingProgram();
    await withProgram(program, async () => {
      await convertCadWithOcct(STEP_BYTES, 'step', 'iges', { outputUnit: unit });
    });
    expect(recorded()).toBe(`--from step --to iges --unit ${unit} input.step output.iges`);
  });

  it('refuses a unit the program does not write before it starts', async () => {
    const marker = path.join(tmpDir('cad-marker-'), 'started');
    await withProgram(standIn(`touch ${marker}`), async () => {
      const failure = await failureOf(() => convertCadWithOcct(STEP_BYTES, 'step', 'stl', { outputUnit: 'furlong' as never }));
      expect(failure).toBeInstanceOf(UnprocessableCadInputError);
      expect(failure.message).toBe("The output unit 'furlong' is not one of mm, cm, m and in.");
    });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('draws a DXF from the STL the program writes, one 3DFACE per triangle, in the units of the mesh', async () => {
    const { program, recorded } = recordingProgram();
    const result = await withProgram(program, () => convertVectorCad(STEP_BYTES, 'step', 'dxf', {}, 'part.step'));
    expect(recorded()).toBe('--from step --to stl --unit mm input.step output.stl');
    expect(result.mimeType).toBe('image/vnd.dxf');
    const dxf = result.buffer.toString('utf-8');
    expect(dxf.split('\n').filter((line) => line === '3DFACE')).toHaveLength(1);
    expect(dxf).toContain('\n 11\n1\n 21\n0\n 31\n0\n');
  });

  it('names the result by its target and gives it the media type of the format', async () => {
    const { program } = recordingProgram();
    await withProgram(program, async () => {
      const cases: Array<[string, string]> = [['stp', 'model/step'], ['igs', 'model/iges'], ['stl', 'model/stl'], ['obj', 'model/obj']];
      for (const [target, mimeType] of cases) {
        const result = await convertVectorCad(STEP_BYTES, 'step', target, {}, 'part.step');
        expect(result.filename, target).toBe(`part.${target}`);
        expect(result.mimeType, target).toBe(mimeType);
        expect(result.size).toBe(result.buffer.length);
      }
    });
  });
});
