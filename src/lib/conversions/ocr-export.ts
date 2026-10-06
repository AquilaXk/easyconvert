import type {
  OcrLayoutGroup,
  OcrLineBlock,
  OcrPageResult,
  OcrResult,
  OcrWord,
} from './ocr-pdf-combiner';
import { HocrExportOptions, AltoExportOptions } from '../types';
import { OcrMarkupError } from './ocr-markup';

export { unescapeXml } from './ocr-markup';
export { parseHocr, parseAlto } from './ocr-import';

/**
 * hOCR 1.2 and ALTO 4.4 writers.
 *
 * Both keep the recognizer's block, paragraph and line structure (a block is `ocr_carea` in hOCR and
 * a ComposedBlock in ALTO, a paragraph is `ocr_par` and a TextBlock). Lines that carry no structure
 * (text-only input) each become their own block and paragraph. Output is assembled as an array of
 * strings joined once; text is escaped in a single pass.
 */

const PERCENT_SCALE = 100;
const NEED_WORD_GEOMETRY = 'hOCR/ALTO need word geometry';
const SLOPE_DECIMALS_SCALE = 1000;
/** Row metrics are floats; eight significant digits is the precision the recognizer's own hOCR writes. */
const METRIC_SIGNIFICANT_DIGITS = 8;
const ALTO_CONFIDENCE_DECIMALS = 2;
const ALTO_SCHEMA_VERSION = '4.4';
const ALTO_PIXEL_UNIT = 'pixel';
const OCR_SYSTEM_NAME = 'easyconvert-ocr';
const OCR_SOFTWARE_NAME = 'EasyConvert OCR';
const HOCR_CAPABILITIES = 'ocr_page ocr_carea ocr_par ocr_line ocrx_word ocrp_wconf';
const UNDETERMINED_LANGUAGE = 'und';
const MAX_LANGUAGE_TAG_CHARS = 35;
const MAX_LANGUAGE_SUBTAG_CHARS = 8;

/** BCP 47 tags for the recognition language codes the pipeline accepts (see ocr.ts). */
const ENGINE_LANGUAGE_TAGS: ReadonlyMap<string, string> = new Map([
  ['eng', 'en'],
  ['kor', 'ko'],
  ['deu', 'de'],
  ['fra', 'fr'],
  ['spa', 'es'],
  ['jpn', 'ja'],
  ['jpn_vert', 'ja'],
  ['chi_sim', 'zh-Hans'],
  ['chi_sim_vert', 'zh-Hans'],
  ['chi_tra', 'zh-Hant'],
  ['chi_tra_vert', 'zh-Hant'],
]);

const CH_TAB = 0x09;
const CH_LF = 0x0a;
const CH_CR = 0x0d;
const CH_AMPERSAND = 0x26;
const CH_APOSTROPHE = 0x27;
const CH_QUOTE = 0x22;
const CH_LT = 0x3c;
const CH_GT = 0x3e;
const CH_HYPHEN = 0x2d;
const CH_UPPER_A = 0x41;
const CH_UPPER_Z = 0x5a;
const CH_LOWER_A = 0x61;
const CH_LOWER_Z = 0x7a;
const CH_DIGIT_0 = 0x30;
const CH_DIGIT_9 = 0x39;
const SURROGATE_HIGH_FIRST = 0xd800;
const SURROGATE_HIGH_LAST = 0xdbff;
const SURROGATE_LOW_FIRST = 0xdc00;
const SURROGATE_LOW_LAST = 0xdfff;
const NONCHARACTER_FFFE = 0xfffe;
const NONCHARACTER_FFFF = 0xffff;
const FIRST_PRINTABLE = 0x20;

function isAsciiLetter(code: number): boolean {
  return (code >= CH_UPPER_A && code <= CH_UPPER_Z) || (code >= CH_LOWER_A && code <= CH_LOWER_Z);
}

function isAsciiDigit(code: number): boolean {
  return code >= CH_DIGIT_0 && code <= CH_DIGIT_9;
}

