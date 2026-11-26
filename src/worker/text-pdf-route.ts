import fs from 'node:fs';
import { safeOutputStem } from '../lib/conversions/page-range';
import { hasCjkScript, hasComplexTextScript } from '../lib/conversions/ctl';
import { assertFontCoverage, findUncoveredCodePoint, loadFontCoverageIndex } from '../lib/conversions/pdf-fonts';
import { decodeHtmlInput } from '../lib/conversions/html-encoding';
import { decodeTextInput, readTextFileCharacters } from '../lib/conversions/text-input';
import { markdownToSafeHtml } from '../lib/conversions/markdown-pdf';
import { stageHtmlForNativeEngine } from '../lib/conversions/html-native-staging';
import type { HtmlResourcePolicy } from '../lib/conversions/html-omitted-resources';
import { convertHwpDocument, parseHwpDocument, type HwpDocument } from '../lib/conversions/hwp';
import { redrawAsPng } from '../lib/conversions/image-to-png';
import { convertFile } from '../lib/conversions';
import { MAX_SVG_INPUT_CHARS } from '../lib/conversions/svg-geometry';
import { isSvg, sanitizeSvgDocument } from '../lib/security/svg-sanitizer';
import { SvgSanitizationError } from '../lib/types';
import { readRawInputBuffer } from './worker-output';
import type { WorkerVfsPayload } from './worker-types';
import { escapeMarkupText } from '../lib/text/escape';

/** Text sources rendered to PDF; CJK or complex-script text and all HTML prefer LibreOffice. */
export const TEXT_PDF_SOURCES: ReadonlySet<string> = new Set(['txt', 'md', 'html', 'htm', 'hwp']);
/** Sources LibreOffice reads directly; their text is scanned in chunks, whatever the size. HTML is decoded whole, by encoding sniffing. */
const STREAMED_TEXT_SOURCES: ReadonlySet<string> = new Set(['txt']);
/** HTML always prefers LibreOffice, which keeps its full structure. */
export const HTML_SOURCES: ReadonlySet<string> = new Set(['html', 'htm', 'xhtml']);
export const HTML_FORMAT = 'html';
const PLAIN_TEXT_SOURCE = 'txt';
const MARKDOWN_SOURCE = 'md';
const TEXT_SCAN_CHUNK_BYTES = 1024 * 1024;

/** CSS page sizes LibreOffice applies to staged HTML (the last @page rule wins). */
const PAGE_SIZE_CSS: Readonly<Record<'portrait' | 'landscape', string>> = {
  portrait: '210mm 297mm',
  landscape: '297mm 210mm',
};

type PageOrientation = 'portrait' | 'landscape';

/** What the route reads from the request: how HTML resources are treated, and whether LibreOffice was chosen as the engine. */
export interface TextPdfPolicy extends HtmlResourcePolicy {
  /** The request chose LibreOffice: every source of the table renders there, whatever its script and orientation. */
  forceNative?: boolean;
}

export interface TextPdfRoute {
  /** Text has Arabic, Hebrew, Indic or another complex script: LibreOffice lays it out first, the in-process shaper is the fallback. */
  readonly complexScript: boolean;
  /** LibreOffice renders this input first when installed. */
  readonly preferNative: boolean;
  /** Page orientation LibreOffice must apply, when one was requested. */
  readonly orientation?: PageOrientation;
  /** The checked HTML LibreOffice renders, rebuilt from the parsed input (absent when it reads the text file itself). */
  readonly stagedHtml?: Buffer;
  /** Warnings the staging produced, one per external image it left out of the HTML. */
  readonly stagedWarnings?: readonly string[];
}

/** The text whose scripts decide the PDF route: the file's characters, or the HWP document text. */
function textForPdfRouting(input: Buffer | WorkerVfsPayload, src: string): { text: string; parsedHwp?: HwpDocument } {
  if (src === 'hwp') {
    const parsedHwp = parseHwpDocument(readRawInputBuffer(input));
    const text = [...parsedHwp.paragraphs.map((p) => p.text), ...parsedHwp.tables.flatMap((t) => t.rows.flat())].join('\n');
    return { text, parsedHwp };
  }
  if (HTML_SOURCES.has(src)) return { text: decodeHtmlInput(readRawInputBuffer(input)) };
  const filePath = !Buffer.isBuffer(input) && !input.inputBuffer ? input.inputPath : undefined;
  if (STREAMED_TEXT_SOURCES.has(src) && filePath && fs.existsSync(filePath)) {
    return { text: readTextFileCharacters(filePath, TEXT_SCAN_CHUNK_BYTES) };
  }
  const raw = readRawInputBuffer(input);
  return { text: decodeTextInput(raw) };
}

async function normalizeHwpModelSvgImages(doc: HwpDocument): Promise<void> {
  for (const image of doc.model.images) {
    if (image.format !== 'svg') continue;
    if (image.data.byteLength > MAX_SVG_INPUT_CHARS * 4) {
      throw new SvgSanitizationError(`SVG input exceeds the ${MAX_SVG_INPUT_CHARS}-character limit.`);
    }
    const rawSvg = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).toString('utf-8');
    const cleanSvg = sanitizeSvgDocument(rawSvg);
    if (!isSvg(cleanSvg)) {
      throw new SvgSanitizationError('Embedded HWP SVG is empty or invalid after sanitization.');
    }
    image.data = await redrawAsPng(Buffer.from(cleanSvg, 'utf-8'), 'image/svg+xml');
    image.format = 'png';
  }
}

