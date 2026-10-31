import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DJVU_MAX_DIRECTORY_FILES, readDjvuContainer } from '../src/lib/conversions/djvu-container';
import {
  checkIncludeGraph,
  DJVU_MAX_INCLUDE_DEPTH,
  DJVU_MAX_INCLUDE_EDGES,
  DJVU_MAX_INCLUDE_LOADS,
} from '../src/lib/conversions/djvu-include-graph';
import { DJVUSED_DIRECTORY_SCRIPT, parseDjvusedDirectory, type DjvuDirectoryEntry } from '../src/lib/conversions/djvu-report';
import { bundledDocument, bundleOf, chunk, form, includeChunk, pageForm, type BundleEntry, type BundleFile } from './helpers/djvu-builder';
import { requireOracleTool } from './helpers/differential-oracle';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';
import { expectWithinHangGuard } from './helpers/timing';

/**
 * The include graph of a bundled document (src/lib/conversions/djvu-include-graph.ts), checked against the directory that
 * `djvused` of djvulibre reports for the same bytes, as the converter does. `poc_f(n)` is the document of the review of PR 935:
 * a chain of shared files that each include the next two, which `ddjvu` 3.5.28 draws in 0.5 s at n = 30 and in over a minute at
 * n = 40, from a file of 2,346 bytes.
 */

const DOGV = 'wc-dogv-12042005.djvu';
/** The files `djvused -e ls` lists for it: two shared dictionaries and 34 pages. */
const DOGV_DIRECTORY_FILES = 36;
const haveTools = !skipWithoutTools('djvused', 'bzz');
/** The loads of `ddjvu` 3.5.28 for `poc_f(n)` are the Fibonacci numbers: 2.1 million at 30. The test files are far below. */
const SHARED_BODY = chunk('Djbz', Buffer.alloc(4));
const HANG_GUARD_MS = 10_000;
const EXPECTED_LOCAL_MS = 200;
const FANOUT = 1000;

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

/** The directory `djvused` reports for `bytes`, read as the converter reads it. */
function directoryOf(bytes: Buffer): readonly DjvuDirectoryEntry[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djvu-graph-'));
  scratch.push(dir);
  const file = path.join(dir, 'document.djvu');
  fs.writeFileSync(file, bytes);
  return parseDjvusedDirectory(execFileSync(requireOracleTool('djvused'), ['-e', DJVUSED_DIRECTORY_SCRIPT, file], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })).entries;
}

function check(bytes: Buffer, directory: readonly DjvuDirectoryEntry[] = directoryOf(bytes)): void {
  const { bundle } = readDjvuContainer(bytes);
  if (bundle === null) throw new Error('the document is not a bundle');
  checkIncludeGraph(bytes, bundle, directory);
}

/** The number of files of the directory of a document the check accepts; a refusal throws. */
function acceptedFiles(bytes: Buffer, directory: readonly DjvuDirectoryEntry[] = directoryOf(bytes)): number {
  check(bytes, directory);
  return directory.length;
}

