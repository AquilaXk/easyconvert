import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getAllFormats, isFormatCompatibleWithMagicBytes } from '../src/lib/registry';
import {
  collectRealSamples,
  coverageOf,
  EXCEPTIONS_SCHEMA,
  FORMAT_ALIASES,
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

/** The first bytes of a file of each canonical format, from the format's own specification (not from the registry). */
const SIGNATURES: Readonly<Record<string, Buffer>> = {
  jpg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]),
  djvu: Buffer.concat([Buffer.from('AT&TFORM', 'latin1'), Buffer.from([0, 0, 0, 0x20]), Buffer.from('DJVM', 'latin1')]),
  'tar.bz2': Buffer.concat([Buffer.from('BZh9', 'latin1'), Buffer.from([0x31, 0x41, 0x59, 0x26, 0x53, 0x59])]),
  'tar.z': Buffer.from([0x1f, 0x9d, 0x90, 0x00, 0x00]),
  mid: Buffer.concat([Buffer.from('MThd', 'latin1'), Buffer.from([0, 0, 0, 6, 0, 1, 0, 2, 0x01, 0xe0])]),
  zst: Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00]),
  jsonl: Buffer.from('{"a":1}\n{"a":2}\n', 'utf8'),
  tex: Buffer.from('\\documentclass{article}\n\\begin{document}x\\end{document}\n', 'utf8'),
  html: Buffer.from('<!DOCTYPE html><html><body>x</body></html>', 'utf8'),
  mpg: Buffer.from([0x00, 0x00, 0x01, 0xba, 0x44, 0x00, 0x04, 0x00, 0x04, 0x01, 0x89, 0xc3, 0xf8]),
  '3gp': Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftyp3gp4', 'latin1'), Buffer.from([0, 0, 0, 0]), Buffer.from('3gp4', 'latin1')]),
  webm: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from('webm', 'latin1')]),
  txt: Buffer.from('plain text\n', 'utf8'),
  m2ts: Buffer.from([0x00, 0x00, 0x00, 0x00, 0x47, 0x40, 0x00, 0x10]),
};

describe('extension aliases', () => {
  it('counts the samples of the canonical format beside the alias own', () => {
    const rows = coverageOf(['mid', 'midi', 'wav'], [sample('mid', 'p1'), sample('mid', 'p2'), sample('midi', 'p3'), sample('wav', 'p1')], { midi: 'mid' });
    expect(rows).toEqual([
      { format: 'mid', samples: 2, producers: 2 },
      { format: 'midi', samples: 3, producers: 3, via: 'mid' },
      { format: 'wav', samples: 1, producers: 1 },
    ]);
  });

  it('names registry formats on both sides, with no chain and no alias of itself', () => {
    const problems = Object.entries(FORMAT_ALIASES).flatMap(([alias, canonical]) => {
      const found: string[] = [];
      if (!KNOWN.has(alias)) found.push(`${alias}: not a registry format`);
      if (!KNOWN.has(canonical)) found.push(`${canonical}: not a registry format`);
      if (alias === canonical) found.push(`${alias}: an alias of itself`);
      if (FORMAT_ALIASES[canonical] !== undefined) found.push(`${alias}: ${canonical} is an alias too`);
      return found;
    });
    expect(problems).toEqual([]);
  });

  it('has a specification signature for every canonical format and the registry accepts it under the alias extension', () => {
    const rejected = Object.entries(FORMAT_ALIASES).flatMap(([alias, canonical]) => {
      const signature = SIGNATURES[canonical];
      if (signature === undefined) return [`${canonical}: no signature in this test`];
      const found: string[] = [];
      if (!isFormatCompatibleWithMagicBytes(signature, canonical)) found.push(`${canonical}: the registry rejects its own signature`);
      if (!isFormatCompatibleWithMagicBytes(signature, alias)) found.push(`${alias}: the registry rejects the signature of ${canonical}`);
      return found;
    });
    expect(rejected).toEqual([]);
  });

  it('counts every alias through its canonical format in the report rows', () => {
    const viaOf = new Map(ROWS.map((row) => [row.format, row.via]));
    for (const [alias, canonical] of Object.entries(FORMAT_ALIASES)) expect(viaOf.get(alias)).toBe(canonical);
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
