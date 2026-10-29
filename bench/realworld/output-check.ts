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
import { hasExtension, readMtl, readObj, shown, type ObjScan } from './obj-mtl';

const VALIDATOR_TIMEOUT_MS = 60_000;
/** The most code points that a refusal quotes of each part of a reference reader's message: its first line of stderr, its path, its signal. */
export const MAX_TOOL_MESSAGE_CHARS = 200;
const CRC_MISMATCH = /CRC32 mismatch/;
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
  /** How long a reference reader may run, in milliseconds; the default is VALIDATOR_TIMEOUT_MS. A test sets a short one. */
  readerTimeoutMs?: number;
}

type ArchiveEntries = { entries: JSZip.JSZipObject[]; folders: JSZip.JSZipObject[] } | { problem: string };
type ObjModel = { problem: string } | { reading: ObjScan };

/** The files and the folders of a ZIP, or why `label` is not a readable ZIP. */
async function archiveEntries(buffer: Buffer, label: string): Promise<ArchiveEntries> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  } catch (error) {
    return { problem: CRC_MISMATCH.test(String(error)) ? `${label} has an entry whose CRC-32 is wrong` : `${label} is not a readable ZIP` };
  }
  const all = Object.values(zip.files);
  return { entries: all.filter((entry) => !entry.dir), folders: all.filter((entry) => entry.dir) };
}

async function pageArchiveProblem(buffer: Buffer, target: string, workDir: string, options: OutputCheckOptions): Promise<string | null> {
  const archive = await archiveEntries(buffer, `${target} page archive`);
  if ('problem' in archive) return archive.problem;
  if (archive.entries.length === 0) return `${target} page archive has no pages`;
  for (const entry of archive.entries) {
    const problem = await outputProblem(await entry.async('nodebuffer'), target, workDir, { ...options, mimeType: undefined, emptyInput: false });
    if (problem !== null) return `page ${shown(entry.name)}: ${problem}`;
  }
  return null;
}

/** The OBJ read by the line reader (see obj-mtl.ts), or why the bytes are not a readable OBJ. The reader refuses everything that is not text of the OBJ vocabulary, executables and other formats included. */
function readableObj(buffer: Buffer): ObjModel {
  if (buffer.length === 0) return { problem: 'empty output' };
  const reading = readObj(buffer);
  return reading.ok ? { reading } : { problem: `obj is not readable, ${reading.problem}` };
}

/**
 * Why a plain OBJ is refused for the material lines it holds: convertCadWithOcct returns a bare OBJ only when the model has no colour, and then
 * neither writer puts `mtllib` or `usemtl` in it.
 */
function plainObjMaterialProblem(reading: ObjScan): string | null {
  if (reading.mtllib !== null) return `obj names material file ${shown(reading.mtllib)}, which comes only in a ZIP with the OBJ`;
  const [material] = reading.usedMaterials;
  if (material !== undefined) return `obj uses material ${shown(material)}, whose material file comes only in a ZIP with the OBJ`;
  return null;
}

/**
 * Why the OBJ and the MTL file of an archive do not belong together, or null. Both directions are checked, as the writer creates every material from
 * a face it then writes, with a `Kd`: the `mtllib` line names the MTL file, every `usemtl` material is defined by a `newmtl`, at
 * least one material is taken by a face, every `newmtl` is taken by one, and each of them has a `Kd`.
 */
function objMaterialProblem(reading: ObjScan, materialFile: string, materials: ReadonlyMap<string, unknown>): string | null {
  if (reading.mtllib === null) return `material file ${shown(materialFile)} is not named by an mtllib line`;
  if (reading.mtllib !== materialFile) return `obj names material file ${shown(reading.mtllib)}, which the archive lacks`;
  const undefinedMaterial = reading.usedMaterials.find((name) => !materials.has(name));
  if (undefinedMaterial !== undefined) return `obj uses material ${shown(undefinedMaterial)}, which ${shown(materialFile)} does not define`;
  if (reading.facedMaterials.size === 0) return 'no face of the obj takes a material, so the model loads as a flat grey mesh';
  const unused = [...materials.keys()].find((name) => !reading.facedMaterials.has(name));
  if (unused !== undefined) return `${shown(materialFile)} defines material ${shown(unused)}, which no face of the obj takes`;
  const withoutKd = [...reading.facedMaterials].find((name) => materials.get(name) === null);
  if (withoutKd !== undefined) return `material ${shown(withoutKd)} has no Kd, so its faces have no colour`;
  return null;
}

/**
 * An OBJ with colours is delivered as a ZIP of the OBJ and its MTL file (convertCadWithOcct returns a ZIP only then), so that `mtllib` resolves and
 * the model does not load as a flat grey mesh. The archive is flat and holds exactly one OBJ and one MTL file and nothing else, not even a folder, the OBJ is
 * readable, the MTL holds only statements the writer emits, and the two agree on the materials (see objMaterialProblem).
 */