const refusalOf = (bytes: Buffer, directory?: readonly DjvuDirectoryEntry[]): Error => {
  try {
    check(bytes, directory);
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error('the document was not refused');
};

const include = (id: string, names: readonly string[] = []): BundleFile => ({ form: form('DJVI', [...names.map(includeChunk), SHARED_BODY]), kind: 'include', id });
const page = (id: string, names: readonly string[] = []): BundleFile => ({ form: pageForm(64, 64, names.map(includeChunk)), kind: 'page', id });

/** A page that includes `i0`, which includes `i1`, and so on for `levels` shared files. */
function chainOf(levels: number): BundleFile[] {
  const files = [page('page.djvu', levels > 0 ? ['i0'] : [])];
  for (let index = 0; index < levels; index++) files.push(include(`i${index}`, index + 1 < levels ? [`i${index + 1}`] : []));
  return files;
}

describe.skipIf(!haveTools)('the include graph of a bundle', () => {
  it('accepts the DOGV document, whose 34 pages include one of two dictionaries each: depth 1', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, DOGV);
    expect(acceptedFiles(bytes)).toBe(DOGV_DIRECTORY_FILES);
  });

  it.each([0, 1, 2, DJVU_MAX_INCLUDE_DEPTH])('accepts a chain of %i shared files below a page', (levels) => {
    expect(acceptedFiles(bundleOf(chainOf(levels)))).toBe(levels + 1);
  });

  it(`refuses a chain of ${DJVU_MAX_INCLUDE_DEPTH + 1} shared files, naming the depth`, () => {
    expect(refusalOf(bundleOf(chainOf(DJVU_MAX_INCLUDE_DEPTH + 1)))).toMatchObject({ name: 'DjvuIncludeGraphError', status: 422, message: expect.stringContaining('files deep') });
  });

  it('follows an include by the name of a file when its id is another, as the program looks a name up after the id', () => {
    const levels = DJVU_MAX_INCLUDE_DEPTH + 1;
    const files = [page('page.djvu', ['n0']), ...Array.from({ length: levels }, (_, index) => ({ ...include(`i${index}`, index + 1 < levels ? [`n${index + 1}`] : []), name: `n${index}` }))];
    expect(refusalOf(bundleOf(files))).toMatchObject({ name: 'DjvuIncludeGraphError', message: expect.stringContaining('files deep') });
  });

  it('refuses shared files that include each other, and one that includes itself', () => {
    const loop = [page('page.djvu', ['a']), include('a', ['b']), include('b', ['a'])];
    expect(refusalOf(bundleOf(loop))).toMatchObject({ name: 'DjvuIncludeGraphError', message: expect.stringContaining('cycle') });
    expect(refusalOf(bundleOf([page('page.djvu', ['a']), include('a', ['a'])]))).toMatchObject({ name: 'DjvuIncludeGraphError', message: expect.stringContaining('cycle') });
  });

  it('refuses the document of the review (n = 40) before the program is started, and every length of it past four levels', () => {
    for (const levels of [20, 40]) {
      const files = [page('page', ['i0'])];
      for (let index = 0; index < levels; index++) files.push(include(`i${index}`, [index + 1 < levels ? `i${index + 1}` : '', index + 2 < levels ? `i${index + 2}` : ''].filter(Boolean)));
      expect(refusalOf(bundleOf(files)), `n = ${levels}`).toMatchObject({ name: 'DjvuIncludeGraphError' });
    }
  });

  it(`refuses pages that would load more than ${DJVU_MAX_INCLUDE_LOADS} shared files within the depth, which a fan-out of ${FANOUT} makes of 2,003 files`, () => {
    const names = (prefix: string) => Array.from({ length: FANOUT }, (_, index) => `${prefix}${index}`);
    const files = [
      page('page', ['a']),
      include('a', names('b')),
      ...names('b').map((id) => include(id, ['c'])),
      include('c', names('d')),
      ...names('d').map((id) => include(id)),
    ];
    expect(refusalOf(bundleOf(files))).toMatchObject({ name: 'DjvuIncludeGraphError', message: expect.stringContaining('would load') });
  });

  it('accepts the same fan-out at a hundredth of the files: the refusal above is the count of loads, not the shape', () => {
    const names = (prefix: string) => Array.from({ length: FANOUT / 10 }, (_, index) => `${prefix}${index}`);
    const files = [page('page', ['a']), include('a', names('b')), ...names('b').map((id) => include(id, ['c'])), include('c', names('d')), ...names('d').map((id) => include(id))];
    expect(acceptedFiles(bundleOf(files))).toBe(files.length);
  });

  it('accepts a page that names a file the directory does not hold or names nothing at all, as the program loads nothing for it', () => {
    expect(acceptedFiles(bundleOf([page('page', ['missing.iff', '', 'a/b', '..:x', '\n\n'])]))).toBe(1);
  });

  it('reads the newlines at the ends of a name away, as the program does', () => {
    const files = chainOf(DJVU_MAX_INCLUDE_DEPTH + 1);
    files[0] = { ...files[0], form: pageForm(64, 64, [chunk('INCL', Buffer.from('\ni0\n'))]) };
    expect(refusalOf(bundleOf(files))).toMatchObject({ name: 'DjvuIncludeGraphError' });
  });

  it(`refuses more than ${DJVU_MAX_INCLUDE_EDGES} include chunks, counted while the chunks are read`, () => {
    const many = Array.from({ length: DJVU_MAX_INCLUDE_EDGES + 1 }, () => includeChunk('a'));
    const files = [{ form: pageForm(64, 64, many), kind: 'page' as const, id: 'page' }, include('a')];
    const started = process.hrtime.bigint();
    expect(refusalOf(bundleOf(files))).toMatchObject({ name: 'DjvuIncludeGraphError', message: expect.stringContaining('include chunks') });
    expectWithinHangGuard('the graph', Number(process.hrtime.bigint() - started) / 1e6, { guardMs: HANG_GUARD_MS, expectedLocalMs: EXPECTED_LOCAL_MS });
  });

  it('lays the files of the directory on the components without the thumbnails, which `djvused ls` does not list, and still sees what follows them', () => {
    const files = [page('page', ['i0']), { form: form('THUM', [chunk('TH44', Buffer.alloc(8))]), kind: 'thumbnails' as const, id: 'thumbs.iff' }, ...chainOf(DJVU_MAX_INCLUDE_DEPTH + 1).slice(1)];
    expect(refusalOf(bundleOf(files))).toMatchObject({ name: 'DjvuIncludeGraphError', message: expect.stringContaining('files deep') });
    const shallow = [page('page', ['i0']), { form: form('THUM', [chunk('TH44', Buffer.alloc(8))]), kind: 'thumbnails' as const, id: 'thumbs.iff' }, ...chainOf(1).slice(1)];
    expect(acceptedFiles(bundleOf(shallow))).toBe(2);
  });

  it('refuses a directory that flags a shared file as thumbnails, because the files of the directory and the components then disagree', () => {
    const files = [page('page', ['i0']), { ...include('i0'), kind: 'thumbnails' as const }];
    expect(refusalOf(bundleOf(files))).toMatchObject({ name: 'CorruptStreamError', message: expect.stringContaining('do not agree') });
  });

  it('reads a version 0 directory, whose flags and sizes the program converts, as it does a version 1 directory', () => {
    expect(acceptedFiles(bundleOf(chainOf(2), { version: 0 }))).toBe(3);
    expect(refusalOf(bundleOf(chainOf(DJVU_MAX_INCLUDE_DEPTH + 1), { version: 0 }))).toMatchObject({ name: 'DjvuIncludeGraphError' });
  });

  it('refuses an offset that points outside the bundle or into the middle of a component', () => {
    const files = chainOf(1);
    const directory = directoryOf(bundleOf(files));
    const outside = bundleOf(files, { offsets: (laidOut) => [laidOut[0], 1 << 30] });
    expect(refusalOf(outside, directory)).toMatchObject({ name: 'CorruptStreamError' });
    const inside = bundleOf(files, { offsets: (laidOut) => [laidOut[0], laidOut[1] + 8] });
    expect(refusalOf(inside, directory)).toMatchObject({ name: 'CorruptStreamError' });
  });

  it('reads a directory of 20,000 entries over one page of 32,000 chunks once, in time that does not grow with the entries', () => {
    const body = Array.from({ length: 1 << 15 }, () => chunk('ANTa', Buffer.alloc(24)));
    const big = pageForm(10, 10, [includeChunk('a'), ...body]);
    const entries = Array.from({ length: DJVU_MAX_DIRECTORY_FILES }, (_, index): BundleEntry => ({ component: 0, kind: 'page', id: `p${index}.djvu` }));
    const bytes = bundledDocument([big], entries);
    const directory = entries.map((entry): DjvuDirectoryEntry => ({ page: true, ids: [entry.id], names: [], titles: [] }));
    const started = process.hrtime.bigint();
    expect(acceptedFiles(bytes, directory)).toBe(DJVU_MAX_DIRECTORY_FILES);
    expectWithinHangGuard('the graph', Number(process.hrtime.bigint() - started) / 1e6, { guardMs: HANG_GUARD_MS, expectedLocalMs: EXPECTED_LOCAL_MS });
    expect(refusalOf(bytes, directory.slice(1))).toMatchObject({ name: 'CorruptStreamError', message: expect.stringContaining('do not agree') });
  });
});
