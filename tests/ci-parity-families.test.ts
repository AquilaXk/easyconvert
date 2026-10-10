import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { QUICK_SUBSET } from '../bench/config';
import { FAMILIES } from '../bench/report';
import { FAMILY_RUNNERS } from '../bench/families';
import {
  ALL_FAMILIES,
  changedRowIds,
  classifyPaths,
  FamilyMapError,
  gitChangedRows,
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
const BENCH_FAMILIES: readonly string[] = ['image', 'video', 'audio', 'ocr', 'document', 'compression', 'pdf-ops'];
const benchEntries = Object.fromEntries(BENCH_FAMILIES.map((name) => [name, { bench: name }]));

describe('the map', () => {
  it('covers exactly the conversion code: the library engines, the worker engines and the worker pool', () => {
    expect(MAP.scope.test('src/lib/conversions/image.ts')).toBe(true);
    expect(MAP.scope.test('src/worker/sandbox.ts')).toBe(true);
    expect(MAP.scope.test('src/lib/workers/cpu-pool.ts')).toBe(true);
    expect(MAP.scope.test('src/lib/jobs/artifact-helpers.ts')).toBe(true);
    expect(MAP.scope.test('src/lib/queue/graph/node-executor.ts')).toBe(true);
    for (const outside of ['src/app/api/convert/route.ts', 'src/components/Upload.tsx', 'src/lib/registry.ts', 'src/lib/jobs/graph.ts', 'src/lib/queue/graph/scheduler.ts', 'bench/realworld/run.ts', 'bench/README.md', 'tests/x.test.ts', 'docs/a.md']) {
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
    expect(unbenchmarked).toEqual(['cad', 'data', 'ebook', 'font', 'hdr-image', 'raw', 'vector']);
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
    ['a PDF operation', 'src/lib/conversions/pdf-postprocess/watermark.ts', ['pdf-ops'], []],
    ['the PDF decryption of the worker', 'src/worker/pdf-decrypt.ts', ['pdf-ops'], []],
    ['the PDF merge of the workflow graph', 'src/lib/jobs/artifact-helpers.ts', ['pdf-ops'], []],
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

  it('sends the graph node executor, which dispatches the conversion, watermark, protect and merge nodes, to every benchmarked family', () => {
    expect(classify('src/lib/queue/graph/node-executor.ts')).toEqual({ benchmarked: [...BENCH_FAMILIES], unmapped: [], unclassified: [] });
  });

  it('sends the shared tool runner and the manifests every conversion depends on to every benchmarked family', () => {
    const everything = { benchmarked: [...BENCH_FAMILIES], unmapped: [], unclassified: [] };
    for (const file of [
      'src/lib/security/process-sandbox.ts',
      'package.json',
      'package-lock.json',
      'Dockerfile.worker',
      'Dockerfile',
      '.github/actions/ci-setup/action.yml',
      '.github/actions/ci-setup/install-tools.sh',
      'docker/seccomp-worker.json',
    ]) {
      expect(classify(file), file).toEqual(everything);
    }
  });

  it('sends the SVG sanitizer to the image family that renders through it', () => {
    expect(classify('src/lib/security/svg-sanitizer.ts')).toEqual({ benchmarked: ['image'], unmapped: [], unclassified: [] });
  });

  it('puts the new media modules under their families', () => {
    expect(classify('src/lib/conversions/mp4-layout.ts')).toEqual({ benchmarked: ['video'], unmapped: [], unclassified: [] });
    expect(classify('src/lib/conversions/media-encoder-threads.ts')).toEqual({ benchmarked: ['video', 'audio'], unmapped: [], unclassified: [] });
    expect(classify('src/lib/conversions/avif-cli.ts')).toEqual({ benchmarked: ['image'], unmapped: [], unclassified: [] });
  });

  it('leaves unrelated files at the repository root and under .github alone', () => {
    expect(classify('README.md', 'tsconfig.json', 'docker-compose.yml', '.github/workflows/nightly.yml', '.github/PULL_REQUEST_TEMPLATE.md', 'docker/AIRGAP.md')).toEqual({
      benchmarked: [],
      unmapped: [],
      unclassified: [],
    });
  });

  it('maps nothing outside the conversion code', () => {
    expect(classify('src/app/page.tsx', 'src/lib/queue/redis.ts', 'README.md', 'bench/README.md', 'tests/a.test.ts', '.github/workflows/nightly.yml')).toEqual({
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

describe('the files of the benchmark itself', () => {
  const walkBench = (dir: string): string[] =>
    readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      const relative = `${dir}/${entry.name}`;
      return entry.isDirectory() ? walkBench(relative) : [relative];
    });
  const benchFiles = walkBench('bench').filter((file) => !file.startsWith('bench/realworld/') && !file.endsWith('.md'));
  const everything = { benchmarked: [...BENCH_FAMILIES], unmapped: [], unclassified: [] };

  it('leaves no file of the harness, its corpus or the parity scripts without a rule', () => {
    expect(benchFiles.length).toBeGreaterThan(30);
    const files = [...benchFiles, ...readdirSync(path.join(ROOT, 'scripts')).filter((name) => /^ci-parity-.*\.mjs$/.test(name)).map((name) => `scripts/${name}`)];
    expect(files.filter((file) => !MAP.scope.test(file))).toEqual([]);
    expect(classify(...files).unclassified).toEqual([]);
  });

  it("sends each family's runner to that family: the runner file names the family, and a document runner may be split", () => {
    const runners = readdirSync(path.join(ROOT, 'bench', 'families')).filter((name) => name !== 'index.ts');
    expect(runners.length).toBeGreaterThanOrEqual(BENCH_FAMILIES.length);
    for (const name of runners) {
      const family = BENCH_FAMILIES.find((candidate) => name === `${candidate}.ts` || name.startsWith(`${candidate}-`));
      expect(family, name).toBeDefined();
      expect(classify(`bench/families/${name}`), name).toEqual({ benchmarked: [family], unmapped: [], unclassified: [] });
    }
  });

  it.each<[string, string, string[]]>([
    ['the bench helper of the image, video and audio rate-distortion fits', 'bench/bd-rate.ts', ['image', 'video', 'audio']],
    ['the text scoring of OCR, documents and PDF operations', 'bench/text-metrics.ts', ['ocr', 'document', 'pdf-ops']],
    ['the structure scoring of documents', 'bench/structure-metrics.ts', ['document']],
    ['the PDF stamp reference', 'bench/pdf-stamp.ts', ['pdf-ops']],
    ['the stamp ink oracle', 'bench/pdf-ink.ts', ['pdf-ops']],
  ])('sends %s to its families', (_name, file, families) => {
    expect(classify(file)).toEqual({ benchmarked: families, unmapped: [], unclassified: [] });
  });

  it.each([
    'bench/family-map.json',
    'bench/gate.ts',
    'bench/parity.ts',
    'bench/parity-gaps.ts',
    'bench/speed-history.ts',
    'bench/speed-parity.ts',
    'bench/config.ts',
    'bench/run.ts',
    'bench/rows.ts',
    'bench/measure.ts',
    'bench/tools.ts',
    'bench/families/index.ts',
    'bench/corpus/clip.mp4',
    'scripts/ci-parity-families.mjs',
    'scripts/ci-parity-policy.mjs',
    '.github/workflows/ci.yml',
  ])('sends %s, the code of the gate itself, to every family', (file) => {
    expect(classify(file)).toEqual(everything);
  });

  it('leaves the benchmark notes and the real-world corpus alone', () => {
    expect(classify('bench/README.md', 'bench/realworld/run.ts', '.github/workflows/nightly.yml')).toEqual({ benchmarked: [], unmapped: [], unclassified: [] });
  });
});

describe('the rows of baseline.json and parity-gaps.json', () => {
  const rows = (ids: string[] | null) => ({ changedRows: () => ids });

  it('map to the families of the rows that changed', () => {
    expect(classifyPaths(['bench/baseline.json'], MAP, rows(['image/photo-a.jpg->avif/throughput', 'pdf-ops/merge.pdf->pdf/bytes']))).toEqual({ benchmarked: ['image', 'pdf-ops'], unmapped: [], unclassified: [] });
    expect(classifyPaths(['bench/parity-gaps.json'], MAP, rows(['image/photo-a.jpg->avif/throughput']))).toEqual({ benchmarked: ['image'], unmapped: [], unclassified: [] });
  });

  it('map to nothing when no row changed, to every family for a row of an unknown family, and to every family when the change cannot be read', () => {
    expect(classifyPaths(['bench/baseline.json'], MAP, rows([]))).toEqual({ benchmarked: [], unmapped: [], unclassified: [] });
    expect(classifyPaths(['bench/baseline.json'], MAP, rows(['sound/a/b']))).toEqual({ benchmarked: [...BENCH_FAMILIES], unmapped: [], unclassified: [] });
    expect(classifyPaths(['bench/baseline.json'], MAP, rows(null))).toEqual({ benchmarked: [...BENCH_FAMILIES], unmapped: [], unclassified: [] });
    expect(classifyPaths(['bench/parity-gaps.json'], MAP)).toEqual({ benchmarked: [...BENCH_FAMILIES], unmapped: [], unclassified: [] });
  });

  it('read the ids of the rows that differ', () => {
    const before = { entries: { 'a/x/m': { ours: 1 }, 'b/x/m': { ours: 2 } } };
    const after = { entries: { 'a/x/m': { ours: 1 }, 'b/x/m': { ours: 3 }, 'c/x/m': { ours: 4 } } };
    expect(changedRowIds('baseline', before, after)?.sort()).toEqual(['b/x/m', 'c/x/m']);
    const gapsBefore = { gaps: [{ id: 'a/x/throughput', ratio: 0.5 }, { id: 'b/x/throughput', ratio: 0.6 }] };
    const gapsAfter = { gaps: [{ id: 'a/x/throughput', ratio: 0.1 }, { id: 'b/x/throughput', ratio: 0.6 }] };
    expect(changedRowIds('gaps', gapsBefore, gapsAfter)).toEqual(['a/x/throughput']);
    expect(changedRowIds('baseline', {}, [])).toBeNull();
    expect(changedRowIds('gaps', { gaps: 1 }, { gaps: [] })).toBeNull();
  });

  describe('in a real repository', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'family-rows-'));
    afterAll(() => rmSync(repo, { recursive: true, force: true }));
    const git = (...args: string[]): string => {
      const run = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
      if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
      return run.stdout.trim();
    };
    const write = (file: string, value: unknown): void => {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      writeFileSync(path.join(repo, file), `${JSON.stringify(value, null, 2)}\n`);
    };
    const gap = (id: string, ratio: number) => ({ id, issue: 641, ratio, note: 'n' });

    it('maps the bypass of a new image gap at 0.1 to the image family, so its speed is measured against the entry', () => {
      git('init', '-q');
      git('config', 'user.email', 'bench@example.test');
      git('config', 'user.name', 'bench');
      write('bench/parity-gaps.json', { schemaVersion: 1, gaps: [gap('compression/mixed.7z->tar/throughput', 0.89)] });
      write('bench/baseline.json', { schemaVersion: 1, entries: { 'image/a.jpg->webp/ssim': { ours: 0.9 }, 'audio/a.wav->opus/snr': { ours: 40 } } });
      git('add', 'bench');
      git('commit', '-q', '-m', 'base');
      const base = git('rev-parse', 'HEAD');
      const read = gitChangedRows(base, repo);
      expect(read('bench/parity-gaps.json', 'gaps')).toEqual([]);
      write('bench/parity-gaps.json', { schemaVersion: 1, gaps: [gap('compression/mixed.7z->tar/throughput', 0.89), gap('image/photo-a.jpg->avif/throughput', 0.1)] });
      expect(classifyPaths(['bench/parity-gaps.json'], MAP, { changedRows: read })).toEqual({ benchmarked: ['image'], unmapped: [], unclassified: [] });
      write('bench/baseline.json', { schemaVersion: 1, entries: { 'image/a.jpg->webp/ssim': { ours: 0.9 }, 'audio/a.wav->opus/snr': { ours: 41 } } });
      expect(classifyPaths(['bench/baseline.json', 'bench/parity-gaps.json'], MAP, { changedRows: read })).toEqual({ benchmarked: ['image', 'audio'], unmapped: [], unclassified: [] });
    });

    it('treats a file the base does not have as all new, and an unreadable base as every family', () => {
      const base = git('rev-parse', 'HEAD');
      write('bench/other.json', { schemaVersion: 1, entries: { 'ocr/x/y': { ours: 1 } } });
      expect(gitChangedRows(base, repo)('bench/other.json', 'baseline')).toEqual(['ocr/x/y']);
      expect(gitChangedRows('0'.repeat(40), repo)('bench/baseline.json', 'baseline')).toBeNull();
      expect(gitChangedRows(undefined, repo)('bench/baseline.json', 'baseline')).toBeNull();
      expect(gitChangedRows(base, repo)('bench/missing-now.json', 'baseline')).toBeNull();
    });
  });
});

describe('a map with a rule over the rows of a file', () => {
  it('accepts rows "baseline" or "gaps" and refuses anything else', () => {
    const map = { schemaVersion: 1, scope: '^src/', families: benchEntries };
    expect(() => validateFamilyMap({ ...map, rules: [{ families: ['image'], match: '^src/', rows: 'gaps' }] })).not.toThrow();
    expect(() => validateFamilyMap({ ...map, rules: [{ families: ['image'], match: '^src/', rows: 'other' }] })).toThrow(/rows must be/);
  });
});
