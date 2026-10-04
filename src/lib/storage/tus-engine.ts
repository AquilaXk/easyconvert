import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, PassThrough } from 'node:stream';
import { localFsStorage } from './index';
import { globalSharedObjects } from './shared-store';

export class TusOffsetMismatchError extends Error {
  constructor(public readonly expectedOffset: number) {
    super(`Upload-Offset mismatch. Expected offset is ${expectedOffset}`);
    this.name = 'TusOffsetMismatchError';
  }
}

export class TusChecksumMismatchError extends Error {
  constructor() {
    super('The checksum for the uploaded chunk did not match the provided Upload-Checksum');
    this.name = 'TusChecksumMismatchError';
  }
}

export class TusNotFoundError extends Error {
  constructor(id: string) {
    super(`TUS upload session "${id}" not found or expired`);
    this.name = 'TusNotFoundError';
  }
}

export interface TusSession {
  id: string;
  uploadLength: number;
  uploadOffset: number;
  metadata: string;
  parsedMetadata: Record<string, string>;
  key: string;
  filename: string;
  mimeType: string;
  ownerUserId?: string;
  createdAt: number;
  expiresAt: number;
  completed: boolean;
}

export interface CreateTusSessionParams {
  uploadLength: number;
  metadataHeader?: string;
  ownerUserId?: string;
  ttlSeconds?: number;
}

export interface AppendChunkResult {
  newOffset: number;
  isComplete: boolean;
  session: TusSession;
}

/**
 * Parses TUS 1.0 Upload-Metadata header.
 * Format: "key1 base64value1,key2 base64value2"
 */
export function parseTusMetadata(header?: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header || typeof header !== 'string') return result;

  const pairs = header.split(',');
  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const firstSpace = trimmed.indexOf(' ');
    if (firstSpace === -1) {
      result[trimmed] = '';
    } else {
      const key = trimmed.slice(0, firstSpace).trim();
      const encodedVal = trimmed.slice(firstSpace + 1).trim();
      try {
        result[key] = Buffer.from(encodedVal, 'base64').toString('utf-8');
      } catch {
        result[key] = '';
      }
    }
  }
  return result;
}

/**
 * Serializes parsed key-value metadata into TUS 1.0 header format.
 */
export function serializeTusMetadata(meta: Record<string, string>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(meta)) {
    const encoded = Buffer.from(value, 'utf-8').toString('base64');
    pairs.push(`${key} ${encoded}`);
  }
  return pairs.join(',');
}

function parseChecksumHeader(header?: string | null): { algo: string; expectedDigest: string } | null {
  if (!header || typeof header !== 'string') return null;
  const spaceIdx = header.indexOf(' ');
  if (spaceIdx === -1) return null;
  const algo = header.slice(0, spaceIdx).trim().toLowerCase();
  const expectedDigest = header.slice(spaceIdx + 1).trim();
  return { algo, expectedDigest };
}

async function rollbackChunk(binPath: string, clientOffset: number): Promise<void> {
  try {
    await fs.promises.truncate(binPath, clientOffset);
  } catch {
    // Disk truncation failed in restricted / failed disk state
  }
}

async function finalizeTusSession(session: TusSession, binPath: string): Promise<void> {
  // Finalize into stream-first object storage
  const readStream = fs.createReadStream(binPath);
  await localFsStorage.putStream(session.key, readStream, {
    contentType: session.mimeType,
    filename: session.filename,
    ttlSeconds: Math.max(3600, Math.floor((session.expiresAt - Date.now()) / 1000)),
  });

  // Synchronize into globalSharedObjects disk spool
  const stat = await fs.promises.stat(binPath);
  const hash = crypto.createHash('sha256').update(String(stat.mtimeMs)).digest('hex');
  let cachedBuffer: Buffer | null = null;
  globalSharedObjects.set(session.key, {
    key: session.key,
    filename: session.filename,
    mimeType: session.mimeType,
    size: session.uploadLength,
    etag: `"${hash}"`,
    uploadedAt: Date.now(),
    expiresAt: session.expiresAt,
    filePath: binPath,
    get buffer(): Buffer {
      if (cachedBuffer) return cachedBuffer;
      if (fs.existsSync(binPath)) {
        cachedBuffer = fs.readFileSync(binPath);
        return cachedBuffer;
      }
      return Buffer.alloc(0);
    },
  });
}

export class TusEngine {
  private readonly tusDir: string;
  private readonly defaultTtlSeconds: number;
  readonly maxUploadSize: number = 5 * 1024 * 1024 * 1024; // 5 GiB

  constructor(options?: { tusDir?: string; defaultTtlSeconds?: number }) {
    this.tusDir =
      options?.tusDir ||
      path.resolve(
        process.env.EASYCONVERT_STORAGE_DIR || path.resolve(process.cwd(), '.easyconvert/storage'),
        'tus'
      );
    this.defaultTtlSeconds = options?.defaultTtlSeconds || 86400; // 24 hours
    this.ensureDirectory();
  }

  private ensureDirectory(): void {
    try {
      if (!fs.existsSync(this.tusDir)) {
        fs.mkdirSync(this.tusDir, { recursive: true });
      }
    } catch {
      // In restricted environments, gracefully proceed
    }
  }

