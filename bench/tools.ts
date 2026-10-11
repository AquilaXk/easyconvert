import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { TOOL_MAX_BUFFER_BYTES, TOOL_TIMEOUT_MS } from './config';
import { MissingToolError, ToolRunError } from './errors';

/**
 * Reference tool discovery. Tools run as separate, unmodified executables. `BENCH_TOOL_DIRS` narrows the search
 * to the listed directories (an empty value finds nothing), which is how a child process sees a toolchain without
 * the tools to exercise the skip and strict-mode paths for real.
 */

/** Candidate executable names per tool; the first one found is used. */
const CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  ffmpeg: ['ffmpeg'],
  ffprobe: ['ffprobe'],
  cwebp: ['cwebp'],
  dwebp: ['dwebp'],
  avifenc: ['avifenc'],
  avifdec: ['avifdec'],
  magick: ['magick', 'convert'],
  zstd: ['zstd'],
  xz: ['xz'],
  '7z': ['7zz', '7z', '7za'],
  tar: ['tar'],
  zip: ['zip'],
  unzip: ['unzip'],
  gzip: ['gzip'],
  bzip2: ['bzip2'],
  unrar: ['unrar'],
  woff2_compress: ['woff2_compress'],
  woff2_decompress: ['woff2_decompress'],
  sfnt2woff: ['sfnt2woff'],
  woff2sfnt: ['woff2sfnt'],
  pdftotext: ['pdftotext'],
  tesseract: ['tesseract'],
  soffice: ['soffice', 'libreoffice'],
  pdfimages: ['pdfimages'],
  epubcheck: ['epubcheck'],
  'ebook-convert': ['ebook-convert'],
  python3: ['python3'],
  ssimulacra2: ['ssimulacra2', 'ssimulacra2_rs'],
};

/** Arguments that make each tool print its version, and the first line of output is kept. */
const VERSION_ARGS: Readonly<Record<string, readonly string[]>> = {
  ffmpeg: ['-version'],
  ffprobe: ['-version'],
  cwebp: ['-version'],
  dwebp: ['-version'],
  avifenc: ['--version'],
  avifdec: ['--version'],
  magick: ['-version'],
  zstd: ['--version'],
  xz: ['--version'],
  '7z': ['i'],
  tar: ['--version'],
  zip: ['-v'],
  unzip: ['-v'],
  gzip: ['--version'],
  bzip2: ['--version'],
  unrar: [],
  pdftotext: ['-v'],
  tesseract: ['--version'],
  soffice: ['--version'],
  pdfimages: ['-v'],
  epubcheck: ['--version'],
  'ebook-convert': ['--version'],
  ssimulacra2: ['--version'],
};

/** Tools that print no version: the Debian package that ships them is asked instead. */
const PACKAGE_OF: Readonly<Record<string, string>> = {
  woff2_compress: 'woff2',
  woff2_decompress: 'woff2',
  sfnt2woff: 'woff-tools',
  woff2sfnt: 'woff-tools',
};

const VERSION_TIMEOUT_MS = 20_000;
const VERSION_LINE_LIMIT = 200;

export const TESSDATA_PSEUDO_TOOL = 'tessdata-eng';
export const LIBVMAF_PSEUDO_TOOL = 'libvmaf';
/** Resolves to python3 when the olefile package (OLE2 container access) imports in isolated mode. */
export const OLEFILE_PSEUDO_TOOL = 'python3-olefile';
/** Resolve to python3 when the library imports in isolated mode; the version of the tool is the library's. */
export const PYARROW_PSEUDO_TOOL = 'python3-pyarrow';
export const DUCKDB_PSEUDO_TOOL = 'python3-duckdb';
export const OPENPYXL_PSEUDO_TOOL = 'python3-openpyxl';
export const FONTTOOLS_PSEUDO_TOOL = 'python3-fonttools';
const PYTHON_LIBRARY_OF: Readonly<Record<string, string>> = {
  [PYARROW_PSEUDO_TOOL]: 'pyarrow',
  [DUCKDB_PSEUDO_TOOL]: 'duckdb',
  [OPENPYXL_PSEUDO_TOOL]: 'openpyxl',
  [FONTTOOLS_PSEUDO_TOOL]: 'fontTools',
};

const TESSDATA_DIRS = [
  ...(process.env.TESSDATA_PREFIX ? [process.env.TESSDATA_PREFIX] : []),
  '/usr/share/tesseract-ocr/5/tessdata',
  '/usr/share/tesseract-ocr/4.00/tessdata',
  '/usr/share/tessdata',
  '/opt/homebrew/share/tessdata',
  '/usr/local/share/tessdata',
];

export type Resolver = (tool: string) => string | null;