/** Whether `tag` matches the xsd:language pattern `[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*`. */
function isLanguageTag(tag: string): boolean {
  if (tag.length === 0 || tag.length > MAX_LANGUAGE_TAG_CHARS) return false;
  let subtagLength = 0;
  let firstSubtag = true;
  for (let i = 0; i < tag.length; i++) {
    const code = tag.charCodeAt(i);
    if (code === CH_HYPHEN) {
      if (subtagLength === 0) return false;
      subtagLength = 0;
      firstSubtag = false;
      continue;
    }
    const allowed = firstSubtag ? isAsciiLetter(code) : isAsciiLetter(code) || isAsciiDigit(code);
    if (!allowed || ++subtagLength > MAX_LANGUAGE_SUBTAG_CHARS) return false;
  }
  return subtagLength > 0;
}

/** BCP 47 tag for an engine language code or tag, or undefined when it is neither. */
function languageTag(language: string | undefined): string | undefined {
  if (!language) return undefined;
  const mapped = ENGINE_LANGUAGE_TAGS.get(language);
  if (mapped) return mapped;
  return isLanguageTag(language) ? language : undefined;
}

/** Characters escapeXml dropped since the current export began; reported once when it ends. */
let droppedCharacters = 0;

function startExport(): void {
  droppedCharacters = 0;
}

function finishExport(): void {
  if (droppedCharacters > 0) {
    console.debug(`[ocr-export] dropped ${droppedCharacters} characters that XML 1.0 cannot carry`);
  }
  droppedCharacters = 0;
}

/**
 * Escapes text for XML in one pass. Characters XML 1.0 cannot carry (control characters other than
 * tab, line feed and carriage return, unpaired surrogates, U+FFFE and U+FFFF) are dropped. In
 * attribute values tab, line feed and carriage return become character references so they survive
 * attribute-value normalization.
 */
function escapeXml(text: string, attribute = false): string {
  if (!text) return '';
  let parts: string[] | null = null;
  let copied = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    let replacement: string | null = null;
    if (code === CH_AMPERSAND) replacement = '&amp;';
    else if (code === CH_LT) replacement = '&lt;';
    else if (code === CH_GT) replacement = '&gt;';
    else if (code === CH_QUOTE) replacement = '&quot;';
    else if (code === CH_APOSTROPHE) replacement = '&apos;';
    else if (code === CH_TAB || code === CH_LF || code === CH_CR) replacement = attribute ? `&#${code};` : null;
    else if (code < FIRST_PRINTABLE || code === NONCHARACTER_FFFE || code === NONCHARACTER_FFFF) {
      replacement = '';
      droppedCharacters++;
    }
    else if (code >= SURROGATE_HIGH_FIRST && code <= SURROGATE_LOW_LAST) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      const paired = code <= SURROGATE_HIGH_LAST && next >= SURROGATE_LOW_FIRST && next <= SURROGATE_LOW_LAST;
      if (paired) {
        i++;
      } else {
        replacement = '';
        droppedCharacters++;
      }
    }
    if (replacement === null) continue;
    parts ??= [];
    parts.push(text.slice(copied, i), replacement);
    copied = i + 1;
  }
  if (parts === null) return text;
  parts.push(text.slice(copied));
  return parts.join('');
}

function escapeAttribute(text: string): string {
  return escapeXml(text, true);
}

/** Rounds a coordinate, rejecting values that cannot be written as XML numbers. */
function wholeNumber(value: number, what: string): number {
  if (!Number.isFinite(value)) throw new OcrMarkupError(`Cannot export ${what}: ${value} is not a finite number.`);
  return Math.round(value);
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

type LooseBBox = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  x0?: number;
  y0?: number;
  x1?: number;
  y1?: number;
};

const MIN_BOX_SIZE_PX = 1;

function requireNumber(value: number | undefined, what: string): number {
  if (typeof value !== 'number') throw new OcrMarkupError(`Cannot export ${what}: it has no position or size.`);
  return value;
}

