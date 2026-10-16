import { describe, expect, it } from 'vitest';
import type { CorpusFile } from '../bench/realworld/manifest';
import { canarySelection, dayBucket, nightlySelection, planRegressionJobs, rotationBucket, ROTATION_DAYS, selectForMode, thinJobs } from '../bench/realworld/regression/schedule';
import { shardJobs } from '../bench/realworld/plan';

/**
 * The weekly and nightly selection of the regression corpus. The pinned buckets were computed with Python's hashlib and datetime
 * (SHA-256 of the id, first four bytes big-endian, modulo 7; days since 1970-01-01 modulo 7), not with the code under test.
 */

const SHA = 'b'.repeat(64);

function file(id: string, format = 'doc', producer?: string): CorpusFile {
  return {
    id,
    source: 'govdocs1',
    format,
    size: 4096,
    sha256: SHA,
    origin: { kind: 'zip', archive: 'https://example.invalid/000.zip', entry: id, offset: 0, compressedSize: 1, method: 0 },
    ...(producer === undefined ? {} : { producer }),
  };
}

const many = (count: number): CorpusFile[] => Array.from({ length: count }, (_, i) => file(`gd-${String(i).padStart(6, '0')}.doc`, 'doc', 'Microsoft Word 9.0'));

describe('rotation', () => {
  it('puts a file in the bucket its id hashes to', () => {
    expect(rotationBucket('gd-000001.doc')).toBe(5);
    expect(rotationBucket('cc-0000007.pdf')).toBe(1);
    expect(rotationBucket('gd-000002.doc')).toBe(5);
  });

  it('counts days since the epoch modulo seven, in UTC', () => {
    expect(dayBucket('1970-01-01')).toBe(0);
    expect(dayBucket('1970-01-08')).toBe(0);
    expect(dayBucket('2026-10-17')).toBe(2);
    expect(dayBucket('2026-10-18')).toBe(3);
    expect(dayBucket('2024-02-29')).toBe(0);
  });

  it('refuses a date that is not a calendar day in YYYY-MM-DD form', () => {
    for (const bad of ['2026-13-01', '2026-02-30', '17-10-2026', '', '2026-10-17T00:00:00Z']) expect(() => dayBucket(bad)).toThrow(/date/);
  });

  it('covers every file exactly once over seven consecutive nights, with no canary', () => {
    const files = many(700);
    const days = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];
    const nights = days.map((day) => nightlySelection(files, day, new Set(), { canary: false }).map((f) => f.id));
    expect(ROTATION_DAYS).toBe(7);
    expect(nights.flat().sort()).toEqual(files.map((f) => f.id).sort());
    for (const night of nights) {
      expect(night.length).toBeGreaterThan(70);
      expect(night.length).toBeLessThan(130);
    }
  });

  it('gives the same night for the same date whatever order the files arrive in', () => {
    const files = many(60);
    const forward = nightlySelection(files, '2026-10-17', new Set()).map((f) => f.id);
    const backward = nightlySelection([...files].reverse(), '2026-10-17', new Set()).map((f) => f.id);
    expect(backward).toEqual(forward);
  });
});

