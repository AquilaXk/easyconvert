import fs from 'node:fs';
import pkg from '../../package.json';
import { FORMAT_REGISTRY } from '../lib/registry';
import { executeSandboxedBinary, SandboxedProcessError } from '../lib/security/process-sandbox';
import { isCalibreEbookTarget } from '../lib/conversions/calibre-ebook-targets';
import { BUILT_IN_ENGINE, ENGINE_IDS, ENGINE_NAMES, isEngineId, type EngineId } from '../lib/conversions/engine-ids';
import { requiresNativeEngine } from '../lib/conversions/native-engine-pairs';
import { isArchiveRoutePair, isMediaRoutePair } from '../lib/conversions/route-formats';
import { RAW_CAMERA_FORMATS } from '../lib/conversions/raw-formats';
import { isSubtitlePair } from '../lib/conversions/subtitle';
import { EngineNotOfferedError, EngineVersionNotOfferedError } from '../lib/conversions/engine-errors';
import { EngineUnavailableError, type ConversionOptions } from '../lib/types';
import { resolveNativeBinary, type NativeBinaryName } from './engines';
import {
  ARCHIVE_EXTRACT_FORMATS,
  ARCHIVE_TARGET_FORMATS,
  IN_PROCESS_RAW_SENSOR_FORMATS,
  ILLUSTRATOR_FORMAT,
  OFFICE_NATIVE_RESAVE_FORMATS,
  PDF_SOURCE_FORMAT,
  PRESENTATION_HTML_SOURCES,
  RAW_PACKAGING_TARGETS,
  SVG_SOURCE,
  HTML_TARGET,
  fixedPageEngineOf,
  isPdfChainTarget,
} from './native-route-formats';
import { OFFICE_NATIVE_SOURCES, bridgeFormat, interchangeNeeded, isMarkupPageImagePair, officeSuiteWritesTarget, BIFF8_TARGET } from './office-suite-route';
import { siblingGhostscript } from './postscript-gs';
import { TEXT_PDF_SOURCES } from './text-pdf-route';

/**
 * Which engines convert a pair, and the version of each as installed (docs/policy-decisions.md, entry 267).
 *
 * An engine is listed for a pair only where the worker has a route of it: the rules below read the same format tables as
 * `executeWorkerConversion` and `convertFile`, in the order those try their routes. A pair has at most one program and, where
 * the in-process converter converts it too, the converter as the second engine. The default is the engine that runs when a
 * request names none: the program when the pair has one and it is installed, the converter otherwise (and for text sources,
 * where the program takes only scripts the converter cannot shape).
 */

export interface PairEngine {
  id: EngineId;
  /** Whether this engine runs when a request names none. */
  default: boolean;
}

/** Sources of the media engine that the in-process converter also decodes, and the targets it writes without FFmpeg (WAV and FLAC). */
const PURE_MEDIA_SOURCES: ReadonlySet<string> = new Set(['wav', 'aiff', 'aif', 'flac']);
const PURE_MEDIA_TARGETS: ReadonlySet<string> = new Set(['wav', 'flac']);
const SIGMA_RAW_SOURCE = 'x3f';
const PDF_TARGET = 'pdf';
const PDF_TEXT_TARGETS: ReadonlySet<string> = new Set(['txt', 'text']);
/** Text and markup sources the in-process converter renders to PDF unless the text needs the office suite's layout. */
const HTML_SOURCES: ReadonlySet<string> = new Set(['html', 'htm']);

/** FFmpeg reads and writes subtitles, and calibre writes the ebook targets: routes no other engine has. */
function subtitleOrEbookProgram(src: string, tgt: string): EngineId | undefined {
  if (isSubtitlePair(src, tgt)) return 'ffmpeg';
  return isCalibreEbookTarget(tgt) ? 'calibre' : undefined;
}

/** The office suite writes an interchange file, a Word 97 or RTF file bridged from a document, or a BIFF8 workbook; Poppler draws the page images of a text source. */
function bridgedProgram(src: string, tgt: string): EngineId | undefined {
  if (interchangeNeeded(src, tgt, isPdfChainTarget(tgt) || ARCHIVE_TARGET_FORMATS.has(tgt)) !== undefined) return 'libreoffice';
  if (bridgeFormat(src, tgt) !== undefined || (tgt === BIFF8_TARGET && src !== tgt)) return 'libreoffice';
  return isMarkupPageImagePair(src, tgt) ? 'poppler' : undefined;
}

