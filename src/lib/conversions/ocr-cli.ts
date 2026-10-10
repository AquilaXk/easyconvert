import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OcrEngineUnavailableError, SandboxUnavailableError } from '../types';
import {
  executeSandboxedBinary,
  SandboxedBufferLimitError,
  SandboxedMemoryLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
} from '../security/process-sandbox';
import { parseTesseractBlocks, type OcrResult } from './ocr-pdf-combiner';
import { groupAtBoundaries, wordBoundariesAfter, type OcrWordMerge } from './ocr-word-merge';
import { fallbackReadsMore, ocrFallbackPageSegMode, ocrSegmentationFor } from './ocr-config';

/** Wall-clock limit for one native Tesseract run. */
export const OCR_CLI_TIMEOUT_MS = 15_000;
/** The sandbox's own timer fires this much later than the abort signal, as a backstop. */
const OCR_CLI_TIMER_BACKSTOP_MS = 2_000;
/** Largest output file (and diagnostics) accepted from the CLI; larger output kills the process. */
export const OCR_CLI_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** Most TSV data rows parsed from one run; a dense page has a few thousand. */
export const OCR_CLI_MAX_TSV_ROWS = 100_000;
/** Native runs allowed at once; each holds a decoded page, so more only adds memory pressure. */
export const OCR_CLI_MAX_CONCURRENCY = Math.max(1, os.availableParallelism());
/** Runs allowed to wait for a slot before further requests are rejected. */
export const OCR_CLI_MAX_QUEUED = 64;
/** Resident memory limit for one native run; the sandbox kills the process group above it. */
export const OCR_CLI_MEMORY_LIMIT_MB = 2048;
/** Characters of CLI diagnostics written to the server log; they are never sent to clients. */
export const OCR_CLI_LOGGED_STDERR_CHARS = 500;

/** Prefix of the private directory each run writes its output files to; removed when the run ends. */
const OCR_CLI_JOB_DIR_PREFIX = 'easyconvert-ocr-';
const OCR_CLI_OUTPUT_BASENAME = 'page';

/**
 * Tesseract starts one OpenMP thread per CPU in every process. With several runs in flight those
 * threads spin against each other and runs stop making progress (16 concurrent runs on 4 CPUs
 * did not finish in 300 s, against 3.7 s when limited). One thread gives the same single-run
 * latency, so concurrency comes from running processes side by side instead.
 */
const OCR_CLI_THREAD_LIMIT = '1';

const TSV_COLUMNS = [
  'level',
  'page_num',
  'block_num',
  'par_num',
  'line_num',
  'word_num',
  'left',
  'top',
  'width',
  'height',
  'conf',
  'text',
] as const;
const TSV_HEADER = TSV_COLUMNS.join('\t');
type TsvColumn = (typeof TSV_COLUMNS)[number];
const COLUMN = Object.fromEntries(TSV_COLUMNS.map((name, index) => [name, index])) as Record<TsvColumn, number>;
const TSV_LEVEL_PAGE = 1;
const TSV_LEVEL_BLOCK = 2;
const TSV_LEVEL_PARAGRAPH = 3;
const TSV_LEVEL_LINE = 4;
const TSV_LEVEL_WORD = 5;
const CONFIDENCE_PERCENT_SCALE = 100;
const INTEGER_FIELD = /^-?\d+$/;
const DECIMAL_FIELD = /^-?\d+(\.\d+)?$/;

interface TsvBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface TsvWord {
  text: string;
  confidence: number | undefined;
  bbox: TsvBox;
}
interface TsvLine {
  bbox: TsvBox | null;
  words: TsvWord[];
}

/** Output the engine cannot be trusted to have produced correctly is an engine fault (503). */
function malformed(message: string): OcrEngineUnavailableError {
  return new OcrEngineUnavailableError(`Malformed Tesseract TSV output: ${message}`);
}

