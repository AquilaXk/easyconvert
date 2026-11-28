import fs from 'node:fs';
import path from 'node:path';
import { endOfRun, recordEngineOutput } from '../engine-output';
import { CpuTaskTimeoutError, EngineUnavailableError, UnprocessableCadInputError } from '../types';
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
import { readSandboxOutputIfPresent } from '../security/sandbox-output';
import { stageTimeoutMs } from './job-time';
import { reportConversionWarning } from './conversion-warnings';
import { resolveBinaryPath } from './pdf-postprocess/utils';
import {
  DxfShapeError,
  READER_MAX_DIAGNOSTIC_BYTES,
  READER_MAX_OUTPUT_BYTES,
  READER_MEMORY_LIMIT_MB,
  SHELL_NOT_EXECUTABLE,
  SHELL_NOT_FOUND,
  convertDwgToDxf,
  forEachPair,
  type DwgReaderOptions,
} from './cad-dwg';

/**
 * DWG output. The engine has no DWG encoder of its own: `dxf2dwg` of the LibreDWG project (GPL-3.0-or-later, an unmodified
 * separate program built from the same pinned release as the reader) writes the DWG from a DXF. A DWG is always written as
 * AutoCAD 2000 (release R2000, `AC1015`): measured on public drawings (entry 471), it is the release whose output the pinned reader
 * reads back with the fewest faults, and every AutoCAD since 2000 and the open readers open it.
 *
 * The writer reports no failure for a drawing it cannot encode: it exits with status 0 and a file that has lost entities. So nothing is
 * returned that was not read back: the pinned reader reads the DWG, and the records of its DXF are counted against the records of the DXF
 * that went in. A drawing that lost any is refused with the number of records by type, and no file is returned.
 */

const WRITER_NAME = 'dxf2dwg';
const WRITER_PATH_VARIABLE = 'DXF2DWG_PATH';
const WRITER_CANDIDATES = ['/usr/local/bin/dxf2dwg', '/usr/bin/dxf2dwg', '/opt/homebrew/bin/dxf2dwg'];
/** One drawing may take this long in the writer; the job's own deadline can shorten it. */
const WRITER_DEFAULT_TIMEOUT_MS = 120_000;
const WRITER_RELEASE = 'r2000';
const INPUT_NAME = 'input.dxf';
const OUTPUT_NAME = 'output.dwg';
const WRITTEN_MAGIC = 'AC1015';
const MAGIC_BYTES = 6;
/** Largest DXF whose missing sections are completed in memory (the text is held as lines); a larger one goes to the writer as it is. */
const COMPLETION_MAX_BYTES = 32 * 1024 * 1024;
const BINARY_DXF_SENTINEL = 'AutoCAD Binary DXF';

export type DwgWriterOptions = DwgReaderOptions;

// ---------------------------------------------------------------------------------------------------------------
// Counting the records of a DXF

const LAYOUT_BLOCK = /^\*(?:model|paper)_space\d*$/i;
const MAX_LISTED_TYPES = 6;

/**
 * The records of the entity section and of the block definitions (the layout blocks `*Model_Space` and `*Paper_Space*` are left out, they hold
 * no entities of a DXF) counted by type: `E:LINE` for the ENTITIES section and `B:LINE` for a block. A malformed file, or one with no
 * ENTITIES section, is a DxfShapeError.
 */
export function countDxfRecords(dxf: Buffer): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (key: string): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  let section: string | null = null;
  let expectName = false;
  let sawEntities = false;
  /** The name of the block being read; empty until its name record, null outside a block. */
  let block: string | null = null;
  forEachPair(dxf, (code, value) => {
    if (expectName) {
      expectName = false;
      if (code === 2) section = value;
      if (value === 'ENTITIES') sawEntities = true;
      return;
    }
    if (section === 'BLOCKS' && block === '' && code === 2) {
      block = value;
      return;
    }
    if (code !== 0) return;
    if (value === 'SECTION') {
      expectName = true;
    } else if (value === 'ENDSEC') {
      section = null;
      block = null;
    } else if (section === 'ENTITIES') {
      bump(`E:${value}`);
    } else if (section === 'BLOCKS') {
      if (value === 'BLOCK') block = '';
      else if (value === 'ENDBLK') block = null;
      else if (block !== null && !LAYOUT_BLOCK.test(block)) bump(`B:${value}`);
    }
  });
  if (!sawEntities) throw new DxfShapeError('it has no ENTITIES section');
  return counts;
}

