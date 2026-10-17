import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getAvailableTargetFormats, getFormatByExtension } from '../src/lib/registry';
import { readManifest } from '../bench/realworld/manifest';
import { isExcludedName } from '../bench/realworld/regression/build';
import { SIZE_CAP_BYTES } from '../bench/realworld/regression/candidates';
import { readFailedBefore, REGRESSION_KNOWN_FAILURES_PATH } from '../bench/realworld/regression/merge';
import { readRegressionManifest } from '../bench/realworld/regression/manifest';
import { producerClass } from '../bench/realworld/regression/producer';
import { canarySelection, ESTIMATED_MS_PER_JOB, JOB_WORKERS, planRegressionJobs, selectForMode, SHARD_CONVERSION_BUDGET_MINUTES, SHARDS } from '../bench/realworld/regression/schedule';
import { sizeClassOf } from '../bench/realworld/regression/stratify';
import { readKnownFailures } from '../bench/realworld/report';

/**
 * The committed regression manifest, checked against facts that do not come from the code that built it: the two public corpora
 * it may draw from, the formats the registry accepts, the real-world manifest it must not repeat, the licence statements it must
 * carry and the time a shard may take. The counts are those of the manifest as built on 2026-10-17.
 */

const ROOT = path.resolve(__dirname, '..');
const manifest = readRegressionManifest();
const files = manifest.files;
const GOVDOCS_PREFIX = 'https://digitalcorpora.s3.amazonaws.com/corpora/files/govdocs1/zipfiles/';
const CRAWL_PREFIX = 'https://digitalcorpora.s3.amazonaws.com/corpora/files/CC-MAIN-2021-31-PDF-UNTRUNCATED/zipfiles/';
const OFFICE_FORMATS = ['doc', 'xls', 'ppt', 'pps', 'docx', 'xlsx', 'pptx'];
const MILLISECONDS_PER_MINUTE = 60_000;
const countBy = (key: (file: (typeof files)[number]) => string): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const file of files) counts.set(key(file), (counts.get(key(file)) ?? 0) + 1);
  return counts;
};

describe('composition', () => {
  it('holds about 20,000 files from the two sources', () => {
    expect(files.length).toBeGreaterThanOrEqual(19_500);
    expect(files.length).toBeLessThanOrEqual(21_000);
    expect(manifest.sources.map((source) => source.id)).toEqual(['govdocs1', 'cc-main-2021-31-pdf']);
    expect([...countBy((file) => file.source).keys()].sort()).toEqual(['cc-main-2021-31-pdf', 'govdocs1']);
  });

  it('holds only office and PDF formats that the registry accepts, with a producer for most of them', () => {
    const formats = [...countBy((file) => file.format).keys()].sort();
    expect(formats).toEqual([...OFFICE_FORMATS, 'pdf'].sort());
    for (const format of formats) expect(getFormatByExtension(format)?.id).toBe(format);
    const named = files.filter((file) => file.producer !== undefined).length;
    expect(named / files.length).toBeGreaterThan(0.8);
  });

  it('has many producer classes in every large format, not one application', () => {
    const classes = (format: string): number => new Set(files.filter((file) => file.format === format).map((file) => producerClass(file.producer ?? null))).size;
    expect(classes('pdf')).toBeGreaterThan(1000);
    expect(classes('doc')).toBeGreaterThan(5);
    expect(classes('xls')).toBeGreaterThan(3);
    expect(classes('ppt')).toBeGreaterThan(2);
  });

  it('reaches every size class and keeps every file within the cap', () => {
    expect([...countBy((file) => sizeClassOf(file.size)).keys()].sort()).toEqual(['huge', 'large', 'medium', 'small']);
    expect(Math.max(...files.map((file) => file.size))).toBeLessThanOrEqual(SIZE_CAP_BYTES);
    expect(Math.min(...files.map((file) => file.size))).toBeGreaterThan(0);
  });
});

