import { describe, expect, it } from 'vitest';
import { ManifestError, type CorpusFile, type CorpusManifest } from '../bench/realworld/manifest';
import { parseRegressionManifest, REGRESSION_COLUMNS, serializeRegressionManifest } from '../bench/realworld/regression/manifest';
import { allocate, selectStratified, sizeClassOf, stratumOf, type StratumCandidate } from '../bench/realworld/regression/stratify';

/**
 * The regression corpus manifest and the stratified draw. Manifests are written out by hand here; the expected allocations are
 * worked out on paper from the max-min rule (every stratum gets an equal share, a stratum smaller than the share gives its
 * unused part to the others), not computed by the code under test.
 */

const KIB = 1024;
const MIB = 1024 * KIB;
const SHA = (digit: string): string => digit.repeat(64);
const GOVDOCS = 'https://digitalcorpora.s3.amazonaws.com/corpora/files/govdocs1/zipfiles/000.zip';
const CRAWL = 'https://digitalcorpora.s3.amazonaws.com/corpora/files/CC-MAIN-2021-31-PDF-UNTRUNCATED/zipfiles/0000-0999/0000.zip';

function file(id: string, over: Partial<CorpusFile> = {}): CorpusFile {
  return {
    id,
    source: 'govdocs1',
    format: 'doc',
    size: 4096,
    sha256: SHA('a'),
    origin: { kind: 'zip', archive: GOVDOCS, entry: `000/${id}`, offset: 100, compressedSize: 50, method: 8 },
    ...over,
  };
}

const manifestOf = (files: CorpusFile[]): CorpusManifest => ({
  schema: 1,
  sources: [
    { id: 'govdocs1', description: 'Government documents', licence: 'Freely redistributable to the best of the publisher\'s knowledge' },
    { id: 'cc-main-2021-31-pdf', description: 'Web-crawl PDFs', licence: 'Common Crawl terms of use' },
  ],
  files,
});

describe('size classes', () => {
  it.each([
    [1, 'small'],
    [64 * KIB - 1, 'small'],
    [64 * KIB, 'medium'],
    [512 * KIB - 1, 'medium'],
    [512 * KIB, 'large'],
    [2 * MIB - 1, 'large'],
    [2 * MIB, 'huge'],
    [8 * MIB, 'huge'],
  ])('puts %i bytes in %s', (size, expected) => {
    expect(sizeClassOf(size)).toBe(expected);
  });
});

describe('allocation of a budget over strata', () => {
  it('gives every stratum an equal share and hands the unused part of a small stratum to the others', () => {
    // Shares: 100 / 4 = 25 -> the stratum of 1 takes 1; 99 / 3 = 33 -> the stratum of 2 takes 2; 97 / 2 = 48 -> the stratum of 50 takes 48; the last takes 49.
    expect(allocate([1, 2, 50, 500], 100)).toEqual([1, 2, 48, 49]);
  });

  it('takes everything when the budget is at least the population, and nothing for a budget of zero', () => {
    expect(allocate([3, 4], 10)).toEqual([3, 4]);
    expect(allocate([3, 4], 0)).toEqual([0, 0]);
    expect(allocate([], 5)).toEqual([]);
  });

  it('keeps the order of the strata it was given and never exceeds the budget or a population', () => {
    const populations = [900, 7, 120, 7, 1];
    const taken = allocate(populations, 200);
    expect(taken.reduce((a, b) => a + b, 0)).toBe(200);
    taken.forEach((count, index) => expect(count).toBeLessThanOrEqual(populations[index]));
    expect(taken[4]).toBe(1);
    expect(taken[1]).toBe(7);
    expect(taken[3]).toBe(7);
  });
});

describe('stratified draw', () => {
  const candidate = (id: string, format: string, producerClass: string, size: number, group = format): StratumCandidate => ({ id, format, producerClass, size, group });
  const pool: StratumCandidate[] = [
    ...Array.from({ length: 40 }, (_, i) => candidate(`word-${i}`, 'doc', 'microsoft-word', 10 * KIB)),
    ...Array.from({ length: 30 }, (_, i) => candidate(`word-big-${i}`, 'doc', 'microsoft-word', 3 * MIB)),
    ...Array.from({ length: 3 }, (_, i) => candidate(`rare-${i}`, 'doc', 'wordperfect', 10 * KIB)),
    candidate('lone', 'doc', 'abiword', 100 * KIB),
    ...Array.from({ length: 50 }, (_, i) => candidate(`xls-${i}`, 'xls', 'microsoft-excel', 10 * KIB)),
  ];

  it('names a stratum by format, producer class and size class', () => {
    expect(stratumOf(candidate('x', 'doc', 'microsoft-word', 10 * KIB))).toBe('doc|microsoft-word|small');
  });

  it('takes the rare strata whole and shares the rest equally, group by group', () => {
    // Group doc, budget 20: strata of 40, 30, 3 and 1 -> 1 takes 1 (20/4=5 -> 1), 3 takes 3 (19/3=6 -> 3), then 16 left over two strata: 8 and 8.
    const chosen = selectStratified(pool, { doc: 20, xls: 10 });
    const count = (prefix: string): number => chosen.filter((c) => c.id.startsWith(prefix)).length;
    expect(count('lone')).toBe(1);
    expect(count('rare-')).toBe(3);
    expect(count('word-big-')).toBe(8);
    expect(chosen.filter((c) => c.id.startsWith('word-') && !c.id.startsWith('word-big-'))).toHaveLength(8);
    expect(count('xls-')).toBe(10);
    expect(chosen).toHaveLength(30);
  });

  it('chooses the same files whatever order the pool arrives in', () => {
    const forward = selectStratified(pool, { doc: 20, xls: 10 }).map((c) => c.id);
    const backward = selectStratified([...pool].reverse(), { doc: 20, xls: 10 }).map((c) => c.id);
    expect(backward).toEqual(forward);
    expect(forward).toEqual([...forward].sort());
  });

  it('draws nothing for a group with no budget', () => {
    expect(selectStratified(pool, { doc: 5 }).every((c) => c.format === 'doc')).toBe(true);
  });
});