/** The records of `before` that `after` has fewer of, by type, with the number lost. */
function lostRecords(before: Map<string, number>, after: Map<string, number>): Array<[string, number]> {
  const lost: Array<[string, number]> = [];
  for (const [type, count] of before) {
    const kept = after.get(type) ?? 0;
    if (kept < count) lost.push([type, count - kept]);
  }
  return lost.sort((a, b) => b[1] - a[1]);
}

function describeLoss(lost: ReadonlyArray<[string, number]>): string {
  const label = ([type, count]: [string, number]): string => `${count} ${type.slice(2)}${type.startsWith('B:') ? ' in blocks' : ''}`;
  const listed = lost.slice(0, MAX_LISTED_TYPES).map(label).join(', ');
  return lost.length > MAX_LISTED_TYPES ? `${listed} and ${lost.length - MAX_LISTED_TYPES} more kinds` : listed;
}

// ---------------------------------------------------------------------------------------------------------------
// Completing the structure of a minimal DXF

/** The writer builds its tables from the BLOCK_RECORD table and takes entities into the layout blocks: a DXF without them yields no drawing. */
const FIRST_RELEASE_WITH_BLOCK_RECORDS = 'AC1015';
const DEFAULT_LAYER = '0';
const SECTION_ORDER = ['HEADER', 'CLASSES', 'TABLES', 'BLOCKS', 'ENTITIES', 'OBJECTS'] as const;

interface DxfPart {
  name: string;
  /** The lines of the section from its SECTION record to its ENDSEC record. */
  lines: string[];
}

const group = (code: number, value: string): string[] => [String(code).padStart(3), value];
const sectionHead = (name: string): string[] => [...group(0, 'SECTION'), ...group(2, name)];
const sectionEnd = (): string[] => group(0, 'ENDSEC');

function splitParts(lines: string[]): DxfPart[] {
  const parts: DxfPart[] = [];
  for (let i = 0; i + 3 < lines.length; i += 2) {
    if (lines[i].trim() !== '0' || lines[i + 1].trim() !== 'SECTION') continue;
    let end = i + 4;
    while (end + 1 < lines.length && !(lines[end].trim() === '0' && lines[end + 1].trim() === 'ENDSEC')) end += 2;
    parts.push({ name: lines[i + 3].trim(), lines: lines.slice(i, end + 2) });
    i = end;
  }
  return parts;
}

/** The values of group `code` that follow each record of type `record` before the next record, the first only. */
function firstValuesAfter(lines: string[], record: string, code: string): string[] {
  const values: string[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (lines[i].trim() !== '0' || lines[i + 1].trim() !== record) continue;
    for (let j = i + 2; j + 1 < lines.length && lines[j].trim() !== '0'; j += 2) {
      if (lines[j].trim() === code) {
        values.push(lines[j + 1].trim());
        break;
      }
    }
  }
  return values;
}

/** The layer names the entities and blocks use (group 8), by lower case name, with the spelling of the first use. */
function usedLayers(parts: DxfPart[]): Map<string, string> {
  const used = new Map<string, string>([[DEFAULT_LAYER, DEFAULT_LAYER]]);
  for (const part of parts) {
    if (part.name !== 'ENTITIES' && part.name !== 'BLOCKS') continue;
    for (let i = 0; i + 1 < part.lines.length; i += 2) {
      if (part.lines[i].trim() !== '8') continue;
      const name = part.lines[i + 1].trim();
      if (!used.has(name.toLowerCase())) used.set(name.toLowerCase(), name);
    }
  }
  return used;
}

/** The table of one kind (`LAYER`) inside the lines of the TABLES section: the index of its TABLE record and of its ENDTAB record, or null. */
function tableRange(lines: string[], kind: string): { start: number; end: number } | null {
  for (let i = 0; i + 3 < lines.length; i += 2) {
    if (lines[i].trim() !== '0' || lines[i + 1].trim() !== 'TABLE' || lines[i + 2].trim() !== '2' || lines[i + 3].trim() !== kind) continue;
    let end = i + 4;
    while (end + 1 < lines.length && !(lines[end].trim() === '0' && lines[end + 1].trim() === 'ENDTAB')) end += 2;
    return { start: i, end };
  }
  return null;
}

