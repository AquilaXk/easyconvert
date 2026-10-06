import os from 'node:os';
import { OcrEngineUnavailableError } from '../types';
import {
  executeSandboxedBinary,
  SandboxedBufferLimitError,
  SandboxedMemoryLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
} from '../security/process-sandbox';
import { parseTesseractBlocks, type OcrResult } from './ocr-pdf-combiner';
import { fallbackReadsMore, ocrFallbackPageSegMode, ocrSegmentationFor } from './ocr-config';

/** Wall-clock limit for one native Tesseract run. */
export const OCR_CLI_TIMEOUT_MS = 15_000;
/** The sandbox's own timer fires this much later than the abort signal, as a backstop. */
const OCR_CLI_TIMER_BACKSTOP_MS = 2_000;
/** Largest TSV (plus diagnostics) accepted from the CLI; larger output kills the process. */
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

/** Rebuilds an OCR result (text, line and word boxes, mean confidence) from `tessedit_create_tsv` output. */
export function parseTesseractTsv(tsv: string): OcrResult {
  if (countDataRows(tsv) > OCR_CLI_MAX_TSV_ROWS) throw malformed(`more than ${OCR_CLI_MAX_TSV_ROWS} rows.`);
  const rows = tsv.split('\n');
  if (rows[0]?.replace(/\r$/, '') !== TSV_HEADER) throw malformed('the header row is missing.');

  let pageWidth: number | null = null;
  let pageHeight = 0;
  // block -> paragraph -> line, in the order Tesseract emitted them.
  const blocks = new Map<number, Map<number, Map<number, TsvLine>>>();
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

  const textBlocks: string[] = [];
  const parsedBlocks: unknown[] = [];
  let confidenceSum = 0;
  let confidenceCount = 0;
  let wordCount = 0;
  for (const paragraphs of blocks.values()) {
    const paragraphTexts: string[] = [];
    const parsedParagraphs: unknown[] = [];
    for (const lines of paragraphs.values()) {
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
        parsedParagraphs.push({ lines: parsedLines });
      }
    }
    if (paragraphTexts.length > 0) {
      textBlocks.push(paragraphTexts.join('\n\n'));
      parsedBlocks.push({ paragraphs: parsedParagraphs });
    }
  }

  const text = textBlocks.join('\n\n');
  const { lines, lineBlocks } = parseTesseractBlocks(parsedBlocks, pageWidth, pageHeight);
  return {
    text,
    confidence: confidenceCount > 0 ? confidenceSum / confidenceCount / CONFIDENCE_PERCENT_SCALE : null,
    wordCount,
    lines,
    lineBlocks,
    imageWidth: pageWidth,
    imageHeight: pageHeight,
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
  /** An image the CLI can read; passed on stdin, so no temporary files are written. */
  image: Buffer;
  timeoutMs?: number;
  maxOutputBytes?: number;
  memoryLimitMb?: number;
  /** Replaces the page segmentation chosen for the language; used for the single-block retry. */
  pageSegMode?: string;
}

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
  const first = await runCli(request);
  const fallbackMode = ocrFallbackPageSegMode(request.tesseractLang);
  if (!fallbackMode || first.wordCount > 0 || request.pageSegMode) return first;
  // Automatic segmentation finds no text block in very small images; read them as one block.
  const retry = await runCli({ ...request, pageSegMode: fallbackMode });
  return fallbackReadsMore(first.wordCount, retry.wordCount) ? retry : first;
}

async function runCli(request: CliOcrRequest): Promise<OcrResult> {
  const timeoutMs = request.timeoutMs ?? OCR_CLI_TIMEOUT_MS;
  const memoryLimitMb = request.memoryLimitMb ?? OCR_CLI_MEMORY_LIMIT_MB;
  const segmentation = ocrSegmentationFor(request.tesseractLang);
  const pageSegMode = request.pageSegMode ?? segmentation.pageSegMode;
  const { engineMode } = segmentation;
  const args = [
    '--tessdata-dir', request.tessdataDir,
    'stdin', 'stdout',
    '-l', request.tesseractLang,
    '--psm', pageSegMode,
    '--oem', String(engineMode),
    '-c', 'tessedit_create_tsv=1',
  ];
  let stdout: Buffer;
  try {
    // The timeout starts when the process does, not while the request waits for a slot.
    ({ stdout } = await cliSemaphore.run(() =>
      executeSandboxedBinary(request.cliPath, args, {
        stdin: request.image,
        env: { OMP_THREAD_LIMIT: OCR_CLI_THREAD_LIMIT },
        signal: AbortSignal.timeout(timeoutMs),
        timeoutMs: timeoutMs + OCR_CLI_TIMER_BACKSTOP_MS,
        maxBuffer: request.maxOutputBytes ?? OCR_CLI_MAX_OUTPUT_BYTES,
        memoryLimitMb,
      })
    ));
  } catch (err) {
    if (err instanceof OcrEngineUnavailableError) throw err;
    if (isTimeout(err)) {
      throw new OcrEngineUnavailableError(`Tesseract CLI did not finish within ${timeoutMs} ms.`);
    }
    if (err instanceof SandboxedBufferLimitError) {
      throw new OcrEngineUnavailableError('Tesseract CLI produced more output than the allowed limit.');
    }
    if (err instanceof SandboxedMemoryLimitError) {
      throw new OcrEngineUnavailableError(`Tesseract CLI exceeded its ${memoryLimitMb} MB memory limit.`);
    }
    if (err instanceof SandboxedProcessError) {
      logCliFailure('Tesseract CLI failed', err.stderr);
      const reason = err.signal ? `terminated by signal ${err.signal}` : `failed with exit code ${err.exitCode}`;
      throw new OcrEngineUnavailableError(`Tesseract CLI ${reason}.`);
    }
    logCliFailure('Tesseract CLI could not run', err instanceof Error ? err.message : String(err));
    throw new OcrEngineUnavailableError('Tesseract CLI could not be started.');
  }
  return parseTesseractTsv(stdout.toString('utf-8'));
}
