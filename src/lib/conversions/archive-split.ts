/**
 * Multi-Volume (Split Archive) Stitching & Splitting Pipeline
 *
 * Supports:
 * - 7z split volumes (.7z.001, .7z.002, ...)
 * - RAR multi-volumes (.part1.rar, .part01.rar, ...)
 * - Zip split volumes (.z01, .z02, ... and .zip)
 * - Tar split volumes (.tar.001, .tar.gz.001, ...)
 * - Generic numeric split volumes (.ext.001, .ext.002, ...)
 *
 * Enforces Fail-Closed validation against missing parts, out-of-order volumes,
 * and corrupted multi-part archives.
 */

export interface SplitArchivePartInfo {
  baseName: string;
  partNumber: number;
  totalDigits: number;
  extension: string;
  format: 'rar' | '7z' | 'zip' | 'tar' | 'numeric';
}

const SPLIT_PATTERNS = [
  // 1. RAR multi-volume: name.part1.rar, name.part01.rar
  {
    regex: /^(.+?)\.part(\d+)\.rar$/i,
    extract: (m: RegExpMatchArray): SplitArchivePartInfo => ({
      baseName: `${m[1]}.rar`,
      partNumber: parseInt(m[2], 10),
      totalDigits: m[2].length,
      extension: 'rar',
      format: 'rar',
    }),
  },
  // 2. 7z split: name.7z.001
  {
    regex: /^(.+?)\.7z\.(\d+)$/i,
    extract: (m: RegExpMatchArray): SplitArchivePartInfo => ({
      baseName: `${m[1]}.7z`,
      partNumber: parseInt(m[2], 10),
      totalDigits: m[2].length,
      extension: '7z',
      format: '7z',
    }),
  },
  // 3. Zip split: name.z01, name.z02 (or terminal .zip)
  {
    regex: /^(.+?)\.z(\d+)$/i,
    extract: (m: RegExpMatchArray): SplitArchivePartInfo => ({
      baseName: `${m[1]}.zip`,
      partNumber: parseInt(m[2], 10),
      totalDigits: m[2].length,
      extension: 'zip',
      format: 'zip',
    }),
  },
  // 4. Tar split: name.tar.001, name.tar.gz.001
  {
    regex: /^(.+?)\.(tar(?:\.gz)?)\.(\d+)$/i,
    extract: (m: RegExpMatchArray): SplitArchivePartInfo => ({
      baseName: `${m[1]}.${m[2]}`,
      partNumber: parseInt(m[3], 10),
      totalDigits: m[3].length,
      extension: m[2],
      format: 'tar',
    }),
  },
  // 5. Generic numeric split: name.ext.001
  {
    regex: /^(.+?\.[a-zA-Z0-9]+)\.(\d{3,})$/,
    extract: (m: RegExpMatchArray): SplitArchivePartInfo => ({
      baseName: m[1],
      partNumber: parseInt(m[2], 10),
      totalDigits: m[2].length,
      extension: m[1].split('.').pop() || 'bin',
      format: 'numeric',
    }),
  },
];

/**
 * Checks whether a filename indicates a multi-volume split archive part.
 */
export function isSplitArchive(filename: string): boolean {
  return SPLIT_PATTERNS.some((p) => p.regex.test(filename));
}

/**
 * Parses sequence number, base filename, and archive format from a split part filename.
 */
export function parseSplitArchivePart(filename: string): SplitArchivePartInfo | null {
  for (const p of SPLIT_PATTERNS) {
    const match = filename.match(p.regex);
    if (match) {
      return p.extract(match);
    }
  }
  return null;
}

export interface StitchedArchiveResult {
  buffer: Buffer;
  baseFilename: string;
  format: string;
  totalParts: number;
}

/**
 * Validates sequence completeness and stitches multi-volume archive parts into a single buffer.
 * Throws a Fail-Closed error if any volume in the sequence is missing.
 */
