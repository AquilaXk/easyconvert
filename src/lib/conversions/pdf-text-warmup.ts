import { warmupFontFile } from './pdf-text-warmup-font';

/**
 * A three-page document that a replacement text thread reads before it takes user documents (see pdf-text-host.ts): it
 * loads pdfjs, the standard font data and the layout path, and its second and third pages carry an embedded TrueType font,
 * as the documents of users do, once as a simple font and once as a composite font with a ToUnicode map and glyph numbers
 * (Latin, Cyrillic, Greek and Japanese text), so the reader's font loading and the mapping to Unicode are warm as well. A thread reads
 * it WARMUP_READS times. It is fixed text written for this purpose, never user data.
 */

/** Page size in points (US Letter). */
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const LINE_HEIGHT = 16;
const FIRST_BASELINE = 720;
const LEFT_MARGIN = 72;
const FONT_SIZE = 12;
/** How often a replacement thread reads the document: warmer code paths mean a first document that costs what a later one does. */
export const WARMUP_READS = 8;
const GLYPH_WIDTH = 600;
const FIRST_CHAR = 0x20;
const LAST_CHAR = 0x7e;
const BF_CHARS_PER_BLOCK = 100;
const FONT_NAME = 'WarmupSans';

/** The lines of the pages, in reading order. The first page uses two standard fonts, the second an embedded simple font, the third an embedded composite font. */
const STANDARD_LINES = [
  'Replacement threads read this page before the first document.',
  'Words, numbers 1234567890 and punctuation, (like this); are set in two fonts.',
  'A second paragraph keeps the reading order and the line joining busy.',
];
const SIMPLE_LINES = [
  'An embedded font program is parsed and its glyphs are mapped back to text.',
  'Fourteen small paragraphs of forty words are what a typical page holds.',
  'The third line closes the page and ends the stream.',
];
const COMPOSITE_LINES = [
  'Glyph numbers and a map to Unicode carry this line.',
  'Здравствуй, мир: строка с кириллицей и греческим αβγ.',
  'これは漢字とかなの文です。',
];

/** The objects of the document, in file order; an object's number is its position plus one. */
const OBJECTS = [
  'catalog',
  'pages',
  'standardPage',
  'simplePage',
  'compositePage',
  'resources',
  'helvetica',
  'times',
  'simpleFont',
  'descriptor',
  'fontFile',
  'compositeFont',
  'cidFont',
  'toUnicode',
  'standardContent',
  'simpleContent',
  'compositeContent',
] as const;
type ObjectName = (typeof OBJECTS)[number];

/** The reference to an object. */
const ref = (name: ObjectName): string => `${OBJECTS.indexOf(name) + 1} 0 R`;

/** The sorted, distinct UTF-16 units of the lines. */
function codesOf(lines: readonly string[]): number[] {
  return [...new Set(lines.join('').split('').map((character) => character.charCodeAt(0)))].sort((a, b) => a - b);
}

const FONT_CODES = codesOf([...SIMPLE_LINES, ...COMPOSITE_LINES]);

function pdfString(text: string): string {
  return `(${text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')})`;
}

/** The glyph numbers of a line as a hexadecimal string, for the composite font. */
function glyphString(line: string): string {
  return `<${line
    .split('')
    .map((character) => (FONT_CODES.indexOf(character.charCodeAt(0)) + 1).toString(16).padStart(4, '0'))
    .join('')}>`;
}

/** A page's text: each line is placed under the one before, in the font `fontOf` names for it, shown as `shown` writes the line. */
function contentStream(lines: readonly string[], fontOf: (index: number) => string, shown: (line: string) => string): string {
  const operations = lines.map((line, index) => `/${fontOf(index)} ${FONT_SIZE} Tf ${LEFT_MARGIN} ${FIRST_BASELINE - index * LINE_HEIGHT} Td ${shown(line)} Tj`);
  return `BT\n${operations.join('\n1 0 0 1 0 0 Tm\n')}\nET`;
}

