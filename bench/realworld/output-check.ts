/**
 * Whether a converted output is a readable file of the target type. A page-oriented target (an image, SVG, EPS, DXF, EMF or WMF) of a
 * document with several pages is delivered as a ZIP of one file per page, declared as `application/zip`; that archive is
 * accepted when it is a well-formed ZIP whose entries are all readable files of the target type. An OBJ of a model that has colours
 * is delivered as a ZIP of the OBJ and the MTL file its `mtllib` line names, declared as `application/zip` too; see objArchiveProblem.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { isFormatCompatibleWithMagicBytes } from '../../src/lib/registry';
import { readMtl, readObj, type ObjReading } from './obj-mtl';

const VALIDATOR_TIMEOUT_MS = 60_000;
const IMAGE_TARGETS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'tiff', 'tif', 'bmp', 'avif', 'heic', 'ico', 'psd']);
/** Targets a multi-page document is split into, one file per page, inside a ZIP. */
export const PAGE_TARGETS: ReadonlySet<string> = new Set([...IMAGE_TARGETS, 'svg', 'eps', 'odd', 'dxf', 'emf', 'wmf']);
const ZIP_MIME_TYPE = 'application/zip';
const OBJ_NAME = /\.obj$/i;
const MTL_NAME = /\.mtl$/i;
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
  /**
   * The corpus manifest marks the input as having no content (`emptyInput`, with the reason read from the file): zero bytes are then
   * the right output (docs/policy-decisions.md, "Empty documents and macros"). The mark comes from the corpus, never from the
   * conversion under test, which declares every blank text result empty, content or not.
   */
  emptyInput?: boolean;
}

type ArchiveEntries = { entries: JSZip.JSZipObject[] } | { problem: string };

/** The files (not the directories) of a ZIP, or why `label` is not a readable ZIP. */
async function archiveEntries(buffer: Buffer, label: string): Promise<ArchiveEntries> {
  const zip = await JSZip.loadAsync(buffer).catch(() => null);
  if (zip === null) return { problem: `${label} is not a readable ZIP` };
  return { entries: Object.values(zip.files).filter((entry) => !entry.dir) };
}

async function pageArchiveProblem(buffer: Buffer, target: string, workDir: string, options: OutputCheckOptions): Promise<string | null> {
  const archive = await archiveEntries(buffer, `${target} page archive`);
  if ('problem' in archive) return archive.problem;
  if (archive.entries.length === 0) return `${target} page archive has no pages`;
  for (const entry of archive.entries) {
    const problem = await outputProblem(await entry.async('nodebuffer'), target, workDir, { ...options, mimeType: undefined, emptyInput: false });
    if (problem !== null) return `page ${entry.name}: ${problem}`;
  }
  return null;
}

/** Why the bytes are not a readable OBJ: the text signature of the format, then the line reader (see obj-mtl.ts). */
function objBytesProblem(buffer: Buffer): { problem: string } | { reading: Extract<ObjReading, { ok: true }> } {
  if (buffer.length === 0) return { problem: 'empty output' };
  if (!isFormatCompatibleWithMagicBytes(buffer, 'obj')) return { problem: 'output bytes do not match obj' };
  const reading = readObj(buffer);
  return reading.ok ? { reading } : { problem: `obj is not readable, ${reading.problem}` };
}

/**
 * An OBJ with colours is delivered as a ZIP of the OBJ and its MTL file (convertCadWithOcct returns a ZIP only then), so that `mtllib` resolves and
 * the model does not load as a flat grey mesh. The archive is flat and holds exactly one OBJ and one MTL file, the OBJ is readable, the `mtllib` names are
 * the MTL file and nothing else, every `usemtl` material is defined by a `newmtl`, and the MTL holds only statements the writer emits.
 */
async function objArchiveProblem(buffer: Buffer): Promise<string | null> {
  const archive = await archiveEntries(buffer, 'obj archive');
  if ('problem' in archive) return archive.problem;
  const { entries } = archive;
  const nested = entries.find((entry) => /[/\\]/.test(entry.name));
  if (nested !== undefined) return `obj archive entry ${nested.name} is not at the archive root`;
  const objects = entries.filter((entry) => OBJ_NAME.test(entry.name));
  const materials = entries.filter((entry) => MTL_NAME.test(entry.name));
  if (objects.length !== 1) return `obj archive holds ${objects.length} .obj files, not one`;
  if (materials.length !== 1) return `obj archive holds ${materials.length} .mtl files, not one`;
  const extra = entries.find((entry) => entry !== objects[0] && entry !== materials[0]);
  if (extra !== undefined) return `obj archive holds an unexpected entry ${extra.name}`;
  const model = objBytesProblem(await objects[0].async('nodebuffer'));
  if ('problem' in model) return `model ${objects[0].name}: ${model.problem}`;
  const library = readMtl(await materials[0].async('nodebuffer'));
  if (!library.ok) return `material file ${materials[0].name}: ${library.problem}`;
  const { mtllibs, usedMaterials } = model.reading;
  const missing = mtllibs.find((name) => name !== materials[0].name);
  if (missing !== undefined) return `obj names material file ${missing}, which the archive lacks`;
  if (!mtllibs.includes(materials[0].name)) return `material file ${materials[0].name} is not named by an mtllib line`;
  const undefinedMaterial = usedMaterials.find((name) => !library.materials.has(name));
  if (undefinedMaterial !== undefined) return `obj uses material ${undefinedMaterial}, which ${materials[0].name} does not define`;
  return null;
}

/** Why the output is not a readable file of the target type, or null when it is. */
export async function outputProblem(buffer: Buffer, target: string, workDir: string, options: OutputCheckOptions): Promise<string | null> {
  if (buffer.length === 0) return options.emptyInput === true ? null : 'empty output';
  if (options.mimeType === ZIP_MIME_TYPE && PAGE_TARGETS.has(target)) return pageArchiveProblem(buffer, target, workDir, options);
  if (options.mimeType === ZIP_MIME_TYPE && target === 'obj') return objArchiveProblem(buffer);
  if (target === 'obj') {
    const model = objBytesProblem(buffer);
    return 'problem' in model ? model.problem : null;
  }
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