/** Fills `into` with the whole-pixel box of `bbox` (at least one pixel wide and tall). */
function fillBox(into: Box, bbox: LooseBBox | null | undefined, what: string): Box {
  if (!bbox) throw new OcrMarkupError(`Cannot export ${what}: it has no box.`);
  const x = requireNumber(bbox.x ?? bbox.x0, what);
  const y = requireNumber(bbox.y ?? bbox.y0, what);
  const width = bbox.width ?? (bbox.x1 === undefined ? undefined : bbox.x1 - x);
  const height = bbox.height ?? (bbox.y1 === undefined ? undefined : bbox.y1 - y);
  into.x0 = wholeNumber(x, what);
  into.y0 = wholeNumber(y, what);
  into.x1 = into.x0 + Math.max(MIN_BOX_SIZE_PX, wholeNumber(requireNumber(width, what), what));
  into.y1 = into.y0 + Math.max(MIN_BOX_SIZE_PX, wholeNumber(requireNumber(height, what), what));
  return into;
}

function newBox(): Box {
  return { x0: 0, y0: 0, x1: 0, y1: 0 };
}

/** A word's confidence on the 0..100 scale used throughout, or null when the word has none. */
function confidencePercent(confidence: number | undefined): number | null {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return null;
  return Math.max(0, Math.min(PERCENT_SCALE, confidence));
}

/** The pages of one result: its `pages` when it has them, otherwise the result itself as one page. */
function pagesOf(res: OcrResult): OcrPageResult[] {
  if (res.pages && res.pages.length > 0) {
    return res.pages.map((p) => ({
      pageNumber: p.pageNumber,
      width: p.width || res.imageWidth || 0,
      height: p.height || res.imageHeight || 0,
      text: p.text || '',
      confidence: p.confidence ?? res.confidence,
      lineBlocks: p.lineBlocks ?? [],
      lines: p.lines,
      language: p.language ?? res.language,
    }));
  }
  return [
    {
      pageNumber: 1,
      width: res.imageWidth || 0,
      height: res.imageHeight || 0,
      text: res.text || '',
      confidence: res.confidence,
      lineBlocks: res.lineBlocks ?? [],
      lines: res.lines,
      language: res.language,
    },
  ];
}

/**
 * Flattens one result or a list of results into pages numbered by position (1-based). Source page
 * numbers are ignored: they can repeat, be zero or negative, and would make identifiers collide.
 */
function normalizePages(ocrInput: OcrResult | OcrResult[]): OcrPageResult[] {
  const results = Array.isArray(ocrInput) ? ocrInput : [ocrInput];
  const pages: OcrPageResult[] = [];
  for (const res of results) {
    for (const page of pagesOf(res)) pages.push({ ...page, pageNumber: pages.length + 1 });
  }
  return pages;
}

/** Text without recognized lines has no geometry to write; a blank page is fine. */
function assertWordGeometry(pages: OcrPageResult[]): void {
  for (const page of pages) {
    if (page.lineBlocks.length === 0 && page.text.trim() !== '') {
      throw new OcrMarkupError(`${NEED_WORD_GEOMETRY}: page ${page.pageNumber} has text but no recognized lines.`);
    }
  }
}

function wordsOf(line: OcrLineBlock, pageNumber: number): OcrWord[] {
  if (line.words.length === 0) {
    throw new OcrMarkupError(`${NEED_WORD_GEOMETRY}: a line on page ${pageNumber} has no words.`);
  }
  return line.words;
}

