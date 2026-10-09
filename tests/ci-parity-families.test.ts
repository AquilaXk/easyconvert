import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUICK_SUBSET } from '../bench/config';
import { FAMILIES } from '../bench/report';
import { FAMILY_RUNNERS } from '../bench/families';
import {
  ALL_FAMILIES,
  classifyPaths,
  FamilyMapError,
  loadFamilyMap,
  MAX_CHANGED_PATHS,
  MAX_PATH_LENGTH,
  validateFamilyMap,
} from '../scripts/ci-parity-families.mjs';

/**
 * Which changed paths the reference-parity gate measures. The expected classification of each sample path is written
 * out here by hand; the completeness check walks the real source tree, so a new conversion file that no rule covers
 * fails this test before it can slip past the gate.
 */

const ROOT = path.resolve(__dirname, '..');
const MAP = loadFamilyMap();
const classify = (...paths: string[]): ReturnType<typeof classifyPaths> => classifyPaths(paths, MAP);
const BENCH_FAMILIES: readonly string[] = ['image', 'video', 'audio', 'ocr', 'document', 'compression'];
const benchEntries = Object.fromEntries(BENCH_FAMILIES.map((name) => [name, { bench: name }]));

describe('the map', () => {
  it('covers exactly the conversion code: the library engines, the worker engines and the worker pool', () => {
    expect(MAP.scope.test('src/lib/conversions/image.ts')).toBe(true);
    expect(MAP.scope.test('src/worker/sandbox.ts')).toBe(true);
    expect(MAP.scope.test('src/lib/workers/cpu-pool.ts')).toBe(true);
    for (const outside of ['src/app/api/convert/route.ts', 'src/components/Upload.tsx', 'src/lib/registry.ts', 'src/lib/security/process-sandbox.ts', 'bench/run.ts', 'tests/x.test.ts', 'docs/a.md']) {
      expect(MAP.scope.test(outside), outside).toBe(false);
    }
  });

  it('benchmarks exactly the families the harness measures, in the harness order', () => {
    expect([...MAP.benchmarked]).toEqual([...FAMILIES]);
    expect(MAP.benchmarked).toEqual(BENCH_FAMILIES);
    expect(Object.keys(FAMILY_RUNNERS).sort()).toEqual([...BENCH_FAMILIES].sort());
    for (const family of FAMILIES) expect(MAP.families.get(family)).toBe(family);
  });

  it('lists the conversion families that still have no reference-compared rows', () => {
    const unbenchmarked = [...MAP.families].filter(([, bench]) => bench === null).map(([name]) => name).sort();
    expect(unbenchmarked).toEqual(['cad', 'data', 'ebook', 'font', 'hdr-image', 'pdf-ops', 'raw', 'vector']);
  });

  it('has a quick subset for every family, and every named case exists in the recorded baseline', () => {
    expect(Object.keys(QUICK_SUBSET).sort()).toEqual([...BENCH_FAMILIES].sort());
    const baseline = JSON.parse(readFileSync(path.join(ROOT, 'bench', 'baseline.json'), 'utf8')) as { entries: Record<string, unknown> };
    const cases = new Set(Object.keys(baseline.entries).map((id) => id.split('/').slice(0, 2).join('/')));
    for (const [family, subset] of Object.entries(QUICK_SUBSET)) {
      for (const caseName of subset ?? []) expect(cases.has(`${family}/${caseName}`), `${family}/${caseName}`).toBe(true);
    }
  });
});

describe('every file of the conversion code is classified', () => {
  function walk(dir: string): string[] {
    return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      const relative = `${dir}/${entry.name}`;
      return entry.isDirectory() ? walk(relative) : [relative];
    });
  }
  const files = ['src/lib/conversions', 'src/worker', 'src/lib/workers'].flatMap(walk);

  it('leaves no file in the scope without a rule, so a new conversion file cannot escape the gate', () => {
    expect(files.length).toBeGreaterThan(200);
    // The scope reaches every one of them, so an empty `unclassified` below is a verdict, not a missed path.
    expect(files.filter((file) => !MAP.scope.test(file))).toEqual([]);
    expect(classify(...files).unclassified).toEqual([]);
  });

  it('gives every benchmarked family at least one file, and every unbenchmarked one too', () => {
    for (const family of MAP.families.keys()) {
      const hit = files.some((file) => {
        const result = classify(file);
        return result.benchmarked.includes(family) || result.unmapped.includes(family);
      });
      expect(hit, family).toBe(true);
    }
  });
});