/** Counts data rows without allocating one string per row. */
function countDataRows(tsv: string): number {
  let newlines = 0;
  for (let at = tsv.indexOf('\n'); at !== -1; at = tsv.indexOf('\n', at + 1)) newlines++;
  const lines = tsv.endsWith('\n') ? newlines : newlines + 1;
  return lines - 1;
}

function integerField(value: string, name: string, row: number): number {
  if (!INTEGER_FIELD.test(value)) throw malformed(`row ${row} has a non-integer ${name} '${value}'.`);
  return Number.parseInt(value, 10);
}

function unionBox(words: TsvWord[]): TsvBox {
  const union = { ...words[0].bbox };
  for (const word of words) {
    union.x0 = Math.min(union.x0, word.bbox.x0);
    union.y0 = Math.min(union.y0, word.bbox.y0);
    union.x1 = Math.max(union.x1, word.bbox.x1);
    union.y1 = Math.max(union.y1, word.bbox.y1);
  }
  return union;
}

/** One word from consecutive rows: joined text, union box, and the lowest confidence of its parts. */
function joinTsvWords(group: readonly TsvWord[]): TsvWord {
  let confidence: number | undefined;
  for (const word of group) {
    if (word.confidence !== undefined && (confidence === undefined || word.confidence < confidence)) {
      confidence = word.confidence;
    }
  }
  return { text: group.map((word) => word.text).join(''), confidence, bbox: unionBox([...group]) };
}

/**
 * Merges the rows of every line into whole words, in place, using the spacing of `pageText`.
 * Rows that do not spell out the page text are left as they are; no text is invented.
 */
function mergeTsvWords(blocks: Map<number, Map<number, Map<number, TsvLine>>>, pageText: string): OcrWordMerge | undefined {
  const lines: TsvLine[] = [];
  for (const paragraphs of blocks.values()) {
    for (const paragraphLines of paragraphs.values()) lines.push(...paragraphLines.values());
  }
  const rows = lines.flatMap((line) => line.words);
  if (rows.length === 0) return undefined;
  const boundaryAfter = wordBoundariesAfter(
    pageText,
    rows.map((row) => row.text)
  );
  if (boundaryAfter === null) return 'unaligned';
  let offset = 0;
  for (const line of lines) {
    const rowCount = line.words.length;
    line.words = groupAtBoundaries(line.words, boundaryAfter.slice(offset, offset + rowCount), joinTsvWords);
    offset += rowCount;
  }
  return 'aligned';
}

/** Key of a paragraph in `paragraphBoxes`; paragraph numbers restart in every block. */
function paragraphKey(block: number, par: number): string {
  return `${block}/${par}`;
}

/**
 * Rebuilds an OCR result (text, block, paragraph, line and word boxes, mean confidence) from
 * `tessedit_create_tsv` output. `language` is the recognition language, recorded on the result.
 *
 * `pageText` is the engine's own text of the same page (`tessedit_create_txt`). TSV carries one
 * row per recognized word, which for Korean, Japanese and Chinese is one character, and no
 * spacing; the page text keeps the original spacing, so boxes with no whitespace between them in
 * it are merged into one word. Without `pageText` the rows are used as they are.
 */
