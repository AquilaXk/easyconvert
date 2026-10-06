import { ConversionFailedError, OcrEngineUnavailableError } from '../types';
import {
  executeSandboxedBinary,
  SandboxedBufferLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
} from '../security/process-sandbox';
import { parseTesseractBlocks, type OcrResult } from './ocr-pdf-combiner';
import { ocrSegmentationFor } from './ocr-config';

/** Wall-clock limit for one native Tesseract run. */
export const OCR_CLI_TIMEOUT_MS = 15_000;
/** The sandbox's own timer fires this much later than the abort signal, as a backstop. */
const OCR_CLI_TIMER_BACKSTOP_MS = 2_000;
/** Largest TSV (plus diagnostics) accepted from the CLI; larger output kills the process. */
export const OCR_CLI_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** Most TSV rows parsed from one run; a dense page has a few thousand. */
export const OCR_CLI_MAX_TSV_ROWS = 500_000;

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
const TSV_TEXT_COLUMN = TSV_COLUMNS.indexOf('text');
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

function malformed(message: string): ConversionFailedError {
  return new ConversionFailedError(`Malformed Tesseract TSV output: ${message}`);
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
  const rows = tsv.split('\n');
  if (rows[0]?.replace(/\r$/, '') !== TSV_HEADER) throw malformed('the header row is missing.');
  if (rows.length - 1 > OCR_CLI_MAX_TSV_ROWS) {
    throw malformed(`more than ${OCR_CLI_MAX_TSV_ROWS} rows.`);
  }

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
    if (fields.length <= TSV_TEXT_COLUMN) {
      throw malformed(`row ${index} has ${fields.length} columns, expected ${TSV_COLUMNS.length}.`);
    }
    const level = integerField(fields[0], 'level', index);
    const left = integerField(fields[6], 'left', index);
    const top = integerField(fields[7], 'top', index);
    const width = integerField(fields[8], 'width', index);
    const height = integerField(fields[9], 'height', index);
    if (width < 0 || height < 0) throw malformed(`row ${index} has a negative size.`);
    const box: TsvBox = { x0: left, y0: top, x1: left + width, y1: top + height };

    if (level === TSV_LEVEL_PAGE) {
      pageWidth = width;
      pageHeight = height;
    } else if (level === TSV_LEVEL_LINE) {
      lineAt(
        integerField(fields[2], 'block_num', index),
        integerField(fields[3], 'par_num', index),
        integerField(fields[4], 'line_num', index)
      ).bbox = box;
    } else if (level === TSV_LEVEL_WORD) {
      if (!DECIMAL_FIELD.test(fields[10])) throw malformed(`row ${index} has a non-numeric conf '${fields[10]}'.`);
      const text = fields.slice(TSV_TEXT_COLUMN).join('\t').trim();
      if (!text) continue;
      const conf = Number.parseFloat(fields[10]);
      lineAt(
        integerField(fields[2], 'block_num', index),
        integerField(fields[3], 'par_num', index),
        integerField(fields[4], 'line_num', index)
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

export interface CliOcrRequest {
  cliPath: string;
  tessdataDir: string;
  tesseractLang: string;
  /** An image the CLI can read; passed on stdin, so no temporary files are written. */
  image: Buffer;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

function isTimeout(err: unknown): boolean {
  return err instanceof SandboxedTimeoutError || (err instanceof Error && err.name === 'TimeoutError');
}

/**
 * Runs the native Tesseract CLI without blocking the event loop. The run is bounded by an
 * AbortSignal timeout and an output cap, and the whole process group is killed when either trips.
 */
export async function recognizeWithCli(request: CliOcrRequest): Promise<OcrResult> {
  const timeoutMs = request.timeoutMs ?? OCR_CLI_TIMEOUT_MS;
  const { pageSegMode, engineMode } = ocrSegmentationFor(request.tesseractLang);
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
    ({ stdout } = await executeSandboxedBinary(request.cliPath, args, {
      stdin: request.image,
      env: { OMP_THREAD_LIMIT: OCR_CLI_THREAD_LIMIT },
      signal: AbortSignal.timeout(timeoutMs),
      timeoutMs: timeoutMs + OCR_CLI_TIMER_BACKSTOP_MS,
      maxBuffer: request.maxOutputBytes ?? OCR_CLI_MAX_OUTPUT_BYTES,
    }));
  } catch (err) {
    if (isTimeout(err)) {
      throw new OcrEngineUnavailableError(`Tesseract CLI did not finish within ${timeoutMs} ms.`);
    }
    if (err instanceof SandboxedBufferLimitError) {
      throw new OcrEngineUnavailableError('Tesseract CLI produced more output than the allowed limit.');
    }
    if (err instanceof SandboxedProcessError) {
      throw new OcrEngineUnavailableError(`Tesseract CLI failed: ${err.message}`);
    }
    throw new OcrEngineUnavailableError(
      `Tesseract CLI could not run: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return parseTesseractTsv(stdout.toString('utf-8'));
}
