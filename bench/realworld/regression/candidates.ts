/**
 * Candidates of the regression corpus: the files of the archive indexes that may be drawn, with the rules that keep out empty and
 * oversized files, names that mark exploit or fuzzer samples, files the real-world corpus already holds, crawl PDFs that carry
 * script, and (after profiling) files with macros. The budgets are the number of files each group holds in the corpus.
 */
import path from 'node:path';
import { getFormatByExtension } from '../../../src/lib/registry';
import type { CorpusFile } from '../manifest';
import { crawlArchiveUrl, govdocsArchiveUrl, isExcludedName } from './build';
import { producerClass } from './producer';
import type { StratumCandidate } from './stratify';

export const GOVDOCS_SOURCE = 'govdocs1';
export const CRAWL_SOURCE = 'cc-main-2021-31-pdf';
/** Files above this size are left out: they dominate fetch and run time (the shard budget, schedule.ts) without adding parser coverage. */
export const SIZE_CAP_BYTES = 8 * 1024 * 1024;

/** Files each group of the corpus holds, sharing the budget equally between its strata of format, producer class and size class. */
export const BUDGETS: Readonly<Record<string, number>> = {
  [`${GOVDOCS_SOURCE}:doc`]: 4000,
  [`${GOVDOCS_SOURCE}:xls`]: 3300,
  [`${GOVDOCS_SOURCE}:ppt`]: 2400,
  [`${GOVDOCS_SOURCE}:pps`]: 400,
  [`${GOVDOCS_SOURCE}:docx`]: 400,
  [`${GOVDOCS_SOURCE}:xlsx`]: 400,
  [`${GOVDOCS_SOURCE}:pptx`]: 400,
  [`${GOVDOCS_SOURCE}:pdf`]: 4500,
  [`${CRAWL_SOURCE}:pdf`]: 5000,
};
const OFFICE_FORMATS: ReadonlySet<string> = new Set(['doc', 'xls', 'ppt', 'pps', 'docx', 'xlsx', 'pptx']);

/** An entry of an archive's central directory. */
export type IndexEntry = [name: string, offset: number, compressedSize: number, method: number, size: number];
export type ArchiveIndex = Readonly<Record<string, readonly IndexEntry[]>>;
export type CrawlMetadata = Readonly<Record<string, { producer: string | null; script: boolean }>>;

export interface Candidate extends StratumCandidate {
  source: string;
  archive: string;
  entry: string;
  offset: number;
  compressedSize: number;
  method: number;
  /** Producer named by the crawl metadata table, used where the file itself names none. */
  hint: string | null;
}

/** What profiling a candidate found out by reading its bytes. */
export interface Profile {
  id: string;
  sha256: string;
  size: number;
  producer: string | null;
  /** The file carries macros or script. */
  excluded: boolean;
}

export const formatOfName = (name: string): string | null => {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? null : (getFormatByExtension(name.slice(dot + 1).toLowerCase())?.id ?? null);
};

const usableSize = (size: number): boolean => size > 0 && size <= SIZE_CAP_BYTES;

/** Office and PDF files of the government corpus's archives (`index` is keyed by archive number); `taken` holds `archive entry` keys already in the real-world corpus. */
export function govdocsCandidates(index: ArchiveIndex, taken: ReadonlySet<string>): Candidate[] {
  const out: Candidate[] = [];
  for (const [zip, entries] of Object.entries(index)) {
    const archive = govdocsArchiveUrl(Number(zip));
    for (const [name, offset, compressedSize, method, size] of entries) {
      const format = formatOfName(name);
      const wanted = format !== null && (OFFICE_FORMATS.has(format) || format === 'pdf');
      if (!wanted || !usableSize(size) || isExcludedName(name) || taken.has(`${archive} ${name}`)) continue;
      out.push({ id: `gd-${path.basename(name).toLowerCase()}`, source: GOVDOCS_SOURCE, group: `${GOVDOCS_SOURCE}:${format}`, format, producerClass: 'unknown', size, archive, entry: name, offset, compressedSize, method, hint: null });
    }
  }
  return out;
}

/** PDF files of the crawl corpus's archives that the metadata table lists and that carry no script. */
export function crawlCandidates(index: ArchiveIndex, metadata: CrawlMetadata): Candidate[] {
  const out: Candidate[] = [];
  for (const [zip, entries] of Object.entries(index)) {
    const archive = crawlArchiveUrl(Number(zip));
    for (const [name, offset, compressedSize, method, size] of entries) {
      const row = metadata[name];
      if (row === undefined || row.script || !name.endsWith('.pdf') || !usableSize(size) || isExcludedName(name)) continue;
      out.push({ id: `cc-${name.toLowerCase()}`, source: CRAWL_SOURCE, group: `${CRAWL_SOURCE}:pdf`, format: 'pdf', producerClass: producerClass(row.producer), size, archive, entry: name, offset, compressedSize, method, hint: row.producer });
    }
  }
  return out;
}

/** The candidates with the producer the file itself names, and without the files that carry macros or script or whose size is not the one the archive lists. */
export function profiledCandidates(candidates: readonly Candidate[], profiles: ReadonlyMap<string, Profile>): Array<Candidate & { profile: Profile }> {
  return candidates.flatMap((candidate) => {
    const profile = profiles.get(candidate.id);
    if (profile === undefined || profile.excluded || profile.size !== candidate.size) return [];
    return [{ ...candidate, producerClass: producerClass(profile.producer), profile }];
  });
}

export const corpusFileOf = (candidate: Candidate, digest: string, producer: string | null): CorpusFile => ({
  id: candidate.id,
  source: candidate.source,
  format: candidate.format,
  size: candidate.size,
  sha256: digest,
  origin: { kind: 'zip', archive: candidate.archive, entry: candidate.entry, offset: candidate.offset, compressedSize: candidate.compressedSize, method: candidate.method },
  ...(producer === null ? {} : { producer }),
});