export function parseTesseractTsv(tsv: string, language?: string, pageText?: string): OcrResult {
  if (countDataRows(tsv) > OCR_CLI_MAX_TSV_ROWS) throw malformed(`more than ${OCR_CLI_MAX_TSV_ROWS} rows.`);
  const rows = tsv.split('\n');
  if (rows[0]?.replace(/\r$/, '') !== TSV_HEADER) throw malformed('the header row is missing.');

  let pageWidth: number | null = null;
  let pageHeight = 0;
  // block -> paragraph -> line, in the order Tesseract emitted them.
  const blocks = new Map<number, Map<number, Map<number, TsvLine>>>();
  const blockBoxes = new Map<number, TsvBox>();
  const paragraphBoxes = new Map<string, TsvBox>();
  const lineAt = (block: number, par: number, line: number): TsvLine => {
    const paragraphs = blocks.get(block) ?? new Map<number, Map<number, TsvLine>>();
    blocks.set(block, paragraphs);
    const lines = paragraphs.get(par) ?? new Map<number, TsvLine>();
    paragraphs.set(par, lines);
    const existing = lines.get(line) ?? { bbox: null, words: [] };
    lines.set(line, existing);
    return existing;
  };

  for (let index = 1; index < rows.length; index++) {
    const raw = rows[index].replace(/\r$/, '');
    if (raw === '') continue;
    const fields = raw.split('\t');
    if (fields.length <= COLUMN.text) {
      throw malformed(`row ${index} has ${fields.length} columns, expected ${TSV_COLUMNS.length}.`);
    }
    const level = integerField(fields[COLUMN.level], 'level', index);
    const left = integerField(fields[COLUMN.left], 'left', index);
    const top = integerField(fields[COLUMN.top], 'top', index);
    const width = integerField(fields[COLUMN.width], 'width', index);
    const height = integerField(fields[COLUMN.height], 'height', index);
    if (width < 0 || height < 0) throw malformed(`row ${index} has a negative size.`);
    const box: TsvBox = { x0: left, y0: top, x1: left + width, y1: top + height };

    if (level === TSV_LEVEL_PAGE) {
      pageWidth = width;
      pageHeight = height;
    } else if (level === TSV_LEVEL_BLOCK) {
      blockBoxes.set(integerField(fields[COLUMN.block_num], 'block_num', index), box);
    } else if (level === TSV_LEVEL_PARAGRAPH) {
      const block = integerField(fields[COLUMN.block_num], 'block_num', index);
      paragraphBoxes.set(paragraphKey(block, integerField(fields[COLUMN.par_num], 'par_num', index)), box);
    } else if (level === TSV_LEVEL_LINE) {
      lineAt(
        integerField(fields[COLUMN.block_num], 'block_num', index),
        integerField(fields[COLUMN.par_num], 'par_num', index),
        integerField(fields[COLUMN.line_num], 'line_num', index)
      ).bbox = box;
    } else if (level === TSV_LEVEL_WORD) {
      const confField = fields[COLUMN.conf];
      if (!DECIMAL_FIELD.test(confField)) throw malformed(`row ${index} has a non-numeric conf '${confField}'.`);
      const text = fields.slice(COLUMN.text).join('\t').trim();
      if (!text) continue;
      const conf = Number.parseFloat(confField);
      lineAt(
        integerField(fields[COLUMN.block_num], 'block_num', index),
        integerField(fields[COLUMN.par_num], 'par_num', index),
        integerField(fields[COLUMN.line_num], 'line_num', index)
      ).words.push({ text, confidence: conf >= 0 ? conf : undefined, bbox: box });
    }
  }
  if (pageWidth === null) throw malformed('the page row is missing.');

  const mergeOutcome = pageText === undefined ? undefined : mergeTsvWords(blocks, pageText);

  const textBlocks: string[] = [];
  const parsedBlocks: unknown[] = [];
  let confidenceSum = 0;
  let confidenceCount = 0;
  let wordCount = 0;
  for (const [blockNumber, paragraphs] of blocks) {
    const paragraphTexts: string[] = [];
    const parsedParagraphs: unknown[] = [];
    for (const [parNumber, lines] of paragraphs) {
      const lineTexts: string[] = [];
      const parsedLines: unknown[] = [];
      for (const line of lines.values()) {
        if (line.words.length === 0) continue;
        const text = line.words.map((w) => w.text).join(' ');
        lineTexts.push(text);
        parsedLines.push({ text, bbox: line.bbox ?? unionBox(line.words), words: line.words });
        for (const word of line.words) {
          wordCount++;
          if (word.confidence !== undefined) {
            confidenceSum += word.confidence;
            confidenceCount++;
          }
        }
      }
      if (lineTexts.length > 0) {
        paragraphTexts.push(lineTexts.join('\n'));
        parsedParagraphs.push({ bbox: paragraphBoxes.get(paragraphKey(blockNumber, parNumber)), lines: parsedLines });
      }
    }
    if (paragraphTexts.length > 0) {
      textBlocks.push(paragraphTexts.join('\n\n'));
      parsedBlocks.push({ bbox: blockBoxes.get(blockNumber), paragraphs: parsedParagraphs });
    }
  }

  const text = textBlocks.join('\n\n');
  const { lines, lineBlocks } = parseTesseractBlocks(parsedBlocks, pageWidth, pageHeight, language);
  return {
    wordMerge: mergeOutcome,
    text,
    confidence: confidenceCount > 0 ? confidenceSum / confidenceCount / CONFIDENCE_PERCENT_SCALE : null,
    wordCount,
    lines,
    lineBlocks,
    imageWidth: pageWidth,
    imageHeight: pageHeight,
    language,
  };
}

