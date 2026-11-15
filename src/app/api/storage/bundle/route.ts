import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { Readable } from 'node:stream';
import { storageProvider as s3Storage } from '@/lib/storage';
import { denyUnlessOwner, resolveObjectOwnership } from '@/lib/api-keys/owner-access';
import { attachmentContentDisposition } from '@/lib/api/content-disposition';
import { MAX_EXTRACTED_ENTRIES } from '@/lib/tools/tool-names';
import { resultAvailability } from '@/lib/storage/retention-service';
import { streamZipReadable, type StreamingZipEntry } from '@/lib/archive/streaming-zip';
import { sanitizeNodeOutputFilename } from '@/lib/queue/graph/node-jobs';

export const dynamic = 'force-dynamic';

const STORAGE_DOWNLOAD_SCOPE = 'storage:download';
const PRIVATE_NO_STORE = 'private, no-store';

interface BundleFileRequest {
  key: string;
  name: string;
}

interface BundleRequestBody {
  files: BundleFileRequest[];
  archiveName?: string;
}

function deduplicateFileNames(items: readonly BundleFileRequest[]): string[] {
  const used = new Set<string>();
  return items.map((item, index) => {
    const rawLeaf = path.basename(item.name || '').trim() || `file_${index + 1}`;
    const sanitized = sanitizeNodeOutputFilename(rawLeaf, `file_${index + 1}`);
    const { name: stem, ext } = path.parse(sanitized);
    let candidate = sanitized;
    for (let copy = 1; used.has(candidate); copy++) {
      candidate = `${stem} (${copy})${ext}`;
    }
    used.add(candidate);
    return candidate;
  });
}

function buildNotFoundResponse(key: string): NextResponse {
  return NextResponse.json(
    { success: false, error: `Object not found for key: "${key}"` },
    { status: 404, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
  );
}

function sanitizeArchiveName(rawName?: string): string {
  if (!rawName || typeof rawName !== 'string') return 'files.zip';
  const leaf = path.basename(rawName.trim());
  const sanitized = sanitizeNodeOutputFilename(leaf, 'files.zip');
  return sanitized.toLowerCase().endsWith('.zip') ? sanitized : `${sanitized}.zip`;
}

export async function POST(req: NextRequest) {
  let body: BundleRequestBody;
  try {
    body = (await req.json()) as BundleRequestBody;
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON request body.' },
      { status: 400, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
    );
  }

  if (!body || !Array.isArray(body.files) || body.files.length === 0) {
    return NextResponse.json(
      { success: false, error: 'The request must contain a non-empty "files" array.' },
      { status: 400, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
    );
  }

  if (body.files.length > MAX_EXTRACTED_ENTRIES) {
    return NextResponse.json(
      { success: false, error: `Cannot bundle more than ${MAX_EXTRACTED_ENTRIES} files at once.` },
      { status: 400, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
    );
  }

  for (const item of body.files) {
    if (!item || typeof item.key !== 'string' || item.key.trim() === '') {
      return NextResponse.json(
        { success: false, error: 'Every file entry must have a valid storage key.' },
        { status: 400, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
      );
    }
  }

  const verifiedFiles: Array<{ key: string; name: string; size: number }> = [];
  const uniqueNames = deduplicateFileNames(body.files);

  for (let i = 0; i < body.files.length; i++) {
    const { key } = body.files[i];
    const notFound = () => buildNotFoundResponse(key);

    const ownership = await resolveObjectOwnership(key);
    if (!ownership.resolved) {
      return notFound();
    }

    const denied = await denyUnlessOwner(req, ownership.ownerUserId, STORAGE_DOWNLOAD_SCOPE, notFound);
    if (denied) {
      return denied;
    }

    const stat = await s3Storage.stat(key);
    if (!stat) {
      return notFound();
    }

    const availability = await resultAvailability(key);
    if (availability?.state === 'deleted') {
      return notFound();
    }

    verifiedFiles.push({ key, name: uniqueNames[i], size: stat.size });
  }

  async function* generateZipEntries(): AsyncGenerator<StreamingZipEntry, void, undefined> {
    for (const file of verifiedFiles) {
      const nodeStream = await s3Storage.openReadStream(file.key);
      if (!nodeStream) {
        throw new Error(`Failed to read stored file "${file.key}" during bundle generation.`);
      }
      const webStream = Readable.toWeb(nodeStream as Readable) as ReadableStream<Uint8Array>;
      yield {
        name: file.name,
        data: webStream,
        size: file.size,
      };
    }
  }

  const archiveName = sanitizeArchiveName(body.archiveName);
  const zipStream = streamZipReadable(generateZipEntries());

  return new NextResponse(zipStream as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': attachmentContentDisposition(archiveName),
      'Cache-Control': PRIVATE_NO_STORE,
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
    },
  });
}