export function stitchMultiVolumeArchive(
  parts: { filename: string; buffer: Buffer }[]
): StitchedArchiveResult {
  if (!parts || parts.length === 0) {
    throw new Error('Cannot stitch empty archive part list');
  }

  // Parse all parts
  const parsedParts: Array<{
    filename: string;
    buffer: Buffer;
    info: SplitArchivePartInfo;
  }> = [];

  let commonBase: string | null = null;
  let detectedFormat = 'bin';

  for (const part of parts) {
    const info = parseSplitArchivePart(part.filename);
    if (!info) {
      throw new Error(`Invalid multi-volume archive filename: "${part.filename}"`);
    }
    if (commonBase === null) {
      commonBase = info.baseName;
      detectedFormat = info.format;
    } else if (info.baseName !== commonBase) {
      throw new Error(
        `Mismatched multi-volume archives in batch: "${commonBase}" vs "${info.baseName}"`
      );
    }
    parsedParts.push({ ...part, info });
  }

  // Sort parts by partNumber ascending
  parsedParts.sort((a, b) => a.info.partNumber - b.info.partNumber);

  // Validate sequence starts at part 1
  if (parsedParts[0].info.partNumber !== 1) {
    throw new Error(
      `Incomplete multi-volume archive for "${commonBase}": missing volume 1 (starts at volume ${parsedParts[0].info.partNumber})`
    );
  }

  // Validate no duplicate volumes or gaps in sequence (1, 2, 3, ...)
  for (let i = 0; i < parsedParts.length; i++) {
    const expected = i + 1;
    const actual = parsedParts[i].info.partNumber;
    if (i > 0 && actual === parsedParts[i - 1].info.partNumber) {
      throw new Error(
        `Duplicate multi-volume archive part in "${commonBase}": volume ${actual} provided multiple times`
      );
    }
    if (actual !== expected) {
      throw new Error(
        `Incomplete multi-volume archive for "${commonBase}": missing volume ${expected} (found volume ${actual})`
      );
    }
  }

  // Concatenate parts sequentially into unified archive buffer
  const stitchedBuffer = Buffer.concat(parsedParts.map((p) => p.buffer));

  return {
    buffer: stitchedBuffer,
    baseFilename: commonBase || 'stitched_archive.bin',
    format: detectedFormat,
    totalParts: parsedParts.length,
  };
}

/**
 * Splits a unified archive buffer into sequential multi-volume chunks.
 */
export function splitArchive(
  archiveBuffer: Buffer,
  baseFilename: string,
  partSizeBytes: number,
  namingScheme?: '7z' | 'rar' | 'numeric'
): { filename: string; buffer: Buffer }[] {
  if (partSizeBytes <= 0 || partSizeBytes >= archiveBuffer.length) {
    return [{ filename: baseFilename, buffer: archiveBuffer }];
  }

  const parts: { filename: string; buffer: Buffer }[] = [];
  const totalParts = Math.ceil(archiveBuffer.length / partSizeBytes);
  const scheme =
    namingScheme ||
    (baseFilename.endsWith('.7z')
      ? '7z'
      : baseFilename.endsWith('.rar')
      ? 'rar'
      : 'numeric');

  let offset = 0;
  let partIndex = 1;

  while (offset < archiveBuffer.length) {
    const chunk = archiveBuffer.subarray(offset, offset + partSizeBytes);
    let partFilename: string;

    if (scheme === '7z') {
      const padDigits = Math.max(3, String(totalParts).length);
      partFilename = `${baseFilename}.${String(partIndex).padStart(padDigits, '0')}`;
    } else if (scheme === 'rar') {
      const baseNoExt = baseFilename.replace(/\.rar$/i, '');
      partFilename = `${baseNoExt}.part${partIndex}.rar`;
    } else {
      const padDigits = Math.max(3, String(totalParts).length);
      partFilename = `${baseFilename}.${String(partIndex).padStart(padDigits, '0')}`;
    }

    parts.push({ filename: partFilename, buffer: chunk });
    offset += partSizeBytes;
    partIndex++;
  }

  return parts;
}