async function objArchiveProblem(buffer: Buffer): Promise<string | null> {
  const archive = await archiveEntries(buffer, 'obj archive');
  if ('problem' in archive) return archive.problem;
  const { entries, folders } = archive;
  const nested = entries.find((entry) => /[/\\]/.test(entry.name));
  if (nested !== undefined) return `obj archive entry ${shown(nested.name)} is not at the archive root`;
  if (folders.length > 0) return `obj archive holds the folder ${shown(folders[0].name)}`;
  const objects = entries.filter((entry) => hasExtension(entry.name, 'obj'));
  const materials = entries.filter((entry) => hasExtension(entry.name, 'mtl'));
  if (objects.length !== 1) return `obj archive holds ${objects.length} .obj files, not one`;
  if (materials.length !== 1) return `obj archive holds ${materials.length} .mtl files, not one`;
  const extra = entries.find((entry) => entry !== objects[0] && entry !== materials[0]);
  if (extra !== undefined) return `obj archive holds an unexpected entry ${shown(extra.name)}`;
  const model = readableObj(await objects[0].async('nodebuffer'));
  if ('problem' in model) return `model ${shown(objects[0].name)}: ${model.problem}`;
  const library = readMtl(await materials[0].async('nodebuffer'));
  if (!library.ok) return `material file ${shown(materials[0].name)}: ${library.problem}`;
  return objMaterialProblem(model.reading, materials[0].name, library.materials);
}

/** Why the output is not a readable file of the target type, or null when it is. */
export async function outputProblem(buffer: Buffer, target: string, workDir: string, options: OutputCheckOptions): Promise<string | null> {
  if (buffer.length === 0) return options.emptyInput === true ? null : 'empty output';
  if (options.mimeType === ZIP_MIME_TYPE && PAGE_TARGETS.has(target)) return pageArchiveProblem(buffer, target, workDir, options);
  if (options.mimeType === ZIP_MIME_TYPE && target === 'obj') return objArchiveProblem(buffer);
  if (target === 'obj') {
    const model = readableObj(buffer);
    return 'problem' in model ? model.problem : plainObjMaterialProblem(model.reading);
  }
  if (!isFormatCompatibleWithMagicBytes(buffer, target)) return `output bytes do not match ${target}`;
  const part = PACKAGE_PARTS[target];
  if (part !== undefined) {
    const zip = await JSZip.loadAsync(buffer).catch(() => null);
    if (zip === null || zip.file(part) === null) return `${target} package has no ${part}`;
  }
  const timeout = options.readerTimeoutMs ?? VALIDATOR_TIMEOUT_MS;
  const file = path.join(workDir, `out.${target}`);
  fs.writeFileSync(file, buffer);
  try {
    if (target === 'pdf' && options.pdfinfo !== '') execFileSync(options.pdfinfo, [file], { stdio: 'pipe', timeout });
    if (IMAGE_TARGETS.has(target) && options.identify !== '') execFileSync(options.identify, [file], { stdio: 'pipe', timeout });
  } catch (error) {
    return readerProblem(error);
  }
  return null;
}

interface ReaderError {
  code?: string;
  path?: string;
  stderr?: Buffer;
  signal?: string | null;
  status?: number | null;
}

/** The first non-empty line of what a reference reader printed to stderr, cut to MAX_TOOL_MESSAGE_CHARS code points; empty when it printed none. */
function firstStderrLine(stderr: Buffer | undefined): string {
  const line = (stderr?.toString() ?? '').split('\n').map((text) => text.trim()).find((text) => text !== '');
  return line === undefined ? '' : shown(line, MAX_TOOL_MESSAGE_CHARS);
}

/** How the reference reader ended, in the order that tells most: it did not start, it timed out, a signal killed it, it exited with a status; its first line of stderr goes with the last three. */
function readerProblem(error: unknown): string {
  const { code, path: binary, stderr, signal, status } = error as ReaderError;
  if (code === 'ENOENT') return `reference reader did not run: ${shown(binary ?? '', MAX_TOOL_MESSAGE_CHARS)} not found`;
  const said = firstStderrLine(stderr);
  if (code === 'ETIMEDOUT') return said === '' ? 'reference reader timed out' : `reference reader timed out: ${said}`;
  let ending = '';
  if (signal) ending = `signal ${shown(signal, MAX_TOOL_MESSAGE_CHARS)}`;
  else if (typeof status === 'number') ending = `exit ${status}`;
  if (said === '' && ending === '') return `reference reader refused the output: ${shown(String(error), MAX_TOOL_MESSAGE_CHARS)}`;
  if (said === '') return `reference reader refused the output: ${ending}`;
  return `reference reader refused the output: ${said}${ending === '' ? '' : ` (${ending})`}`;
}
