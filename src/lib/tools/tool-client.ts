import { ConversionFailedError, type ArchiveInspectResponse } from '../types';
import { serverRefusal } from '../conversion-failure';
import { SINGLE_REQUEST_FILE_MAX_BYTES, UPLOAD_PART_MAX_BYTES } from '../plan-limits';
import { MAX_TOOL_FILES, type WebTool, type WebToolOptions } from './tool-names';
import type { StoredToolJobResult } from './tool-job-store';

/** A file of a tool's answer, ready to download from `url`. */
export interface ToolResultFile {
  name: string;
  size: number;
  url: string;
  key?: string;
}

/** What a run answered: one file (a merge, an archive, the parts of a split, a rotated PDF), the files of an unpacked archive, or an inspection summary. */
export type ToolResult =
  | { kind: 'file'; file: ToolResultFile }
  | { kind: 'entries'; entries: ToolResultFile[] }
  | { kind: 'inspection'; inspection: ArchiveInspectResponse; file: ToolResultFile };

interface ListedEntry {
  name: string;
  size: number;
  mimeType: string;
  data?: string;
  url?: string;
  key?: string;
}

const DEFAULT_ARCHIVE_FORMAT = 'zip';
const MULTIPART_URL = '/api/storage/multipart';

/** Why the server would refuse the files of a run, found before they are sent. */
export type ToolInputProblem = 'tooMany' | 'empty';

/**
 * What the server's checks (`assertToolInput`) would refuse about files on the page, so that a run is not uploaded to be turned
 * away: more files than a run takes, and a file with nothing in it. Files >64 MiB are uploaded in parts and dispatched as async tool jobs.
 */
export function toolInputProblem(files: readonly { size: number }[]): ToolInputProblem | null {
  if (files.length > MAX_TOOL_FILES) return 'tooMany';
  if (files.some((file) => file.size === 0)) return 'empty';
  return null;
}

/** The name the downloaded file of a run carries, as the server names it. */
export function resultNameOf(tool: WebTool, firstFileName: string, options: WebToolOptions): string {
  const base = firstFileName.replace(/\.[^/.]+$/, '') || firstFileName;
  switch (tool) {
    case 'merge':
      return 'merged.pdf';
    case 'archive-create':
      return `archive.${options.format ?? DEFAULT_ARCHIVE_FORMAT}`;
    case 'split':
      return `${base}-split.zip`;
    case 'rotate':
      return `${base}-rotated.pdf`;
    case 'archive-extract':
      return base;
    case 'protect':
      return `${base}-protected.pdf`;
    case 'unlock':
      return `${base}-unlocked.pdf`;
    case 'watermark':
      return `${base}-watermarked.pdf`;
    case 'extract-pages':
      return `${base}-extracted.pdf`;
    case 'delete-pages':
      return `${base}-deleted.pdf`;
    case 'reorder-pages':
      return `${base}-reordered.pdf`;
    case 'archive-inspect':
      return `${base}-inspection.json`;
    case 'zip-repair':
      return `${base}-repaired.zip`;
  }
}

function urlOf(blob: Blob): string {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new ConversionFailedError('This runtime cannot create a download URL for the result.');
  }
  return URL.createObjectURL(blob);
}

function bytesOfBase64(data: string): Uint8Array<ArrayBuffer> {
  const text = atob(data);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

function toClientToolResult(stored: StoredToolJobResult): ToolResult {
  if (stored.kind === 'file') {
    return { kind: 'file', file: stored.file };
  }
  if (stored.kind === 'entries') {
    return {
      kind: 'entries',
      entries: stored.entries.map((entry) => ({
        name: entry.name,
        size: entry.size,
        key: entry.key,
        url: entry.url,
      })),
    };
  }
  const blob = new Blob([JSON.stringify(stored.inspection, null, 2)], { type: 'application/json' });
  return {
    kind: 'inspection',
    inspection: stored.inspection,
    file: { name: stored.name, size: blob.size, url: urlOf(blob) },
  };
}

async function uploadToolFileInParts(file: File, signal?: AbortSignal): Promise<{ key: string; name: string }> {
  let activeUploadId: string | undefined;
  try {
    const initRes = await fetch(`${MULTIPART_URL}?action=initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        totalSize: file.size,
        partSize: UPLOAD_PART_MAX_BYTES,
      }),
      signal,
    });
    const initBody = (await initRes.json().catch(() => ({}))) as Record<string, unknown>;
    if (!initRes.ok) throw serverRefusal(initBody, initRes.status, 'Failed starting multipart upload.');
    const uploadId = String(initBody.uploadId ?? '');
    if (!uploadId) throw new ConversionFailedError('Multipart upload did not return an uploadId.');
    activeUploadId = uploadId;
    const partBytes = typeof initBody.partSize === 'number' && initBody.partSize > 0 ? initBody.partSize : UPLOAD_PART_MAX_BYTES;

    const parts: Array<{ partNumber: number; etag: string }> = [];
    for (let start = 0; start < file.size; start += partBytes) {
      const partNumber = parts.length + 1;
      const chunkRes = await fetch(
        `${MULTIPART_URL}?action=chunk&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file.slice(start, start + partBytes),
          signal,
        }
      );
      const chunkBody = (await chunkRes.json().catch(() => ({}))) as Record<string, unknown>;
      if (!chunkRes.ok) throw serverRefusal(chunkBody, chunkRes.status, `Failed uploading part ${partNumber}.`);
      parts.push({ partNumber, etag: String(chunkBody.etag ?? '') });
    }

    const completeRes = await fetch(`${MULTIPART_URL}?action=complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ uploadId, parts }),
      signal,
    });
    const completeBody = (await completeRes.json().catch(() => ({}))) as Record<string, unknown>;
    if (!completeRes.ok) throw serverRefusal(completeBody, completeRes.status, 'Failed completing multipart upload.');
    activeUploadId = undefined;
    const key = String(completeBody.key ?? '');
    if (!key) throw new ConversionFailedError('Multipart completion did not return a storage key.');
    return { key, name: file.name };
  } catch (err) {
    if (activeUploadId) {
      void fetch(`${MULTIPART_URL}?action=abort`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId: activeUploadId }),
        keepalive: true,
      }).catch(() => undefined);
    }
    throw err;
  }
}

async function pollToolJob(jobId: string, signal?: AbortSignal): Promise<ToolResult> {
  let delay = 100;
  try {
    while (!signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      const res = await fetch(`/api/tools/jobs/${encodeURIComponent(jobId)}`, { signal });
      if (!res.ok) throw serverRefusal(await res.json().catch(() => ({})), res.status, 'Failed polling tool job.');
      const data = (await res.json()) as {
        status: string;
        result?: ToolResultFile;
        toolResult?: StoredToolJobResult;
        error?: string;
      };
      if (data.status === 'completed') {
        if (data.toolResult) return toClientToolResult(data.toolResult);
        if (data.result) return { kind: 'file', file: data.result };
      }
      if (data.status === 'failed' || data.status === 'cancelled') {
        throw new ConversionFailedError(data.error || 'Tool job failed.');
      }
      delay = Math.min(delay * 1.5, 1000);
    }
    throw new ConversionFailedError('Tool job cancelled.');
  } catch (err) {
    if (signal?.aborted) {
      void fetch(`/api/tools/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE', keepalive: true }).catch(() => undefined);
    }
    throw err;
  }
}

