/**
 * Multi-Volume (Split Archive) Stitching, Streaming & Splitting Pipeline
 *
 * Supports:
 * - 7z split volumes (.7z.001, .7z.002, ...)
 * - RAR multi-volumes (.part1.rar, .part01.rar, ...)
 * - Zip split volumes (.z01, .z02, ... and .zip)
 * - Tar split volumes (.tar.001, .tar.gz.001, ...)
 * - Generic numeric split volumes (.ext.001, .ext.002, ...)
 *
 * Features:
 * - Virtual Spanned Readable Stream (VFS Pipeline) with O(1) memory consumption
 * - Backpressure-aware chunk delivery with single-active-FD lifecycle management
 * - Zero-leak resource cleanup on consumer cancel / destroy
 * - Fail-Closed validation against missing parts, sequence gaps, duplicates, and corrupt names
 * - Direct streaming to disk and standard input (stdin)
 */

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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
 * In-memory buffer stitching limit (500MB).
 * Beyond this threshold, callers MUST use createVirtualSpannedStream or stitchMultiVolumeToDisk
 * to prevent V8 heap exhaustion and Buffer.constants.MAX_LENGTH overflow.
 */
export const MAX_STITCH_BUFFER_SIZE = 500 * 1024 * 1024; // 500MB

/**
 * Fail-Closed error thrown when multi-volume stitching exceeds safe in-memory buffer limit.
 */
export class MultiVolumeBufferOverflowError extends Error {
  public readonly code = 'ERR_MULTI_VOLUME_BUFFER_OVERFLOW';
  public readonly totalBytes: number;
  public readonly limitBytes: number;

  constructor(totalBytes: number, limitBytes: number = MAX_STITCH_BUFFER_SIZE) {
    super(
      `Multi-volume archive total size (${(totalBytes / (1024 * 1024)).toFixed(1)}MB) ` +
        `exceeds in-memory stitching limit (${(limitBytes / (1024 * 1024)).toFixed(0)}MB). ` +
        `Use createVirtualSpannedStream() or stitchMultiVolumeToDisk() to stream without memory limits.`
    );
    this.name = 'MultiVolumeBufferOverflowError';
    this.totalBytes = totalBytes;
    this.limitBytes = limitBytes;
  }
}

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

export interface VirtualSpannedPartSource {
  filename: string;
  filePath?: string;
  buffer?: Buffer;
  createStream?: () => NodeJS.ReadableStream;
  sizeBytes?: number;
}

export interface VirtualSpannedStreamOptions {
  highWaterMark?: number;
  signal?: AbortSignal;
  onProgress?: (bytesRead: number, totalBytes: number | null) => void;
}

export interface SpannedArchiveMetadata {
  baseFilename: string;
  format: 'rar' | '7z' | 'zip' | 'tar' | 'numeric';
  totalParts: number;
  totalSizeBytes: number | null;
  parts: SplitArchivePartInfo[];
}

/**
 * Normalizes, validates, and sorts split archive parts into strict ascending sequence.
 * Enforces Fail-Closed validation against missing part 1, sequence gaps, duplicates,
 * mismatched base archive names, and missing disk files.
 */
