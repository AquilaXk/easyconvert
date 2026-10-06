import type {
  OcrBaseline,
  OcrLayoutGroup,
  OcrLineBlock,
  OcrPageResult,
  OcrResult,
  OcrWord,
} from './ocr-pdf-combiner';
import { OcrMarkupError, readMarkup, type MarkupAttributes, type MarkupHandler } from './ocr-markup';

/**
 * Reads hOCR 1.2 (XHTML) and ALTO documents into OcrResult, keeping the block, paragraph and line
 * structure, baselines and row metrics. Documents are read with the bounded XML reader in
 * ocr-markup.ts; anything that is not well formed, or lacks the geometry the structure needs,
 * throws OcrMarkupError.
 */

const PERCENT_SCALE = 100;
const HOCR_BBOX_VALUES = 4;
const HOCR_BASELINE_VALUES = 2;
const ALTO_POINT_PAIR_VALUES = 4;
const ALTO_SINGLE_BASELINE_VALUES = 1;
const CH_SPACE = 0x20;
const CH_TAB = 0x09;
const CH_LF = 0x0a;
const CH_CR = 0x0d;
const CH_NBSP = 0xa0;
const QUOTE = '"';
const PROPERTY_SEPARATOR = ';';

type HocrKind = 'page' | 'area' | 'par' | 'line' | 'word';

/** hOCR class names mapped to the structure level they open; the line-like classes are typographic variants of ocr_line. */
const HOCR_CLASS_KINDS: ReadonlyMap<string, HocrKind> = new Map([
  ['ocr_page', 'page'],
  ['ocr_carea', 'area'],
  ['ocr_par', 'par'],
  ['ocr_line', 'line'],
  ['ocr_header', 'line'],
  ['ocr_caption', 'line'],
  ['ocr_textfloat', 'line'],
  ['ocrx_word', 'word'],
]);

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function toBBox(box: Box): OcrLineBlock['bbox'] {
  return { x: box.x0, y: box.y0, width: Math.max(1, box.x1 - box.x0), height: Math.max(1, box.y1 - box.y0) };
}

function unionBoxes(boxes: Iterable<Box>): Box | null {
  let union: Box | null = null;
  for (const box of boxes) {
    if (union === null) {
      union = { ...box };
    } else {
      union.x0 = Math.min(union.x0, box.x0);
      union.y0 = Math.min(union.y0, box.y0);
      union.x1 = Math.max(union.x1, box.x1);
      union.y1 = Math.max(union.y1, box.y1);
    }
  }
  return union;
}

function collapseSpace(parts: string[]): string {
  const text = parts.join('');
  const words: string[] = [];
  let start = -1;
  for (let i = 0; i <= text.length; i++) {
    const code = i < text.length ? text.charCodeAt(i) : CH_SPACE;
    const space = code === CH_SPACE || code === CH_TAB || code === CH_LF || code === CH_CR || code === CH_NBSP;
    if (space && start !== -1) {
      words.push(text.slice(start, i));
      start = -1;
    } else if (!space && start === -1) {
      start = i;
    }
  }
  return words.join(' ');
}

function numberList(source: string, separators: ReadonlySet<string>): number[] | null {
  const values: number[] = [];
  let start = -1;
  for (let i = 0; i <= source.length; i++) {
    const separator = i === source.length || separators.has(source[i]);
    if (separator && start !== -1) {
      const value = Number(source.slice(start, i));
      if (!Number.isFinite(value)) return null;
      values.push(value);
      start = -1;
    } else if (!separator && start === -1) {
      start = i;
    }
  }
  return values;
}

const HOCR_NUMBER_SEPARATORS: ReadonlySet<string> = new Set([' ', '\t']);
const ALTO_NUMBER_SEPARATORS: ReadonlySet<string> = new Set([' ', ',', '\t', '\n', '\r']);

function boxFromValues(values: number[], what: string): Box {
  const [x0, y0, x1, y1] = values;
  if (x1 < x0 || y1 < y0) throw new OcrMarkupError(`${what} has a box with negative size.`);
  return { x0, y0, x1, y1 };
}

// ---------------------------------------------------------------------------------------------
// hOCR
// ---------------------------------------------------------------------------------------------