async function runMultipartToolJob(
  tool: WebTool,
  files: readonly File[],
  options: WebToolOptions,
  signal?: AbortSignal
): Promise<ToolResult> {
  const uploaded: Array<{ key: string; name: string }> = [];
  try {
    for (const file of files) {
      uploaded.push(await uploadToolFileInParts(file, signal));
    }
    const res = await fetch('/api/tools/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, files: uploaded, options }),
      signal,
    });
    const body = (await res.json().catch(() => ({}))) as {
      id?: string;
      result?: ToolResultFile;
      toolResult?: StoredToolJobResult;
    };
    if (!res.ok) throw serverRefusal(body, res.status, 'The tool job failed on the server.');
    if (body.toolResult) return toClientToolResult(body.toolResult);
    if (body.result) return { kind: 'file', file: body.result };
    return pollToolJob(String(body.id), signal);
  } catch (err) {
    for (const item of uploaded) {
      void fetch(`${MULTIPART_URL}?action=discard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: item.key }),
        keepalive: true,
      }).catch(() => undefined);
    }
    throw err;
  }
}

/** Runs `tool` on `files` on the server (one conversion of the day's allowance) and turns its answer into files to download. */
export async function runToolRequest(
  tool: WebTool,
  files: readonly File[],
  options: WebToolOptions,
  signal?: AbortSignal
): Promise<ToolResult> {
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > SINGLE_REQUEST_FILE_MAX_BYTES) {
    return runMultipartToolJob(tool, files, options, signal);
  }

  const form = new FormData();
  for (const file of files) form.append('files', file);
  form.append('options', JSON.stringify(options));

  const res = await fetch(`/api/tools/${tool}`, { method: 'POST', body: form, signal });
  if (!res.ok) throw serverRefusal(await res.json().catch(() => ({})), res.status, 'The tool failed on the server.');

  if (tool === 'archive-extract') {
    const { entries } = (await res.json()) as { entries: ListedEntry[] };
    return {
      kind: 'entries',
      entries: entries.map((entry) => ({
        name: entry.name,
        size: entry.size,
        key: entry.key,
        url: entry.url ?? (entry.data ? urlOf(new Blob([bytesOfBase64(entry.data)], { type: entry.mimeType })) : ''),
      })),
    };
  }
  if (tool === 'archive-inspect') {
    const json = (await res.json()) as { inspection?: ArchiveInspectResponse } & ArchiveInspectResponse;
    const inspectionData = json.inspection ?? json;
    const blob = new Blob([JSON.stringify(inspectionData, null, 2)], { type: 'application/json' });
    return {
      kind: 'inspection',
      inspection: inspectionData,
      file: { name: resultNameOf(tool, files[0].name, options), size: blob.size, url: urlOf(blob) },
    };
  }
  const blob = await res.blob();
  return { kind: 'file', file: { name: resultNameOf(tool, files[0].name, options), size: blob.size, url: urlOf(blob) } };
}

/** Frees the download URLs of a result. */
export function releaseToolResult(result: ToolResult): void {
  const revokeIfBlob = (url: string) => {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  };
  if (result.kind === 'file' || result.kind === 'inspection') {
    revokeIfBlob(result.file.url);
  } else {
    for (const file of result.entries) revokeIfBlob(file.url);
  }
}