function searchDirs(env: NodeJS.ProcessEnv): string[] {
  const restricted = env.BENCH_TOOL_DIRS;
  if (restricted !== undefined) return restricted.split(path.delimiter).filter(Boolean);
  const onPath = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return [...new Set([...onPath, '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/bin'])];
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Resolves a tool name to an absolute path, or null when it is not installed. */
export function defaultResolver(env: NodeJS.ProcessEnv = process.env): Resolver {
  const cache = new Map<string, string | null>();
  return (tool) => {
    const cached = cache.get(tool);
    if (cached !== undefined) return cached;
    let found: string | null = null;
    if (tool === TESSDATA_PSEUDO_TOOL) {
      const dirs = env.BENCH_TOOL_DIRS === undefined ? TESSDATA_DIRS : [];
      found = dirs.find((dir) => fs.existsSync(path.join(dir, 'eng.traineddata'))) ?? null;
    } else if (tool === OLEFILE_PSEUDO_TOOL) {
      const python = defaultResolver(env)('python3');
      found = python && pythonImports(python, 'olefile') ? python : null;
    } else if (PYTHON_LIBRARY_OF[tool] !== undefined) {
      const python = defaultResolver(env)('python3');
      found = python && pythonImports(python, PYTHON_LIBRARY_OF[tool]) ? python : null;
    } else if (tool === LIBVMAF_PSEUDO_TOOL) {
      const ffmpeg = defaultResolver(env)('ffmpeg');
      found = ffmpeg && ffmpegHasFilter(ffmpeg, 'libvmaf') ? ffmpeg : null;
    } else {
      const names = CANDIDATES[tool] ?? [tool];
      for (const dir of searchDirs(env)) {
        const hit = names.map((name) => path.join(dir, name)).find(isExecutable);
        if (hit) {
          found = hit;
          break;
        }
      }
    }
    cache.set(tool, found);
    return found;
  };
}

/** Whether `python -I -c "import <module>"` succeeds. */
export function pythonImports(python: string, moduleName: string): boolean {
  const run = spawnSync(python, ['-I', '-c', `import ${moduleName}`], { timeout: VERSION_TIMEOUT_MS });
  return run.status === 0;
}

/** Whether `ffmpeg -filters` lists `filter`. */
export function ffmpegHasFilter(ffmpeg: string, filter: string): boolean {
  const run = spawnSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: VERSION_TIMEOUT_MS });
  if (run.status !== 0) return false;
  return new RegExp(`^\\s*\\S+\\s+${filter}\\s`, 'm').test(run.stdout);
}

export function toolVersion(tool: string, binary: string | null): string | null {
  if (!binary) return null;
  const library = PYTHON_LIBRARY_OF[tool];
  if (library !== undefined) return pythonLibraryVersion(binary, library);
  const pkg = PACKAGE_OF[tool];
  if (pkg !== undefined) return packageVersion(pkg) ?? path.basename(binary);
  const args = VERSION_ARGS[tool];
  if (!args) return path.basename(binary);
  const run = spawnSync(binary, [...args], { encoding: 'utf8', timeout: VERSION_TIMEOUT_MS });
  const text = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const line = text.split('\n').map((l) => l.trim()).find((l) => /\d/.test(l));
  return (line ?? path.basename(binary)).slice(0, VERSION_LINE_LIMIT);
}

/** `<library> <version>` as the library reports it, or the library name when it reports none. */
function pythonLibraryVersion(python: string, library: string): string {
  const run = spawnSync(python, ['-I', '-c', `import ${library} as m; v = getattr(m, '__version__', None) or getattr(m, 'version', ''); print(v if isinstance(v, str) else '')`], { encoding: 'utf8', timeout: VERSION_TIMEOUT_MS });
  const version = (run.stdout ?? '').trim();
  return `${library} ${version}`.trim().slice(0, VERSION_LINE_LIMIT);
}

/** `<package> <version>` from the Debian package database, or null where there is none (a laptop, a container without dpkg). */
function packageVersion(pkg: string): string | null {
  const run = spawnSync('/usr/bin/dpkg-query', ['-W', '-f', '${Version}', pkg], { encoding: 'utf8', timeout: VERSION_TIMEOUT_MS });
  return run.status === 0 && run.stdout.trim() !== '' ? `${pkg} ${run.stdout.trim()}` : null;
}

export interface ToolPlanReady {
  ok: true;
  paths: Readonly<Record<string, string>>;
}

export interface ToolPlanSkipped {
  ok: false;
  missing: string[];
  optional: boolean;
  reason: string;
}

export type ToolPlan = ToolPlanReady | ToolPlanSkipped;

export interface PlanOptions {
  /** An optional tool (a metric that is only reported when installed) is skipped even under strict mode. */
  optional?: boolean;
}

/**
 * Decides whether a row can run: every tool in `required` must resolve. A row with a missing tool is skipped with
 * an explicit reason; under strict mode (ORACLE_STRICT_MODE=1) the same absence throws MissingToolError instead,
 * unless the tool is optional.
 */
export function planTools(
  required: readonly string[],
  context: string,
  resolver: Resolver,
  strict: boolean,
  options: PlanOptions = {}
): ToolPlan {
  const paths: Record<string, string> = {};
  const missing: string[] = [];
  for (const tool of required) {
    const resolved = resolver(tool);
    if (resolved) paths[tool] = resolved;
    else missing.push(tool);
  }
  if (missing.length === 0) return { ok: true, paths };
  const optional = options.optional === true;
  if (strict && !optional) throw new MissingToolError(missing, context);
  return { ok: false, missing, optional, reason: `${optional ? 'optional ' : ''}tool${missing.length === 1 ? '' : 's'} not installed: ${missing.join(', ')}` };
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: Buffer;
  timeoutMs?: number;
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

/** Runs a reference tool, throwing ToolRunError with the stderr tail on a non-zero exit, timeout or runaway output. */
export function runTool(binary: string, args: readonly string[], options: RunOptions = {}): RunResult {
  const run = spawnSync(binary, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    timeout: options.timeoutMs ?? TOOL_TIMEOUT_MS,
    maxBuffer: TOOL_MAX_BUFFER_BYTES,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = run.stderr?.toString('utf8') ?? '';
  if (run.error) throw new ToolRunError(`${path.basename(binary)} could not run: ${run.error.message}`);
  if (run.status !== 0) {
    throw new ToolRunError(`${path.basename(binary)} exited with ${run.status ?? run.signal}: ${stderr.slice(-600).trim()}`);
  }
  return { stdout: run.stdout, stderr };
}