  private getPaths(id: string): { infoPath: string; binPath: string } {
    return {
      infoPath: path.join(this.tusDir, `${id}.info`),
      binPath: path.join(this.tusDir, `${id}.bin`),
    };
  }

  private toNodeReadable(
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>
  ): NodeJS.ReadableStream {
    if ('pipe' in stream && typeof stream.pipe === 'function') {
      return stream as NodeJS.ReadableStream;
    }
    return Readable.fromWeb(stream as any);
  }

  async createSession(params: CreateTusSessionParams): Promise<TusSession> {
    this.ensureDirectory();
    if (params.uploadLength > this.maxUploadSize) {
      throw new Error(`Upload length ${params.uploadLength} exceeds maximum allowed size ${this.maxUploadSize}`);
    }

    const id = `tus_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    const rawMetadata = params.metadataHeader || '';
    const parsed = parseTusMetadata(rawMetadata);

    const filename = parsed.filename || parsed.name || `upload-${id}.bin`;
    const mimeType = parsed.filetype || parsed.contentType || 'application/octet-stream';
    const now = Date.now();
    const expiresAt = now + (params.ttlSeconds || this.defaultTtlSeconds) * 1000;
    const key = `uploads/${id}/${path.basename(filename)}`;

    const session: TusSession = {
      id,
      uploadLength: params.uploadLength,
      uploadOffset: 0,
      metadata: rawMetadata,
      parsedMetadata: parsed,
      key,
      filename,
      mimeType,
      ownerUserId: params.ownerUserId,
      createdAt: now,
      expiresAt,
      completed: false,
    };

    const { infoPath, binPath } = this.getPaths(id);
    await fs.promises.writeFile(infoPath, JSON.stringify(session, null, 2), 'utf-8');
    await fs.promises.writeFile(binPath, Buffer.alloc(0));

    return session;
  }

  async getSession(id: string): Promise<TusSession | null> {
    const { infoPath, binPath } = this.getPaths(id);
    if (!fs.existsSync(infoPath) || !fs.existsSync(binPath)) {
      return null;
    }

    try {
      const raw = await fs.promises.readFile(infoPath, 'utf-8');
      const session: TusSession = JSON.parse(raw);

      if (Date.now() > session.expiresAt) {
        await this.terminateSession(id);
        return null;
      }

      // Sync uploadOffset with real byte size on disk
      const stat = await fs.promises.stat(binPath);
      session.uploadOffset = stat.size;

      return session;
    } catch {
      return null;
    }
  }

  async appendChunk(
    id: string,
    clientOffset: number,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    checksumHeader?: string | null
  ): Promise<AppendChunkResult> {
    const session = await this.getSession(id);
    if (!session) {
      throw new TusNotFoundError(id);
    }

    if (session.completed) {
      throw new Error(`Upload session "${id}" is already completed`);
    }

    if (session.uploadOffset !== clientOffset) {
      throw new TusOffsetMismatchError(session.uploadOffset);
    }

    const { infoPath, binPath } = this.getPaths(id);
    const nodeReadable = this.toNodeReadable(stream);

    const parsedChecksum = parseChecksumHeader(checksumHeader);
    let checksumHasher: crypto.Hash | null = null;
    if (parsedChecksum) {
      try {
        checksumHasher = crypto.createHash(parsedChecksum.algo);
      } catch {
        throw new Error(`Unsupported checksum algorithm "${parsedChecksum.algo}"`);
      }
    }

    let chunkBytes = 0;
    const passThrough = new PassThrough();
    passThrough.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunkBytes += buf.length;
      if (checksumHasher) {
        checksumHasher.update(buf);
      }
    });

    const fileWriteStream = fs.createWriteStream(binPath, { flags: 'a' });

    try {
      await pipeline(nodeReadable, passThrough, fileWriteStream);
    } catch (err) {
      await rollbackChunk(binPath, clientOffset);
      throw err;
    }

    if (checksumHasher && parsedChecksum) {
      const computedBase64 = checksumHasher.digest('base64');
      if (computedBase64 !== parsedChecksum.expectedDigest) {
        await rollbackChunk(binPath, clientOffset);
        throw new TusChecksumMismatchError();
      }
    }

    const newOffset = clientOffset + chunkBytes;
    if (newOffset > session.uploadLength) {
      await rollbackChunk(binPath, clientOffset);
      throw new Error(`Uploaded bytes (${newOffset}) exceed declared Upload-Length (${session.uploadLength})`);
    }

    session.uploadOffset = newOffset;

    let isComplete = false;
    if (newOffset === session.uploadLength) {
      isComplete = true;
      session.completed = true;
      await finalizeTusSession(session, binPath);
    }

    await fs.promises.writeFile(infoPath, JSON.stringify(session, null, 2), 'utf-8');

    return {
      newOffset,
      isComplete,
      session,
    };
  }

  async terminateSession(id: string): Promise<boolean> {
    const { infoPath, binPath } = this.getPaths(id);
    let deleted = false;
    try {
      if (fs.existsSync(infoPath)) {
        await fs.promises.unlink(infoPath);
        deleted = true;
      }
    } catch {
      // In-flight deletion race
    }
    try {
      if (fs.existsSync(binPath)) {
        await fs.promises.unlink(binPath);
        deleted = true;
      }
    } catch {
      // In-flight deletion race
    }
    return deleted;
  }
}

export const tusEngine = new TusEngine();