interface HocrProperties {
  bbox: Box | null;
  baseline: { slope: number; offset: number } | null;
  xSize: number | undefined;
  xAscenders: number | undefined;
  xDescenders: number | undefined;
  xWconf: number | undefined;
}

function emptyProperties(): HocrProperties {
  return { bbox: null, baseline: null, xSize: undefined, xAscenders: undefined, xDescenders: undefined, xWconf: undefined };
}

/** Splits a title on `;` outside double quotes, so an `image "a;b.png"` value stays whole. */
function forEachProperty(title: string, visit: (name: string, value: string) => void): void {
  let start = 0;
  let quoted = false;
  for (let i = 0; i <= title.length; i++) {
    const char = i < title.length ? title[i] : PROPERTY_SEPARATOR;
    if (char === QUOTE) quoted = !quoted;
    if (char !== PROPERTY_SEPARATOR || quoted) continue;
    const segment = title.slice(start, i).trim();
    start = i + 1;
    if (segment === '') continue;
    const space = segment.indexOf(' ');
    if (space === -1) visit(segment, '');
    else visit(segment.slice(0, space), segment.slice(space + 1).trim());
  }
}

function singleNumber(value: string, name: string): number {
  const values = numberList(value, HOCR_NUMBER_SEPARATORS);
  if (values === null || values.length !== 1) throw new OcrMarkupError(`hOCR property ${name} needs one number.`);
  return values[0];
}

function readHocrProperties(title: string | undefined): HocrProperties {
  const props = emptyProperties();
  if (!title) return props;
  forEachProperty(title, (name, value) => {
    if (name === 'bbox') {
      const values = numberList(value, HOCR_NUMBER_SEPARATORS);
      if (values === null || values.length !== HOCR_BBOX_VALUES) throw new OcrMarkupError('hOCR bbox needs four numbers.');
      props.bbox = boxFromValues(values, 'hOCR bbox');
    } else if (name === 'baseline') {
      const values = numberList(value, HOCR_NUMBER_SEPARATORS);
      if (values === null || values.length !== HOCR_BASELINE_VALUES) {
        throw new OcrMarkupError('hOCR baseline needs a slope and an offset.');
      }
      props.baseline = { slope: values[0], offset: values[1] };
    } else if (name === 'x_size') {
      props.xSize = singleNumber(value, name);
    } else if (name === 'x_ascenders') {
      props.xAscenders = singleNumber(value, name);
    } else if (name === 'x_descenders') {
      props.xDescenders = singleNumber(value, name);
    } else if (name === 'x_wconf') {
      props.xWconf = singleNumber(value, name);
    }
  });
  return props;
}

function hocrKind(className: string | undefined): HocrKind | null {
  if (!className) return null;
  let start = -1;
  for (let i = 0; i <= className.length; i++) {
    const space = i === className.length || className.charCodeAt(i) <= CH_SPACE;
    if (space && start !== -1) {
      const kind = HOCR_CLASS_KINDS.get(className.slice(start, i));
      if (kind) return kind;
      start = -1;
    } else if (!space && start === -1) {
      start = i;
    }
  }
  return null;
}

function languageOf(attributes: MarkupAttributes): string | undefined {
  const language = attributes.lang ?? attributes['xml:lang'];
  return language ? language : undefined;
}

interface PageDraft {
  width: number;
  height: number;
  lines: OcrLineBlock[];
}

interface LineDraft {
  props: HocrProperties;
  words: OcrWord[];
  text: string[];
  block: OcrLayoutGroup | undefined;
  paragraph: OcrLayoutGroup | undefined;
}

interface WordDraft {
  props: HocrProperties;
  text: string[];
}

function finishHocrLine(line: LineDraft): OcrLineBlock | null {
  const text = line.words.length > 0 ? line.words.map((w) => w.text).join(' ') : collapseSpace(line.text);
  if (text === '') return null;
  const box = line.props.bbox ?? unionBoxes(line.words.map((w) => boxFromWord(w)));
  if (box === null) throw new OcrMarkupError('An hOCR line with text has no bbox.');
  const block: OcrLineBlock = { text, bbox: toBBox(box), words: line.words };
  if (line.block) block.block = line.block;
  if (line.paragraph) block.paragraph = line.paragraph;
  const baseline = line.props.baseline;
  if (baseline) {
    // The offset is relative to the bottom-left corner of the line box.
    const startY = box.y1 + baseline.offset;
    const lineWidth = box.x1 - box.x0;
    const result: OcrBaseline = { x0: box.x0, y0: startY, x1: box.x1, y1: startY + baseline.slope * lineWidth };
    if (lineWidth > 0) block.baseline = result;
  }
  if (line.props.xSize !== undefined) block.rowHeight = line.props.xSize;
  if (line.props.xAscenders !== undefined) block.ascenders = line.props.xAscenders;
  if (line.props.xDescenders !== undefined) block.descenders = line.props.xDescenders;
  return block;
}