/** Bounds concurrent native runs and the queue behind them. */
export class CliSemaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly limit: number,
    private readonly maxQueued: number,
    /** What is queued, for the saturation message. */
    private readonly unit: string = 'native runs'
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      if (this.waiting.length >= this.maxQueued) {
        throw new OcrEngineUnavailableError(
          `OCR is saturated: ${this.maxQueued} ${this.unit} are already waiting.`
        );
      }
      // The slot is handed over directly, so `active` stays counted across the hand-off.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

const cliSemaphore = new CliSemaphore(OCR_CLI_MAX_CONCURRENCY, OCR_CLI_MAX_QUEUED);

export interface CliOcrRequest {
  cliPath: string;
  tessdataDir: string;
  tesseractLang: string;
  /** An image the CLI can read; passed on stdin. */
  image: Buffer;
  timeoutMs?: number;
  maxOutputBytes?: number;
  memoryLimitMb?: number;
  /** The job's signal: the run is killed when it fires, as well as at its own timeout. */
  signal?: AbortSignal;
  /** Replaces the page segmentation chosen for the language; used for the single-block retry. */
  pageSegMode?: string;
  /** Image height in pixels; images too short for page layout analysis are read as one block. */
  imageHeight?: number;
  /** Text rows counted in a short image; one row is read as a single line. */
  textRows?: number;
  /**
   * Also write the engine's own markup of the page (hOCR or ALTO) and return it on the result as `engineMarkup`.
   * For checking the product exports against the engine; it costs no second run.
   */
  engineMarkup?: OcrEngineMarkupFormat;
}

/** The markup formats the engine writes itself. */
export type OcrEngineMarkupFormat = 'hocr' | 'alto';
/** Tesseract config variable and output file extension of each engine markup format. */
const ENGINE_MARKUP_OUTPUT: Readonly<Record<OcrEngineMarkupFormat, { variable: string; extension: string }>> = {
  hocr: { variable: 'tessedit_create_hocr', extension: 'hocr' },
  alto: { variable: 'tessedit_create_alto', extension: 'xml' },
};

function isTimeout(err: unknown): boolean {
  return err instanceof SandboxedTimeoutError || (err instanceof Error && err.name === 'TimeoutError');
}

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Keeps CLI diagnostics in the server log only, stripped of control characters and truncated. */
function logCliFailure(summary: string, diagnostics: string): void {
  const cleaned = diagnostics.replace(CONTROL_CHARACTERS, '').replace(/\s+/g, ' ').trim();
  console.warn(`[ocr] ${summary}: ${cleaned.slice(0, OCR_CLI_LOGGED_STDERR_CHARS)}`);
}

/**
 * Runs the native Tesseract CLI without blocking the event loop. At most OCR_CLI_MAX_CONCURRENCY
 * runs execute at once. Each run is bounded by an AbortSignal timeout, an output cap and a
 * memory limit, and the whole process group is killed when one trips. Errors sent to callers
 * carry fixed messages; the CLI's own diagnostics go to the server log.
 */
