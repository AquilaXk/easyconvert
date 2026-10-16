/**
 * Helpers of the script that builds the regression corpus manifest (scripts/regression-corpus-manifest.ts): the archive addresses
 * of the two corpora, a streaming CSV reader for the crawl corpus's metadata tables, and the rule that keeps malicious-file
 * samples out. The corpora are read only through the digital corpora archive, never through UNSAFE-DOCS.
 */

export const GOVDOCS_ARCHIVE_BASE = 'https://digitalcorpora.s3.amazonaws.com/corpora/files/govdocs1/zipfiles';
export const CRAWL_ARCHIVE_BASE = 'https://digitalcorpora.s3.amazonaws.com/corpora/files/CC-MAIN-2021-31-PDF-UNTRUNCATED/zipfiles';
export const CRAWL_METADATA_URL = 'https://digitalcorpora.s3.amazonaws.com/corpora/files/CC-MAIN-2021-31-PDF-UNTRUNCATED/metadata/pdfinfo-20230315.csv.gz';
const GOVDOCS_ARCHIVE_DIGITS = 3;
const CRAWL_ARCHIVE_DIGITS = 4;
const CRAWL_ARCHIVES_PER_DIRECTORY = 1000;

export const govdocsArchiveUrl = (n: number): string => `${GOVDOCS_ARCHIVE_BASE}/${String(n).padStart(GOVDOCS_ARCHIVE_DIGITS, '0')}.zip`;

export function crawlArchiveUrl(n: number): string {
  const first = Math.floor(n / CRAWL_ARCHIVES_PER_DIRECTORY) * CRAWL_ARCHIVES_PER_DIRECTORY;
  const directory = `${String(first).padStart(CRAWL_ARCHIVE_DIGITS, '0')}-${String(first + CRAWL_ARCHIVES_PER_DIRECTORY - 1).padStart(CRAWL_ARCHIVE_DIGITS, '0')}`;
  return `${CRAWL_ARCHIVE_BASE}/${directory}/${String(n).padStart(CRAWL_ARCHIVE_DIGITS, '0')}.zip`;
}

/** Names that mark a file as an exploit sample, a fuzzer output or malware: those belong to the security batch (#761). */
const EXCLUDED_NAME = /(^|[^a-z])(cve|edb|unsafe|fuzz|fuzzed|crash|exploit|poc|malware|malicious|virus|trojan)([^a-z]|$)/i;

export const isExcludedName = (name: string): boolean => EXCLUDED_NAME.test(name);

/** The records of a CSV text (RFC 4180) read chunk by chunk: quoted fields may hold commas, doubled quotes and line breaks. */
export async function* csvRecords(chunks: AsyncIterable<string>): AsyncGenerator<string[]> {
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let quoteSeen = false;
  let first = true;
  for await (const chunk of chunks) {
    const text = first ? chunk.replace(/^﻿/, '') : chunk;
    first = false;
    for (const char of text) {
      if (quoteSeen) {
        quoteSeen = false;
        if (char === '"') {
          field += '"';
          continue;
        }
        quoted = false;
      }
      if (quoted) {
        if (char === '"') quoteSeen = true;
        else field += char;
      } else if (char === '"' && field === '') {
        quoted = true;
      } else if (char === ',') {
        record.push(field);
        field = '';
      } else if (char === '\n') {
        record.push(field.replace(/\r$/, ''));
        yield record;
        record = [];
        field = '';
      } else {
        field += char;
      }
    }
  }
  if (field !== '' || record.length > 0) {
    record.push(field.replace(/\r$/, ''));
    yield record;
  }
}

export interface CrawlRecord {
  fileName: string;
  /** The Producer of the PDF's Info dictionary, else its Creator. */
  producer: string | null;
  /** The file carries JavaScript (poppler's report). */
  script: boolean;
}

/** The crawl metadata table as records: only the columns the manifest build needs. */
export function pdfinfoRecords(rows: readonly string[][]): CrawlRecord[] {
  const [header, ...body] = rows;
  const column = (name: string): number => {
    const at = header.indexOf(name);
    if (at === -1) throw new Error(`crawl metadata table has no ${name} column`);
    return at;
  };
  const [fileName, producer, creator, script] = ['file_name', 'producer', 'creator', 'javascript'].map(column);
  return body.map((row) => ({
    fileName: row[fileName],
    producer: row[producer].trim() || row[creator].trim() || null,
    script: row[script] === 'yes',
  }));
}