describe('classifying changed paths', () => {
  it.each<[string, string, string[], string[]]>([
    ['an image engine file', 'src/lib/conversions/image-resample.ts', ['image'], []],
    ['the AVIF colour code', 'src/lib/conversions/avif-colour.ts', ['image'], []],
    ['the zstd encoder', 'src/lib/conversions/zstd-encoder.ts', ['compression'], []],
    ['the LZMA decoder', 'src/lib/conversions/lzma-decoder.ts', ['compression'], []],
    ['the 7z reader', 'src/lib/conversions/sevenzip-reader.ts', ['compression'], []],
    ['the FLAC encoder', 'src/lib/conversions/flac-encoder.ts', ['audio'], []],
    ['an audio quality file', 'src/lib/conversions/media-audio-quality.ts', ['audio'], []],
    ['the video encoder', 'src/lib/conversions/media-encoder.ts', ['video'], []],
    ['a file shared by audio and video', 'src/lib/conversions/media-ffprobe.ts', ['video', 'audio'], []],
    ['an OCR engine file', 'src/lib/conversions/ocr-text-layer.ts', ['ocr'], []],
    ['an OCR calibration table', 'src/lib/conversions/ocr-calibration/eng.cli.json', ['ocr'], []],
    ['the office pipeline', 'src/lib/conversions/office.ts', ['document'], []],
    ['a legacy office reader', 'src/lib/conversions/office/doc-reader.ts', ['document'], []],
    ['the LibreOffice pool', 'src/worker/libreoffice-pool.ts', ['document'], []],
    ['the document model', 'src/lib/conversions/document-model/build.ts', ['document'], []],
    ['the document model for DOCX', 'src/lib/conversions/document-model/docx.ts', ['document'], []],
    ['the DOCX numbering reader', 'src/lib/conversions/docx-numbering.ts', ['document'], []],
    ['the EPUB reader', 'src/lib/conversions/epub-reader.ts', ['document'], []],
    ['the package reader the document formats share', 'src/lib/conversions/package-access.ts', ['document'], []],
    ['the PDF text layout analysis', 'src/lib/conversions/pdf-layout/columns.ts', ['document'], []],
    ['the PDF text reader', 'src/lib/conversions/pdf-text-document.ts', ['document'], []],
    ['the complex-script shaper', 'src/lib/conversions/text-shaping/shape.ts', ['document'], []],
    ['the PDF font coverage', 'src/lib/conversions/pdf-fonts.ts', ['document'], []],
    ['a CAD file', 'src/lib/conversions/cad-nurbs.ts', [], ['cad']],
    ['a font file', 'src/lib/conversions/font-woff2.ts', [], ['font']],
    ['a RAW file', 'src/lib/conversions/raw-demosaic.ts', [], ['raw']],
    ['the RAW decode worker', 'src/worker/raw-decode-worker.ts', [], ['raw']],
    ['a data file', 'src/lib/conversions/parquet-writer.ts', [], ['data']],
    ['an ebook reader', 'src/lib/conversions/office/mobi-reader.ts', [], ['ebook']],
    ['a PDF operation', 'src/lib/conversions/pdf-postprocess/watermark.ts', [], ['pdf-ops']],
    ['a vector file', 'src/lib/conversions/svg-geometry.ts', [], ['vector']],
    ['an HDR file', 'src/lib/conversions/openexr-decode.ts', [], ['hdr-image']],
  ])('maps %s', (_name, file, benchmarked, unmapped) => {
    expect(classify(file)).toEqual({ benchmarked, unmapped, unclassified: [] });
  });

  it('sends the dispatcher and the shared worker code to every benchmarked family', () => {
    for (const file of ['src/lib/conversions/dispatch.ts', 'src/lib/conversions/index.ts', 'src/worker/engines.ts', 'src/worker/sandbox.ts', 'src/lib/workers/cpu-pool.ts']) {
      expect(classify(file), file).toEqual({ benchmarked: [...BENCH_FAMILIES], unmapped: [], unclassified: [] });
    }
  });

  it('maps nothing outside the conversion code', () => {
    expect(classify('src/app/page.tsx', 'src/lib/queue/redis.ts', 'README.md', 'bench/run.ts', 'tests/a.test.ts', '.github/workflows/ci.yml')).toEqual({
      benchmarked: [],
      unmapped: [],
      unclassified: [],
    });
  });

  it('combines the families of several changed files, benchmarked ones in harness order', () => {
    expect(classify('src/lib/conversions/zstd.ts', 'src/lib/conversions/image.ts', 'src/lib/conversions/cad-nurbs.ts', 'src/lib/conversions/font.ts', 'docs/a.md')).toEqual({
      benchmarked: ['image', 'compression'],
      unmapped: ['cad', 'font'],
      unclassified: [],
    });
  });

  it('reports a path inside the scope that no rule covers', () => {
    expect(classify('src/lib/conversions/brand-new-engine.ts', 'src/lib/conversions/image.ts')).toEqual({
      benchmarked: ['image'],
      unmapped: [],
      unclassified: ['src/lib/conversions/brand-new-engine.ts'],
    });
  });

  it('takes the first matching rule of the map', () => {
    const map = validateFamilyMap({
      schemaVersion: 1,
      scope: '^src/',
      families: { ...benchEntries, extra: { bench: null } },
      rules: [
        { families: ['extra'], match: '^src/a\\.ts$' },
        { families: ['image'], match: '^src/' },
      ],
    });
    expect(classifyPaths(['src/a.ts'], map)).toEqual({ benchmarked: [], unmapped: ['extra'], unclassified: [] });
    expect(classifyPaths(['src/b.ts'], map)).toEqual({ benchmarked: ['image'], unmapped: [], unclassified: [] });
  });

  it('stops being unmapped, and is measured, once the map benchmarks the family', () => {
    const rules = [{ families: ['cad'], match: '^src/cad\\.ts$' }];
    const before = validateFamilyMap({ schemaVersion: 1, scope: '^src/', families: { ...benchEntries, cad: { bench: null } }, rules });
    expect(classifyPaths(['src/cad.ts'], before)).toEqual({ benchmarked: [], unmapped: ['cad'], unclassified: [] });
    const after = validateFamilyMap({ schemaVersion: 1, scope: '^src/', families: { ...benchEntries, cad: { bench: 'cad' } }, rules });
    expect(classifyPaths(['src/cad.ts'], after)).toEqual({ benchmarked: ['cad'], unmapped: [], unclassified: [] });
    // The family joins "every benchmarked family" too.
    expect(classifyPaths(['src/x.ts'], validateFamilyMap({ schemaVersion: 1, scope: '^src/', families: { ...benchEntries, cad: { bench: 'cad' } }, rules: [{ families: ['*'], match: '^src/' }] })).benchmarked).toEqual([...BENCH_FAMILIES, 'cad']);
  });

  it('bounds the number and the length of the paths it reads', () => {
    expect(() => classifyPaths(Array.from({ length: MAX_CHANGED_PATHS + 1 }, () => 'a'), MAP)).toThrow(FamilyMapError);
    expect(() => classifyPaths([`src/${'a'.repeat(MAX_PATH_LENGTH)}`], MAP)).toThrow(/longer than/);
  });
});

