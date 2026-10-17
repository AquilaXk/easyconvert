import fs from 'node:fs';
import path from 'node:path';

/**
 * Why an archive 7-Zip cannot convert cannot be converted, in words that name the limit of the file instead of 7-Zip's
 * "malformed or unsupported". Each function returns the message for its case, or null when the case does not apply; the
 * extraction safety module wraps the message in its typed error.
 */

const PREFIX = 'Could not read the archive:';

/**
 * An entry that continues in another volume (or began in another) means the archive is one part of a multi-volume set whose
 * other parts are not here: its data is incomplete, which 7-Zip would report only as a missing volume after extracting.
 */
export function multiVolumeMessage(listing: ReadonlyArray<{ splitAfter?: boolean; splitBefore?: boolean }>): string | null {
  if (listing.some((entry) => entry.splitAfter === true)) {
    return `${PREFIX} it is the first part of a multi-volume set and the other parts are not part of the upload; upload all parts together as one archive.`;
  }
  if (listing.some((entry) => entry.splitBefore === true)) {
    return `${PREFIX} it is a later part of a multi-volume set and the first part is not part of the upload; upload all parts together as one archive.`;
  }
  return null;
}

const DISK_IMAGE_EXTENSIONS = new Set(['.img', '.dmg']);
/** The Master Directory Block of a classic HFS volume starts at byte 1024 with the signature "BD". */
const CLASSIC_HFS_SIGNATURE_OFFSET = 1024;
const CLASSIC_HFS_SIGNATURE = Buffer.from('BD', 'latin1');

function hasClassicHfsSignature(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const found = Buffer.alloc(CLASSIC_HFS_SIGNATURE.length);
    fs.readSync(fd, found, 0, found.length, CLASSIC_HFS_SIGNATURE_OFFSET);
    return found.equals(CLASSIC_HFS_SIGNATURE);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The reason 7-Zip could not open a disk image, which it reports only as "cannot open the file as archive": a classic HFS
 * volume (the Mac OS 8 and earlier format, which it does not read), or an image with no file system it reads.
 */
export function diskImageMessage(archivePath: string): string | null {
  if (!DISK_IMAGE_EXTENSIONS.has(path.extname(archivePath).toLowerCase())) return null;
  if (hasClassicHfsSignature(archivePath)) {
    return `${PREFIX} it is a classic HFS volume (the Mac OS 8 and earlier format), which is not supported; HFS+ and other current file systems are.`;
  }
  return `${PREFIX} the disk image holds no file system that can be read (it may be blank, unformatted or use an unsupported file system).`;
}

/** The entry 7-Zip names on its own error line when the data of an entry does not decode or fails its checksum. */
const DAMAGED_ENTRY_PATTERN = /^ERROR: (?:Data Error|CRC Failed) : (.+)$/m;
const MAX_REPORTED_NAME_CHARACTERS = 120;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is removed from a name echoed in a message
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/** An entry name of an untrusted archive, made safe to echo in a message: no control characters, bounded length. */
function printableEntryName(name: string): string {
  const clean = name.replace(CONTROL_CHARACTERS, '?');
  return clean.length > MAX_REPORTED_NAME_CHARACTERS ? `${clean.slice(0, MAX_REPORTED_NAME_CHARACTERS)}...` : clean;
}

/** What 7-Zip calls the one stream of a compression wrapper (xz, gzip, ...), which has no name of its own. */
const NAMELESS_STREAM = '~';

/** The message for an entry whose data is damaged, from 7-Zip's stderr, naming the first such entry. */
export function damagedEntryMessage(stderr: string): string | null {
  const name = DAMAGED_ENTRY_PATTERN.exec(stderr)?.[1];
  if (name === undefined) return null;
  const what = name === NAMELESS_STREAM ? 'the compressed data' : `the data of '${printableEntryName(name)}'`;
  return `${PREFIX} ${what} is damaged (7-Zip reports a data error).`;
}