function boxFromWord(word: OcrWord): Box {
  return { x0: word.bbox.x, y0: word.bbox.y, x1: word.bbox.x + word.bbox.width, y1: word.bbox.y + word.bbox.height };
}

function groupFromHocr(attributes: MarkupAttributes): OcrLayoutGroup {
  const group: OcrLayoutGroup = {};
  const box = readHocrProperties(attributes.title).bbox;
  if (box) group.bbox = toBBox(box);
  const language = languageOf(attributes);
  if (language) group.language = language;
  return group;
}

class HocrReader implements MarkupHandler {
  readonly pages: PageDraft[] = [];
  language: string | undefined;
  private readonly kinds: Array<HocrKind | null> = [];
  private page: PageDraft | null = null;
  private block: OcrLayoutGroup | undefined;
  private paragraph: OcrLayoutGroup | undefined;
  private line: LineDraft | null = null;
  private word: WordDraft | null = null;

  open(_name: string, attributes: MarkupAttributes, depth: number): void {
    if (depth === 1) this.language = languageOf(attributes);
    const kind = hocrKind(attributes.class);
    this.kinds[depth] = kind;
    if (kind === 'page') {
      const box = readHocrProperties(attributes.title).bbox;
      if (!box) throw new OcrMarkupError('An ocr_page has no bbox.');
      this.page = { width: box.x1 - box.x0, height: box.y1 - box.y0, lines: [] };
      this.pages.push(this.page);
      this.block = undefined;
      this.paragraph = undefined;
    } else if (kind === 'area') {
      this.block = groupFromHocr(attributes);
      this.paragraph = undefined;
    } else if (kind === 'par') {
      this.paragraph = groupFromHocr(attributes);
    } else if (kind === 'line') {
      this.line = {
        props: readHocrProperties(attributes.title),
        words: [],
        text: [],
        block: this.block,
        paragraph: this.paragraph,
      };
    } else if (kind === 'word' && this.line) {
      this.word = { props: readHocrProperties(attributes.title), text: [] };
    }
  }

  text(text: string): void {
    if (this.word) this.word.text.push(text);
    else if (this.line) this.line.text.push(text);
  }

  close(_name: string, depth: number): void {
    const kind = this.kinds[depth];
    this.kinds.length = depth;
    if (kind === 'word' && this.word && this.line) {
      const text = collapseSpace(this.word.text);
      if (text !== '') {
        const box = this.word.props.bbox;
        if (!box) throw new OcrMarkupError(`The hOCR word '${text}' has no bbox.`);
        const word: OcrWord = { text, bbox: toBBox(box) };
        if (this.word.props.xWconf !== undefined) word.confidence = this.word.props.xWconf;
        this.line.words.push(word);
      }
      this.word = null;
    } else if (kind === 'line' && this.line) {
      const finished = finishHocrLine(this.line);
      if (finished && this.page) this.page.lines.push(finished);
      this.line = null;
    } else if (kind === 'par') {
      this.paragraph = undefined;
    } else if (kind === 'area') {
      this.block = undefined;
      this.paragraph = undefined;
    } else if (kind === 'page') {
      this.page = null;
    }
  }
}

function buildOcrPage(
  pageNumber: number,
  width: number,
  height: number,
  lineBlocks: OcrLineBlock[],
  language: string | undefined
): OcrPageResult {
  const pageLines = lineBlocks.map((b) => b.text).filter(Boolean);
  let pageWordConfSum = 0;
  let pageWordCount = 0;
  for (const b of lineBlocks) {
    for (const w of b.words) {
      if (typeof w.confidence === 'number') {
        pageWordConfSum += w.confidence;
        pageWordCount++;
      }
    }
  }
  const page: OcrPageResult = {
    pageNumber,
    width,
    height,
    text: pageLines.join('\n'),
    confidence: pageWordCount > 0 ? pageWordConfSum / pageWordCount / PERCENT_SCALE : null,
    lineBlocks,
    lines: pageLines,
  };
  if (language) page.language = language;
  return page;
}