/** PostScript, XPS and DjVu are drawn by the program of their own; an Illustrator file is a PDF that Poppler draws, or a PostScript program the interpreter draws. */
function fixedPageProgram(src: string, tgt: string): EngineId | undefined {
  const fixedPage = fixedPageEngineOf(src);
  if (fixedPage && (tgt === PDF_TARGET || isPdfChainTarget(tgt))) return fixedPage;
  return src === ILLUSTRATOR_FORMAT && isPdfChainTarget(tgt) ? 'poppler' : undefined;
}

/** The office suite writes the target in the pass that opens the source, renders a presentation's HTML, saves a drawing again, or renders text and HTML to PDF. */
function officeProgram(src: string, tgt: string): EngineId | undefined {
  const writes = OFFICE_NATIVE_SOURCES.has(src) && (officeSuiteWritesTarget(src, tgt) || isPdfChainTarget(tgt) || (PRESENTATION_HTML_SOURCES.has(src) && tgt === HTML_TARGET));
  const resaves = src === tgt && OFFICE_NATIVE_RESAVE_FORMATS.has(src);
  const rendersText = tgt === PDF_TARGET && TEXT_PDF_SOURCES.has(src);
  return writes || resaves || rendersText ? 'libreoffice' : undefined;
}

/** LibRaw decodes the camera files it opens (Sigma X3F it cannot); librsvg draws an SVG as a vector PDF. */
function pictureProgram(src: string, tgt: string): EngineId | undefined {
  if (RAW_CAMERA_FORMATS.has(src) && !RAW_PACKAGING_TARGETS.has(tgt) && src !== SIGMA_RAW_SOURCE) return 'libraw';
  return src === SVG_SOURCE && tgt === PDF_TARGET ? 'librsvg' : undefined;
}

/** The media engine runs FFmpeg for the pairs the archive engine does not take first. */
function mediaProgram(src: string, tgt: string): EngineId | undefined {
  const category = FORMAT_REGISTRY[src]?.category;
  return !isArchiveRoutePair(category, src, tgt) && isMediaRoutePair(category, tgt) ? 'ffmpeg' : undefined;
}

/** Poppler draws the pages of a PDF and reads its text; 7-Zip converts between the archives of its tables. */
function pdfOrArchiveProgram(src: string, tgt: string): EngineId | undefined {
  if (src === PDF_SOURCE_FORMAT && (isPdfChainTarget(tgt) || PDF_TEXT_TARGETS.has(tgt))) return 'poppler';
  return isNativeArchivePair(src, tgt) ? '7zip' : undefined;
}

/** The program that converts the pair, from the route the worker takes first; undefined when the in-process converter is the only engine. */
function programOf(src: string, tgt: string): EngineId | undefined {
  return (
    subtitleOrEbookProgram(src, tgt) ??
    bridgedProgram(src, tgt) ??
    fixedPageProgram(src, tgt) ??
    officeProgram(src, tgt) ??
    pictureProgram(src, tgt) ??
    mediaProgram(src, tgt) ??
    pdfOrArchiveProgram(src, tgt)
  );
}

/** The native 7-Zip route takes a pair of its tables, except Zstandard, which stock 7-Zip builds cannot open or create. */
function isNativeArchivePair(src: string, tgt: string): boolean {
  return ARCHIVE_EXTRACT_FORMATS.has(src) && ARCHIVE_TARGET_FORMATS.has(tgt) && !src.includes('zst') && !tgt.includes('zst');
}

/** Whether the in-process converter converts the pair when no program does. */
function converterConverts(src: string, tgt: string, program: EngineId | undefined): boolean {
  if (requiresNativeEngine(src, tgt)) return false;
  if (program === 'ffmpeg') return PURE_MEDIA_SOURCES.has(src) && PURE_MEDIA_TARGETS.has(tgt);
  if (program === 'libraw') return IN_PROCESS_RAW_SENSOR_FORMATS.has(src);
  // The in-process converter reads the text layer of a PDF, but draws no page: page images, SVG and PostScript need Poppler.
  if (program === 'poppler') return src === PDF_SOURCE_FORMAT && PDF_TEXT_TARGETS.has(tgt);
  if (program === 'calibre' || program === 'ghostscript' || program === 'ghostxps' || program === 'djvulibre') return false;
  if (program === '7zip') return isInProcessArchiveSource(src);
  return true;
}