interface Extent {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface ParagraphPlan {
  group: OcrLayoutGroup | undefined;
  extent: Extent;
  lines: OcrLineBlock[];
}

interface BlockPlan {
  group: OcrLayoutGroup | undefined;
  /** False for a line that came without block or paragraph information. */
  structured: boolean;
  extent: Extent;
  paragraphs: ParagraphPlan[];
}

function growExtent(extent: Extent, box: Box): void {
  if (box.x0 < extent.x0) extent.x0 = box.x0;
  if (box.y0 < extent.y0) extent.y0 = box.y0;
  if (box.x1 > extent.x1) extent.x1 = box.x1;
  if (box.y1 > extent.y1) extent.y1 = box.y1;
}

function extentOf(box: Box): Extent {
  return { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 };
}

/**
 * Groups lines into blocks and paragraphs by the layout groups they share, in order of first
 * appearance. A line with neither group is its own block and paragraph.
 */
function planLayout(lines: OcrLineBlock[], scratch: Box): BlockPlan[] {
  const blocks: BlockPlan[] = [];
  const blockByGroup = new Map<OcrLayoutGroup, BlockPlan>();
  const paragraphByGroup = new Map<OcrLayoutGroup, ParagraphPlan>();
  for (const line of lines) {
    const box = fillBox(scratch, line.bbox, 'a line box');
    const blockGroup = line.block ?? line.paragraph;
    if (blockGroup === undefined) {
      blocks.push({
        group: undefined,
        structured: false,
        extent: extentOf(box),
        paragraphs: [{ group: undefined, extent: extentOf(box), lines: [line] }],
      });
      continue;
    }
    let block = blockByGroup.get(blockGroup);
    if (block === undefined) {
      block = { group: blockGroup, structured: true, extent: extentOf(box), paragraphs: [] };
      blockByGroup.set(blockGroup, block);
      blocks.push(block);
    } else {
      growExtent(block.extent, box);
    }
    const paragraphGroup = line.paragraph ?? line.block;
    let paragraph = paragraphGroup === undefined ? undefined : paragraphByGroup.get(paragraphGroup);
    if (paragraph === undefined) {
      paragraph = { group: line.paragraph, extent: extentOf(box), lines: [] };
      block.paragraphs.push(paragraph);
      if (paragraphGroup !== undefined) paragraphByGroup.set(paragraphGroup, paragraph);
    } else {
      growExtent(paragraph.extent, box);
    }
    paragraph.lines.push(line);
  }
  return blocks;
}

/** The group's own box when it has one, otherwise the union of its lines. */
function groupBox(into: Box, group: OcrLayoutGroup | undefined, extent: Extent): Box {
  if (group?.bbox) return fillBox(into, group.bbox, 'a layout box');
  into.x0 = extent.x0;
  into.y0 = extent.y0;
  into.x1 = extent.x1;
  into.y1 = extent.y1;
  return into;
}

function finiteOrThrow(value: number, what: string): number {
  if (!Number.isFinite(value)) throw new OcrMarkupError(`Cannot export ${what}: ${value} is not a finite number.`);
  return value;
}

function roundedSlope(value: number): string {
  return String(Math.round(finiteOrThrow(value, 'a baseline') * SLOPE_DECIMALS_SCALE) / SLOPE_DECIMALS_SCALE);
}

function metric(value: number, what: string): string {
  return String(Number(finiteOrThrow(value, what).toPrecision(METRIC_SIGNIFICANT_DIGITS)));
}

/**
 * hOCR line properties after the box: `baseline slope offset` (offset measured from the bottom of the
 * line box, y pointing down) and the row metrics. Absent values are left out.
 */
function hocrLineTitle(box: Box, line: OcrLineBlock): string {
  const parts: string[] = [`bbox ${box.x0} ${box.y0} ${box.x1} ${box.y1}`];
  const baseline = line.baseline;
  if (baseline && baseline.x1 > baseline.x0) {
    const slope = (baseline.y1 - baseline.y0) / (baseline.x1 - baseline.x0);
    const offset = baseline.y0 + slope * (box.x0 - baseline.x0) - box.y1;
    parts.push(`baseline ${roundedSlope(slope)} ${wholeNumber(offset, 'a baseline')}`);
  }
  if (line.rowHeight !== undefined) parts.push(`x_size ${metric(line.rowHeight, 'x_size')}`);
  if (line.descenders !== undefined) {
    parts.push(`x_descenders ${metric(line.descenders, 'x_descenders')}`);
  }
  if (line.ascenders !== undefined) {
    parts.push(`x_ascenders ${metric(line.ascenders, 'x_ascenders')}`);
  }
  return parts.join('; ');
}

function pageImageName(options: HocrExportOptions, pageNumber: number, pageCount: number): string {
  const cleanBase = options.filename ? options.filename.replace(/\.[^/.]+$/, '') : 'page';
  if (pageCount > 1) return `${cleanBase}_page_${pageNumber}.png`;
  return options.filename || `page_${pageNumber}.png`;
}

function pageDimensions(page: OcrPageResult): { width: number; height: number } {
  const width = wholeNumber(page.width, 'a page width');
  const height = wholeNumber(page.height, 'a page height');
  if (width < 1 || height < 1) throw new OcrMarkupError(`Cannot export a page of ${width}x${height} pixels.`);
  return { width, height };
}

function writeHocrWords(out: string[], line: OcrLineBlock, pageNumber: number, lineNumber: number, scratch: Box): void {
  const words = wordsOf(line, pageNumber);
  for (let wIdx = 0; wIdx < words.length; wIdx++) {
    const w = words[wIdx];
    const wb = fillBox(scratch, w.bbox, 'a word box');
    const percent = confidencePercent(w.confidence);
    const wconf = percent === null ? '' : `; x_wconf ${Math.round(percent)}`;
    out.push(
      `          <span class="ocrx_word" id="word_${pageNumber}_${lineNumber}_${wIdx + 1}" title="bbox ${wb.x0} ${wb.y0} ${wb.x1} ${wb.y1}${wconf}">${escapeXml(w.text)}</span>`
    );
  }
}

/**
 * Exports OCR results to hOCR 1.2 compliant XHTML.
 * Pages are numbered by position. Text the recognizer returned that XML 1.0 cannot carry (control
 * characters, U+FFFE and U+FFFF, unpaired surrogates) is dropped; the number dropped is logged at
 * debug level.
 * @throws OcrMarkupError when a page has text but no recognized lines or a line has no words (hOCR
 * needs word geometry and none is invented), or a coordinate is not finite.
 * Writes ocr_page, ocr_carea, ocr_par, ocr_line and ocrx_word elements; a line carries its bbox,
 * baseline and row metrics when the recognizer reported them, a word its bbox and x_wconf.
 */
export function exportHocr(
  ocrInput: OcrResult | OcrResult[],
  options: HocrExportOptions = {}
): string {
  startExport();
  const pages = normalizePages(ocrInput);
  assertWordGeometry(pages);
  const docTitle = options.documentTitle || options.filename || 'OCR Document';
  const pageTags = pages.map((page) => languageTag(page.language));
  const documentLanguage = pageTags.find((tag) => tag !== undefined) ?? UNDETERMINED_LANGUAGE;
  const usedLanguages = [...new Set(pageTags.filter((tag): tag is string => tag !== undefined))];

  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">',
    `<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${documentLanguage}" lang="${documentLanguage}">`,
    '<head>',
    `  <title>${escapeXml(docTitle)}</title>`,
    '  <meta http-equiv="Content-Type" content="text/html;charset=utf-8" />',
    `  <meta name="ocr-system" content="${OCR_SYSTEM_NAME}" />`,
    `  <meta name="ocr-capabilities" content="${HOCR_CAPABILITIES}" />`,
    `  <meta name="ocr-number-of-pages" content="${pages.length}" />`,
  ];
  if (usedLanguages.length > 0) out.push(`  <meta name="ocr-langs" content="${usedLanguages.join(' ')}" />`);
  out.push('</head>', '<body>');

