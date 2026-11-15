import { ConversionFailedError } from '../types';
import { serverRefusal } from '../conversion-failure';
import { SINGLE_REQUEST_FILE_MAX_BYTES } from '../plan-limits';
import { MAX_TOOL_FILES, type WebTool, type WebToolOptions } from './tool-names';

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
  | { kind: 'inspection'; inspection: Record<string, unknown>; file: ToolResultFile };

interface ListedEntry {
  name: string;
  size: number;
  mimeType: string;
  data?: string;
  url?: string;
  key?: string;
}

const DEFAULT_ARCHIVE_FORMAT = 'zip';

/** Why the server would refuse the files of a run, found before they are sent. */
export type ToolInputProblem = 'tooMany' | 'empty';

/**
 * What the server's checks (`assertToolInput`) would refuse about files on the page, so that a run is not uploaded to be turned
 * away: more files than a run takes, and a file with nothing in it. Files >64 MiB are dispatched as async tool jobs.
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

async function pollToolJob(jobId: string, signal?: AbortSignal): Promise<ToolResult> {
  let delay = 100;
  while (!signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    const res = await fetch(`/api/tools/jobs/${jobId}`, { signal });
    if (!res.ok) throw serverRefusal(await res.json().catch(() => ({})), res.status, 'Failed polling tool job.');
    const data = (await res.json()) as { status: string; result?: ToolResultFile; error?: string };
    if (data.status === 'completed' && data.result) {
      return { kind: 'file', file: data.result };
    }
    if (data.status === 'failed') {
      throw new ConversionFailedError(data.error || 'Tool job failed.');
    }
    delay = Math.min(delay * 1.5, 1000);
  }
  throw new ConversionFailedError('Tool job cancelled.');
}

/** Runs `tool` on `files` on the server (one conversion of the day's allowance) and turns its answer into files to download. */
export async function runToolRequest(
  tool: WebTool,
  files: readonly File[],
  options: WebToolOptions,
  signal?: AbortSignal
): Promise<ToolResult> {
  const form = new FormData();
  for (const file of files) form.append('files', file);
  form.append('options', JSON.stringify(options));

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > SINGLE_REQUEST_FILE_MAX_BYTES) {
    form.append('tool', tool);
    const res = await fetch('/api/tools/jobs', { method: 'POST', body: form, signal });
    if (!res.ok) throw serverRefusal(await res.json().catch(() => ({})), res.status, 'The tool job failed on the server.');
    const data = (await res.json()) as { id: string; status: string; result?: ToolResultFile };
    if (data.result) return { kind: 'file', file: data.result };
    return pollToolJob(data.id, signal);
  }

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
    const json = await res.json();
    const inspectionData = (json.inspection ?? json) as Record<string, unknown>;
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
  if (result.kind === 'file' || result.kind === 'inspection') {
    URL.revokeObjectURL(result.file.url);
  } else {
    for (const file of result.entries) URL.revokeObjectURL(file.url);
  }
}