export async function recognizeWithCli(request: CliOcrRequest): Promise<OcrResult> {
  const imageMode = ocrSegmentationFor(request.tesseractLang, request.imageHeight, request.textRows).pageSegMode;
  if (!request.pageSegMode && imageMode !== ocrSegmentationFor(request.tesseractLang).pageSegMode) {
    return runCli({ ...request, pageSegMode: imageMode });
  }
  const first = await runCli(request);
  const fallbackMode = ocrFallbackPageSegMode(request.tesseractLang);
  if (!fallbackMode || first.wordCount > 0 || request.pageSegMode) return first;
  // Automatic segmentation finds no text block in very small images; read them as one block.
  const retry = await runCli({ ...request, pageSegMode: fallbackMode });
  return fallbackReadsMore(first.wordCount, retry.wordCount) ? retry : first;
}

/**
 * Reads one output file of a run. A file at the cap is refused as well as a larger one: the
 * file-size limit stops a writer at exactly that many bytes, so such a file may be cut short.
 */
async function readJobOutput(file: string, maxBytes: number, what: string): Promise<string> {
  let size: number;
  try {
    size = (await fs.promises.stat(file)).size;
  } catch {
    throw malformed(`the ${what} output is missing.`);
  }
  if (size >= maxBytes) throw new OcrEngineUnavailableError('Tesseract CLI produced more output than the allowed limit.');
  return fs.promises.readFile(file, 'utf-8');
}

/** The error a caller sees for a failed run; the CLI's own diagnostics go to the server log only. */
function describeCliFailure(err: unknown, timeoutMs: number, memoryLimitMb: number): Error {
  if (err instanceof OcrEngineUnavailableError || err instanceof SandboxUnavailableError) return err;
  if (isTimeout(err)) return new OcrEngineUnavailableError(`Tesseract CLI did not finish within ${timeoutMs} ms.`);
  if (err instanceof SandboxedBufferLimitError) {
    return new OcrEngineUnavailableError('Tesseract CLI produced more output than the allowed limit.');
  }
  if (err instanceof SandboxedMemoryLimitError) {
    return new OcrEngineUnavailableError(`Tesseract CLI exceeded its ${memoryLimitMb} MB memory limit.`);
  }
  if (err instanceof SandboxedProcessError) {
    logCliFailure('Tesseract CLI failed', err.stderr);
    const reason = err.signal ? `terminated by signal ${err.signal}` : `failed with exit code ${err.exitCode}`;
    return new OcrEngineUnavailableError(`Tesseract CLI ${reason}.`);
  }
  logCliFailure('Tesseract CLI could not run', err instanceof Error ? err.message : String(err));
  return new OcrEngineUnavailableError('Tesseract CLI could not be started.');
}

/**
 * The signal of one CLI run: its own timeout, and the job's signal when there is one. The run ends with the job's
 * reason, not a timeout, when the job is over (deadline, cancel), so the caller does not mistake it for a slow page.
 */
function runSignal(timeoutMs: number, jobSignal?: AbortSignal): AbortSignal {
  const own = AbortSignal.timeout(timeoutMs);
  return jobSignal ? AbortSignal.any([own, jobSignal]) : own;
}

