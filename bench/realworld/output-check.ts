/**
 * Whether a converted output is a readable file of the target type. A page-oriented target (an image, SVG, EPS or DXF) of a
 * document with several pages is delivered as a ZIP of one file per page, declared as `application/zip`; that archive is
 * accepted when it is a well-formed ZIP whose entries are all readable files of the target type.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { isFormatCompatibleWithMagicBytes } from '../../src/lib/registry';

const VALIDATOR_TIMEOUT_MS = 60_000;
const IMAGE_TARGETS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'tiff', 'tif', 'bmp', 'avif', 'heic', 'ico']);
/** Targets a multi-page document is split into, one file per page, inside a ZIP. */
const PAGE_TARGETS: ReadonlySet<string> = new Set([...IMAGE_TARGETS, 'svg', 'eps', 'dxf']);
const ZIP_MIME_TYPE = 'application/zip';
const PACKAGE_PARTS: Readonly<Record<string, string>> = {
  docx: '[Content_Types].xml',
  xlsx: '[Content_Types].xml',
  pptx: '[Content_Types].xml',
  odt: 'mimetype',
  ods: 'mimetype',
  odp: 'mimetype',
  epub: 'mimetype',
};

export interface OutputCheckOptions {
  /** MIME type the conversion declared for the output. */
  mimeType?: string;
  /** Path of `pdfinfo`; an empty value skips the PDF reader. */
  pdfinfo: string;
  /** Path of ImageMagick `identify`; an empty value skips the image reader. */
  identify: string;
}

async function pageArchiveProblem(buffer: Buffer, target: string, workDir: string, options: OutputCheckOptions): Promise<string | null> {
  const zip = await JSZip.loadAsync(buffer).catch(() => null);
  if (zip === null) return `${target} page archive is not a readable ZIP`;
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length === 0) return `${target} page archive has no pages`;
  for (const entry of entries) {
    const problem = await outputProblem(await entry.async('nodebuffer'), target, workDir, { ...options, mimeType: undefined });
    if (problem !== null) return `page ${entry.name}: ${problem}`;
  }
  return null;
}

/** Why the output is not a readable file of the target type, or null when it is. */
export async function outputProblem(buffer: Buffer, target: string, workDir: string, options: OutputCheckOptions): Promise<string | null> {
  if (buffer.length === 0) return 'empty output';
  if (options.mimeType === ZIP_MIME_TYPE && PAGE_TARGETS.has(target)) return pageArchiveProblem(buffer, target, workDir, options);
  if (!isFormatCompatibleWithMagicBytes(buffer, target)) return `output bytes do not match ${target}`;
  const part = PACKAGE_PARTS[target];
  if (part !== undefined) {
    const zip = await JSZip.loadAsync(buffer).catch(() => null);
    if (zip === null || zip.file(part) === null) return `${target} package has no ${part}`;
  }
  const file = path.join(workDir, `out.${target}`);
  fs.writeFileSync(file, buffer);
  try {
    if (target === 'pdf' && options.pdfinfo !== '') execFileSync(options.pdfinfo, [file], { stdio: 'pipe', timeout: VALIDATOR_TIMEOUT_MS });
    if (IMAGE_TARGETS.has(target) && options.identify !== '') execFileSync(options.identify, [file], { stdio: 'pipe', timeout: VALIDATOR_TIMEOUT_MS });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim().split('\n')[0] ?? String(error);
    return `reference reader refused the output: ${stderr}`;
  }
  return null;
}
