import { describe, expect, it } from 'vitest';
import { BUDGETS, corpusFileOf, crawlCandidates, CRAWL_SOURCE, formatOfName, govdocsCandidates, GOVDOCS_SOURCE, type IndexEntry, type Profile, profiledCandidates, SIZE_CAP_BYTES } from '../bench/realworld/regression/candidates';

/** Which archive entries may enter the regression corpus, worked out on hand-written archive indexes. */

const entry = (name: string, size: number): IndexEntry => [name, 100, 40, 8, size];
const MIB = 1024 * 1024;

describe('government corpus candidates', () => {
  const index = {
    '007': [
      entry('007/007001.doc', 5000),
      entry('007/007002.xls', 6000),
      entry('007/007003.pdf', 7000),
      entry('007/007004.html', 8000),
      entry('007/007005.doc', 0),
      entry('007/007006.doc', SIZE_CAP_BYTES + 1),
      entry('007/007007.ppt', SIZE_CAP_BYTES),
      entry('007/cve-2012-0158.doc', 4000),
      entry('007/007009.doc', 4500),
      entry('007/007010.docx', 4500),
    ],
  };
  const taken = new Set(['https://digitalcorpora.s3.amazonaws.com/corpora/files/govdocs1/zipfiles/007.zip 007/007009.doc']);
  const candidates = govdocsCandidates(index, taken);

  it('takes the office and PDF files that are not empty, not over the cap, not exploit samples and not already in the real-world corpus', () => {
    expect(candidates.map((c) => c.id)).toEqual(['gd-007001.doc', 'gd-007002.xls', 'gd-007003.pdf', 'gd-007007.ppt', 'gd-007010.docx']);
  });

  it('puts each in the budget group of its source and format and points at its archive entry', () => {
    const first = candidates[0];
    expect(first).toMatchObject({ source: GOVDOCS_SOURCE, group: 'govdocs1:doc', format: 'doc', size: 5000, entry: '007/007001.doc', offset: 100, compressedSize: 40, method: 8 });
    expect(first.archive).toBe('https://digitalcorpora.s3.amazonaws.com/corpora/files/govdocs1/zipfiles/007.zip');
    expect(Object.keys(BUDGETS)).toContain(first.group);
  });
});

describe('crawl corpus candidates', () => {
  const index = { '0200': [entry('0200001.pdf', 9000), entry('0200002.pdf', 9000), entry('0200003.pdf', 9000), entry('0200004.pdf', 2 * MIB * 9), entry('0200005.pdf', 9000)] };
  const metadata = {
    '0200001.pdf': { producer: 'Microsoft® Word 2010', script: false },
    '0200002.pdf': { producer: 'Acrobat Distiller 9.0', script: true },
    '0200003.pdf': { producer: null, script: false },
    '0200004.pdf': { producer: 'TCPDF 6.2', script: false },
  };
  const candidates = crawlCandidates(index, metadata);

  it('takes the PDF files the table lists, without script, within the cap', () => {
    expect(candidates.map((c) => c.id)).toEqual(['cc-0200001.pdf', 'cc-0200003.pdf']);
  });

  it('names the producer class from the table and keeps the table producer as the hint', () => {
    expect(candidates[0]).toMatchObject({ source: CRAWL_SOURCE, group: 'cc-main-2021-31-pdf:pdf', producerClass: 'microsoft-word', hint: 'Microsoft® Word 2010' });
    expect(candidates[1]).toMatchObject({ producerClass: 'unknown', hint: null });
    expect(candidates[0].archive).toBe('https://digitalcorpora.s3.amazonaws.com/corpora/files/CC-MAIN-2021-31-PDF-UNTRUNCATED/zipfiles/0000-0999/0200.zip');
  });
});

describe('profiled candidates', () => {
  const candidates = govdocsCandidates({ '000': [entry('000/000001.doc', 100), entry('000/000002.doc', 200), entry('000/000003.doc', 300), entry('000/000004.doc', 400)] }, new Set());
  const profile = (id: string, over: Partial<Profile> = {}): Profile => ({ id, sha256: 'd'.repeat(64), size: Number(id.slice(3, 9)) * 100, producer: 'Microsoft Word 9.0', excluded: false, ...over });
  const profiles = new Map([profile('gd-000001.doc'), profile('gd-000002.doc', { excluded: true }), profile('gd-000003.doc', { size: 301 })].map((p) => [p.id, p]));

  it('drops a file that carries macros, one whose size differs from the archive, and one that was not profiled', () => {
    expect(profiledCandidates(candidates, profiles).map((c) => c.id)).toEqual(['gd-000001.doc']);
  });

  it('takes the producer class from the producer the file names', () => {
    expect(profiledCandidates(candidates, profiles)[0].producerClass).toBe('microsoft-word');
  });

  it('writes the manifest entry with the digest and the producer', () => {
    const [chosen] = profiledCandidates(candidates, profiles);
    expect(corpusFileOf(chosen, chosen.profile.sha256, chosen.profile.producer)).toEqual({
      id: 'gd-000001.doc',
      source: 'govdocs1',
      format: 'doc',
      size: 100,
      sha256: 'd'.repeat(64),
      producer: 'Microsoft Word 9.0',
      origin: { kind: 'zip', archive: 'https://digitalcorpora.s3.amazonaws.com/corpora/files/govdocs1/zipfiles/000.zip', entry: '000/000001.doc', offset: 100, compressedSize: 40, method: 8 },
    });
  });
});

describe('format of a name', () => {
  it('maps an extension to the registry format and an unknown one to null', () => {
    expect(formatOfName('a/b.DOC')).toBe('doc');
    expect(formatOfName('x.pdf')).toBe('pdf');
    expect(formatOfName('noextension')).toBeNull();
    expect(formatOfName('x.zzzz')).toBeNull();
  });
});