const layerRow = (name: string): string[] => [...group(0, 'LAYER'), ...group(2, name), ...group(70, '0'), ...group(62, '7'), ...group(6, 'CONTINUOUS')];
const blockRecordRow = (name: string): string[] => [...group(0, 'BLOCK_RECORD'), ...group(2, name)];
const layoutBlock = (name: string): string[] => [
  ...group(0, 'BLOCK'),
  ...group(8, DEFAULT_LAYER),
  ...group(2, name),
  ...group(70, '0'),
  ...group(10, '0'),
  ...group(20, '0'),
  ...group(30, '0'),
  ...group(3, name),
  ...group(0, 'ENDBLK'),
  ...group(8, DEFAULT_LAYER),
];

/** The HEADER lines with a release the writer can build tables for: below AutoCAD 2000, or none, the header says AC1015. */
function headerWithRelease(header: DxfPart | undefined): DxfPart {
  if (header === undefined) return { name: 'HEADER', lines: [...sectionHead('HEADER'), ...group(9, '$ACADVER'), ...group(1, FIRST_RELEASE_WITH_BLOCK_RECORDS), ...sectionEnd()] };
  const lines = [...header.lines];
  for (let i = 4; i + 3 < lines.length; i += 2) {
    if (lines[i].trim() === '9' && lines[i + 1].trim() === '$ACADVER') {
      if (lines[i + 3].trim() < FIRST_RELEASE_WITH_BLOCK_RECORDS) lines[i + 3] = FIRST_RELEASE_WITH_BLOCK_RECORDS;
      return { name: 'HEADER', lines };
    }
  }
  lines.splice(4, 0, ...group(9, '$ACADVER'), ...group(1, FIRST_RELEASE_WITH_BLOCK_RECORDS));
  return { name: 'HEADER', lines };
}

function tablesWithRecords(tables: DxfPart | undefined, layers: Map<string, string>, blockNames: string[]): DxfPart {
  const lines = tables === undefined ? [...sectionHead('TABLES'), ...sectionEnd()] : [...tables.lines];
  const layerTable = tableRange(lines, 'LAYER');
  const declared = new Set<string>();
  if (layerTable !== null) {
    for (const name of firstValuesAfter(lines.slice(layerTable.start, layerTable.end), 'LAYER', '2')) declared.add(name.toLowerCase());
  }
  const undeclared = [...layers].filter(([key]) => !declared.has(key)).map(([, name]) => name);
  const rows = undeclared.flatMap((name) => layerRow(name));
  if (layerTable !== null) lines.splice(layerTable.end, 0, ...rows);
  else lines.splice(lines.length - 2, 0, ...group(0, 'TABLE'), ...group(2, 'LAYER'), ...group(70, String(undeclared.length)), ...rows, ...group(0, 'ENDTAB'));
  if (tableRange(lines, 'BLOCK_RECORD') === null) {
    const records = blockNames.flatMap((name) => blockRecordRow(name));
    lines.splice(lines.length - 2, 0, ...group(0, 'TABLE'), ...group(2, 'BLOCK_RECORD'), ...group(70, String(blockNames.length)), ...records, ...group(0, 'ENDTAB'));
  }
  return { name: 'TABLES', lines };
}

function blocksWithLayouts(blocks: DxfPart | undefined, missingLayouts: string[]): DxfPart {
  const lines = blocks === undefined ? [...sectionHead('BLOCKS'), ...sectionEnd()] : [...blocks.lines];
  lines.splice(4, 0, ...missingLayouts.flatMap((name) => layoutBlock(name)));
  return { name: 'BLOCKS', lines };
}

/** The parts in the order of the file, with the ones that were missing placed where the format puts them. */
function placed(parts: DxfPart[], added: DxfPart[]): DxfPart[] {
  const result = [...parts];
  for (const part of added) {
    const rank = SECTION_ORDER.indexOf(part.name as (typeof SECTION_ORDER)[number]);
    const at = result.findIndex((other) => {
      const otherRank = SECTION_ORDER.indexOf(other.name as (typeof SECTION_ORDER)[number]);
      return otherRank > rank || otherRank < 0;
    });
    result.splice(at < 0 ? result.length : at, 0, part);
  }
  return result;
}