/**
 * Decides how text and HTML go to PDF. Complex-script text prefers LibreOffice and is shaped in-process without it. HTML prefers it for
 * its full structure, and so do CJK Markdown and HWP; plain CJK text stays in-process when the
 * installed fonts cover it. With an explicit orientation, everything but complex-script text stays
 * in-process, which applies the orientation itself. Both engines draw with the installed fonts, so
 * CJK or complex-script letters no installed font covers fail first with EngineUnavailableError.
 */
export async function planTextPdfRoute(
  input: Buffer | WorkerVfsPayload,
  src: string,
  tgt: string,
  originalFilename: string,
  orientation?: PageOrientation,
  policy: TextPdfPolicy = {}
): Promise<TextPdfRoute | null> {
  if (tgt !== 'pdf' || !TEXT_PDF_SOURCES.has(src)) return null;
  await loadFontCoverageIndex();
  const { text, parsedHwp } = textForPdfRouting(input, src);
  const complexScript = hasComplexTextScript(text);
  const cjk = hasCjkScript(text);
  if (complexScript || cjk) {
    const scriptLetters = new Set<string>();
    for (const ch of text) {
      if (hasCjkScript(ch) || hasComplexTextScript(ch)) scriptLetters.add(ch);
    }
    assertFontCoverage(Array.from(scriptLetters).join(''));
  }
  const route = policy.forceNative ? { complexScript, preferNative: true, orientation } : planTextPdfEngine(src, text, complexScript, cjk, orientation);
  if (!route.preferNative || (src === PLAIN_TEXT_SOURCE && !route.orientation)) return route;
  // Staged here, before LibreOffice is tried, so a refused reference is a 400 and never a fallback.
  const staged = await stageTextPdfHtml(input, src, originalFilename, route.orientation, policy, parsedHwp);
  return { ...route, stagedHtml: staged.html, stagedWarnings: staged.warnings };
}

/**
 * The HTML LibreOffice renders for a text source, rebuilt from the parsed document so it reads
 * only what was checked: HTML as given, Markdown and HWP converted in-process (LibreOffice cannot
 * open them), and text as one paragraph per line. A requested orientation is a CSS page size.
 */
async function stageTextPdfHtml(
  input: Buffer | WorkerVfsPayload,
  src: string,
  originalFilename: string,
  orientation?: PageOrientation,
  policy: HtmlResourcePolicy = {},
  parsedHwp?: HwpDocument
): Promise<{ html: Buffer; warnings: string[] }> {
  let html: string;
  if (HTML_SOURCES.has(src)) {
    html = decodeHtmlInput(readRawInputBuffer(input));
  } else if (src === PLAIN_TEXT_SOURCE) {
    html = plainTextToHtml(decodeTextInput(readRawInputBuffer(input)));
  } else if (src === MARKDOWN_SOURCE) {
    html = markdownToSafeHtml(decodeTextInput(readRawInputBuffer(input)), safeOutputStem(originalFilename));
  } else if (parsedHwp) {
    await normalizeHwpModelSvgImages(parsedHwp);
    const baseName = safeOutputStem(originalFilename, 'document');
    html = (await convertHwpDocument(parsedHwp, HTML_FORMAT, {}, baseName)).buffer.toString('utf-8');
  } else {
    html = (await convertFile(readRawInputBuffer(input), src, HTML_FORMAT, {}, originalFilename)).buffer.toString('utf-8');
  }
  // Appended last so it overrides any @page rule of the document.
  const pageSize = orientation ? `\n<style>@page { size: ${PAGE_SIZE_CSS[orientation]}; }</style>\n` : '';
  const staged = await stageHtmlForNativeEngine(html, policy);
  return { html: Buffer.from(staged.html + pageSize, 'utf-8'), warnings: staged.warnings };
}

function planTextPdfEngine(
  src: string,
  text: string,
  complexScript: boolean,
  cjk: boolean,
  orientation?: PageOrientation
): TextPdfRoute {
  if (complexScript) return { complexScript, preferNative: true, orientation };
  if (orientation) return { complexScript, preferNative: false };
  if (HTML_SOURCES.has(src)) return { complexScript, preferNative: true };
  if (src === PLAIN_TEXT_SOURCE) return { complexScript, preferNative: cjk && findUncoveredCodePoint(text) !== null };
  return { complexScript, preferNative: cjk };
}

/** Plain text as an HTML document, one paragraph per line. */
function plainTextToHtml(text: string): string {
  const paragraphs = text.split(/\r\n?|\n/).map((line) => (line.trim() ? `<p>${escapeMarkupText(line)}</p>` : '<p><br></p>'));
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>\n${paragraphs.join('\n')}\n</body></html>\n`;
}