  const scratch = newBox();
  const groupScratch = newBox();
  for (const page of pages) {
    const pNum = page.pageNumber;
    const { width, height } = pageDimensions(page);
    const imageName = pageImageName(options, pNum, pages.length);
    const pageTag = languageTag(page.language);
    // hOCR counts physical pages from zero.
    out.push(
      `  <div class="ocr_page" id="page_${pNum}" title="image &quot;${escapeAttribute(imageName)}&quot;; bbox 0 0 ${width} ${height}; ppageno ${pNum - 1}">`
    );

    let blockNumber = 0;
    let parNumber = 0;
    let lineNumber = 0;
    for (const block of planLayout(page.lineBlocks || [], scratch)) {
      const bb = groupBox(groupScratch, block.group, block.extent);
      out.push(`    <div class="ocr_carea" id="block_${pNum}_${++blockNumber}" title="bbox ${bb.x0} ${bb.y0} ${bb.x1} ${bb.y1}">`);
      for (const paragraph of block.paragraphs) {
        const pb = groupBox(groupScratch, paragraph.group, paragraph.extent);
        const parTag = languageTag(paragraph.group?.language) ?? pageTag;
        const lang = parTag === undefined ? '' : ` lang="${parTag}"`;
        out.push(`      <p class="ocr_par" id="par_${pNum}_${++parNumber}"${lang} title="bbox ${pb.x0} ${pb.y0} ${pb.x1} ${pb.y1}">`);
        for (const line of paragraph.lines) {
          lineNumber++;
          const lb = fillBox(scratch, line.bbox, 'a line box');
          out.push(`        <span class="ocr_line" id="line_${pNum}_${lineNumber}" title="${hocrLineTitle(lb, line)}">`);
          writeHocrWords(out, line, pNum, lineNumber, scratch);
          out.push('        </span>');
        }
        out.push('      </p>');
      }
      out.push('    </div>');
    }
    out.push('  </div>');
  }

