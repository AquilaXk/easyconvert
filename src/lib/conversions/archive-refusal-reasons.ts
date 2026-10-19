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
 * `nextVolume` gives the name the following volume has, when it can be told (see {@link nextVolumeName}); it is asked for
 * only when the archive turns out to continue in another volume.
 */
export function multiVolumeMessage(
  listing: ReadonlyArray<{ splitAfter?: boolean; splitBefore?: boolean }>,
  nextVolume: () => string | null = () => null
): string | null {
  if (listing.some((entry) => entry.splitAfter === true)) {
    const following = nextVolume();
    const others = following === null ? 'the other parts are' : `the next volume, ${printableEntryName(following)}, is`;
    return `${PREFIX} it is the first part of a multi-volume set and ${others} not part of the upload; upload all parts together as one archive.`;
  }
  if (listing.some((entry) => entry.splitBefore === true)) {
    return `${PREFIX} it is a later part of a multi-volume set and the first part is not part of the upload; upload all parts together as one archive.`;
  }
  return null;
}

const RAR4_MARKER = Buffer.from('Rar!\x1a\x07\x00', 'latin1');
const RAR5_MARKER = Buffer.from('Rar!\x1a\x07\x01\x00', 'latin1');
/** The marker block of a RAR 4.x file is followed by the main header: CRC (2 bytes), type (0x73), flags (2 bytes). */
const RAR4_MAIN_TYPE_OFFSET = RAR4_MARKER.length + 2;
const RAR4_MAIN_FLAGS_OFFSET = RAR4_MAIN_TYPE_OFFSET + 1;
const RAR4_MAIN_HEADER_TYPE = 0x73;
/** Main header flag: the volumes are numbered `.part1.rar`, `.part2.rar`, ... instead of `.rar`, `.r00`, `.r01`, ... */
const RAR4_NEW_NUMBERING_FLAG = 0x0010;
const RAR_HEADER_PROBE_BYTES = RAR4_MAIN_FLAGS_OFFSET + 2;
const RAR_EXTENSION = /\.rar$/i;
const OLD_NUMBERING_FIRST_EXTENSION = '.r00';
/** A name `<base>.part<N>.rar`: the number is the only part that changes from one volume to the next. */
const NEW_NUMBERING_NAME = /^(.+\.part)(\d{1,9})(\.rar)$/i;

function readHeaderProbe(file: string): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const probe = Buffer.alloc(RAR_HEADER_PROBE_BYTES);
    return probe.subarray(0, fs.readSync(fd, probe, 0, probe.length, 0));
  } finally {
    fs.closeSync(fd);
  }
}

function nextPartName(archiveName: string): string | null {
  const parts = NEW_NUMBERING_NAME.exec(archiveName);
  if (parts === null) return null;
  return `${parts[1]}${String(Number(parts[2]) + 1).padStart(parts[2].length, '0')}${parts[3]}`;
}

/**
 * The name the volume after this one has in a RAR set, from the name the caller gave the archive and the numbering the
 * archive declares: a RAR 4.x main header says whether the set is numbered `.partN.rar` or `.rar`, `.r00`, ...; a RAR 5
 * set is numbered by its name alone. Null when the archive is not a RAR, or the numbering cannot be read from the name (a
 * set that was renamed), so the message then says only that the other parts are missing. Reads the first 12 bytes of the file.
 */
export function nextVolumeName(archivePath: string, archiveName: string | undefined): string | null {
  if (archiveName === undefined) return null;
  const leaf = archiveName.split(/[\\/]/).pop() ?? '';
  const probe = readHeaderProbe(archivePath);
  if (probe.subarray(0, RAR5_MARKER.length).equals(RAR5_MARKER)) return nextPartName(leaf);
  if (probe.length < RAR_HEADER_PROBE_BYTES || !probe.subarray(0, RAR4_MARKER.length).equals(RAR4_MARKER)) return null;
  if (probe[RAR4_MAIN_TYPE_OFFSET] !== RAR4_MAIN_HEADER_TYPE) return null;
  if ((probe.readUInt16LE(RAR4_MAIN_FLAGS_OFFSET) & RAR4_NEW_NUMBERING_FLAG) !== 0) return nextPartName(leaf);
  return RAR_EXTENSION.test(leaf) ? leaf.replace(RAR_EXTENSION, OLD_NUMBERING_FIRST_EXTENSION) : null;
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
export function printableEntryName(name: string): string {
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

/** The line 7-Zip prints on stderr for an entry it has no decoder for. */
const UNSUPPORTED_METHOD_PATTERN = /^ERROR: Unsupported Method : (.+)$/m;

/**
 * The message for an entry whose compression method 7-Zip does not decode, naming the entry and the method the listing gives
 * for it. The line must name an entry of the listing exactly: 7-Zip prints the same words, followed by the cause, when a
 * password is wrong, and such a line (or one for a name the listing does not hold) is not claimed here.
 */
export function unsupportedMethodMessage(stderr: string, listing: ReadonlyArray<{ path: string; method?: string }>): string | null {
  const name = UNSUPPORTED_METHOD_PATTERN.exec(stderr)?.[1];
  if (name === undefined) return null;
  const entry = listing.find((listed) => listed.path === name);
  if (entry === undefined) return null;
  const how =
    entry.method === undefined
      ? 'a compression method this 7-Zip build does not decode'
      : `the compression method ${printableEntryName(entry.method)}, which this 7-Zip build does not decode`;
  return `${PREFIX} the data of '${printableEntryName(name)}' uses ${how}.`;
}
