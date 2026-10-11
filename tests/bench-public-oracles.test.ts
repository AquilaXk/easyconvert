import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { truthWordsOf, wordRecallOf } from '../bench/families/document-public';
import { sourceText } from '../bench/office-words';
import { ReferenceServer } from '../bench/reference-server';
import { defaultResolver, EZDXF_PSEUDO_TOOL, OLEFILE_PSEUDO_TOOL, XLRD_PSEUDO_TOOL } from '../bench/tools';
import { skipUnless } from './helpers/strict-skip';

/**
 * The independent readers behind the public-sample rows, checked against files that are not the product's: the text of the
 * 97-2003 formats (olefile, xlrd) against the OOXML source the office suite saved them from, and the strokes that ezdxf reads from
 * a DXF against the geometry the generator of the committed drawing wrote down. Each needs its library and, for the formats, the
 * office suite; under ORACLE_STRICT_MODE=1 a missing one fails the suite instead of skipping it.
 */

const resolve = defaultResolver();
const python = resolve('python3');
const soffice = resolve('soffice');
const hasOle = resolve(OLEFILE_PSEUDO_TOOL) !== null;
const hasXlrd = resolve(XLRD_PSEUDO_TOOL) !== null;
const hasEzdxf = resolve(EZDXF_PSEUDO_TOOL) !== null;
const FIXTURES = path.join(__dirname, 'fixtures');
const none = { server: (): never => { throw new Error('no server needed'); } };
/** Share of the truth words a reader must recover from a file the office suite wrote: the suite may drop a style-only word, never most of the text. */
const MIN_RECALL = 0.95;

function convertWithSuite(work: string, input: string, target: string): string {
  const run = spawnSync(soffice as string, [`-env:UserInstallation=file://${path.join(work, 'profile')}`, '--headless', '--convert-to', target, '--outdir', work, input], { encoding: 'utf8', timeout: 180_000 });
  if (run.status !== 0) throw new Error(`soffice failed: ${run.stderr}`);
  return path.join(work, `${path.parse(input).name}.${target}`);
}

describe.skipIf(skipUnless('python3, olefile, xlrd and soffice', python !== null && hasOle && hasXlrd && soffice !== null))('the text of the 97-2003 formats', () => {
  let work: string;
  let server: ReferenceServer;
  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'public-oracles-'));
    server = ReferenceServer.start(python as string);
  });
  afterAll(async () => {
    await server.close();
    fs.rmSync(work, { recursive: true, force: true });
  });
  const readers = { server: () => server };

  it.each([
    ['sample.docx', 'doc'],
    ['golden/office/multi-sheet-enterprise.xlsx', 'xls'],
    ['golden/office/drawingml-shapes-presentation.pptx', 'ppt'],
  ])('reads %s saved as .%s with the words of the source package', async (fixture, target) => {
    const source = path.join(FIXTURES, fixture);
    const expected = truthWordsOf(await sourceText(path.extname(fixture).slice(1), source, none));
    expect(expected.length).toBeGreaterThan(5);
    const legacy = convertWithSuite(work, source, target);
    const found = await sourceText(target, legacy, readers);
    expect(wordRecallOf(expected, found), `${target} recall`).toBeGreaterThanOrEqual(MIN_RECALL);
  });

  it('refuses a file that is no Word binary', async () => {
    const bogus = path.join(work, 'bogus.doc');
    fs.writeFileSync(bogus, 'not an OLE file');
    await expect(sourceText('doc', bogus, readers)).rejects.toThrow(/office\.text/);
  });
});

describe.skipIf(skipUnless('python3 and ezdxf', python !== null && hasEzdxf))('the strokes of a DXF drawing', () => {
  let server: ReferenceServer;
  beforeAll(() => {
    server = ReferenceServer.start(python as string);
  });
  afterAll(async () => {
    await server.close();
  });

  it('read the strokes, the text and the visibility of a hand-written R12 drawing', async () => {
    interface Truth {
      strokes: Array<Array<[number, number]>>;
      textBoxes: number[][];
      words: string[];
    }
    const dxf = [
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'LINE', '8', '0', '10', '0.0', '20', '0.0', '30', '0.0', '11', '10.0', '21', '0.0', '31', '0.0',
      '0', 'CIRCLE', '8', '0', '10', '5.0', '20', '5.0', '30', '0.0', '40', '2.0',
      '0', 'TEXT', '8', '0', '10', '1.0', '20', '8.0', '30', '0.0', '40', '1.0', '1', 'HELLO WORLD',
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-oracles-dxf-'));
    try {
      const file = path.join(dir, 'drawing.dxf');
      fs.writeFileSync(file, `${dxf}\n`);
      const truth = await server.call<Truth>('cad.truth', { file });
      const points = truth.strokes.flat();
      const edges = [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1])), Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))];
      expect(edges[0]).toBeCloseTo(0, 6);
      expect(edges[1]).toBeCloseTo(0, 6);
      expect(edges[2]).toBeCloseTo(10, 6);
      expect(edges[3]).toBeCloseTo(7, 2);
      expect(truth.strokes).toHaveLength(2);
      expect(truth.words).toEqual(['HELLO', 'WORLD']);
      expect(truth.textBoxes).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(skipUnless('python3', python !== null))('the cell truth of JSON arrays', () => {
  let work: string;
  let server: ReferenceServer;
  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'public-oracles-data-'));
    server = ReferenceServer.start(python as string);
  });
  afterAll(async () => {
    await server.close();
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('keeps the order of the keys of the file, fills a missing key with an empty cell, and compares a CSV output cell by cell', async () => {
    const json = path.join(work, 'records.json');
    fs.writeFileSync(json, '[{"2020": 1, "b": "x", "a": null}, {"2020": 2, "c": true}]');
    const good = path.join(work, 'good.csv');
    fs.writeFileSync(good, '2020,b,a,c\n1,x,,\n2,,,true\n');
    const reordered = path.join(work, 'reordered.csv');
    fs.writeFileSync(reordered, 'a,b,c,2020\n,x,,1\n,,true,2\n');
    interface Check {
      readers: Record<string, { cells: number; mismatches: number }>;
    }
    const truth = { kind: 'json', file: json };
    const same = await server.call<Check>('data.check', { kind: 'csv', file: good, truth });
    expect(same.readers.csv).toMatchObject({ cells: 8, mismatches: 0 });
    const moved = await server.call<Check>('data.check', { kind: 'csv', file: reordered, truth });
    // A header that differs costs the width (4), and the cells are compared by position: 2 in the first row, 3 in the second.
    expect(moved.readers.csv.mismatches).toBe(9);
  });
});
