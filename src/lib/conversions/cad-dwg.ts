import fs from 'node:fs';
import path from 'node:path';
import {
  CadGeometryError,
  CpuTaskTimeoutError,
  EngineUnavailableError,
  UnprocessableCadInputError,
  UnsupportedDwgVersionError,
  type ConversionOptions,
} from '../types';
import {
  SandboxedBufferLimitError,
  SandboxedMemoryLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
  cleanupWorkerSandboxDir,
  createWorkerSandboxDir,
  executeSandboxedBinary,
  rethrowSandboxUnavailable,
} from '../../worker/sandbox';
import { stageTimeoutMs, type JobDeadlined } from './job-time';
import { reportConversionWarning } from './conversion-warnings';
import { resolveBinaryPath } from './pdf-postprocess/utils';

/**
 * DWG input. The engine has no DWG decoder of its own: `dwg2dxf` of the LibreDWG project (GPL-3.0-or-later, an unmodified
 * separate program, pinned in the images and in CI) writes a DXF, and the DXF path draws it. The file is refused before the
 * program starts when its release is one the reader does not decode reliably, and what the program writes is checked
 * to be a well-formed ASCII DXF before the DXF path reads it. Damaged files are what the program is exposed to, so it runs
 * in the process sandbox with a time, memory, output and file-size limit and without a network.
 */

// ---------------------------------------------------------------------------------------------------------------
// Release codes

export interface DwgVersion {
  /** The release code that starts the file: `AC1015`. */
  magic: string;
  /** The AutoCAD release that wrote it, as the Open Design Specification names it: `R2000`. */
  release: string;
  /** Whether the reader decodes this release reliably. */
  readable: boolean;
}

/** Release codes of the Open Design Specification for .dwg files, oldest first. The codes are not all the same length. */
const RELEASES: ReadonlyArray<readonly [magic: string, release: string]> = [
  ['MC0.0', 'R1.0'],
  ['AC1.2', 'R1.2'],
  ['AC1.40', 'R1.40'],
  ['AC1.50', 'R2.0'],
  ['AC2.10', 'R2.10'],
  ['AC1002', 'R2.5'],
  ['AC1003', 'R2.6'],
  ['AC1004', 'R9'],
  ['AC1006', 'R10'],
  ['AC1009', 'R11/R12'],
  ['AC1012', 'R13'],
  ['AC1014', 'R14'],
  ['AC1015', 'R2000'],
  ['AC1018', 'R2004'],
  ['AC1021', 'R2007'],
  ['AC1024', 'R2010'],
  ['AC1027', 'R2013'],
  ['AC1032', 'R2018'],
];

/**
 * The releases the reader decodes reliably: R13 (the first with the object-map layout) to R2018. The reader's own
 * help text calls its output for the older line-oriented layouts experimental, and no licensed drawing with an
 * independent truth exists for them, so they are refused with the way out in the message.
 */
const READABLE_MAGICS: ReadonlySet<string> = new Set(['AC1012', 'AC1014', 'AC1015', 'AC1018', 'AC1021', 'AC1024', 'AC1027', 'AC1032']);
const NEWEST_KNOWN_CODE = 1032;
const MAGIC_PROBE_BYTES = 6;
const ACAD_CODE = /^AC10(\d\d)$/;

const BY_LENGTH_DESCENDING = [...RELEASES].sort((a, b) => b[0].length - a[0].length);

/** The release of a DWG from the code at the start of the file, or null when the bytes do not start like any DWG. */
export function identifyDwgVersion(header: Buffer): DwgVersion | null {
  const probe = header.subarray(0, MAGIC_PROBE_BYTES).toString('latin1');
  for (const [magic, release] of BY_LENGTH_DESCENDING) {
    if (probe.startsWith(magic)) return { magic, release, readable: READABLE_MAGICS.has(magic) };
  }
  // A code of the AC10xx family that the table does not list: a release newer than the reader knows, or a code nobody released.
  if (ACAD_CODE.test(probe)) return { magic: probe, release: Number(probe.slice(2)) > NEWEST_KNOWN_CODE ? 'a release newer than R2018' : 'an unreleased format code', readable: false };
  return null;
}

const SAVE_AS_HINT = 'Save the drawing as an AutoCAD 2000 or newer DWG (or as a DXF) and convert that file.';

/** The release of a DWG the reader decodes; a 400 for bytes that are no DWG at all, a 422 for a release it does not decode. */
export function assertReadableDwg(input: Buffer): DwgVersion {
  const version = identifyDwgVersion(input);
  if (version === null) {
    throw new CadGeometryError('The file is not a DWG drawing: it does not start with a DWG release code.');
  }
  if (!version.readable) {
    throw new UnsupportedDwgVersionError(
      `This DWG is ${version.release} (${version.magic}), which the DWG reader does not decode. It reads R13 (AC1012) to AutoCAD 2018 (AC1032). ${SAVE_AS_HINT}`,
      version.magic
    );
  }
  return version;
}

// ---------------------------------------------------------------------------------------------------------------
// The DXF the reader writes