describe('regression manifest file', () => {
  const files = [
    file('gd-000001.doc', { producer: 'Microsoft Word 9.0', size: 40960, sha256: SHA('1') }),
    file('gd-000002.doc', { sha256: SHA('2') }),
    file('cc-0000007.pdf', {
      source: 'cc-main-2021-31-pdf',
      format: 'pdf',
      size: 9000,
      sha256: SHA('3'),
      producer: 'TCPDF 6.2.11 (http://www.tcpdf.org)',
      origin: { kind: 'zip', archive: CRAWL, entry: '0000007.pdf', offset: 7, compressedSize: 8000, method: 8 },
    }),
  ];

  /** The manifest of the three files above as it is written on disk, worked out by hand: sorted by id, one row per line, archives in order of first use. */
  const written = [
    '{',
    '"schema": 1,',
    `"sources": ${JSON.stringify(manifestOf([]).sources)},`,
    `"archives": [{"url":"${CRAWL}","source":"cc-main-2021-31-pdf"},{"url":"${GOVDOCS}","source":"govdocs1"}],`,
    '"columns": ["id","format","archive","entry","offset","compressedSize","method","size","sha256","producer"],',
    '"files": [',
    `["cc-0000007.pdf","pdf",0,"0000007.pdf",7,8000,8,9000,"${SHA('3')}","TCPDF 6.2.11 (http://www.tcpdf.org)"],`,
    `["gd-000001.doc","doc",1,"000/gd-000001.doc",100,50,8,40960,"${SHA('1')}","Microsoft Word 9.0"],`,
    `["gd-000002.doc","doc",1,"000/gd-000002.doc",100,50,8,4096,"${SHA('2')}",""]`,
    ']',
    '}',
    '',
  ].join('\n');

  it('writes one file per line, sorted by id, with the archive list once', () => {
    expect(serializeRegressionManifest(manifestOf(files))).toBe(written);
  });

  it('keeps its columns in the order the reader expects', () => {
    expect(JSON.parse(written).columns).toEqual([...REGRESSION_COLUMNS]);
  });

  it('reads a manifest written by hand, with archive, entry, offsets, digest and producer intact', () => {
    const back = parseRegressionManifest(written);
    const byId = new Map(back.files.map((f) => [f.id, f]));
    expect(back.files).toHaveLength(3);
    expect(byId.get('gd-000001.doc')).toEqual(files[0]);
    expect(byId.get('cc-0000007.pdf')).toEqual(files[2]);
    expect(byId.get('gd-000002.doc')?.producer).toBeUndefined();
    expect(back.sources.map((s) => s.id)).toEqual(['govdocs1', 'cc-main-2021-31-pdf']);
  });

  it('refuses a manifest whose columns are not the ones it reads', () => {
    expect(() => parseRegressionManifest(JSON.stringify({ ...JSON.parse(written), columns: ['id', 'format'] }))).toThrow(/columns/);
  });

  it('refuses a row with a bad digest, a duplicate id or an unknown archive through the shared manifest checks', () => {
    const edit = (change: (json: { files: unknown[][] }) => void): string => {
      const json = JSON.parse(written) as { files: unknown[][] };
      change(json);
      return JSON.stringify(json);
    };
    expect(() => parseRegressionManifest(edit((json) => (json.files[0][8] = 'xyz')))).toThrow(ManifestError);
    expect(() => parseRegressionManifest(edit((json) => (json.files[1][0] = json.files[0][0])))).toThrow(/duplicate/);
    expect(() => parseRegressionManifest(edit((json) => (json.files[0][2] = 9)))).toThrow(/archive/);
  });

  it('refuses a file that is not read out of a ZIP archive', () => {
    const loose = file('web-1.doc', { origin: { kind: 'file', url: 'https://example.invalid/x.doc' } });
    expect(() => serializeRegressionManifest(manifestOf([loose]))).toThrow(/zip/);
  });
});