describe('what is drawn from', () => {
  it('reads the government corpus and the crawl corpus of the digital corpora archive, and nothing else', () => {
    for (const file of files) {
      if (file.origin.kind !== 'zip') throw new Error(`${file.id} is not read out of a ZIP archive`);
      const prefix = file.source === 'govdocs1' ? GOVDOCS_PREFIX : CRAWL_PREFIX;
      expect(file.origin.archive.startsWith(prefix), file.id).toBe(true);
    }
  });

  it('holds no file that is named for an exploit, a fuzzer, a CVE or the unsafe set', () => {
    for (const file of files) {
      const origin = file.origin.kind === 'zip' ? `${file.origin.archive} ${file.origin.entry}` : '';
      expect(isExcludedName(`${file.id} ${origin}`), file.id).toBe(false);
      expect(origin.toLowerCase()).not.toMatch(/unsafe|malicious|fuzz|cve/);
    }
  });

  it('repeats no file of the real-world corpus and no entry of its own', () => {
    const held = new Set(readManifest().files.flatMap((file) => (file.origin.kind === 'zip' ? [`${file.origin.archive} ${file.origin.entry}`] : [])));
    const seen = new Set<string>();
    for (const file of files) {
      if (file.origin.kind !== 'zip') continue;
      const key = `${file.origin.archive} ${file.origin.entry}`;
      expect(held.has(key), file.id).toBe(false);
      expect(seen.has(key), file.id).toBe(false);
      seen.add(key);
    }
  });

  it('states the terms of both sources: internal test use, fetched at run time, not committed', () => {
    const licences = new Map(manifest.sources.map((source) => [source.id, source.licence]));
    expect(licences.get('govdocs1')).toMatch(/freely redistributable to the best of the publisher's knowledge/);
    expect(licences.get('cc-main-2021-31-pdf')).toMatch(/Common Crawl terms of use/);
    for (const licence of licences.values()) expect(licence).toMatch(/Not committed.*fetched at run time by digest for internal conversion testing/);
  });
});

describe('time', () => {
  const targetsOf = (format: string): string[] => getAvailableTargetFormats(format).map((def) => def.id);
  const minutesFor = (jobs: number, shards: number): number => (Math.ceil(jobs / shards) * ESTIMATED_MS_PER_JOB) / JOB_WORKERS / MILLISECONDS_PER_MINUTE;
  const failedBefore = new Set(readFailedBefore());

  it('fits a full run into the shards, each well under the job limit', () => {
    const jobs = planRegressionJobs(files, targetsOf, 1).length;
    expect(jobs).toBeGreaterThan(files.length * 0.99);
    expect(minutesFor(jobs, SHARDS.full)).toBeLessThan(SHARD_CONVERSION_BUDGET_MINUTES);
  });

  it('fits the busiest night, a seventh and the canary, into its shards', () => {
    const days = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];
    const nights = days.map((day) => selectForMode('nightly', files, day, failedBefore));
    const largest = Math.max(...nights.map((night) => planRegressionJobs(night, targetsOf, 1).length));
    expect(minutesFor(largest, SHARDS.nightly)).toBeLessThan(SHARD_CONVERSION_BUDGET_MINUTES);
    expect(new Set(nights.flat().map((file) => file.id)).size).toBe(files.length);
  });

  it('keeps the canary to a few hundred files that reach every format', () => {
    const canary = canarySelection(files, failedBefore);
    expect(canary.length).toBeGreaterThan(1000);
    expect(canary.length).toBeLessThan(2000);
    expect(new Set(canary.map((file) => file.format))).toEqual(new Set([...OFFICE_FORMATS, 'pdf']));
  });
});

describe('the lists a run is judged with', () => {
  const ids = new Set(files.map((file) => file.id));

  it('names only corpus files in the list of files that failed before', () => {
    expect(readFailedBefore().filter((id) => !ids.has(id))).toEqual([]);
  });

  it('tracks every known failure with an issue, and a corpus file where it names one', () => {
    const known = readKnownFailures(REGRESSION_KNOWN_FAILURES_PATH);
    expect(known.filter((entry) => entry.file !== undefined && !ids.has(entry.file))).toEqual([]);
    expect(known.every((entry) => entry.issue > 0)).toBe(true);
  });

  it('tracks every known failure on #783, the item that fixes conversion failures of real files (QA review of #787)', () => {
    const known = readKnownFailures(REGRESSION_KNOWN_FAILURES_PATH);
    expect(known.map((entry) => entry.issue)).toEqual(known.map(() => 783));
  });
});

describe('documentation', () => {
  const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf-8');

  it('records the sources in the provenance file and the decision in the policy file', () => {
    const provenance = read('bench/realworld/PROVENANCE.md');
    expect(provenance).toMatch(/^## Regression corpus$/m);
    expect(provenance).toMatch(/\| `cc-main-2021-31-pdf` \|/);
    const policy = read('docs/policy-decisions.md');
    expect(policy).toMatch(/Regression corpus at the scale of the document engines/);
    expect(policy).toMatch(/^## 39\. Layer cache of the worker image in the container registry$/m);
  });
});