async function runCli(request: CliOcrRequest): Promise<OcrResult> {
  const timeoutMs = request.timeoutMs ?? OCR_CLI_TIMEOUT_MS;
  const memoryLimitMb = request.memoryLimitMb ?? OCR_CLI_MEMORY_LIMIT_MB;
  const maxOutputBytes = request.maxOutputBytes ?? OCR_CLI_MAX_OUTPUT_BYTES;
  const segmentation = ocrSegmentationFor(request.tesseractLang);
  const pageSegMode = request.pageSegMode ?? segmentation.pageSegMode;
  const { engineMode } = segmentation;
  // TSV holds the boxes and the page text holds the spacing, which one stream on stdout cannot
  // carry together, so both go to a private directory that is removed when the run ends.
  const jobDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), OCR_CLI_JOB_DIR_PREFIX));
  const outputBase = path.join(jobDir, OCR_CLI_OUTPUT_BASENAME);
  const args = [
    '--tessdata-dir', request.tessdataDir,
    'stdin', outputBase,
    '-l', request.tesseractLang,
    '--psm', pageSegMode,
    '--oem', String(engineMode),
    '-c', 'tessedit_create_tsv=1',
    '-c', 'tessedit_create_txt=1',
    ...(request.engineMarkup ? ['-c', `${ENGINE_MARKUP_OUTPUT[request.engineMarkup].variable}=1`] : []),
  ];
  try {
    try {
      // The timeout starts when the process does, not while the request waits for a slot.
      await cliSemaphore.run(() =>
        executeSandboxedBinary(request.cliPath, args, {
          stdin: request.image,
          env: { OMP_THREAD_LIMIT: OCR_CLI_THREAD_LIMIT },
          signal: runSignal(timeoutMs, request.signal),
          timeoutMs: timeoutMs + OCR_CLI_TIMER_BACKSTOP_MS,
          maxBuffer: maxOutputBytes,
          maxFileSize: maxOutputBytes,
          memoryLimitMb,
        })
      );
    } catch (err) {
      if (request.signal?.aborted) throw request.signal.reason;
      throw describeCliFailure(err, timeoutMs, memoryLimitMb);
    }
    const tsv = await readJobOutput(`${outputBase}.tsv`, maxOutputBytes, 'TSV');
    const pageText = await readJobOutput(`${outputBase}.txt`, maxOutputBytes, 'text');
    const parsed = parseTesseractTsv(tsv, request.tesseractLang, pageText);
    if (!request.engineMarkup) return parsed;
    const { extension } = ENGINE_MARKUP_OUTPUT[request.engineMarkup];
    const content = await readJobOutput(`${outputBase}.${extension}`, maxOutputBytes, request.engineMarkup);
    return { ...parsed, engineMarkup: { format: request.engineMarkup, content } };
  } finally {
    await fs.promises.rm(jobDir, { recursive: true, force: true });
  }
}

/** Largest orientation report accepted from the CLI; a real one is a few lines. */
const OCR_CLI_OSD_MAX_OUTPUT_BYTES = 64 * 1024;
const OSD_TOO_FEW_CHARACTERS = /Too few characters/;

export interface CliOsdRequest {
  cliPath: string;
  /** Directory holding `osd.traineddata`. */
  tessdataDir: string;
  /** A page the CLI can read, passed on stdin. */
  image: Buffer;
  timeoutMs?: number;
  memoryLimitMb?: number;
  /** The job's signal: the run is killed when it fires, as well as at its own timeout. */
  signal?: AbortSignal;
}

/**
 * Runs the native tool's orientation and script detection (`--psm 0`) under the same limits and slot
 * count as recognition. Returns the report it prints, or null when it found too few characters to
 * read; any other failure is an OcrEngineUnavailableError with a fixed message.
 */
export async function runOsdWithCli(request: CliOsdRequest): Promise<string | null> {
  const timeoutMs = request.timeoutMs ?? OCR_CLI_TIMEOUT_MS;
  const memoryLimitMb = request.memoryLimitMb ?? OCR_CLI_MEMORY_LIMIT_MB;
  const args = ['--tessdata-dir', request.tessdataDir, 'stdin', 'stdout', '-l', 'osd', '--psm', '0'];
  try {
    const { stdout } = await cliSemaphore.run(() =>
      executeSandboxedBinary(request.cliPath, args, {
        stdin: request.image,
        env: { OMP_THREAD_LIMIT: OCR_CLI_THREAD_LIMIT },
        signal: runSignal(timeoutMs, request.signal),
        timeoutMs: timeoutMs + OCR_CLI_TIMER_BACKSTOP_MS,
        maxBuffer: OCR_CLI_OSD_MAX_OUTPUT_BYTES,
        memoryLimitMb,
      })
    );
    return stdout.toString('utf-8');
  } catch (err) {
    if (request.signal?.aborted) throw request.signal.reason;
    if (err instanceof SandboxedProcessError && OSD_TOO_FEW_CHARACTERS.test(err.stderr)) return null;
    throw describeCliFailure(err, timeoutMs, memoryLimitMb);
  }
}