describe('canary', () => {
  const files = [
    file('a-1.doc', 'doc', 'Microsoft Word 9.0'),
    file('a-2.doc', 'doc', 'Microsoft Word 10.0'),
    file('a-3.doc', 'doc', 'Microsoft Office Word 2003'),
    file('b-1.doc', 'doc', 'WordPerfect 8'),
    file('c-1.xls', 'xls', 'Microsoft Excel'),
    file('c-2.xls', 'xls', 'Microsoft Excel 9.0'),
    file('d-1.doc'),
    file('e-1.pdf', 'pdf', 'TCPDF 6.2.11 (http://www.tcpdf.org)'),
    file('e-2.pdf', 'pdf', 'TCPDF 5.0'),
    file('f-1.pdf', 'pdf', 'Acrobat Distiller 9.0.0 (Windows)'),
  ];

  it('holds one file of every format and producer class', () => {
    const chosen = canarySelection(files, new Set());
    const classes = chosen.map((f) => `${f.format}:${f.producer?.split(' ')[0] ?? 'none'}`).sort();
    // Hand-counted classes: doc Microsoft Word, doc WordPerfect, doc unknown, xls Microsoft Excel, pdf TCPDF, pdf Acrobat Distiller.
    expect(chosen).toHaveLength(6);
    expect(classes).toEqual(['doc:Microsoft', 'doc:WordPerfect', 'doc:none', 'pdf:Acrobat', 'pdf:TCPDF', 'xls:Microsoft'].sort());
  });

  it('adds every file that failed before and keeps the list in the manifest', () => {
    const chosen = canarySelection(files, new Set(['a-2.doc', 'c-1.xls'])).map((f) => f.id);
    expect(chosen).toContain('a-2.doc');
    expect(chosen).toContain('c-1.xls');
    expect(new Set(chosen).size).toBe(chosen.length);
    expect(() => canarySelection(files, new Set(['gone.doc']))).toThrow(/gone\.doc/);
  });

  it('chooses the same representatives whatever order the files arrive in', () => {
    const forward = canarySelection(files, new Set()).map((f) => f.id);
    expect(canarySelection([...files].reverse(), new Set()).map((f) => f.id)).toEqual(forward);
  });

  it('is part of every night and not of a full run', () => {
    const canary = canarySelection(files, new Set()).map((f) => f.id);
    for (const day of ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']) {
      const night = new Set(nightlySelection(files, day, new Set()).map((f) => f.id));
      for (const id of canary) expect(night.has(id)).toBe(true);
    }
    expect(selectForMode('full', files, '2026-10-17', new Set())).toHaveLength(files.length);
    expect(selectForMode('nightly', files, '2026-10-17', new Set()).length).toBeLessThan(files.length);
  });
});

describe('job plan', () => {
  const targetsOf = (format: string): string[] => (format === 'doc' ? ['pdf', 'txt', 'html', 'docx', 'rtf'] : ['pdf']);

  it('gives each file its own number of distinct targets of its format', () => {
    const jobs = planRegressionJobs([file('a.doc'), file('b.doc')], targetsOf, 3);
    for (const id of ['a.doc', 'b.doc']) {
      const targets = jobs.filter((job) => job.file.id === id).map((job) => job.target);
      expect(targets).toHaveLength(3);
      expect(new Set(targets).size).toBe(3);
      for (const target of targets) expect(targetsOf('doc')).toContain(target);
    }
  });

  it('takes no more targets than the format has, and none for a format without any', () => {
    expect(planRegressionJobs([file('a.pdf', 'pdf')], targetsOf, 4)).toHaveLength(1);
    expect(planRegressionJobs([file('a.xyz', 'xyz')], () => [], 2)).toEqual([]);
  });

  it('does not change a file target when other files are added or removed', () => {
    const alone = planRegressionJobs([file('a.doc')], targetsOf, 1);
    const among = planRegressionJobs([file('z.doc'), file('a.doc'), file('m.doc')], targetsOf, 1);
    expect(among.find((job) => job.file.id === 'a.doc')?.target).toBe(alone[0].target);
  });

  it('spreads the targets of many files over all of them', () => {
    const jobs = planRegressionJobs(many(500), targetsOf, 1);
    for (const target of targetsOf('doc')) {
      const share = jobs.filter((job) => job.target === target).length / jobs.length;
      expect(share).toBeGreaterThan(0.1);
      expect(share).toBeLessThan(0.3);
    }
  });

  it('shards the jobs of the selected files evenly and without overlap', () => {
    const jobs = planRegressionJobs(many(600), targetsOf, 1);
    const shards = [0, 1, 2].map((shard) => shardJobs(jobs, shard, 3));
    expect(shards.flat()).toHaveLength(600);
    for (const shard of shards) expect(shard).toHaveLength(200);
  });
});

describe('trial runs', () => {
  const jobs = planRegressionJobs(many(100), () => ['pdf'], 1);

  it('keeps evenly spread jobs, the first one among them, and all jobs when the limit is not smaller', () => {
    const thin = thinJobs(jobs, 10);
    expect(thin.map((job) => job.file.id)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90].map((i) => jobs[i].file.id));
    expect(thinJobs(jobs, 100)).toHaveLength(100);
    expect(thinJobs(jobs, 500)).toHaveLength(100);
  });
});
