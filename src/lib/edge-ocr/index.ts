import { PDFDocument, StandardFonts } from 'pdf-lib';
import { ConversionOptions, ConversionQueueItem } from '../types';
import { injectInvisibleTextLayer, parseTesseractBlocks, OcrResult } from '../conversions/ocr-pdf-combiner';

export interface EdgeOcrResult {
  blob: Blob;
  text: string;
  confidence: number;
  filename: string;
}

/**
 * Raised when the edge tier cannot produce a searchable PDF: the OCR engine failed to load or
 * run, recognized nothing, or the input needs processing the edge tier does not have.
 * Callers escalate to the cloud tier instead of returning an unsearchable result.
 */
export class EdgeOcrError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EdgeOcrError';
  }
}

const OCR_LANGUAGE_CODES: Readonly<Record<string, string>> = {
  auto: 'eng',
  en: 'eng',
  ko: 'kor',
  de: 'deu',
  fr: 'fra',
  es: 'spa',
  ja: 'jpn',
  zh: 'chi_sim',
};
const DEFAULT_OCR_LANGUAGE = 'eng';
const CONFIDENCE_PERCENT_SCALE = 100;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
/** Edge OCR only produces a searchable PDF; other OCR targets go through the normal flow. */
const EDGE_OCR_TARGET_FORMAT = 'pdf';

/**
 * Returns true if the client environment supports in-browser WebAssembly & Web Worker execution.
 */
export function isClientEdgeOcrSupported(): boolean {
  return typeof Blob !== 'undefined' && typeof Uint8Array !== 'undefined';
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resolveTesseractLanguage(language: string | undefined): string {
  if (!language) {
    return DEFAULT_OCR_LANGUAGE;
  }
  return OCR_LANGUAGE_CODES[language.toLowerCase()] ?? language;
}

function hasSignature(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, i) => bytes[i] === byte);
}

async function recognizeImage(
  file: File,
  arrayBuffer: ArrayBuffer,
  options: ConversionOptions,
  onProgress?: (percent: number) => void
): Promise<OcrResult> {
  const language = resolveTesseractLanguage(options.ocrLanguage);
  let data: { text?: string; confidence?: number; blocks?: unknown[] | null };
  try {
    const Tesseract = await import('tesseract.js');
    const worker = await Tesseract.createWorker(language, 1, {
      // Failures already reject the pending job; without a handler the worker also rethrows
      // them from its message listener as an uncaught exception.
      errorHandler: () => undefined,
      logger: (m) => {
        if (m.status === 'recognizing text' && typeof m.progress === 'number') {
          onProgress?.(Math.round(35 + m.progress * 45));
        }
      },
    });
    try {
      const input = typeof Buffer !== 'undefined' ? Buffer.from(arrayBuffer) : file;
      ({ data } = await worker.recognize(input, {}, { blocks: true }));
    } finally {
      await worker.terminate();
    }
  } catch (err: unknown) {
    throw new EdgeOcrError(`Edge OCR engine failed: ${describeError(err)}`, { cause: err });
  }

  const text = (data.text ?? '').trim();
  if (!text) {
    throw new EdgeOcrError('Edge OCR recognized no text in the image');
  }
  if (typeof data.confidence !== 'number' || !Number.isFinite(data.confidence)) {
    throw new EdgeOcrError('Edge OCR engine reported no recognition confidence');
  }
  const { lines, lineBlocks } = parseTesseractBlocks(data.blocks as any[] | null | undefined, undefined, undefined, language);
  if (lineBlocks.length === 0) {
    throw new EdgeOcrError('Edge OCR returned text without line geometry, so no text layer can be placed');
  }

  return {
    text,
    confidence: data.confidence / CONFIDENCE_PERCENT_SCALE,
    wordCount: text.split(/\s+/).length,
    lines,
    lineBlocks,
    language,
  };
}

/**
 * Executes 100% local, client-side Edge OCR and Searchable PDF generation for a raster image.
 * All computations run strictly within client RAM without a single byte sent over the network.
 * Throws {@link EdgeOcrError} whenever no searchable text layer can be produced.
 */
export async function runClientEdgeOcr(
  file: File,
  options: ConversionOptions = {},
  onProgress?: (percent: number) => void
): Promise<EdgeOcrResult> {
  if (!isClientEdgeOcrSupported()) {
    throw new EdgeOcrError('Client-side Edge OCR is not supported in this environment.');
  }

  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf' || file.type === 'application/pdf') {
    throw new EdgeOcrError('Edge OCR cannot rasterize PDF pages; the document needs server-side OCR');
  }

  onProgress?.(10);
  const arrayBuffer = await file.arrayBuffer();
  const fileBytes = new Uint8Array(arrayBuffer);
  const fileName = file.name.replace(/\.[^/.]+$/, '');

  // Check the bytes, not the name or MIME type, before spending time on recognition.
  const isJpg = hasSignature(fileBytes, JPEG_SIGNATURE);
  if (!isJpg && !hasSignature(fileBytes, PNG_SIGNATURE)) {
    throw new EdgeOcrError(`Edge OCR can only embed PNG or JPEG images, not "${ext || file.type}"`);
  }

  onProgress?.(35);
  const ocrResult = await recognizeImage(file, arrayBuffer, options, onProgress);
  onProgress?.(80);

  const doc = await PDFDocument.create();
  doc.setTitle(fileName);
  doc.setCreator('EasyConvert Client-Side Edge OCR');
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const embeddedImage = isJpg ? await doc.embedJpg(fileBytes) : await doc.embedPng(fileBytes);
  const { width, height } = embeddedImage;
  ocrResult.imageWidth = width;
  ocrResult.imageHeight = height;

  const page = doc.addPage([width, height]);
  page.drawImage(embeddedImage, { x: 0, y: 0, width, height });
  injectInvisibleTextLayer(page, font, ocrResult, 1.0, 1.0);

  onProgress?.(90);
  const pdfBytes = await doc.save();
  const blob = new Blob([pdfBytes.buffer as ArrayBuffer], { type: 'application/pdf' });
  onProgress?.(100);

  return {
    blob,
    text: ocrResult.text,
    confidence: ocrResult.confidence as number,
    filename: `${fileName}.pdf`,
  };
}

/**
 * Executes client-side Edge OCR for a queue item when edge OCR is enabled and the target is PDF.
 * Returns null when edge OCR does not apply (including non-PDF targets, which the normal flow
 * handles); throws {@link EdgeOcrError} when it applies but fails,
 * so the caller can escalate to the cloud tier and record why.
 */
export async function tryProcessClientEdgeOcr(
  item: ConversionQueueItem,
  onProgress?: (percent: number) => void
): Promise<{ resultUrl: string; resultSize: number } | null> {
  if (item.options.clientEdgeMode === false || !item.options.ocrEnabled || typeof window === 'undefined') {
    return null;
  }
  if (item.targetFormat.toLowerCase() !== EDGE_OCR_TARGET_FORMAT) {
    return null;
  }

  const edgeResult = await runClientEdgeOcr(item.file, item.options, onProgress);
  return {
    resultUrl: URL.createObjectURL(edgeResult.blob),
    resultSize: edgeResult.blob.size,
  };
}