export function validateAndSortSplitParts(
  parts: Array<string | VirtualSpannedPartSource | { filename: string; buffer: Buffer }>
): {
  sortedParts: Array<VirtualSpannedPartSource & { info: SplitArchivePartInfo }>;
  metadata: SpannedArchiveMetadata;
} {
  if (!parts || !Array.isArray(parts) || parts.length === 0) {
    throw new Error('Cannot process empty archive part list');
  }

  // Pre-scan for zip split bases (e.g. data.z01 -> baseName is data.zip)
  const zipSplitBases = new Set<string>();
  for (const rawPart of parts) {
    const fn = typeof rawPart === 'string' ? path.basename(rawPart) : rawPart.filename;
    const parsed = parseSplitArchivePart(fn);
    if (parsed && parsed.format === 'zip') {
      zipSplitBases.add(parsed.baseName.toLowerCase());
    }
  }

  const normalizedParts: Array<VirtualSpannedPartSource & { info: SplitArchivePartInfo }> = [];
  let commonBase: string | null = null;
  let detectedFormat: 'rar' | '7z' | 'zip' | 'tar' | 'numeric' = 'numeric';

  for (const rawPart of parts) {
    let source: VirtualSpannedPartSource;

    if (typeof rawPart === 'string') {
      const resolved = path.resolve(rawPart);
      if (!fs.existsSync(resolved)) {
        throw new Error(`Split archive part file not found on disk: "${rawPart}"`);
      }
      const stat = fs.statSync(resolved);
      source = {
        filename: path.basename(resolved),
        filePath: resolved,
        sizeBytes: stat.size,
      };
    } else {
      source = { ...rawPart };
      if (source.filePath) {
        const resolved = path.resolve(source.filePath);
        if (!fs.existsSync(resolved)) {
          throw new Error(`Split archive part file not found on disk: "${source.filePath}"`);
        }
        if (source.sizeBytes === undefined) {
          source.sizeBytes = fs.statSync(resolved).size;
        }
        source.filePath = resolved;
      } else if (source.buffer) {
        if (source.sizeBytes === undefined) {
          source.sizeBytes = source.buffer.length;
        }
      }
    }

    let info = parseSplitArchivePart(source.filename);
    if (!info && zipSplitBases.has(source.filename.toLowerCase())) {
      // Terminal .zip volume in a PKZIP multi-volume split set (e.g. name.zip along with name.z01)
      info = {
        baseName: source.filename,
        partNumber: -1, // Sentinel indicating terminal volume, resolved after collecting all parts
        totalDigits: 0,
        extension: 'zip',
        format: 'zip',
      };
    }
    if (!info) {
      throw new Error(`Invalid multi-volume archive filename: "${source.filename}"`);
    }

    if (commonBase === null) {
      commonBase = info.baseName;
      detectedFormat = info.format;
    } else if (info.baseName !== commonBase) {
      throw new Error(
        `Mismatched multi-volume archives in batch: "${commonBase}" vs "${info.baseName}"`
      );
    }

    normalizedParts.push({ ...source, info });
  }

  // Resolve terminal .zip volume part number (if any)
  const terminalZipParts = normalizedParts.filter(
    (p) => p.info.format === 'zip' && p.info.partNumber === -1
  );
  if (terminalZipParts.length > 1) {
    throw new Error(
      `Duplicate multi-volume archive part in "${commonBase}": terminal volume provided multiple times`
    );
  }
  if (terminalZipParts.length === 1) {
    const numericParts = normalizedParts.filter(
      (p) => p.info.format === 'zip' && p.info.partNumber > 0
    );
    const maxPart = numericParts.reduce((max, p) => Math.max(max, p.info.partNumber), 0);
    terminalZipParts[0].info.partNumber = maxPart + 1;
  }

  // Sort parts by partNumber ascending
  normalizedParts.sort((a, b) => a.info.partNumber - b.info.partNumber);

  // Validate sequence starts strictly at part 1
  if (normalizedParts[0].info.partNumber !== 1) {
    throw new Error(
      `Incomplete multi-volume archive for "${commonBase}": missing volume 1 (starts at volume ${normalizedParts[0].info.partNumber})`
    );
  }

  // Validate no duplicate volumes or gaps in sequence (1, 2, 3, ...)
  for (let i = 0; i < normalizedParts.length; i++) {
    const expected = i + 1;
    const actual = normalizedParts[i].info.partNumber;
    if (i > 0 && actual === normalizedParts[i - 1].info.partNumber) {
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

  let totalSizeBytes: number | null = 0;
  for (const p of normalizedParts) {
    if (typeof p.sizeBytes === 'number') {
      totalSizeBytes! += p.sizeBytes;
    } else {
      totalSizeBytes = null;
      break;
    }
  }

  const metadata: SpannedArchiveMetadata = {
    baseFilename: commonBase || 'stitched_archive.bin',
    format: detectedFormat,
    totalParts: normalizedParts.length,
    totalSizeBytes,
    parts: normalizedParts.map((p) => p.info),
  };

  return { sortedParts: normalizedParts, metadata };
}

/**
 * Virtual Spanned Readable Stream (VFS Pipeline).
 *
 * Streams multi-volume archive parts sequentially as a continuous byte stream.
 * Opens only one file descriptor / stream at a time, enforcing O(1) bounded memory
 * and zero file descriptor leaks under backpressure and early consumer cancellation.
 */
export class VirtualSpannedStream extends Readable {
  private readonly parts: VirtualSpannedPartSource[];
  public readonly metadata: SpannedArchiveMetadata;
  private readonly streamOptions?: VirtualSpannedStreamOptions;
  private currentPartIndex = 0;
  private currentChildStream: NodeJS.ReadableStream | null = null;
  private currentBufferOffset = 0;
  private totalBytesStreamed = 0;
  private isDestroying = false;
  private reading = false;
  private canPush = true;
  private pendingTransitionTimer: NodeJS.Timeout | null = null;
  private abortHandler: (() => void) | null = null;

  constructor(
    parts: VirtualSpannedPartSource[],
    metadata: SpannedArchiveMetadata,
    options?: VirtualSpannedStreamOptions
  ) {
    super({
      highWaterMark: options?.highWaterMark ?? 64 * 1024,
    });
    this.parts = parts;
    this.metadata = metadata;
    this.streamOptions = options;

    if (options?.signal) {
      if (options.signal.aborted) {
        queueMicrotask(() => {
          this.destroy(options.signal!.reason || new Error('Aborted'));
        });
      } else {
        this.abortHandler = () => {
          this.destroy(options.signal!.reason || new Error('Aborted'));
        };
        options.signal.addEventListener('abort', this.abortHandler, { once: true });
      }
    }
  }

  override _read(size: number): void {
    if (this.isDestroying) return;
    this.canPush = true;

    // If currently streaming from an active child stream that was paused by backpressure, resume it
    if (this.currentChildStream) {
      if (typeof (this.currentChildStream as any).resume === 'function') {
        (this.currentChildStream as any).resume();
      }
      return;
    }

    if (this.reading) return;
    this.reading = true;
    this.pump();
  }

  private pump(): void {
    if (this.isDestroying || !this.canPush) {
      this.reading = false;
      return;
    }

    // 1. If currently streaming from an active child stream, resume it if paused
    if (this.currentChildStream) {
      if (typeof (this.currentChildStream as any).resume === 'function') {
        (this.currentChildStream as any).resume();
      }
      this.reading = false;
      return;
    }

    // 2. Check if all parts have been consumed
    if (this.currentPartIndex >= this.parts.length) {
      this.reading = false;
      this.push(null); // Signal EOF
      return;
    }

    const currentPart = this.parts[this.currentPartIndex];

    // 3. Part is an in-memory Buffer
    if (currentPart.buffer) {
      const buf = currentPart.buffer;
      const hwm = this.readableHighWaterMark || 64 * 1024;

      while (this.canPush && this.currentBufferOffset < buf.length) {
        const end = Math.min(this.currentBufferOffset + hwm, buf.length);
        const chunk = buf.subarray(this.currentBufferOffset, end);
        this.currentBufferOffset = end;
        this.totalBytesStreamed += chunk.length;

        if (this.streamOptions?.onProgress) {
          try {
            this.streamOptions.onProgress(this.totalBytesStreamed, this.metadata.totalSizeBytes);
          } catch {}
        }

        this.canPush = this.push(chunk);
      }

      if (this.currentBufferOffset >= buf.length) {
        this.currentBufferOffset = 0;
        this.currentPartIndex++;
        if (this.canPush) {
          this.pump();
          return;
        }
      }

      this.reading = false;
      return;
    }

    // 4. Part is a file path or custom stream factory
    let childStream: NodeJS.ReadableStream;
    try {
      if (currentPart.createStream) {
        childStream = currentPart.createStream();
      } else if (currentPart.filePath) {
        childStream = fs.createReadStream(currentPart.filePath, {
          highWaterMark: this.readableHighWaterMark || 64 * 1024,
        });
      } else {
        throw new Error(
          `Split archive part "${currentPart.filename}" has neither buffer, filePath, nor createStream.`
        );
      }
    } catch (err) {
      this.destroy(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    this.currentChildStream = childStream;

    const onData = (chunk: Buffer | Uint8Array | string) => {
      if (this.isDestroying) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.totalBytesStreamed += buf.length;

      if (this.streamOptions?.onProgress) {
        try {
          this.streamOptions.onProgress(this.totalBytesStreamed, this.metadata.totalSizeBytes);
        } catch {}
      }

      this.canPush = this.push(buf);
      if (!this.canPush) {
        // Apply backpressure by pausing child stream
        if (typeof (childStream as any).pause === 'function') {
          (childStream as any).pause();
        }
      }
    };

    const onEnd = () => {
      const prev = childStream;
      this.cleanupCurrentChild();
      this.currentPartIndex++;

      let proceeded = false;
      const proceed = () => {
        if (!proceeded) {
          proceeded = true;
          if (this.pendingTransitionTimer) {
            clearTimeout(this.pendingTransitionTimer);
            this.pendingTransitionTimer = null;
          }
          if (this.canPush && !this.isDestroying) {
            this.pump();
          }
        }
      };

      if (prev && typeof (prev as any).once === 'function' && (prev as any).closed === false) {
        (prev as any).once('close', proceed);
        this.pendingTransitionTimer = setTimeout(proceed, 20);
      } else {
        proceed();
      }
    };

    const onError = (err: Error) => {
      this.cleanupCurrentChild();
      this.destroy(err);
    };

    childStream.on('data', onData);
    childStream.once('end', onEnd);
    childStream.once('error', onError);

    this.reading = false;
  }

  private cleanupCurrentChild(): void {
    if (this.pendingTransitionTimer) {
      clearTimeout(this.pendingTransitionTimer);
      this.pendingTransitionTimer = null;
    }
    if (this.currentChildStream) {
      const s = this.currentChildStream as any;
      if (typeof s.destroy === 'function' && !s.destroyed) {
        try {
          s.destroy();
        } catch {}
      }
      s.removeAllListeners?.('data');
      s.removeAllListeners?.('end');
      s.removeAllListeners?.('error');
      this.currentChildStream = null;
    }
  }

  override _destroy(err: Error | null, callback: (error?: Error | null) => void): void {
    this.isDestroying = true;
    if (this.pendingTransitionTimer) {
      clearTimeout(this.pendingTransitionTimer);
      this.pendingTransitionTimer = null;
    }
    if (this.streamOptions?.signal && this.abortHandler) {
      this.streamOptions.signal.removeEventListener('abort', this.abortHandler);
      this.abortHandler = null;
    }
    this.cleanupCurrentChild();
    callback(err);
  }
}

/**
 * Creates a Virtual Spanned Readable Stream from an array of split archive parts.
 */
export function createVirtualSpannedStream(
  parts: Array<string | VirtualSpannedPartSource | { filename: string; buffer: Buffer }>,
  options?: VirtualSpannedStreamOptions
): { stream: VirtualSpannedStream; metadata: SpannedArchiveMetadata } {
  const { sortedParts, metadata } = validateAndSortSplitParts(parts);
  const stream = new VirtualSpannedStream(sortedParts, metadata, options);
  return { stream, metadata };
}

/**
 * Streams multi-volume archive parts directly into a unified destination disk file.
 * Operates with O(1) memory overhead and guaranteed cleanup on failure.
 */
export async function stitchMultiVolumeToDisk(
  parts: Array<string | VirtualSpannedPartSource | { filename: string; buffer: Buffer }>,
  destinationPath: string,
  options?: VirtualSpannedStreamOptions
): Promise<{ destinationPath: string; bytesWritten: number; metadata: SpannedArchiveMetadata }> {
  const { stream, metadata } = createVirtualSpannedStream(parts, options);
  const resolvedDest = path.resolve(destinationPath);
  const destDir = path.dirname(resolvedDest);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const writeStream = fs.createWriteStream(resolvedDest);

  try {
    await pipeline(stream, writeStream);

    return {
      destinationPath: resolvedDest,
      bytesWritten: writeStream.bytesWritten,
      metadata,
    };
  } catch (err) {
    try {
      if (fs.existsSync(resolvedDest)) {
        fs.unlinkSync(resolvedDest);
      }
    } catch {}
    throw err;
  }
}

/**
 * Validates sequence completeness and stitches multi-volume archive parts into a single buffer.
 * Enforces Fail-Closed validation against missing parts and memory limits.
 *
 * @throws {MultiVolumeBufferOverflowError} If total stitched size exceeds MAX_STITCH_BUFFER_SIZE (500MB)
 */
export function stitchMultiVolumeArchive(
  parts: { filename: string; buffer: Buffer }[]
): StitchedArchiveResult {
  const { sortedParts, metadata } = validateAndSortSplitParts(parts);

  const totalSize = sortedParts.reduce((acc, p) => acc + (p.buffer?.length ?? 0), 0);
  if (totalSize > MAX_STITCH_BUFFER_SIZE) {
    throw new MultiVolumeBufferOverflowError(totalSize, MAX_STITCH_BUFFER_SIZE);
  }

  const stitchedBuffer = Buffer.concat(
    sortedParts.map((p) => {
      if (!p.buffer) {
        throw new Error(`Part ${p.filename} does not contain an in-memory buffer`);
      }
      return p.buffer;
    })
  );

  return {
    buffer: stitchedBuffer,
    baseFilename: metadata.baseFilename,
    format: metadata.format,
    totalParts: sortedParts.length,
  };
}

/**
 * Splits a unified archive buffer into sequential multi-volume chunks.
 */
export function splitArchive(
  archiveBuffer: Buffer,
  baseFilename: string,
  partSizeBytes: number,
  namingScheme?: '7z' | 'rar' | 'zip' | 'numeric'
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
      : baseFilename.endsWith('.zip')
      ? 'zip'
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
    } else if (scheme === 'zip') {
      const baseNoExt = baseFilename.replace(/\.zip$/i, '');
      if (partIndex === totalParts) {
        partFilename = `${baseNoExt}.zip`;
      } else {
        const padDigits = Math.max(2, String(totalParts).length);
        partFilename = `${baseNoExt}.z${String(partIndex).padStart(padDigits, '0')}`;
      }
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
