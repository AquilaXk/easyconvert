import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultResolver, EZDXF_PSEUDO_TOOL } from '../bench/tools';
import { completeDxfStructure, convertDwgToDwg, convertDxfToDwg, countDxfRecords } from '../src/lib/conversions/cad-dwg-writer';
import { convertVectorCad } from '../src/lib/conversions/vector-cad';
import { EngineUnavailableError, UnprocessableCadInputError } from '../src/lib/types';
import { getOracleToolPath } from './helpers/differential-oracle';
import { requireDwgSample } from './helpers/dwg-samples';
import { skipUnless } from './helpers/strict-skip';
import { runWithoutFileConfinement } from './helpers/unconfined-files';

// The stand-in programs of this suite write their records outside the job directory, which the file confinement refuses (policy 248).
runWithoutFileConfinement();

/**
 * Entry 471: a DXF and a DWG are written as an AutoCAD 2000 DWG by `dxf2dwg` of the pinned LibreDWG release, a separate sandboxed process. The
 * program exits with status 0 for a drawing it cannot encode and writes a file that has lost the entities, so the wrapper reads every DWG back
 * with the pinned reader and counts the records against those of the DXF that went in.
 *
 * The wrapper is tested with stand-in programs (a writer and a reader that fail in each way a real one can). The real programs are judged on
 * the public drawings pinned in bench/corpus/remote-manifest.json by an independent reader of DXF, ezdxf, which counts the entities of each type
 * and their coordinates in the drawing that went in and in the drawing read back from the DWG.
 */

const resolve = defaultResolver();
const python = resolve('python3');
const hasEzdxf = resolve(EZDXF_PSEUDO_TOOL) !== null;
const dwg2dxf = getOracleToolPath('dwg2dxf');
const dxf2dwg = getOracleToolPath('dxf2dwg');
const haveTools = !skipUnless('dwg2dxf, dxf2dwg, python3 and ezdxf', dwg2dxf !== null && dxf2dwg !== null && python !== null && hasEzdxf);

const scratch: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs `body` with the variable set to `value` (unset when undefined), then restores it. */
async function withEnv<T>(name: string, value: string | undefined, body: () => Promise<T>): Promise<T> {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
}