export interface DxfFacts {
  /** Records between the start of the ENTITIES section and its end. */
  entities: number;
  /** Proxy entities (objects of an add-on application) in ENTITIES and BLOCKS: the reader keeps them as stubs with no geometry. */
  proxyEntities: number;
}

const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;
const MAX_GROUP_CODE = 1071;
const PROXY_ENTITY = 'ACAD_PROXY_ENTITY';

class DxfShapeError extends Error {}

/** Group codes whose value the structure check reads: the record type (0) and the name of a section (2). The other values are skipped unread. */
const STRUCTURE_CODES: ReadonlySet<number> = new Set([0, 2]);

/**
 * Calls `visit` with the group code of every pair and, for the codes the structure check reads, its value (an empty string for
 * the others, which are not decoded); throws DxfShapeError when the bytes are not pairs of an integer line and a value line.
 */
function forEachPair(dxf: Buffer, visit: (code: number, value: string) => void): void {
  let position = 0;
  let line = 0;
  let pendingCode = -1;
  while (position < dxf.length) {
    let end = dxf.indexOf(LINE_FEED, position);
    if (end < 0) end = dxf.length;
    let stop = end;
    if (stop > position && dxf[stop - 1] === CARRIAGE_RETURN) stop--;
    line++;
    if (pendingCode < 0) {
      let code = 0;
      let digits = 0;
      let index = position;
      while (index < stop && dxf[index] === 0x20) index++;
      while (index < stop && dxf[index] >= 0x30 && dxf[index] <= 0x39) {
        code = code * 10 + (dxf[index] - 0x30);
        digits++;
        index++;
      }
      while (index < stop && dxf[index] === 0x20) index++;
      if (digits === 0 || digits > 4 || index !== stop || code > MAX_GROUP_CODE) throw new DxfShapeError(`line ${line} is not a group code`);
      pendingCode = code;
    } else {
      visit(pendingCode, STRUCTURE_CODES.has(pendingCode) ? dxf.toString('utf8', position, stop).trim() : '');
      pendingCode = -1;
    }
    position = end + 1;
  }
  if (pendingCode >= 0) throw new DxfShapeError('the last group code has no value');
}

/**
 * Checks that `dxf` is an ASCII DXF in the layout of the DXF reference: pairs of a group code and a value, balanced
 * SECTION / ENDSEC records, an ENTITIES section, and the EOF record last. A reader that failed half way, or a file that is
 * no DXF, stops here and never reaches the DXF path.
 */
export function assertDxfDocument(dxf: Buffer): DxfFacts {
  const fail = (why: string): UnprocessableCadInputError => new UnprocessableCadInputError(`The DWG reader wrote no usable drawing: ${why}.`);
  if (dxf.length === 0) throw fail('its output is empty');
  if (dxf.indexOf(0) >= 0) throw fail('its output holds NUL bytes, which an ASCII DXF does not');
  let section: string | null = null;
  let expectName = false;
  let sawEntities = false;
  let sawEof = false;
  let entities = 0;
  let proxyEntities = 0;
  try {
    forEachPair(dxf, (code, value) => {
      if (sawEof) throw new DxfShapeError('records follow the EOF record');
      if (expectName) {
        expectName = false;
        if (code !== 2) throw new DxfShapeError('a SECTION record has no name');
        section = value;
        if (value === 'ENTITIES') sawEntities = true;
        return;
      }
      if (code !== 0) return;
      if (value === 'SECTION') {
        if (section !== null) throw new DxfShapeError('a SECTION starts inside a section');
        expectName = true;
      } else if (value === 'ENDSEC') {
        if (section === null) throw new DxfShapeError('an ENDSEC closes no section');
        section = null;
      } else if (value === 'EOF') {
        if (section !== null) throw new DxfShapeError('the EOF record comes inside a section');
        sawEof = true;
      } else if (section === 'ENTITIES') {
        entities++;
        if (value === PROXY_ENTITY) proxyEntities++;
      } else if (section === 'BLOCKS' && value === PROXY_ENTITY) {
        proxyEntities++;
      }
    });
  } catch (error) {
    if (error instanceof DxfShapeError) throw fail(`its output is not a DXF (${error.message})`);
    throw error;
  }
  if (!sawEof) throw fail('its output ends before the EOF record');
  if (!sawEntities) throw fail('its output has no ENTITIES section');
  return { entities, proxyEntities };
}

// ---------------------------------------------------------------------------------------------------------------
// Running the reader

const READER_NAME = 'dwg2dxf';
const READER_PATH_VARIABLE = 'DWG2DXF_PATH';
const READER_CANDIDATES = ['/usr/local/bin/dwg2dxf', '/usr/bin/dwg2dxf', '/opt/homebrew/bin/dwg2dxf'];
/** One drawing may take this long in the reader; the job's own deadline can shorten it. */
const READER_DEFAULT_TIMEOUT_MS = 120_000;
/** The reader keeps the whole drawing in memory; this is above what the drawings of the corpus need by a wide margin. */
const READER_MEMORY_LIMIT_MB = 2048;
/** The largest DXF accepted: the DXF reader holds it as one string, which V8 caps near 512 MB. */
const READER_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
/** Its messages go to the error stream, one line per fault in a damaged file. */
const READER_MAX_DIAGNOSTIC_BYTES = 4 * 1024 * 1024;
const MAX_DETAIL_CHARS = 160;
const INPUT_NAME = 'input.dwg';
const OUTPUT_NAME = 'output.dxf';
const SHELL_NOT_EXECUTABLE = 126;
const SHELL_NOT_FOUND = 127;
const UNPRINTABLE = /[^\x20-\x7e]/g;