  out.push('</body>', '</html>', '');
  finishExport();
  return out.join('\n');
}

function altoBaselineAttribute(line: OcrLineBlock): string {
  const baseline = line.baseline;
  if (!baseline || baseline.x1 <= baseline.x0) return '';
  const points = [baseline.x0, baseline.y0, baseline.x1, baseline.y1].map((v) => wholeNumber(v, 'a baseline'));
  return ` BASELINE="${points[0]},${points[1]} ${points[2]},${points[3]}"`;
}

function writeAltoLine(
  out: string[],
  line: OcrLineBlock,
  pageNumber: number,
  lineNumber: number,
  indent: string,
  scratch: Box,
  nextScratch: Box
): void {
  const lb = fillBox(scratch, line.bbox, 'a line box');
  out.push(
    `${indent}<TextLine ID="TL_${pageNumber}_${lineNumber}" HPOS="${lb.x0}" VPOS="${lb.y0}" WIDTH="${lb.x1 - lb.x0}" HEIGHT="${lb.y1 - lb.y0}"${altoBaselineAttribute(line)}>`
  );
  const words = wordsOf(line, pageNumber);
  const wordIndent = `${indent}  `;
  for (let wIdx = 0; wIdx < words.length; wIdx++) {
    const w = words[wIdx];
    const wb = fillBox(scratch, w.bbox, 'a word box');
    const percent = confidencePercent(w.confidence);
    const wc = percent === null ? '' : ` WC="${(percent / PERCENT_SCALE).toFixed(ALTO_CONFIDENCE_DECIMALS)}"`;
    out.push(
      `${wordIndent}<String CONTENT="${escapeAttribute(w.text)}" HPOS="${wb.x0}" VPOS="${wb.y0}" WIDTH="${wb.x1 - wb.x0}" HEIGHT="${wb.y1 - wb.y0}"${wc} />`
    );
    // Standard <SP> whitespace delimiter between consecutive words in a line
    if (wIdx < words.length - 1) {
      const spX = wb.x1;
      const spW = Math.max(1, fillBox(nextScratch, words[wIdx + 1].bbox, 'a word box').x0 - spX);
      out.push(`${wordIndent}<SP HPOS="${spX}" VPOS="${wb.y0}" WIDTH="${spW}" />`);
    }
  }
  out.push(`${indent}</TextLine>`);
}

function altoBoxAttributes(box: Box): string {
  return `HPOS="${box.x0}" VPOS="${box.y0}" WIDTH="${box.x1 - box.x0}" HEIGHT="${box.y1 - box.y0}"`;
}