function assembleParsedOcrResult(pages: OcrPageResult[]): OcrResult {
  const allTexts = pages.map((p) => p.text).filter(Boolean);
  let totalWordConf = 0;
  let totalWordCount = 0;
  let wordCount = 0;
  for (const p of pages) {
    for (const b of p.lineBlocks) {
      for (const w of b.words) {
        wordCount++;
        if (typeof w.confidence === 'number') {
          totalWordConf += w.confidence;
          totalWordCount++;
        }
      }
    }
  }
  const firstPage = pages[0];
  const result: OcrResult = {
    text: allTexts.join('\n\n').trim(),
    confidence: totalWordCount > 0 ? totalWordConf / totalWordCount / PERCENT_SCALE : null,
    wordCount,
    lines: pages.flatMap((p) => p.lines ?? []),
    lineBlocks: pages.flatMap((p) => p.lineBlocks),
    imageWidth: firstPage.width,
    imageHeight: firstPage.height,
    pages,
  };
  if (firstPage.language) result.language = firstPage.language;
  return result;
}

/**
 * Parses an hOCR 1.2 XHTML document into a structured OcrResult. Pages are numbered in document order.
 * @throws OcrMarkupError when the document is not well formed XML, has no ocr_page, or a page, word or
 * text line lacks its bbox.
 */
export function parseHocr(hocrContent: string): OcrResult {
  if (typeof hocrContent !== 'string' || hocrContent === '') throw new OcrMarkupError('The hOCR document is empty.');
  const reader = new HocrReader();
  readMarkup(hocrContent, reader);
  if (reader.pages.length === 0) throw new OcrMarkupError('The hOCR document has no ocr_page.');
  const pages = reader.pages.map((page, index) =>
    buildOcrPage(index + 1, page.width, page.height, page.lines, reader.language)
  );
  return assembleParsedOcrResult(pages);
}

// ---------------------------------------------------------------------------------------------
// ALTO
// ---------------------------------------------------------------------------------------------

function altoNumber(attributes: MarkupAttributes, name: string): number | undefined {
  const raw = attributes[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new OcrMarkupError(`ALTO attribute ${name} is not a number: '${raw}'.`);
  return value;
}

function altoBox(attributes: MarkupAttributes): Box | null {
  const x = altoNumber(attributes, 'HPOS');
  const y = altoNumber(attributes, 'VPOS');
  const width = altoNumber(attributes, 'WIDTH');
  const height = altoNumber(attributes, 'HEIGHT');
  if (x === undefined || y === undefined || width === undefined || height === undefined) return null;
  if (width < 0 || height < 0) throw new OcrMarkupError('An ALTO element has a negative size.');
  return { x0: x, y0: y, x1: x + width, y1: y + height };
}

/** BASELINE is a polyline `x1,y1 x2,y2 ...`; older schema versions use a single y position. */
function altoBaseline(raw: string | undefined, line: Box | null): OcrBaseline | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const values = numberList(raw, ALTO_NUMBER_SEPARATORS);
  if (values === null) throw new OcrMarkupError(`ALTO BASELINE is not a list of numbers: '${raw}'.`);
  if (values.length === ALTO_SINGLE_BASELINE_VALUES) {
    if (line === null) return undefined;
    return { x0: line.x0, y0: values[0], x1: line.x1, y1: values[0] };
  }
  if (values.length < ALTO_POINT_PAIR_VALUES || values.length % 2 !== 0) {
    throw new OcrMarkupError(`ALTO BASELINE needs coordinate pairs: '${raw}'.`);
  }
  const last = values.length - 2;
  const baseline = { x0: values[0], y0: values[1], x1: values[last], y1: values[last + 1] };
  return baseline.x1 > baseline.x0 ? baseline : undefined;
}

interface AltoLineDraft {
  box: Box | null;
  baseline: string | undefined;
  words: OcrWord[];
  block: OcrLayoutGroup | undefined;
  paragraph: OcrLayoutGroup;
}