/** Archive sources the in-process archive engine reads itself; the others need 7-Zip (`NATIVE_SEVEN_ZIP_SOURCES` of archive.ts, and RAR, which it reads only when stored). */
const IN_PROCESS_ARCHIVE_SOURCES: ReadonlySet<string> = new Set(['zip', '7z', 'tar', 'gz', 'gzip', 'tgz', 'tar.gz', 'bz2', 'bzip2', 'tbz2', 'tar.bz2', 'xz', 'txz', 'tar.xz']);
function isInProcessArchiveSource(src: string): boolean {
  return IN_PROCESS_ARCHIVE_SOURCES.has(src);
}

/** Whether the converter, not the program, runs first for the pair when a request names no engine. */
function converterRunsFirst(src: string, tgt: string, program: EngineId | undefined): boolean {
  if (program === 'libraw') return IN_PROCESS_RAW_SENSOR_FORMATS.has(src);
  // Plain text, Markdown and Hangul documents render in-process unless their script needs the office suite's layout.
  if (program === 'libreoffice' && tgt === PDF_TARGET && TEXT_PDF_SOURCES.has(src) && !HTML_SOURCES.has(src)) return true;
  return false;
}

/** The engines of a pair, the default first. Empty for a source or target the registry does not know. */
export function enginesForPair(source: string, target: string): PairEngine[] {
  const src = source.toLowerCase();
  const tgt = target.toLowerCase();
  if (!FORMAT_REGISTRY[src]?.targetFormats.includes(tgt)) return [];
  const program = programOf(src, tgt);
  const converter = program === undefined || converterConverts(src, tgt, program);
  const ids: EngineId[] = [];
  if (program !== undefined) ids.push(program);
  if (converter) {
    if (converterRunsFirst(src, tgt, program) || program === undefined) ids.unshift(BUILT_IN_ENGINE);
    else ids.push(BUILT_IN_ENGINE);
  }
  return ids.map((id, index) => ({ id, default: index === 0 }));
}

/** The programs the media engine and the in-process converter share: a result of a media pair that the converter returned was written by FFmpeg unless FFmpeg was off. */
export function engineOfResult(source: string, target: string, engineUsed: string | undefined, ffmpegRanInProcess: boolean): EngineId {
  const src = source.toLowerCase();
  const tgt = target.toLowerCase();
  const program = programOf(src, tgt);
  if (engineUsed !== undefined && engineUsed !== 'internal-fallback' && engineUsed !== 'in-process-raw') return program ?? BUILT_IN_ENGINE;
  if (program === 'ffmpeg' && ffmpegRanInProcess) return 'ffmpeg';
  return BUILT_IN_ENGINE;
}

/** The version of the in-process converter: the release it ships in. */
const BUILT_IN_VERSION: string = pkg.version;

interface VersionProbe {
  /** The binary of the worker's table that reports the version, or a function that finds it. */
  binary: NativeBinaryName | 'ghostscript';
  args: readonly string[];
  /** The version is the first group of this pattern, read from the output of the program. */
  pattern: RegExp;
}

const VERSION_NUMBER = String.raw`(\d+(?:\.\d+)+)`;

/** The engines whose program prints its own version. */
type ProbedEngineId = Exclude<EngineId, 'easyconvert' | 'libraw'>;

const VERSION_PROBES: Readonly<Record<ProbedEngineId, VersionProbe>> = {
  libreoffice: { binary: 'soffice', args: ['--version'], pattern: new RegExp(`LibreOffice ${VERSION_NUMBER}`) },
  ffmpeg: { binary: 'ffmpeg', args: ['-version'], pattern: new RegExp(`ffmpeg version n?${VERSION_NUMBER}`) },
  poppler: { binary: 'pdftoppm', args: ['-v'], pattern: new RegExp(`pdftoppm version ${VERSION_NUMBER}`) },
  '7zip': { binary: 'p7zip', args: [], pattern: new RegExp(String.raw`7-Zip (?:\(\w\) |\[\d+\] )?${VERSION_NUMBER}`) },
  ghostscript: { binary: 'ghostscript', args: ['--version'], pattern: new RegExp(`^${VERSION_NUMBER}`) },
  ghostxps: { binary: 'gxps', args: ['-h'], pattern: new RegExp(`Version: ${VERSION_NUMBER}`) },
  djvulibre: { binary: 'ddjvu', args: ['-help'], pattern: new RegExp(`DjVuLibre-${VERSION_NUMBER}`) },
  calibre: { binary: 'ebookConvert', args: ['--version'], pattern: new RegExp(`calibre ${VERSION_NUMBER}`) },
  librsvg: { binary: 'rsvgConvert', args: ['--version'], pattern: new RegExp(`version ${VERSION_NUMBER}`) },
};

