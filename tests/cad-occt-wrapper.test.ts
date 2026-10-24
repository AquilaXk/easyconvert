import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { convertCadWithOcct, convertMeshToIgesWithOcct, type IndexedMesh } from '../src/lib/conversions/cad-occt';
import { convertVectorCad } from '../src/lib/conversions/vector-cad';
import JSZip from 'jszip';
import { igesFile } from './helpers/iges-builder';
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

  it.each([
    [127, 'a program the shell did not find'],
    [126, 'a program the shell could not execute'],
  ])('answers the engine-unavailable error (503, retried on another worker), not a 422, when the program exits %i (%s)', async (status) => {
    await withProgram(standIn(`exit ${status}`), async () => {
      const failure = await failureOf(() => convertCadWithOcct(STEP_BYTES, 'step', 'stl'));
      expect(failure).toBeInstanceOf(EngineUnavailableError);
      expect(failure).toBeInstanceOf(EngineMissingError);
      expect(failure).not.toBeInstanceOf(UnprocessableCadInputError);
      expect((failure as EngineUnavailableError).engineName).toBe('cad-convert');
      expect(failure.message).toBe("Engine 'cad-convert' is unavailable: cad-convert (Open CASCADE) could not be started");
    });
  });

  it('answers 422 that names the memory limit when the program reports that it ran out of memory', async () => {
    await withProgram(standIn('echo "cad-convert: error: memory: the model needs more memory than the program may use" >&2; exit 5'), async () => {
      const failure = await failureOf(() => convertCadWithOcct(STEP_BYTES, 'step', 'stl'));
      expect(failure).toBeInstanceOf(UnprocessableCadInputError);
      expect(failure.message).toBe('The CAD converter ran out of memory: the model needs more than the 2048 MB it may use.');
    });
  });

  it('answers 422 that the model is too large, not that the diagnostics are too long, when the output grows past the size limit', async () => {
    // 300 MB against the 256 MB limit: the sandbox stops the program with SIGXFSZ where it limits file sizes, and the size check catches the file otherwise.
    await withProgram(standIn('exec head -c 300000000 /dev/zero > "$8"'), async () => {
      const failure = await failureOf(() => convertCadWithOcct(STEP_BYTES, 'step', 'stl'));
      expect(failure).toBeInstanceOf(UnprocessableCadInputError);
      expect(failure.message).toBe('The model is larger than the CAD converter may write.');
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

/** A binary STL of `triangles` triangles that share one vertex: the 80-byte header, the count and 50 bytes per facet. */
function binaryStl(triangles: number): Buffer {
  const stl = Buffer.alloc(84 + 50 * triangles);
  stl.writeUInt32LE(triangles, 80);
  for (let i = 0; i < triangles; i++) {
    const at = 84 + 50 * i + 12;
    [0, 0, 0, 1 + i, 0, 0, 0, 1 + i, 0].forEach((value, k) => stl.writeFloatLE(value, at + 4 * k));
  }
  return stl;
}

describe('an IGES file or a mesh that is refused before the program starts', () => {
  const started = (): { program: string; marker: string } => {
    const marker = path.join(tmpDir('cad-marker-'), 'started');
    return { program: standIn(`touch ${marker}`), marker };
  };

  it('answers 422 for an IGES file whose Terminate line disagrees with its records, and never starts the program', async () => {
    const { program, marker } = started();
    const records = igesFile().toString('latin1').split('\r\n');
    records.splice(records.length - 3, 1);
    await withProgram(program, async () => {
      const failure = await failureOf(() => convertVectorCad(Buffer.from(records.join('\r\n'), 'latin1'), 'igs', 'stl', {}, 'part.igs'));
      expect(failure).toBeInstanceOf(UnprocessableCadInputError);
      expect((failure as UnprocessableCadInputError).status).toBe(422);
      expect(failure.message).toBe('The IGES file is cut off or damaged: its Terminate line counts 1 Parameter Data records, but the file holds 0.');
    });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('answers 422 naming the triangle count and the limit for a mesh of more than 50,000 triangles written as IGES, and never starts the program', async () => {
    const { program, marker } = started();
    await withProgram(program, async () => {
      const failure = await failureOf(() => convertVectorCad(binaryStl(50_001), 'stl', 'iges', {}, 'big.stl'));
      expect(failure).toBeInstanceOf(UnprocessableCadInputError);
      expect(failure.message).toBe('The mesh has 50,001 triangles; the IGES file takes at most 50,000, because every triangle is a trimmed surface of its own.');
    });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('hands the program a mesh of exactly 50,000 triangles as its indexed triangle list', async () => {
    const dir = tmpDir('cad-mesh-');
    const copy = path.join(dir, 'mesh.bin');
    const program = standIn(`cp "$7" ${copy}\nprintf 'ISO-10303-21;' > "$8"`);
    await withProgram(program, async () => {
      const result = await convertVectorCad(binaryStl(50_000), 'stl', 'igs', {}, 'edge.stl');
      expect(result.filename).toBe('edge.igs');
      expect(result.mimeType).toBe('model/iges');
    });
    const mesh = fs.readFileSync(copy);
    const vertices = mesh.readUInt32LE(0);
    const triangles = mesh.readUInt32LE(4);
    expect(triangles).toBe(50_000);
    expect(mesh.length).toBe(8 + 24 * vertices + 12 * triangles);
    expect(mesh.readDoubleLE(8 + 24 * 1)).toBe(1);
  });
});

describe('an OBJ with colours comes as the ZIP of the OBJ and its material file', () => {
  /** A stand-in that writes an OBJ naming its material file, and the MTL beside it, as the real program does for a model with colours. */
  const withColours = (): string =>
    standIn(`stem="\${8%.obj}"\nprintf 'mtllib %s\\nv 0 0 0\\nv 1 0 0\\nv 0 1 0\\nusemtl mat_1\\nf 1 2 3\\n' "$(basename "$stem").mtl" > "$8"\nprintf 'newmtl mat_1\\nKd 1 0 0\\n' > "$stem.mtl"`);

  it('names the ZIP by the request and both files by the request name with unsafe characters replaced', async () => {
    await withProgram(withColours(), async () => {
      const result = await convertVectorCad(STEP_BYTES, 'step', 'obj', {}, 'Müller part (1).step');
      expect(result.mimeType).toBe('application/zip');
      expect(result.filename).toBe('Müller part (1).zip');
      expect(result.size).toBe(result.buffer.length);
      const zip = await JSZip.loadAsync(result.buffer);
      expect(Object.keys(zip.files).sort()).toEqual(['M_ller_part__1_.mtl', 'M_ller_part__1_.obj']);
      expect(await zip.files['M_ller_part__1_.obj'].async('string')).toContain('mtllib M_ller_part__1_.mtl\n');
      expect(await zip.files['M_ller_part__1_.mtl'].async('string')).toContain('Kd 1 0 0');
    });
  });

  it('keeps a hostile request name inside the scratch directory', async () => {
    await withProgram(withColours(), async () => {
      const result = await convertVectorCad(STEP_BYTES, 'step', 'obj', {}, '../../etc/passwd\u0000.step');
      const zip = await JSZip.loadAsync(result.buffer);
      for (const name of Object.keys(zip.files)) expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(Object.keys(zip.files).every((name) => !name.includes('/'))).toBe(true);
    });
  });
});

describe('a mesh the program cannot take is refused with a typed 422 before the program starts', () => {
  const TRIANGLE: IndexedMesh = { vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]] };
  const withFaces = (faces: ReadonlyArray<readonly [number, number, number]>): IndexedMesh => ({ vertices: TRIANGLE.vertices, faces });

  it('names a face index that is not an integer inside the vertex list', async () => {
    await withProgram('/nonexistent/cad-convert', async () => {
      for (const index of [5_000_000_000, 3, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const failure = await convertMeshToIgesWithOcct(withFaces([[0, 1, index]])).catch((error: unknown) => error);
        expect(failure, String(index)).toBeInstanceOf(UnprocessableCadInputError);
        expect((failure as Error).message, String(index)).toBe('The mesh holds a triangle that names a vertex it does not list.');
      }
    });
  });

  it('refuses a coordinate beyond the kernel\'s infinite value (2e100), however finite it is', async () => {
    await withProgram('/nonexistent/cad-convert', async () => {
      for (const value of [1e300, -2.5e100, Number.NaN]) {
        const failure = await convertMeshToIgesWithOcct({ vertices: [[0, 0, 0], [value, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]] }).catch((error: unknown) => error);
        expect(failure, String(value)).toBeInstanceOf(UnprocessableCadInputError);
        expect((failure as Error).message, String(value)).toBe("The mesh holds a coordinate that is not a number or is larger than 2e100 mm, the kernel's limit.");
      }
    });
  });

  it('refuses more than 150,000 vertices, listed or not', async () => {
    await withProgram('/nonexistent/cad-convert', async () => {
      const vertices = Array.from({ length: 150_001 }, (): readonly [number, number, number] => [0, 0, 0]);
      const failure = await convertMeshToIgesWithOcct({ vertices, faces: [[0, 1, 2]] }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(UnprocessableCadInputError);
      expect((failure as Error).message).toBe('The mesh lists 150,001 vertices; the IGES file takes at most 150,000.');
    });
  });
});