/**
 * A DXF the writer can use. Files of AutoCAD releases before 2000 and of generators that write only the entities have no BLOCK_RECORD table
 * and no layout blocks; the writer then finds no block table and writes a file without entities. This adds what is missing, and nothing else:
 * the release in the header (AutoCAD 2000), a LAYER table that names each layer the entities use, the BLOCK_RECORD table of the blocks, and the
 * two layout blocks. A file that has the table and the layout block is returned as it is, byte for byte. The entities are never touched.
 */
export function completeDxfStructure(dxf: Buffer): Buffer {
  if (dxf.length > COMPLETION_MAX_BYTES) return dxf;
  const lines = dxf.toString('latin1').split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (lines.length % 2 === 1 && lines[lines.length - 1] === '') lines.pop();
  const parts = splitParts(lines);
  const named = (name: string): DxfPart | undefined => parts.find((part) => part.name === name);
  const tables = named('TABLES');
  const blocks = named('BLOCKS');
  const definedBlocks = blocks === undefined ? [] : firstValuesAfter(blocks.lines, 'BLOCK', '2');
  const missingLayouts = ['*Model_Space', '*Paper_Space'].filter((layout) => !definedBlocks.some((name) => name.toLowerCase() === layout.toLowerCase()));
  const hasRecords = tables !== undefined && tableRange(tables.lines, 'BLOCK_RECORD') !== null;
  if (hasRecords && missingLayouts.length === 0) return dxf;

  const blockNames = [...new Set(['*Model_Space', '*Paper_Space', ...definedBlocks.filter((name) => !LAYOUT_BLOCK.test(name))])];
  const replaced = new Map<string, DxfPart>([
    ['HEADER', headerWithRelease(named('HEADER'))],
    ['TABLES', tablesWithRecords(tables, usedLayers(parts), blockNames)],
    ['BLOCKS', blocksWithLayouts(blocks, missingLayouts)],
  ]);
  const kept = parts.map((part) => replaced.get(part.name) ?? part);
  const added = [...replaced.values()].filter((part) => !parts.some((original) => original.name === part.name));
  const text = placed(kept, added).flatMap((part) => part.lines);
  return Buffer.from(`${[...text, ...group(0, 'EOF')].join('\n')}\n`, 'latin1');
}

// ---------------------------------------------------------------------------------------------------------------
// Running the writer

function writerBinary(): string {
  const binary = resolveBinaryPath(WRITER_PATH_VARIABLE, WRITER_CANDIDATES, WRITER_NAME);
  if (binary === null) throw new EngineUnavailableError(WRITER_NAME, 'dxf2dwg (LibreDWG) is not installed or not in PATH');
  return binary;
}

function toWriterError(error: unknown, timeoutMs: number): unknown {
  rethrowSandboxUnavailable(error);
  if (error instanceof SandboxedTimeoutError) return new CpuTaskTimeoutError('DWG writer', timeoutMs);
  if (error instanceof SandboxedMemoryLimitError) return new UnprocessableCadInputError('The DWG writer ran out of memory or crashed on this drawing.');
  if (error instanceof SandboxedBufferLimitError) return new UnprocessableCadInputError('The DWG writer printed more diagnostics than the limit allows: the drawing is damaged.');
  if (error instanceof SandboxedProcessError) {
    if (error.exitCode === SHELL_NOT_FOUND || error.exitCode === SHELL_NOT_EXECUTABLE) return new EngineUnavailableError(WRITER_NAME, 'dxf2dwg (LibreDWG) could not be started');
    recordEngineOutput(WRITER_NAME, 'write', error.stderr);
    return new UnprocessableCadInputError(`The DWG writer could not write this drawing: ${endOfRun(error)}.`);
  }
  return error;
}