/** The map from glyph numbers to text of the composite font. */
function toUnicodeCMap(): string {
  const blocks: string[] = [];
  for (let first = 0; first < FONT_CODES.length; first += BF_CHARS_PER_BLOCK) {
    const entries = FONT_CODES.slice(first, first + BF_CHARS_PER_BLOCK).map((code, offset) => {
      const glyph = (first + offset + 1).toString(16).padStart(4, '0');
      return `<${glyph}> <${code.toString(16).padStart(4, '0')}>`;
    });
    blocks.push(`${entries.length} beginbfchar\n${entries.join('\n')}\nendbfchar`);
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CMapName /Warmup-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange',
    ...blocks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
}

function streamObject(dictionary: string, data: string | Buffer): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
  return Buffer.concat([Buffer.from(`<< ${dictionary} /Length ${body.length} >>\nstream\n`, 'latin1'), body, Buffer.from('\nendstream', 'latin1')]);
}

function objectBodies(): Record<ObjectName, string | Buffer> {
  const font = warmupFontFile(FONT_CODES);
  const widths = Array.from({ length: LAST_CHAR - FIRST_CHAR + 1 }, () => GLYPH_WIDTH).join(' ');
  const page = (contents: ObjectName): string =>
    `<< /Type /Page /Parent ${ref('pages')} /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources ${ref('resources')} /Contents ${ref(contents)} >>`;
  return {
    catalog: `<< /Type /Catalog /Pages ${ref('pages')} >>`,
    pages: `<< /Type /Pages /Kids [${ref('standardPage')} ${ref('simplePage')} ${ref('compositePage')}] /Count 3 >>`,
    standardPage: page('standardContent'),
    simplePage: page('simpleContent'),
    compositePage: page('compositeContent'),
    resources: `<< /Font << /F1 ${ref('helvetica')} /F2 ${ref('times')} /F3 ${ref('simpleFont')} /F4 ${ref('compositeFont')} >> >>`,
    helvetica: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    times: '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>',
    simpleFont: `<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+${FONT_NAME} /FirstChar ${FIRST_CHAR} /LastChar ${LAST_CHAR} /Widths [${widths}] /FontDescriptor ${ref('descriptor')} /Encoding /WinAnsiEncoding >>`,
    descriptor: `<< /Type /FontDescriptor /FontName /ABCDEF+${FONT_NAME} /Flags 32 /FontBBox [0 0 ${GLYPH_WIDTH} 700] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 ${ref('fontFile')} >>`,
    fontFile: streamObject(`/Length1 ${font.length}`, font),
    compositeFont: `<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+${FONT_NAME} /Encoding /Identity-H /DescendantFonts [${ref('cidFont')}] /ToUnicode ${ref('toUnicode')} >>`,
    cidFont: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+${FONT_NAME} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${ref('descriptor')} /CIDToGIDMap /Identity /DW ${GLYPH_WIDTH} >>`,
    toUnicode: streamObject('', toUnicodeCMap()),
    standardContent: streamObject('', contentStream(STANDARD_LINES, (index) => (index % 2 === 0 ? 'F1' : 'F2'), pdfString)),
    simpleContent: streamObject('', contentStream(SIMPLE_LINES, () => 'F3', pdfString)),
    compositeContent: streamObject('', contentStream(COMPOSITE_LINES, () => 'F4', glyphString)),
  };
}

/** The document, with an exact cross-reference table. */
export function warmupPdf(): Uint8Array {
  const objects = objectBodies();
  const bodies = OBJECTS.map((name) => (typeof objects[name] === 'string' ? Buffer.from(objects[name], 'latin1') : objects[name]));
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let length = parts[0].length;
  const offsets = bodies.map((body, index) => {
    const offset = length;
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(object);
    length += object.length;
    return offset;
  });
  const entries = offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  parts.push(
    Buffer.from(`xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${entries}trailer\n<< /Size ${bodies.length + 1} /Root ${ref('catalog')} >>\nstartxref\n${length}\n%%EOF\n`, 'latin1')
  );
  return Buffer.concat(parts);
}
