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

const VALIDATOR_TIMEOUT_MS = 60_000;
const IMAGE_TARGETS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'tiff', 'tif', 'bmp', 'avif', 'heic', 'ico', 'psd']);
/** Targets a multi-page document is split into, one file per page, inside a ZIP. */
export const PAGE_TARGETS: ReadonlySet<string> = new Set([...IMAGE_TARGETS, 'svg', 'eps', 'odd', 'dxf', 'emf', 'wmf']);
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
  /**
   * The corpus manifest marks the input as having no content (`emptyInput`, with the reason read from the file): zero bytes are then
   * the right output (docs/policy-decisions.md, "Empty documents and macros"). The mark comes from the corpus, never from the
   * conversion under test, which declares every blank text result empty, content or not.
   */
  emptyInput?: boolean;
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

const MTL_NAME = /\.mtl$/i;
const OBJ_NAME = /\.obj$/i;

/** The file names the `mtllib` lines of an OBJ name; a line may name several files. */
function mtllibNames(obj: string): string[] {
  return obj.split(/\r?\n/).flatMap((line) => (/^\s*mtllib\s/.test(line) ? line.trim().split(/\s+/).slice(1) : []));
}

/**
 * An OBJ with colours is delivered as a ZIP of the OBJ and its MTL file, so that `mtllib` resolves and the model does not load as a
 * flat grey mesh. The archive is accepted when it holds exactly one OBJ that is a readable OBJ, at most one MTL file that holds a
 * material, every file the OBJ's `mtllib` names, and nothing else: the converter writes no textures, so a further entry, or an MTL
 * `map_*` statement that points at a file the archive lacks, is a defect.
 */
async function objArchiveProblem(buffer: Buffer, workDir: string, options: OutputCheckOptions): Promise<string | null> {
  const zip = await JSZip.loadAsync(buffer).catch(() => null);
  if (zip === null) return 'obj archive is not a readable ZIP';
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  const objects = entries.filter((entry) => OBJ_NAME.test(entry.name));
  const materials = entries.filter((entry) => MTL_NAME.test(entry.name));
  if (objects.length !== 1) return `obj archive holds ${objects.length} .obj files, not one`;
  if (materials.length > 1) return `obj archive holds ${materials.length} .mtl files, at most one is expected`;
  const extra = entries.find((entry) => !objects.includes(entry) && !materials.includes(entry));
  if (extra !== undefined) return `obj archive holds an unexpected entry ${extra.name}`;
  const model = await objects[0].async('nodebuffer');
  const problem = await outputProblem(model, 'obj', workDir, { ...options, mimeType: undefined });
  if (problem !== null) return `model ${objects[0].name}: ${problem}`;
  for (const name of mtllibNames(model.toString('latin1'))) {
    if (!materials.some((entry) => entry.name === name)) return `obj names material file ${name}, which the archive lacks`;
  }
  if (materials.length === 0) return null;
  const text = (await materials[0].async('nodebuffer')).toString('latin1');
  if (!/^\s*newmtl\s+\S/m.test(text)) return `material file ${materials[0].name} defines no material`;
  const texture = /^\s*map_\w+\s+(?:-\S+\s+)*(\S+)/m.exec(text);
  if (texture !== null) return `material file ${materials[0].name} names texture ${texture[1]}, which the archive lacks`;
  return null;
}

/** Why the output is not a readable file of the target type, or null when it is. */
export async function outputProblem(buffer: Buffer, target: string, workDir: string, options: OutputCheckOptions): Promise<string | null> {
  if (buffer.length === 0) return options.emptyInput === true ? null : 'empty output';
  if (options.mimeType === ZIP_MIME_TYPE && PAGE_TARGETS.has(target)) return pageArchiveProblem(buffer, target, workDir, options);
  if (options.mimeType === ZIP_MIME_TYPE && target === 'obj') return objArchiveProblem(buffer, workDir, options);
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