export type DwgReaderOptions = Pick<ConversionOptions, 'signal' | 'timeoutMs'> & JobDeadlined;

function readerBinary(): string {
  const binary = resolveBinaryPath(READER_PATH_VARIABLE, READER_CANDIDATES, READER_NAME);
  if (binary === null) {
    throw new EngineUnavailableError(READER_NAME, 'dwg2dxf (LibreDWG) is not installed or not in PATH');
  }
  return binary;
}

/** The first error line the reader printed, with the scratch directory and every unprintable character removed. */
function diagnostic(stderr: string, sandboxDir: string): string {
  const first = stderr
    .replaceAll(sandboxDir, '<tmp>')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^error/i.test(line));
  if (first === undefined) return '';
  return ` (${first.replace(UNPRINTABLE, '?').slice(0, MAX_DETAIL_CHARS)})`;
}

function toReaderError(error: unknown, sandboxDir: string, timeoutMs: number): unknown {
  rethrowSandboxUnavailable(error);
  if (error instanceof SandboxedTimeoutError) return new CpuTaskTimeoutError('DWG reader', timeoutMs);
  // The sandbox reports a signal SIGSEGV or SIGKILL of a memory-limited process as a memory error: running out of the limit and
  // crashing on a damaged file look the same to it, and the message says both.
  if (error instanceof SandboxedMemoryLimitError) return new UnprocessableCadInputError('The DWG reader ran out of memory or crashed on this drawing.');
  if (error instanceof SandboxedBufferLimitError) return new UnprocessableCadInputError('The DWG reader printed more diagnostics than the limit allows: the drawing is damaged.');
  if (error instanceof SandboxedProcessError) {
    if (error.exitCode === SHELL_NOT_FOUND || error.exitCode === SHELL_NOT_EXECUTABLE) {
      return new EngineUnavailableError(READER_NAME, 'dwg2dxf (LibreDWG) could not be started');
    }
    const how = error.signal ? `was stopped by ${error.signal}` : `exited with status ${error.exitCode}`;
    return new UnprocessableCadInputError(`The DWG reader could not read this drawing: it ${how}${diagnostic(error.stderr, sandboxDir)}.`);
  }
  return error;
}

/**
 * Converts a DWG to an ASCII DXF with the pinned reader and returns the DXF, checked to be well formed. Fails with a 400 for
 * bytes that are no DWG, a typed 422 for a release or a drawing the reader refuses, a typed timeout when it overruns its
 * time, and an engine-unavailable error (503, retried on another worker) when the program is missing. Never returns an
 * estimate: a failed read is an error.
 */
export async function convertDwgToDxf(input: Buffer, options: DwgReaderOptions = {}): Promise<Buffer> {
  assertReadableDwg(input);
  const binary = readerBinary();
  const timeoutMs = stageTimeoutMs(options, READER_DEFAULT_TIMEOUT_MS);
  const sandboxDir = createWorkerSandboxDir();
  try {
    const inputPath = path.join(sandboxDir, INPUT_NAME);
    const outputPath = path.join(sandboxDir, OUTPUT_NAME);
    fs.writeFileSync(inputPath, input, { mode: 0o600 });
    try {
      await executeSandboxedBinary(binary, ['-y', '-o', outputPath, inputPath], {
        cwd: sandboxDir,
        timeoutMs,
        maxBuffer: READER_MAX_DIAGNOSTIC_BYTES,
        maxFileSize: READER_MAX_OUTPUT_BYTES,
        memoryLimitMb: READER_MEMORY_LIMIT_MB,
        networkIsolated: true,
        signal: options.signal,
      });
    } catch (error) {
      throw toReaderError(error, sandboxDir, timeoutMs);
    }
    if (!fs.existsSync(outputPath)) {
      throw new UnprocessableCadInputError('The DWG reader wrote no drawing from this file.');
    }
    if (fs.statSync(outputPath).size >= READER_MAX_OUTPUT_BYTES) {
      throw new UnprocessableCadInputError('The drawing is larger than the DWG reader may write.');
    }
    const dxf = fs.readFileSync(outputPath);
    const facts = assertDxfDocument(dxf);
    if (facts.proxyEntities > 0) {
      const noun = facts.proxyEntities === 1 ? 'proxy entity' : 'proxy entities';
      reportConversionWarning(`${facts.proxyEntities} ${noun} (objects of an add-on application, which a DWG stores without drawable geometry) were left out of the drawing.`);
    }
    return dxf;
  } finally {
    cleanupWorkerSandboxDir(sandboxDir);
  }
}
