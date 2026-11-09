import { ConversionFailedError } from '../types';
import { serverRefusal } from '../conversion-failure';
import { SINGLE_REQUEST_FILE_MAX_BYTES } from '../plan-limits';
import { MAX_TOOL_FILES, type WebTool, type WebToolOptions } from './tool-names';

/** A file of a tool's answer, ready to download from `url`. */
export interface ToolResultFile {
  name: string;
  size: number;
  url: string;
}

/** What a run answered: one file (a merge, an archive, the parts of a split, a rotated PDF), or the files of an unpacked archive. */
export type ToolResult = { kind: 'file'; file: ToolResultFile } | { kind: 'entries'; entries: ToolResultFile[] };

interface ListedEntry {
  name: string;
  size: number;
  mimeType: string;
  data: string;
}

const DEFAULT_ARCHIVE_FORMAT = 'zip';

/** Why the server would refuse the files of a run, found before they are sent. */
export type ToolInputProblem = 'tooMany' | 'tooLarge' | 'empty';

/**
 * What the server's checks (`assertToolInput`) would refuse about files on the page, so that a run is not uploaded to be turned
 * away: more files than a run takes, files together over one request, and a file with nothing in it. The tools that take one
 * file get that file alone from the page, so their count is never over.
 */
export function toolInputProblem(files: readonly { size: number }[]): ToolInputProblem | null {
  if (files.length > MAX_TOOL_FILES) return 'tooMany';
  if (files.reduce((total, file) => total + file.size, 0) > SINGLE_REQUEST_FILE_MAX_BYTES) return 'tooLarge';
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
  const res = await fetch(`/api/tools/${tool}`, { method: 'POST', body: form, signal });
  if (!res.ok) throw serverRefusal(await res.json().catch(() => ({})), res.status, 'The tool failed on the server.');

  if (tool === 'archive-extract') {
    const { entries } = (await res.json()) as { entries: ListedEntry[] };
    return {
      kind: 'entries',
      entries: entries.map((entry) => ({ name: entry.name, size: entry.size, url: urlOf(new Blob([bytesOfBase64(entry.data)], { type: entry.mimeType })) })),
    };
  }
  const blob = await res.blob();
  return { kind: 'file', file: { name: resultNameOf(tool, files[0].name, options), size: blob.size, url: urlOf(blob) } };
}

/** Frees the download URLs of a result. */
export function releaseToolResult(result: ToolResult): void {
  const files = result.kind === 'file' ? [result.file] : result.entries;
  for (const file of files) URL.revokeObjectURL(file.url);
}
