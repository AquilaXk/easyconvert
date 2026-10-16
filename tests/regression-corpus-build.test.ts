import { describe, expect, it } from 'vitest';
import { crawlArchiveUrl, csvRecords, CRAWL_ARCHIVE_BASE, govdocsArchiveUrl, isExcludedName, pdfinfoRecords } from '../bench/realworld/regression/build';

/** The helpers that build the regression corpus manifest: a streaming CSV reader, the crawl metadata table, archive addresses and the exclusion rule. */

async function* chunks(...parts: string[]): AsyncGenerator<string> {
  for (const part of parts) yield part;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

describe('csv records', () => {
  it('reads quoted fields with commas, doubled quotes and line breaks', async () => {
    const text = 'a,b,c\r\n1,"x, y",z\r\n"line\nbreak","say ""hi""",\r\n';
    expect(await collect(csvRecords(chunks(text)))).toEqual([['a', 'b', 'c'], ['1', 'x, y', 'z'], ['line\nbreak', 'say "hi"', '']]);
  });

  it('gives the same records however the text is cut into chunks, and drops a byte order mark', async () => {
    const text = '﻿id,name\n1,"A ""quoted"" name"\n2,plain\n';
    const whole = await collect(csvRecords(chunks(text)));
    for (let cut = 1; cut < text.length; cut++) expect(await collect(csvRecords(chunks(text.slice(0, cut), text.slice(cut))))).toEqual(whole);
    expect(whole[0]).toEqual(['id', 'name']);
    expect(whole[1]).toEqual(['1', 'A "quoted" name']);
  });

  it('ends a last record that has no line break', async () => {
    expect(await collect(csvRecords(chunks('a,b\n1,2')))).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('crawl metadata table', () => {
  const header = 'url_id,file_name,exit_value,creator,producer,javascript,pages';
  const rows = [header, '1,0000001.pdf,0,Word,Microsoft Word 2010,no,3', '2,0000002.pdf,0,Writer,,no,1', '3,0000003.pdf,0,,,yes,2', '4,0000004.pdf,1,,,,0'].map((line) => line.split(','));

  it('keeps the file name, the producer (the creator when there is none) and whether the file carries script', () => {
    expect(pdfinfoRecords(rows)).toEqual([
      { fileName: '0000001.pdf', producer: 'Microsoft Word 2010', script: false },
      { fileName: '0000002.pdf', producer: 'Writer', script: false },
      { fileName: '0000003.pdf', producer: null, script: true },
      { fileName: '0000004.pdf', producer: null, script: false },
    ]);
  });

  it('refuses a table without the columns it needs', () => {
    expect(() => pdfinfoRecords([['url_id', 'file_name']])).toThrow(/producer/);
  });
});

describe('archive addresses and exclusions', () => {
  it('names the archives of the two corpora', () => {
    expect(govdocsArchiveUrl(7)).toBe('https://digitalcorpora.s3.amazonaws.com/corpora/files/govdocs1/zipfiles/007.zip');
    expect(crawlArchiveUrl(1234)).toBe(`${CRAWL_ARCHIVE_BASE}/1000-1999/1234.zip`);
    expect(crawlArchiveUrl(5)).toBe(`${CRAWL_ARCHIVE_BASE}/0000-0999/0005.zip`);
  });

  it('refuses names that mark a file as malicious, fuzzed or an exploit sample', () => {
    for (const name of ['000/cve-2019-1234.doc', 'unsafe-docs/x.pdf', 'fuzz/crash-1.pdf', 'poc_exploit.doc', 'malware.xls', 'EDB-12345.pdf']) expect(isExcludedName(name)).toBe(true);
    for (const name of ['000/000123.doc', '0000007.pdf', 'budget-2009.xls']) expect(isExcludedName(name)).toBe(false);
  });
});