class AltoReader implements MarkupHandler {
  readonly pages: Array<{ number: number | undefined; width: number; height: number; lines: OcrLineBlock[] }> = [];
  private page: AltoReader['pages'][number] | null = null;
  private composedDepth = 0;
  private block: OcrLayoutGroup | undefined;
  private paragraph: OcrLayoutGroup | undefined;
  private line: AltoLineDraft | null = null;

  open(name: string, attributes: MarkupAttributes): void {
    if (name === 'Page') {
      const width = altoNumber(attributes, 'WIDTH');
      const height = altoNumber(attributes, 'HEIGHT');
      if (width === undefined || height === undefined) throw new OcrMarkupError('An ALTO Page has no WIDTH and HEIGHT.');
      this.page = { number: altoNumber(attributes, 'PHYSICAL_IMG_NR'), width, height, lines: [] };
      this.pages.push(this.page);
    } else if (name === 'ComposedBlock') {
      if (this.composedDepth++ === 0) this.block = this.groupFrom(attributes);
    } else if (name === 'TextBlock') {
      this.paragraph = this.groupFrom(attributes);
    } else if (name === 'TextLine' && this.page) {
      this.line = {
        box: altoBox(attributes),
        baseline: attributes.BASELINE,
        words: [],
        block: this.block,
        paragraph: this.paragraph ?? {},
      };
    } else if (name === 'String' && this.line) {
      this.readString(attributes);
    }
  }

  text(): void {
    // ALTO keeps its text in the CONTENT attribute.
  }

  close(name: string): void {
    if (name === 'TextLine' && this.line) {
      const finished = this.finishLine(this.line);
      if (finished && this.page) this.page.lines.push(finished);
      this.line = null;
    } else if (name === 'TextBlock') {
      this.paragraph = undefined;
    } else if (name === 'ComposedBlock') {
      if (--this.composedDepth === 0) this.block = undefined;
    } else if (name === 'Page') {
      this.page = null;
      this.block = undefined;
      this.paragraph = undefined;
    }
  }

  private groupFrom(attributes: MarkupAttributes): OcrLayoutGroup {
    const group: OcrLayoutGroup = {};
    const box = altoBox(attributes);
    if (box) group.bbox = toBBox(box);
    const language = attributes.LANG ?? attributes.language;
    if (language) group.language = language;
    return group;
  }

  private readString(attributes: MarkupAttributes): void {
    const text = collapseSpace([attributes.CONTENT ?? '']);
    if (text === '' || !this.line) return;
    const box = altoBox(attributes);
    if (!box) throw new OcrMarkupError(`The ALTO String '${text}' has no HPOS, VPOS, WIDTH and HEIGHT.`);
    const word: OcrWord = { text, bbox: toBBox(box) };
    const wc = altoNumber(attributes, 'WC');
    if (wc !== undefined) word.confidence = wc * PERCENT_SCALE;
    this.line.words.push(word);
  }

  private finishLine(line: AltoLineDraft): OcrLineBlock | null {
    if (line.words.length === 0) return null;
    const box = line.box ?? unionBoxes(line.words.map((w) => boxFromWord(w)));
    if (box === null) return null;
    const block: OcrLineBlock = {
      text: line.words.map((w) => w.text).join(' '),
      bbox: toBBox(box),
      words: line.words,
      paragraph: line.paragraph,
    };
    if (line.block) block.block = line.block;
    const baseline = altoBaseline(line.baseline, box);
    if (baseline) block.baseline = baseline;
    return block;
  }
}

/**
 * Parses an ALTO document (any schema version) into a structured OcrResult. A ComposedBlock is a
 * layout block and a TextBlock a paragraph. Elements are matched by local name.
 * @throws OcrMarkupError when the document is not well formed XML, has no Page, or a Page or String
 * lacks its geometry.
 */
export function parseAlto(altoXml: string): OcrResult {
  if (typeof altoXml !== 'string' || altoXml === '') throw new OcrMarkupError('The ALTO document is empty.');
  const reader = new AltoReader();
  readMarkup(altoXml, reader);
  if (reader.pages.length === 0) throw new OcrMarkupError('The ALTO document has no Page.');
  const pages = reader.pages.map((page, index) =>
    buildOcrPage(page.number ?? index + 1, page.width, page.height, page.lines, undefined)
  );
  return assembleParsedOcrResult(pages);
}
