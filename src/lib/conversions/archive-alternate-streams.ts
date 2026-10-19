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

const PATH_SEPARATOR = /[\\/]/;

/** A stream is named `<file>:<stream>`, so the property is believed only for a path with a colon after its last separator. */
function isAlternateStream(entry: ListedArchiveEntry): boolean {
  return entry.alternateStream === true && (entry.path.split(PATH_SEPARATOR).pop() ?? '').includes(':');
}

/**
 * Takes the alternate data streams out of a listing and counts them. A stream is told by the listing's own property and
 * not by its name alone: `A:attr` is a stream when 7-Zip says so and a drive path when it is a plain entry. The property
 * is believed only for a name that has the shape of a stream (a colon in its last segment), so a forged flag on a plain
 * name leaves the entry vetted as any other. Streams are not extracted, so their names and sizes cannot reach the disk
 * and are not vetted or counted against the entry, size and ratio caps; every other entry is vetted exactly as before.
 */
export function separateAlternateStreams(listing: ListedArchiveEntry[]): ArchiveListing {
  const entries = listing.filter((entry) => !isAlternateStream(entry));
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

/** The warnings a result already carries, if it carries any. */
function warningsOf(metadata: Record<string, unknown> | undefined): unknown[] {
  const warnings = metadata?.warnings;
  return Array.isArray(warnings) ? warnings : [];
}

/**
 * `result` with what the extraction left out reported: the skipped links, and one warning that counts the alternate
 * streams, added after the warnings the result already has.
 */
export function withExtractionNotes<T extends { skippedLinks?: string[]; metadata?: Record<string, unknown> }>(result: T, findings: ExtractionFindings): T {
  const warning = alternateStreamsWarning(findings.alternateStreams);
  return {
    ...result,
    ...(findings.skippedLinks.length > 0 ? { skippedLinks: findings.skippedLinks } : {}),
    ...(findings.alternateStreams > 0 ? { metadata: { ...result.metadata, warnings: [...warningsOf(result.metadata), warning] } } : {}),
  };
}