describe('a malformed map', () => {
  const benchFamilies = benchEntries;
  const valid = { schemaVersion: 1, scope: '^src/', families: benchFamilies, rules: [{ families: ['image'], match: '^src/' }] };

  it.each<[string, unknown, RegExp]>([
    ['a non-object', [], /must be an object/],
    ['another schema version', { ...valid, schemaVersion: 2 }, /schemaVersion/],
    ['an invalid pattern', { ...valid, scope: '(' }, /not a valid pattern/],
    ['an empty pattern', { ...valid, scope: '' }, /non-empty pattern/],
    ['a family benchmarked under another name', { ...valid, families: { ...benchFamilies, cad: { bench: 'sound' } } }, /families\.cad\.bench must be null or "cad"/],
    ['no benchmarked family at all', { ...valid, families: { cad: { bench: null } } }, /at least one family must be benchmarked/],
    ['the reserved star as a family', { ...valid, families: { ...benchFamilies, [ALL_FAMILIES]: { bench: null } } }, /cannot name a family/],
    ['a family name with a slash', { ...valid, families: { ...benchFamilies, 'a/b': { bench: null } } }, /cannot name a family/],
    ['no rules', { ...valid, rules: [] }, /rules must be a list/],
    ['a rule naming an unknown family', { ...valid, rules: [{ families: ['sound'], match: '.' }] }, /unknown family sound/],
    ['a rule without families', { ...valid, rules: [{ families: [], match: '.' }] }, /non-empty list/],
  ])('rejects %s', (_name, value, message) => {
    expect(() => validateFamilyMap(value)).toThrow(FamilyMapError);
    expect(() => validateFamilyMap(value)).toThrow(message);
  });
});

describe('the command the changes job runs', () => {
  const run = (input: string): { status: number | null; stdout: string; stderr: string } =>
    spawnSync('node', ['scripts/ci-parity-families.mjs'], { cwd: ROOT, input, encoding: 'utf-8' });

  it('prints the three lists the workflow reads', () => {
    const result = run('src/lib/conversions/zstd.ts\nsrc/lib/conversions/cad-nurbs.ts\nREADME.md\n');
    expect(result.status).toBe(0);
    expect(result.stdout.split('\n').filter(Boolean)).toEqual(['families=compression', 'unmapped=cad', 'unclassified=']);
  });

  it('prints empty lists for a change outside the conversion code', () => {
    const result = run('docs/guide.md\n');
    expect(result.status).toBe(0);
    expect(result.stdout.split('\n').filter(Boolean)).toEqual(['families=', 'unmapped=', 'unclassified=']);
  });

  it('exits 1 with an error annotation for an unclassified conversion path', () => {
    const result = run('src/lib/conversions/brand-new-engine.ts\n');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('unclassified=src/lib/conversions/brand-new-engine.ts');
    expect(result.stderr).toContain('::error::no rule in bench/family-map.json covers src/lib/conversions/brand-new-engine.ts');
  });
});