/** The debian package that carries LibRaw's `dcraw_emu`, which prints no version: its version is the package's (the epoch and the release suffix cut). */
const LIBRAW_PACKAGE = 'libraw-bin';
const DPKG_STATUS_FILE = '/var/lib/dpkg/status';
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_BYTES = 64 * 1024;
/** A probe that could not run is asked again after this long; a version that was read is kept for the life of the process. */
const FAILED_PROBE_RETRY_MS = 60_000;

interface ProbeState {
  version?: string;
  failedAt?: number;
  pending?: Promise<string | undefined>;
}
const probes = new Map<string, ProbeState>();

function binaryOf(probe: VersionProbe): string | null {
  if (probe.binary !== 'ghostscript') return resolveNativeBinary(probe.binary);
  const ps2pdf = resolveNativeBinary('ps2pdf');
  return ps2pdf === null ? null : siblingGhostscript(ps2pdf);
}

async function runVersionProbe(binary: string, probe: VersionProbe): Promise<string | undefined> {
  let output: string;
  try {
    const result = await executeSandboxedBinary(binary, [...probe.args], { timeoutMs: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BYTES, networkIsolated: true, workDir: null });
    output = `${result.stdout.toString('utf-8')}\n${result.stderr.toString('utf-8')}`;
  } catch (err) {
    // Some programs print their version and exit with a failure status (a usage text); only a program that did not run says nothing.
    if (!(err instanceof SandboxedProcessError) || err.spawnErrorCode !== undefined) return undefined;
    output = `${err.stdout}\n${err.stderr}`;
  }
  return probe.pattern.exec(output)?.[1];
}

/** The version of a package in dpkg's status file, as the upstream release (`4:0.21.4-2` is `0.21.4`); undefined without dpkg or the package. */
export function debianPackageVersion(name: string, statusFile = DPKG_STATUS_FILE): string | undefined {
  let status: string;
  try {
    status = fs.readFileSync(statusFile, 'utf-8');
  } catch {
    return undefined;
  }
  for (const stanza of status.split('\n\n')) {
    if (!stanza.startsWith(`Package: ${name}\n`)) continue;
    const version = /^Version: (?:\d+:)?(\d+(?:\.\d+)+)/m.exec(stanza)?.[1];
    if (version !== undefined) return version;
  }
  return undefined;
}

/** Where an engine's program is installed, or null; the in-process converter is always there. */
function programPath(id: EngineId): string | null {
  if (id === BUILT_IN_ENGINE) return 'in-process';
  if (id === 'libraw') return resolveNativeBinary('dcrawEmu');
  return binaryOf(VERSION_PROBES[id]);
}

/** Whether the program of the engine is installed here (the converter always is). */
export function isEngineInstalled(id: EngineId): boolean {
  return programPath(id) !== null;
}

/** The installed version of an engine, read once from the program (its binary path, size and modification time key the answer) and kept; undefined when it is not installed or prints none. */
export async function installedEngineVersion(id: EngineId): Promise<string | undefined> {
  if (id === BUILT_IN_ENGINE) return BUILT_IN_VERSION;
  const binary = programPath(id);
  if (binary === null) return undefined;
  if (id === 'libraw') {
    const key = `${id}|${binary}`;
    const known = probes.get(key);
    if (known?.version !== undefined) return known.version;
    const version = debianPackageVersion(LIBRAW_PACKAGE);
    if (version !== undefined) probes.set(key, { version });
    return version;
  }
  const stat = fs.statSync(binary);
  const key = `${id}|${binary}|${stat.size}|${stat.mtimeMs}`;
  let state = probes.get(key);
  if (state === undefined) {
    state = {};
    probes.set(key, state);
  }
  if (state.version !== undefined) return state.version;
  if (state.pending !== undefined) return state.pending;
  if (state.failedAt !== undefined && Date.now() - state.failedAt < FAILED_PROBE_RETRY_MS) return undefined;
  const settled = state;
  settled.pending = runVersionProbe(binary, VERSION_PROBES[id]).then((version) => {
    if (version === undefined) settled.failedAt = Date.now();
    else settled.version = version;
    return version;
  }).finally(() => {
    settled.pending = undefined;
  });
  return settled.pending;
}