/** A shell script that stands in for a program: `body` runs with $1.. as its arguments. */
function standIn(name: string, body: string): string {
  const file = path.join(tmpDir('dwg-writer-standin-'), name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

/** The output file the wrapper asked for: the argument after -o. */
const OUTPUT_ARG = 'out=""; while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done';
const line = (code: number, value: string | number): string => `${String(code).padStart(3)}\n${value}\n`;
const lineEntity = (layer: string): string => `${line(0, 'LINE')}${line(8, layer)}${line(10, 0)}${line(20, 0)}${line(30, 0)}${line(11, 1)}${line(21, 1)}${line(31, 0)}`;
/** A DXF of generators that write only the entities. */
const ENTITIES_ONLY_DXF = `${line(0, 'SECTION')}${line(2, 'ENTITIES')}${lineEntity('WALLS')}${lineEntity('walls')}${lineEntity('0')}${line(0, 'ENDSEC')}${line(0, 'EOF')}`;
/** What a reader writes for the drawing above, with `lines` LINE records. */
const dxfWithLines = (lines: number): string => `${line(0, 'SECTION')}${line(2, 'ENTITIES')}${lineEntity('0').repeat(lines)}${line(0, 'ENDSEC')}${line(0, 'EOF')}`;
const WRITTEN = "printf 'AC1015\\000\\000\\000\\000\\000\\000\\000'";

function sectionLines(dxf: Buffer, name: string): string[] {
  const lines = dxf.toString('latin1').split('\n').map((text) => text.trimEnd());
  const start = lines.findIndex((text, index) => index % 2 === 0 && text.trim() === '0' && lines[index + 1].trim() === 'SECTION' && lines[index + 3].trim() === name);
  if (start < 0) return [];
  let end = start + 4;
  while (!(lines[end].trim() === '0' && lines[end + 1].trim() === 'ENDSEC')) end += 2;
  return lines.slice(start + 4, end);
}

/** The values of group `code` in a list of lines, in order. */
const valuesOf = (lines: string[], code: string): string[] => lines.flatMap((text, index) => (index % 2 === 0 && text.trim() === code ? [lines[index + 1].trim()] : []));

/** The names (group 2) of the records of the table of kind `kind` in the lines of a TABLES section. */
function tableNames(tables: string[], kind: string): string[] {
  const start = tables.findIndex((text, i) => i % 2 === 0 && text.trim() === '2' && tables[i + 1].trim() === kind && tables[i - 1]?.trim() === 'TABLE');
  const names: string[] = [];
  for (let i = start + 2; i + 1 < tables.length && tables[i + 1].trim() !== 'ENDTAB'; i += 2) if (tables[i].trim() === '2') names.push(tables[i + 1].trim());
  return names;
}

describe('the records of a DXF', () => {
  it('counts the entities and the entities of block definitions by type, and leaves the layout blocks out', () => {
    const dxf = [
      line(0, 'SECTION'), line(2, 'BLOCKS'),
      line(0, 'BLOCK'), line(8, '0'), line(2, '*Model_Space'), line(0, 'ENDBLK'),
      line(0, 'BLOCK'), line(8, '0'), line(2, 'BOLT'), lineEntity('0'), lineEntity('0'), line(0, 'ATTDEF'), line(2, 'TAG'), line(0, 'ENDBLK'),
      line(0, 'ENDSEC'),
      line(0, 'SECTION'), line(2, 'ENTITIES'), lineEntity('0'), line(0, 'CIRCLE'), line(0, 'ENDSEC'),
      line(0, 'EOF'),
    ].join('');
    expect([...countDxfRecords(Buffer.from(dxf))].sort()).toEqual([['B:ATTDEF', 1], ['B:LINE', 2], ['E:CIRCLE', 1], ['E:LINE', 1]]);
  });

  it('refuses bytes that are not pairs of a group code and a value, and a DXF with no ENTITIES section', () => {
    expect(() => countDxfRecords(Buffer.from('not a drawing\nat all\n'))).toThrow(/group code/);
    expect(() => countDxfRecords(Buffer.from(`${line(0, 'SECTION')}${line(2, 'HEADER')}${line(0, 'ENDSEC')}${line(0, 'EOF')}`))).toThrow(/ENTITIES/);
  });
});

describe('the structure a minimal DXF is completed with', () => {
  const complete = (text: string): Buffer => completeDxfStructure(Buffer.from(text, 'latin1'));

  it('returns a DXF that has the BLOCK_RECORD table and the layout blocks as it is', () => {
    const dxf = Buffer.from(
      [
        line(0, 'SECTION'), line(2, 'TABLES'), line(0, 'TABLE'), line(2, 'BLOCK_RECORD'), line(70, 2), line(0, 'BLOCK_RECORD'), line(2, '*Model_Space'), line(0, 'BLOCK_RECORD'), line(2, '*Paper_Space'), line(0, 'ENDTAB'), line(0, 'ENDSEC'),
        line(0, 'SECTION'), line(2, 'BLOCKS'), line(0, 'BLOCK'), line(8, '0'), line(2, '*Model_Space'), line(0, 'ENDBLK'), line(0, 'BLOCK'), line(8, '0'), line(2, '*paper_space'), line(0, 'ENDBLK'), line(0, 'ENDSEC'),
        line(0, 'SECTION'), line(2, 'ENTITIES'), lineEntity('0'), line(0, 'ENDSEC'), line(0, 'EOF'),
      ].join('')
    );
    expect(completeDxfStructure(dxf)).toBe(dxf);
  });

  it('adds the release, the layers the entities use, the block table and the layout blocks to a DXF of entities, and keeps the entities byte for byte', () => {
    const result = complete(ENTITIES_ONLY_DXF);
    const header = sectionLines(result, 'HEADER');
    expect(valuesOf(header, '1')).toEqual(['AC1015']);
    const tables = sectionLines(result, 'TABLES');
    // Layer names are compared without regard to case: WALLS and walls are one layer, spelled as first used.
    expect(tableNames(tables, 'LAYER')).toEqual(['0', 'WALLS']);
    expect(tableNames(tables, 'BLOCK_RECORD')).toEqual(['*Model_Space', '*Paper_Space']);
    expect(valuesOf(sectionLines(result, 'BLOCKS'), '2')).toEqual(['*Model_Space', '*Paper_Space']);
    expect(sectionLines(result, 'ENTITIES')).toEqual(sectionLines(Buffer.from(ENTITIES_ONLY_DXF), 'ENTITIES'));
    expect(countDxfRecords(result)).toEqual(countDxfRecords(Buffer.from(ENTITIES_ONLY_DXF)));
    expect(result.toString('latin1').endsWith(`${line(0, 'EOF')}`)).toBe(true);
  });

  it('raises a release before AutoCAD 2000 and keeps a later one, and does not declare a layer twice', () => {
    const declared = [
      line(0, 'SECTION'), line(2, 'HEADER'), line(9, '$ACADVER'), line(1, 'AC1009'), line(0, 'ENDSEC'),
      line(0, 'SECTION'), line(2, 'TABLES'), line(0, 'TABLE'), line(2, 'LAYER'), line(70, 1), line(0, 'LAYER'), line(2, 'Walls'), line(70, 0), line(0, 'ENDTAB'), line(0, 'ENDSEC'),
      line(0, 'SECTION'), line(2, 'ENTITIES'), lineEntity('WALLS'), line(0, 'ENDSEC'), line(0, 'EOF'),
    ].join('');
    const result = complete(declared);
    expect(valuesOf(sectionLines(result, 'HEADER'), '1')).toEqual(['AC1015']);
    expect(tableNames(sectionLines(result, 'TABLES'), 'LAYER')).toEqual(['Walls', '0']);
    const later = declared.replace('AC1009', 'AC1032');
    expect(valuesOf(sectionLines(complete(later), 'HEADER'), '1')).toEqual(['AC1032']);
  });

  it('lists the blocks of the drawing in the block table', () => {
    const blocks = [
      line(0, 'SECTION'), line(2, 'BLOCKS'), line(0, 'BLOCK'), line(8, '0'), line(2, 'BOLT'), line(0, 'ENDBLK'), line(0, 'ENDSEC'),
      line(0, 'SECTION'), line(2, 'ENTITIES'), lineEntity('0'), line(0, 'ENDSEC'), line(0, 'EOF'),
    ].join('');
    expect(tableNames(sectionLines(complete(blocks), 'TABLES'), 'BLOCK_RECORD')).toEqual(['*Model_Space', '*Paper_Space', 'BOLT']);
  });
});

describe('the wrapper around the writer, with stand-in programs', () => {
  const dxf = Buffer.from(dxfWithLines(3));
  const writer = (body: string): string => standIn('dxf2dwg', `${OUTPUT_ARG}\n${body}`);
  const reader = (lines: number): string => standIn('dwg2dxf', `${OUTPUT_ARG}\ncat > "$out" <<'DXF'\n${dxfWithLines(lines)}DXF`);
  const converted = (writerProgram: string | undefined, readerProgram: string | undefined, input: Buffer = dxf): Promise<Buffer> =>
    withEnv('DXF2DWG_PATH', writerProgram, () => withEnv('DWG2DXF_PATH', readerProgram, () => convertDxfToDwg(input, {})));
  const failureOf = async (run: Promise<unknown>): Promise<Error> => {
    try {
      await run;
    } catch (error) {
      return error as Error;
    }
    throw new Error('expected the conversion to fail');
  };

  it('returns the DWG when the reader finds every record of the DXF in it', async () => {
    const result = await converted(writer(`${WRITTEN} > "$out"`), reader(3));
    expect(result.subarray(0, 6).toString('latin1')).toBe('AC1015');
  });

  it('asks the writer for AutoCAD 2000 and tells it to overwrite its output', async () => {
    const record = path.join(tmpDir('dwg-writer-args-'), 'arguments');
    await converted(standIn('dxf2dwg', `echo "$@" > "${record}"\n${OUTPUT_ARG}\n${WRITTEN} > "$out"`), reader(3));
    expect(fs.readFileSync(record, 'utf8').trim()).toMatch(/^-y --as r2000 -o \S+output\.dwg \S+input\.dxf$/);
  });

  it('refuses a drawing that lost records in the DWG, with the count and no file', async () => {
    const failure = await failureOf(converted(writer(`${WRITTEN} > "$out"`), reader(1)));
    expect(failure).toBeInstanceOf(UnprocessableCadInputError);
    expect((failure as UnprocessableCadInputError).status).toBe(422);
    expect(failure.message).toMatch(/would lose part of this drawing \(2 LINE\)/);
  });

  it('refuses a written file that the reader cannot read back', async () => {
    const failure = await failureOf(converted(writer(`${WRITTEN} > "$out"`), standIn('dwg2dxf', 'echo "ERROR: cannot read" >&2; exit 1')));
    expect(failure).toBeInstanceOf(UnprocessableCadInputError);
    expect(failure.message).toMatch(/cannot read back/);
  });

  it('refuses a writer that fails, that writes nothing and that writes a file of another release, without its own words in the answer', async () => {
    const failed = await failureOf(converted(writer('echo "ERROR: Invalid handle /private/path" >&2; exit 2'), reader(3)));
    expect(failed).toBeInstanceOf(UnprocessableCadInputError);
    expect(failed.message).toMatch(/exited with status 2/);
    expect(failed.message).not.toContain('/private/path');
    for (const body of ['exit 0', "printf 'AC1032xxxxxxxx' > \"$out\""]) {
      const failure = await failureOf(converted(writer(body), reader(3)));
      expect(failure).toBeInstanceOf(UnprocessableCadInputError);
      expect(failure.message).toMatch(/wrote no drawing/);
    }
  });

  it('answers 503 with the name of the program when the writer is missing', async () => {
    const failure = await failureOf(converted('/nonexistent/dxf2dwg', reader(3)));
    expect(failure).toBeInstanceOf(EngineUnavailableError);
    expect((failure as EngineUnavailableError).engineName).toBe('dxf2dwg');
  });

  it('refuses a binary DXF and bytes that are no DXF before the writer starts', async () => {
    const marker = path.join(tmpDir('dwg-writer-marker-'), 'started');
    const program = writer(`touch ${marker}`);
    for (const input of [Buffer.concat([Buffer.from('AutoCAD Binary DXF\r\n\x1a\0'), Buffer.alloc(40)]), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')]) {
      const failure = await failureOf(converted(program, reader(3), input));
      expect(failure).toBeInstanceOf(UnprocessableCadInputError);
    }
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('writes a DWG as a DWG through the reader and the writer, and saves a newer release as AutoCAD 2000', async () => {
    const source = Buffer.concat([Buffer.from('AC1018'), Buffer.alloc(200, 1)]);
    const result = await withEnv('DXF2DWG_PATH', writer(`${WRITTEN} > "$out"`), () => withEnv('DWG2DXF_PATH', reader(3), () => convertDwgToDwg(source, {})));
    expect(result.subarray(0, 6).toString('latin1')).toBe('AC1015');
  });
});

/** ezdxf's view of a drawing: entities by type (layouts and the blocks that are not layouts), the layers and the geometry of the common entities. */
const EZDXF_FACTS = `
import sys, json, collections, ezdxf
from ezdxf import recover
def load(path):
    try:
        return ezdxf.readfile(path)
    except Exception:
        return recover.readfile(path)[0]
def r(values):
    return [round(float(v), 5) for v in values]
def geometry(e):
    t, d = e.dxftype(), e.dxf
    if t == 'LINE': return [t, r(d.start), r(d.end)]
    if t == 'CIRCLE': return [t, r(d.center), r([d.radius])]
    if t == 'ARC': return [t, r(d.center), r([d.radius, d.start_angle, d.end_angle])]
    if t == 'TEXT': return [t, r(d.insert), d.text.strip()]
    if t == 'LWPOLYLINE': return [t, [r(p[:2]) for p in e.get_points()], bool(e.closed)]
    if t == 'POINT': return [t, r(d.location)]
    if t == 'INSERT': return [t, d.name, r(d.insert)]
    return [t]
doc = load(sys.argv[1])
counts, shapes = collections.Counter(), collections.Counter()
for layout in doc.layouts:
    for e in layout:
        counts[e.dxftype()] += 1
        shapes[json.dumps(geometry(e))] += 1
for block in doc.blocks:
    if block.name.startswith('*'):
        continue
    for e in block:
        counts['block:' + e.dxftype()] += 1
print(json.dumps({'counts': counts, 'shapes': shapes, 'layers': sorted(l.dxf.name for l in doc.layers)}))
`;

interface Facts {
  counts: Record<string, number>;
  shapes: Record<string, number>;
  layers: string[];
}

function factsOf(dxf: string): Facts {
  const result = spawnSync(python as string, ['-c', EZDXF_FACTS, dxf], { cwd: tmpDir('dwg-writer-cwd-'), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`ezdxf could not read ${dxf}: ${result.stderr.slice(-500)}`);
  return JSON.parse(result.stdout) as Facts;
}

/** The DXF the pinned reader writes of a DWG, read directly and not through the product. */
function readerDxf(dwg: Buffer): string {
  const dir = tmpDir('dwg-writer-read-');
  fs.writeFileSync(path.join(dir, 'drawing.dwg'), dwg);
  const result = spawnSync(dwg2dxf as string, ['-y', '-o', path.join(dir, 'drawing.dxf'), path.join(dir, 'drawing.dwg')], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`dwg2dxf failed: ${result.stderr.slice(-500)}`);
  return path.join(dir, 'drawing.dxf');
}

function fileOf(bytes: Buffer, name: string): string {
  const file = path.join(tmpDir('dwg-writer-in-'), name);
  fs.writeFileSync(file, bytes);
  return file;
}

/** Public drawings, every entity of which is in the DWG that is written: AutoCAD, BricsCAD, LibreCAD, OpenSCAD and ezdxf files in four AutoCAD releases. */
const PRESERVED_DXF = [
  'cad-circles-ellipses-arcs.dxf',
  'cad-columns-r2007.dxf',
  'cad-elliptical-arcs.dxf',
  'cad-entities.dxf',
  'cad-floorplan.dxf',
  'cad-insert-bricscad.dxf',
  'cad-lines.dxf',
  'cad-lwpolylines.dxf',
  'cad-polylines.dxf',
  'cad-splines.dxf',
  'cad-text-alignments.dxf',
  'cad-text-fonts.dxf',
] as const;
/** Drawings that have no block table: the structure is completed, and every entity and layer is in the DWG that is written. */
const COMPLETED_DXF = ['cad-openscad-export.dxf'] as const;
const PUBLIC_DWG = [
  'dwg-example-r13.dwg',
  'dwg-example-r14.dwg',
  'dwg-example-2000.dwg',
  'dwg-example-2004.dwg',
  'dwg-example-2007.dwg',
  'dwg-example-2010.dwg',
  'dwg-example-2013.dwg',
  'dwg-example-2018.dwg',
  'dwg-gdal-circles-2000.dwg',
  'dwg-gdal-ellipse-2000.dwg',
  'dwg-gdal-attribs-2013.dwg',
] as const;
const WRITE_TIMEOUT_MS = 120_000;

describe.skipIf(!haveTools)('public drawings written as DWG by the pinned writer and read back by independent programs', () => {
  for (const id of [...PRESERVED_DXF, ...COMPLETED_DXF]) {
    it(`${id} keeps every entity, its coordinates and its layers`, { timeout: WRITE_TIMEOUT_MS }, async (ctx) => {
      const source = await requireDwgSample(ctx, id);
      const result = await convertVectorCad(source, 'dxf', 'dwg', {}, id);
      expect(result.mimeType).toBe('image/vnd.dwg');
      expect(result.filename).toBe(id.replace(/\.dxf$/, '.dwg'));
      expect(result.buffer.subarray(0, 6).toString('latin1')).toBe('AC1015');
      const before = factsOf(fileOf(source, id));
      const after = factsOf(readerDxf(result.buffer));
      expect(after.counts).toEqual(before.counts);
      expect(after.shapes).toEqual(before.shapes);
      const layers = new Set(after.layers.map((name) => name.toLowerCase()));
      for (const name of before.layers) expect(layers.has(name.toLowerCase()), `layer ${name}`).toBe(true);
    });
  }

  it('completes the plate of the benchmark that has only the entity records, with its five layers', { timeout: WRITE_TIMEOUT_MS }, async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'bench', 'corpus', 'cad', 'plate-basic.dxf'));
    const result = await convertVectorCad(source, 'dxf', 'dwg', {}, 'plate-basic.dxf');
    const after = factsOf(readerDxf(result.buffer));
    expect(after.counts).toEqual({ LINE: 8, ARC: 6, CIRCLE: 4, LWPOLYLINE: 2, TEXT: 2 });
    expect(after.layers).toEqual(expect.arrayContaining(['OUTLINE', 'HOLES', 'CENTER', 'DETAIL', 'ANNOTATION']));
  });

  for (const id of PUBLIC_DWG) {
    it(`${id} is written as an AutoCAD 2000 DWG with every entity of the drawing the reader read from it`, { timeout: WRITE_TIMEOUT_MS }, async (ctx) => {
      const source = await requireDwgSample(ctx, id);
      const result = await convertVectorCad(source, 'dwg', 'dwg', {}, id);
      expect(result.mimeType).toBe('image/vnd.dwg');
      expect(result.buffer.subarray(0, 6).toString('latin1')).toBe('AC1015');
      const before = readerDxf(source);
      const after = readerDxf(result.buffer);
      // The records of the entity section and of the blocks, by type, counted from the two files without the wrapper's reading of them.
      expect(countDxfRecords(fs.readFileSync(after))).toEqual(countDxfRecords(fs.readFileSync(before)));
      // ezdxf adds the standard arrowhead blocks of a drawing with dimensions to the blocks it loads, which differs between releases: the entities of the layouts are compared.
      const layouts = (counts: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(counts).filter(([type]) => !type.startsWith('block:')));
      const factsBefore = factsOf(before);
      const factsAfter = factsOf(after);
      expect(layouts(factsAfter.counts)).toEqual(layouts(factsBefore.counts));
      expect(factsAfter.shapes).toEqual(factsBefore.shapes);
    });
  }

  it('refuses the drawing whose block definitions the writer drops, and the plate with a block that has no block record', { timeout: WRITE_TIMEOUT_MS }, async (ctx) => {
    const blocks = await requireDwgSample(ctx, 'cad-blocks.dxf');
    const plate = fs.readFileSync(path.join(__dirname, '..', 'bench', 'corpus', 'cad', 'plate-full.dxf'));
    for (const [source, name] of [[blocks, 'cad-blocks.dxf'], [plate, 'plate-full.dxf']] as const) {
      const failure = await convertVectorCad(source, 'dxf', 'dwg', {}, name).then(
        () => null,
        (error: unknown) => error as UnprocessableCadInputError
      );
      expect(failure, name).toBeInstanceOf(UnprocessableCadInputError);
      expect(failure?.status).toBe(422);
      expect(failure?.message).toMatch(/would lose part of this drawing \(.*in blocks/);
    }
  });
});
