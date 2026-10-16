import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getAllFormats } from '../src/lib/registry';
import {
  collectRealSamples,
  coverageOf,
  EXCEPTIONS_SCHEMA,
  MIN_REAL_SAMPLES,
  readExceptions,
  remoteFormatOf,
  violationOf,
  type CoverageExceptions,
  type FormatCoverage,
  type RealSample,
} from '../bench/realworld/format-coverage';
import { curatedEntries, readManifest } from '../bench/realworld/manifest';

/**
 * Every format the registry accepts as an input has real sample files in the corpus manifests (QA decision 2026-10-16,
 * #780). The expectations come from the manifests, never from the code under test: a sample is a file pinned by SHA-256 in
 * `bench/corpus/remote-manifest.json`, `bench/realworld/manifest.json` or `tests/fixtures/raw/*.json`. A format that has no
 * public sample with a usable licence is listed in `bench/realworld/format-coverage-exceptions.json` with the reason.
 */

const FORMATS = getAllFormats().map((def) => def.id);
const KNOWN = new Set(FORMATS);
const SAMPLES = collectRealSamples(KNOWN);
const ROWS = coverageOf(FORMATS, SAMPLES);
const EXCEPTIONS = readExceptions();
const MIN_REASON_CHARS = 40;
const REALWORLD_DIR = path.join(__dirname, '..', 'bench', 'realworld');

const none: CoverageExceptions = { schema: EXCEPTIONS_SCHEMA, formats: {} };
const sample = (format: string, producer: string): RealSample => ({ format, producer, manifest: 'realworld' });

describe('format coverage rule', () => {
  it('counts samples and distinct producers per format', () => {
    const rows = coverageOf(['a', 'b', 'c'], [sample('a', 'p1'), sample('a', 'p1'), sample('a', 'p2'), sample('b', 'p1')]);
    expect(rows).toEqual([
      { format: 'a', samples: 3, producers: 2 },
      { format: 'b', samples: 1, producers: 1 },
      { format: 'c', samples: 0, producers: 0 },
    ]);
  });

  it('flags too few samples unless a reason is recorded', () => {
    const thin: FormatCoverage = { format: 'x', samples: MIN_REAL_SAMPLES - 1, producers: 2 };
    const enough: FormatCoverage = { format: 'z', samples: MIN_REAL_SAMPLES, producers: 1 };
    expect(violationOf(thin, none)).toMatch(/no recorded reason/);
    expect(violationOf(enough, none)).toBeNull();
    expect(violationOf(thin, { ...none, formats: { x: { reason: 'r', searched: ['s'] } } })).toBeNull();
  });

  it('reads the registry format of a remote sample from its declared format, else from the longest known suffix', () => {
    const known = new Set(['gz', 'tar', 'tar.gz', 'png']);
    expect(remoteFormatOf({ id: 'a.tar.gz', set: 's' }, known)).toBe('tar.gz');
    expect(remoteFormatOf({ id: 'kodim01.png', set: 's' }, known)).toBe('png');
    expect(remoteFormatOf({ id: 'a.png', set: 's', meta: { format: 'gz' } }, known)).toBe('gz');
    expect(remoteFormatOf({ id: 'a.y4m', set: 's' }, known)).toBeNull();
    expect(remoteFormatOf({ id: 'silesia-xml', set: 's' }, known)).toBeNull();
  });
});

describe('manifest rebuild', () => {
  it('keeps the hand-picked sources and files and replaces the generated ones', () => {
    const manifest = readManifest();
    const generated = new Set(['govdocs1', 'office-test-data']);
    const curated = curatedEntries(manifest, generated);
    expect(curated.sources.map((source) => source.id)).not.toContain('govdocs1');
    expect(curated.sources.length).toBe(manifest.sources.length - generated.size);
    expect(curated.files.some((file) => generated.has(file.source))).toBe(false);
    expect(curated.files.length).toBe(manifest.files.filter((file) => !generated.has(file.source)).length);
    expect(curated.files.length).toBeGreaterThan(0);
  });
});

describe('corpus format coverage', () => {
  it('gives every registry format at least the required real samples, or a recorded reason', () => {
    const violations = ROWS.map((row) => violationOf(row, EXCEPTIONS)).filter((message): message is string => message !== null);
    expect(violations).toEqual([]);
  });

  it('keeps no stale or empty reason', () => {
    const byFormat = new Map(ROWS.map((row) => [row.format, row]));
    const stale: string[] = [];
    for (const [format, entry] of Object.entries(EXCEPTIONS.formats)) {
      const row = byFormat.get(format);
      if (row === undefined) stale.push(`${format}: not a registry format`);
      else if (row.samples >= MIN_REAL_SAMPLES) stale.push(`${format}: has ${row.samples} samples, remove its reason`);
      if (entry.reason.trim().length < MIN_REASON_CHARS || entry.searched.length === 0) stale.push(`${format}: needs a concrete reason and the sources searched`);
    }
    expect(stale).toEqual([]);
  });

  it('names a registry format on every real-world sample, so none is silently left uncounted', () => {
    const unknown = readManifest().files.filter((file) => !KNOWN.has(file.format)).map((file) => `${file.id}: ${file.format}`);
    expect(unknown).toEqual([]);
  });

  it('records the licence of every per-file licence code in the provenance notes', () => {
    const provenance = fs.readFileSync(path.join(REALWORLD_DIR, 'PROVENANCE.md'), 'utf8');
    const codes = new Set(readManifest().files.flatMap((file) => (file.licence === undefined ? [] : [file.licence])));
    const missing = [...codes].filter((code) => !provenance.includes(`\`${code}\``));
    expect(missing).toEqual([]);
  });

  it('gives every new-set source a licence statement and a provenance section', () => {
    const provenance = fs.readFileSync(path.join(REALWORLD_DIR, 'PROVENANCE.md'), 'utf8');
    const missing = readManifest().sources.filter((source) => !provenance.includes(`\`${source.id}\``)).map((source) => source.id);
    expect(missing).toEqual([]);
  });
});