async function runWriter(dxf: Buffer, options: DwgWriterOptions): Promise<Buffer> {
  const binary = writerBinary();
  const timeoutMs = stageTimeoutMs(options, WRITER_DEFAULT_TIMEOUT_MS);
  const sandboxDir = createWorkerSandboxDir();
  try {
    const inputPath = path.join(sandboxDir, INPUT_NAME);
    const outputPath = path.join(sandboxDir, OUTPUT_NAME);
    fs.writeFileSync(inputPath, dxf, { mode: 0o600 });
    try {
      await executeSandboxedBinary(binary, ['-y', '--as', WRITER_RELEASE, '-o', outputPath, inputPath], {
        cwd: sandboxDir,
        workDir: sandboxDir,
        timeoutMs,
        maxBuffer: READER_MAX_DIAGNOSTIC_BYTES,
        maxFileSize: READER_MAX_OUTPUT_BYTES,
        memoryLimitMb: READER_MEMORY_LIMIT_MB,
        networkIsolated: true,
        signal: options.signal,
      });
    } catch (error) {
      throw toWriterError(error, timeoutMs);
    }
    const dwg = readSandboxOutputIfPresent(outputPath, (size) => {
      if (size >= READER_MAX_OUTPUT_BYTES) throw new UnprocessableCadInputError('The drawing is larger than the DWG writer may write.');
    });
    if (dwg === null || dwg.subarray(0, MAGIC_BYTES).toString('latin1') !== WRITTEN_MAGIC) {
      throw new UnprocessableCadInputError('The DWG writer wrote no drawing from this file.');
    }
    return dwg;
  } finally {
    cleanupWorkerSandboxDir(sandboxDir);
  }
}

/** The DWG the pinned reader reads back, or a refusal that says the written file is not one. */
async function readBack(dwg: Buffer, options: DwgReaderOptions): Promise<Buffer> {
  try {
    return await convertDwgToDxf(dwg, options);
  } catch (error) {
    if (error instanceof UnprocessableCadInputError) throw new UnprocessableCadInputError('The DWG writer wrote a file that the DWG reader cannot read back, so no DWG is returned.');
    throw error;
  }
}

/**
 * Writes an ASCII DXF as an AutoCAD 2000 DWG and returns the DWG, which has been read back with the pinned reader and has every record of the
 * DXF. Fails with a 422 for a DXF that is no ASCII DXF, for one the writer cannot encode and for one whose drawing would lose entities (the
 * message counts them), a typed timeout when it overruns its time, and an engine-unavailable error (503, retried on another worker) when a program
 * is missing. Never returns an estimate: a failed write is an error.
 */
export async function convertDxfToDwg(dxf: Buffer, options: DwgWriterOptions = {}): Promise<Buffer> {
  if (dxf.subarray(0, BINARY_DXF_SENTINEL.length).toString('latin1') === BINARY_DXF_SENTINEL) {
    throw new UnprocessableCadInputError('This is a binary DXF; the DWG writer reads an ASCII DXF. Save the drawing as an ASCII DXF and convert that file.');
  }
  let before: Map<string, number>;
  try {
    before = countDxfRecords(dxf);
  } catch (error) {
    if (error instanceof DxfShapeError) throw new UnprocessableCadInputError(`The file is not an ASCII DXF: ${error.message}.`);
    throw error;
  }
  const dwg = await runWriter(completeDxfStructure(dxf), options);
  const after = countDxfRecords(await readBack(dwg, options));
  const lost = lostRecords(before, after);
  if (lost.length > 0) {
    throw new UnprocessableCadInputError(`The DWG writer would lose part of this drawing (${describeLoss(lost)}), so no DWG is returned. Convert the drawing to SVG, PDF or another format that keeps all of it.`);
  }
  return dwg;
}

/**
 * Writes a DWG as an AutoCAD 2000 DWG: the pinned reader writes its DXF, and the DXF goes through the writer and the check of `convertDxfToDwg`.
 * A drawing of a newer release is saved as the older release, which the result says.
 */
export async function convertDwgToDwg(dwg: Buffer, options: DwgWriterOptions = {}): Promise<Buffer> {
  const dxf = await convertDwgToDxf(dwg, options);
  const written = await convertDxfToDwg(dxf, options);
  if (dwg.subarray(0, MAGIC_BYTES).toString('latin1') > WRITTEN_MAGIC) {
    reportConversionWarning('The drawing is saved as an AutoCAD 2000 DWG; what the newer release of the source added to the format is left out.');
  }
  return written;
}