/**
 * Exports OCR results to ALTO 4.4 XML (Library of Congress). Pages are numbered by position, and text
 * XML 1.0 cannot carry is dropped as for hOCR (counted in a debug log). A recognizer block is a ComposedBlock,
 * a paragraph a TextBlock, and every line a TextLine with its BASELINE polyline when known; words are
 * String elements with WC confidence between 0 and 1 separated by SP.
 * @throws OcrMarkupError when `measurementUnit` is not `pixel` (the coordinates are pixels) or a
 * coordinate is not finite.
 */
export function exportAlto(
  ocrInput: OcrResult | OcrResult[],
  options: AltoExportOptions = {}
): string {
  const unit = options.measurementUnit || ALTO_PIXEL_UNIT;
  if (unit !== ALTO_PIXEL_UNIT) {
    throw new OcrMarkupError(`ALTO export writes pixel coordinates; measurement unit '${unit}' is not supported.`);
  }
  startExport();
  const pages = normalizePages(ocrInput);
  assertWordGeometry(pages);

  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<alto xmlns="http://www.loc.gov/standards/alto/ns-v4#"',
    '      xmlns:xlink="http://www.w3.org/1999/xlink"',
    '      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    `      xsi:schemaLocation="http://www.loc.gov/standards/alto/ns-v4# http://www.loc.gov/standards/alto/v4/alto-4-4.xsd"`,
    `      SCHEMAVERSION="${ALTO_SCHEMA_VERSION}">`,
    '  <Description>',
    `    <MeasurementUnit>${unit}</MeasurementUnit>`,
  ];
  if (options.filename) {
    out.push(
      '    <sourceImageInformation>',
      `      <fileName>${escapeXml(options.filename)}</fileName>`,
      '    </sourceImageInformation>'
    );
  }
  out.push(
    '    <Processing ID="PROC_1">',
    '      <processingCategory>contentGeneration</processingCategory>',
    '      <processingSoftware>',
    `        <softwareName>${OCR_SOFTWARE_NAME}</softwareName>`,
    '      </processingSoftware>',
    '    </Processing>',
    '  </Description>',
    '  <Layout>'
  );

  const scratch = newBox();
  const nextScratch = newBox();
  const groupScratch = newBox();
  for (const page of pages) {
    const pNum = page.pageNumber;
    const { width, height } = pageDimensions(page);
    out.push(`    <Page ID="PAGE_${pNum}" PHYSICAL_IMG_NR="${pNum}" WIDTH="${width}" HEIGHT="${height}">`);
    out.push(`      <PrintSpace HPOS="0" VPOS="0" WIDTH="${width}" HEIGHT="${height}">`);

    let blockNumber = 0;
    let textBlockNumber = 0;
    let lineNumber = 0;
    for (const block of planLayout(page.lineBlocks || [], scratch)) {
      const indent = block.structured ? '          ' : '        ';
      if (block.structured) {
        const cb = groupBox(groupScratch, block.group, block.extent);
        out.push(`        <ComposedBlock ID="CB_${pNum}_${++blockNumber}" ${altoBoxAttributes(cb)}>`);
      }
      for (const paragraph of block.paragraphs) {
        const pb = groupBox(groupScratch, paragraph.group, paragraph.extent);
        const tag = languageTag(paragraph.group?.language) ?? languageTag(page.language);
        const lang = tag === undefined ? '' : ` LANG="${tag}"`;
        out.push(`${indent}<TextBlock ID="TB_${pNum}_${++textBlockNumber}" ${altoBoxAttributes(pb)}${lang}>`);
        for (const line of paragraph.lines) {
          writeAltoLine(out, line, pNum, ++lineNumber, `${indent}  `, scratch, nextScratch);
        }
        out.push(`${indent}</TextBlock>`);
      }
      if (block.structured) out.push('        </ComposedBlock>');
    }

    out.push('      </PrintSpace>', '    </Page>');
  }

  out.push('  </Layout>', '</alto>', '');
  finishExport();
  return out.join('\n');
}
