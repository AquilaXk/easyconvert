import type { ListedArchiveEntry } from './archive-extraction-safety';

/**
 * Alternate data streams in the archives 7-Zip reads: an HFS+ attribute or resource fork, an NTFS stream. 7-Zip hands
 * each out as an item of its own named `<file>:<stream>`, which is not a file of the archive. Without a switch it lists
 * none yet extracts them all, so the listing and the extraction disagree. The listing is therefore run with `-sns` (every
 * stream shown, flagged with the listing's `Alternate Stream` property) and the extraction with `-sns-` (none written):
 * the streams are counted and reported, and nothing the listing did not vet reaches the disk (policy 56).
 */
export const LIST_ALTERNATE_STREAMS = '-sns';
export const SKIP_ALTERNATE_STREAMS = '-sns-';

/** The entries a listing vets (alternate streams taken out) and the number of alternate streams it held. */
export interface ArchiveListing {
  entries: ListedArchiveEntry[];
  alternateStreams: number;
}

/**
 * Takes the alternate data streams out of a listing and counts them. A stream is told by the listing's own property and
 * never by its name: `A:attr` is a stream when 7-Zip says so and a drive path when it is a plain entry. Streams are not
 * extracted, so their names and sizes cannot reach the disk and are not vetted or counted against the entry, size and
 * ratio caps; every other entry is vetted exactly as before.
 */
export function separateAlternateStreams(listing: ListedArchiveEntry[]): ArchiveListing {
  const entries = listing.filter((entry) => entry.alternateStream !== true);
  return { entries, alternateStreams: listing.length - entries.length };
}

/** The warning for the alternate streams left out of a conversion; the count is the number 7-Zip listed. */
export function alternateStreamsWarning(count: number): string {
  const noun = count === 1 ? 'alternate stream' : 'alternate streams';
  const verb = count === 1 ? 'was' : 'were';
  return `${count} ${noun} (extended attributes and resource forks of the files) ${verb} left out.`;
}

/** What an extraction left out of the files it handed on: link entries (`skipLinks`) and alternate streams. */
export interface ExtractionFindings {
  skippedLinks: string[];
  alternateStreams: number;
}

/** `result` with what the extraction left out reported: the skipped links, and one warning that counts the alternate streams. */
export function withExtractionNotes<T extends { skippedLinks?: string[]; metadata?: Record<string, unknown> }>(result: T, findings: ExtractionFindings): T {
  return {
    ...result,
    ...(findings.skippedLinks.length > 0 ? { skippedLinks: findings.skippedLinks } : {}),
    ...(findings.alternateStreams > 0 ? { metadata: { ...result.metadata, warnings: [alternateStreamsWarning(findings.alternateStreams)] } } : {}),
  };
}