/** Forgets what the probes read (tests that point a program at another file). */
export function resetEngineVersionProbes(): void {
  probes.clear();
}

export interface EngineDescription {
  id: EngineId;
  name: string;
  /** Whether the program is installed on this deployment. */
  installed: boolean;
  /** The one version installed; absent when the engine is not installed or its program prints none. */
  version?: string;
}

/** Every engine with its installed version, in the order of `ENGINE_IDS`. */
export async function describeEngines(): Promise<EngineDescription[]> {
  return Promise.all(ENGINE_IDS.map(async (id) => {
    const version = await installedEngineVersion(id);
    return { id, name: ENGINE_NAMES[id], installed: isEngineInstalled(id), ...(version === undefined ? {} : { version }) };
  }));
}

/** The engine a request chose for a pair, as validated. */
export interface EngineChoice {
  engine: EngineId;
}

/** What a request may carry about its engine: the two options. */
export type EngineChoiceOptions = Pick<ConversionOptions, 'engine' | 'engineVersion'>;

function offeredList(ids: readonly string[]): string {
  return ids.length === 0 ? 'none' : ids.join(', ');
}

/**
 * Checks the engine and the version a request names against the pair: the engine must be one the pair lists (`engine_not_offered`,
 * with the list), and the version must be the one installed (`engine_version_unavailable`, naming it). Returns undefined when the
 * request names neither, so the pair's default runs as it always did. A named engine whose program is not installed is the
 * missing-tool answer (503), as for any engine.
 */
export async function resolveEngineChoice(source: string, target: string, options: EngineChoiceOptions): Promise<EngineChoice | undefined> {
  const { engine, engineVersion } = options;
  if (engine === undefined && engineVersion === undefined) return undefined;
  const offered = enginesForPair(source, target).map((entry) => entry.id);
  if (engine === undefined) {
    throw new EngineNotOfferedError(`engineVersion needs an engine: name one of the engines of the .${source} to .${target} conversion (${offeredList(offered)}).`, offered);
  }
  if (!isEngineId(engine) || !offered.includes(engine)) {
    const known = isEngineId(engine) ? `Engine '${engine}' does not convert` : `'${engine}' is not an engine that converts`;
    throw new EngineNotOfferedError(`${known} .${source} to .${target}; one of ${offeredList(offered)} does.`, offered);
  }
  if (!isEngineInstalled(engine)) throw new EngineUnavailableError(ENGINE_NAMES[engine], 'the program is not installed on this deployment');
  await assertInstalledVersion(engine, engineVersion);
  return { engine };
}

/** Refuses a version other than the installed one (`engine_version_unavailable`); a request that names none passes. */
async function assertInstalledVersion(engine: EngineId, requested: string | undefined): Promise<void> {
  if (requested === undefined) return;
  const version = await installedEngineVersion(engine);
  if (requested === version) return;
  const installed = version === undefined ? 'its version cannot be read, so no version can be named' : `the installed version is ${version}`;
  throw new EngineVersionNotOfferedError(`Engine '${engine}' has no version ${requested} here: ${installed}.`, engine, version);
}

/**
 * The check of a request that cannot say its pair yet (a graph node reads the file an earlier node writes): the engine must be one
 * of the catalogue and the version the installed one. Whether the pair lists the engine is checked when the node runs.
 */
export async function checkEngineNamed(options: EngineChoiceOptions): Promise<void> {
  const { engine, engineVersion } = options;
  if (engine === undefined && engineVersion === undefined) return;
  if (engine === undefined || !isEngineId(engine)) {
    throw new EngineNotOfferedError(`${engine === undefined ? 'engineVersion needs an engine' : `'${engine}' is not an engine`}: name one of ${ENGINE_IDS.join(', ')}.`, ENGINE_IDS);
  }
  await assertInstalledVersion(engine, engineVersion);
}

