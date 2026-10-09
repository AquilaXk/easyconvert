import JSZip from 'jszip';
import sharp from 'sharp';
import { PayloadLimitError } from '../../types';
import { resolveLanguage } from '../document-language';
import { redrawAsPng } from '../image-to-png';
import { escapeXmlText } from './xml-text';
import type {
  Block,
  DocumentImage,
  DocumentModel,
  ImageFormat,
  Inline,
  ListBlock,
  ListLevelFormat,
  NoteDefinition,
  ParagraphBlock,
  Section,
  TableBlock,
  TableCellBlock,
} from './model';
import { IMAGE_MIME, bodyBlocks, cellBlocks, imagesById, notesOf, walkBlocks, walkRuns } from './support';

/**
 * DOCX (ECMA-376 Part 1, WordprocessingML) from a structured document: headings use the Heading1 to Heading6 styles
 * (`w:pStyle`), lists use `numbering.xml` abstract and concrete numbering (section 17.9), tables are `w:tbl` with
 * `gridSpan`, `vMerge` and shading, columns are `w:cols` of the section properties (section 17.6.4), running headers
 * and footers are `w:hdr` and `w:ftr` parts, hyperlinks go through relationships and bookmarks, footnotes and endnotes
 * are parts referenced from the text, and pictures are `w:drawing` inline pictures whose original bytes are the files
 * in `word/media`. A picture type Word cannot hold is redrawn as PNG.
 */

/** Most pictures one document may carry. */
export const DOCX_WRITER_MAX_IMAGES = 5_000;

const TWIPS_PER_POINT = 20;
const EMU_PER_POINT = 12_700;
const EMU_PER_PIXEL = 9_525;
const HALF_POINTS = 2;
const DEFAULT_COLUMN_GAP_TWIPS = 720;
const HEADING_LEVELS = 6;
const LIST_LEVELS = 9;
const LIST_INDENT_TWIPS = 720;
const LIST_HANGING_TWIPS = 360;
const MIN_TABLE_COLUMN_TWIPS = 240;
const BOOKMARK_NAME_LIMIT = 40;
const FOOTNOTE_SEPARATOR_ID = -1;
const FOOTNOTE_CONTINUATION_ID = 0;
/** Body size scale for a heading level whose size the source did not provide (level 1 first). */
const DEFAULT_HEADING_SCALE = [1.6, 1.35, 1.2, 1.1, 1, 1];
const BULLET_CYCLE = ['•', '◦', '▪'];
const FONT_BY_FAMILY: Record<DocumentModel['bodyFont'], string> = {
  serif: 'Times New Roman',
  sans: 'Arial',
  monospace: 'Courier New',
};
const EAST_ASIAN_FONTS: ReadonlyMap<string, string> = new Map([
  ['ko', 'Malgun Gothic'],
  ['ja', 'Yu Mincho'],
  ['zh', 'SimSun'],
]);
const MONOSPACE_FONT = 'Courier New';
/** Picture types Word holds natively; any other is redrawn as PNG. */
const WORD_IMAGE_FORMATS: ReadonlySet<ImageFormat> = new Set(['jpeg', 'png', 'gif', 'bmp', 'tiff']);
const MEDIA_EXTENSION: Readonly<Record<ImageFormat, string>> = { jpeg: 'jpeg', png: 'png', gif: 'gif', bmp: 'bmp', tiff: 'tiff', svg: 'png' };
const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const RTL_LETTER = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const LINE_OR_TAB = /[\n\t]/;
const HEADER_RELATIONSHIP_ID = 'rIdHeader1';
const FOOTER_RELATIONSHIP_ID = 'rIdFooter1';

export interface DocxWriteOptions {
  /** Document title for the core properties; a title the document states takes precedence. */
  title?: string;
  /** Requested content language; validated as a BCP 47 tag. */
  language?: string;
}

const twips = (points: number): number => Math.round(points * TWIPS_PER_POINT);
const attr = (value: string | number): string => escapeXmlText(String(value));

// ---------------------------------------------------------------------------------------------
// Package state
// ---------------------------------------------------------------------------------------------

interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

interface MediaFile {
  /** Path inside `word/`. */
  path: string;
  format: ImageFormat;
  data: Uint8Array;
  widthEmu: number;
  heightEmu: number;
}

/** Everything shared by the parts of one package: pictures, bookmarks, note numbers and the running ids. */
class PackageState {
  readonly media = new Map<number, MediaFile>();
  readonly bookmarks = new Map<string, { name: string; id: number }>();
  /** Package-wide number of each cited note, by `kind:id`. */
  readonly noteNumbers = new Map<string, number>();
  readonly anchors = new Set<string>();
  private nextBookmark = 0;
  private nextDrawing = 0;

  drawingId(): number {
    this.nextDrawing += 1;
    return this.nextDrawing;
  }

  bookmark(name: string): { name: string; id: number } {
    let entry = this.bookmarks.get(name);
    if (!entry) {
      this.nextBookmark += 1;
      const safe = `_${name.replace(/[^A-Za-z0-9_]/g, '_')}`.slice(0, BOOKMARK_NAME_LIMIT - 4);
      entry = { name: `${safe}${this.nextBookmark}`.slice(0, BOOKMARK_NAME_LIMIT), id: this.nextBookmark };
      this.bookmarks.set(name, entry);
    }
    return entry;
  }
}

async function prepareMedia(image: DocumentImage, index: number): Promise<MediaFile> {
  let { format, data } = image;
  if (!WORD_IMAGE_FORMATS.has(format)) {
    data = await redrawAsPng(Buffer.from(data), IMAGE_MIME[format]);
    format = 'png';
  }
  let width = image.pixelWidth;
  let height = image.pixelHeight;
  if (format !== image.format || width === undefined || height === undefined) {
    const metadata = await sharp(Buffer.from(data)).metadata();
    width = metadata.width ?? 1;
    height = metadata.height ?? 1;
  }
  return { path: `media/image${index + 1}.${MEDIA_EXTENSION[format]}`, format, data, widthEmu: width * EMU_PER_PIXEL, heightEmu: height * EMU_PER_PIXEL };
}

// ---------------------------------------------------------------------------------------------
// Runs and paragraphs
// ---------------------------------------------------------------------------------------------

/** Text with tabs and line breaks as the elements Word expects. */
function textElements(text: string): string {
  const parts = text.split(LINE_OR_TAB);
  const breaks = text.match(LINE_OR_TAB) ?? [];
  let xml = '';
  parts.forEach((part, index) => {
    if (part !== '') xml += `<w:t xml:space="preserve">${escapeXmlText(part)}</w:t>`;
    const separator = breaks[index];
    if (separator === '\t') xml += '<w:tab/>';
    else if (separator === '\n') xml += '<w:br/>';
  });
  return xml;
}

interface ParagraphProperties {
  style?: string;
  numbering?: { level: number; id: number };
  border?: string;
  rtl?: boolean;
  align?: ParagraphBlock['align'];
  sectPr?: string;
}

const JUSTIFICATION: Record<ParagraphBlock['align'], string> = { left: 'left', center: 'center', right: 'right', justify: 'both' };

/** `w:pPr` with its children in the order the schema fixes. */
function paragraphProperties(props: ParagraphProperties): string {
  let xml = '';
  if (props.style) xml += `<w:pStyle w:val="${attr(props.style)}"/>`;
  if (props.numbering) xml += `<w:numPr><w:ilvl w:val="${props.numbering.level}"/><w:numId w:val="${props.numbering.id}"/></w:numPr>`;
  if (props.border) xml += props.border;
  if (props.rtl) xml += '<w:bidi/>';
  if (props.align && props.align !== 'left') xml += `<w:jc w:val="${JUSTIFICATION[props.align]}"/>`;
  if (props.sectPr) xml += props.sectPr;
  return xml === '' ? '' : `<w:pPr>${xml}</w:pPr>`;
}

interface Piece {
  /** XML of the piece; a paragraph takes the section properties that end its section. */
  render(sectPr?: string): string;
  /** The piece is a paragraph and can carry section properties of its own. */
  carriesSection: boolean;
}

/** The relationships and numbering references of one part (document, footnotes or endnotes). */
class PartWriter {
  readonly relationships: Relationship[] = [];
  private nextRelationship = 0;

  constructor(
    private readonly model: DocumentModel,
    private readonly state: PackageState,
    private availableTwips: number
  ) {}

  private relate(type: string, target: string, external: boolean): string {
    const existing = this.relationships.find((rel) => rel.type === type && rel.target === target && rel.external === external);
    if (existing) return existing.id;
    this.nextRelationship += 1;
    const id = `rId${this.nextRelationship}`;
    this.relationships.push({ id, type, target, external });
    return id;
  }

  private runXml(run: Inline, size: number | undefined, linked: boolean): string {
    if (run.text === '') return '';
    const props: string[] = [];
    if (linked) props.push('<w:rStyle w:val="Hyperlink"/>');
    if (run.monospace) props.push(`<w:rFonts w:ascii="${MONOSPACE_FONT}" w:hAnsi="${MONOSPACE_FONT}" w:cs="${MONOSPACE_FONT}"/>`);
    if (run.bold) props.push('<w:b/><w:bCs/>');
    if (run.italic) props.push('<w:i/><w:iCs/>');
    if (run.strike) props.push('<w:strike/>');
    if (run.color) props.push(`<w:color w:val="${run.color}"/>`);
    const points = run.sizePt ?? size;
    if (points !== undefined) props.push(`<w:sz w:val="${Math.round(points * HALF_POINTS)}"/><w:szCs w:val="${Math.round(points * HALF_POINTS)}"/>`);
    if (run.underline) props.push('<w:u w:val="single"/>');
    if (run.superscript) props.push('<w:vertAlign w:val="superscript"/>');
    if (run.subscript) props.push('<w:vertAlign w:val="subscript"/>');
    if (RTL_LETTER.test(run.text)) props.push('<w:rtl/>');
    return `<w:r>${props.length > 0 ? `<w:rPr>${props.join('')}</w:rPr>` : ''}${textElements(run.text)}</w:r>`;
  }

  private drawing(image: NonNullable<Inline['image']>, drawingId: number): string {
    const media = this.state.media.get(image.imageId);
    if (!media) return '';
    const relationshipId = this.relate(`${REL_BASE}/image`, media.path, false);
    const widthEmu = image.widthPt && image.heightPt ? Math.round(image.widthPt * EMU_PER_POINT) : media.widthEmu;
    const heightEmu = image.widthPt && image.heightPt ? Math.round(image.heightPt * EMU_PER_POINT) : media.heightEmu;
    const alt = attr(image.alt);
    const name = `Picture ${drawingId}`;
    return (
      '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
      `<wp:extent cx="${widthEmu}" cy="${heightEmu}"/><wp:docPr id="${drawingId}" name="${name}" descr="${alt}"/>` +
      '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      `<a:graphic><a:graphicData uri="${NS_PIC}">` +
      `<pic:pic><pic:nvPicPr><pic:cNvPr id="${drawingId}" name="${name}" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
    );
  }

  runsXml(runs: readonly Inline[], size?: number): string {
    let xml = '';
    let index = 0;
    while (index < runs.length) {
      const run = runs[index];
      if (run.image) {
        xml += this.drawing(run.image, this.state.drawingId());
      } else if (run.note) {
        const number = this.state.noteNumbers.get(`${run.note.kind}:${run.note.id}`);
        if (number !== undefined) {
          const element = run.note.kind === 'footnote' ? 'footnoteReference' : 'endnoteReference';
          xml += `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:${element} w:id="${number}"/></w:r>`;
        }
      } else if (run.anchor !== undefined) {
        const mark = this.state.bookmark(run.anchor);
        xml += `<w:bookmarkStart w:id="${mark.id}" w:name="${attr(mark.name)}"/><w:bookmarkEnd w:id="${mark.id}"/>`;
      } else if (run.href !== undefined) {
        // Consecutive runs of one link share one w:hyperlink.
        const { href } = run;
        let linkRuns = '';
        while (index < runs.length && runs[index].href === href && runs[index].image === undefined && runs[index].note === undefined && runs[index].anchor === undefined) {
          linkRuns += this.runXml(runs[index], size, true);
          index += 1;
        }
        if (href.startsWith('#')) {
          // A link to a bookmark the document does not hold is plain text.
          xml += this.state.anchors.has(href.slice(1))
            ? `<w:hyperlink w:anchor="${attr(this.state.bookmark(href.slice(1)).name)}" w:history="1">${linkRuns}</w:hyperlink>`
            : linkRuns;
        } else {
          const id = this.relate(`${REL_BASE}/hyperlink`, href, true);
          xml += `<w:hyperlink r:id="${id}" w:history="1">${linkRuns}</w:hyperlink>`;
        }
        continue;
      } else {
        xml += this.runXml(run, size, false);
      }
      index += 1;
    }
    return xml;
  }

  private paragraph(runs: readonly Inline[], props: ParagraphProperties, size?: number): string {
    return `<w:p>${paragraphProperties(props)}${this.runsXml(runs, size)}</w:p>`;
  }

  // -------------------------------------------------------------------------------------------
  // Tables
  // -------------------------------------------------------------------------------------------

  private cellXml(cell: TableCellBlock, widthTwips: number, rowSpanContinues: boolean): string {
    let props = `<w:tcW w:w="${widthTwips}" w:type="dxa"/>`;
    if (cell.colSpan > 1) props += `<w:gridSpan w:val="${cell.colSpan}"/>`;
    if (cell.continuation) props += '<w:vMerge/>';
    else if (rowSpanContinues) props += '<w:vMerge w:val="restart"/>';
    if (cell.shading) props += `<w:shd w:val="clear" w:color="auto" w:fill="${cell.shading}"/>`;
    let content = '';
    if (!cell.continuation) {
      const blocks = cell.header ? cellBlocks(cell).map((block) => (block.type === 'paragraph' ? { ...block, runs: block.runs.map((run) => ({ ...run, bold: true })) } : block)) : cellBlocks(cell);
      // Tables inside the cell are fitted to the cell, not the page.
      const outer = this.availableTwips;
      this.availableTwips = widthTwips;
      content = this.blocksXml(blocks);
      this.availableTwips = outer;
    }
    // A cell must hold at least one paragraph and end with one.
    if (!content.endsWith('</w:p>')) content += '<w:p/>';
    return `<w:tc><w:tcPr>${props}</w:tcPr>${content}</w:tc>`;
  }

  private tableXml(table: TableBlock): string {
    const columns = table.columnWidths.length;
    let widths = table.columnWidths.map((width) => Math.max(MIN_TABLE_COLUMN_TWIPS, twips(width)));
    const total = widths.reduce((sum, width) => sum + width, 0);
    if (total > this.availableTwips && this.availableTwips > 0) widths = widths.map((width) => Math.max(MIN_TABLE_COLUMN_TWIPS, Math.floor((width * this.availableTwips) / total)));
    const grid = widths.map((width) => `<w:gridCol w:w="${width}"/>`).join('');
    const rows = table.rows
      .map((row, rowIndex) => {
        let column = 0;
        const cells = row
          .map((cell) => {
            const span = Math.min(cell.colSpan, Math.max(1, columns - column));
            const width = widths.slice(column, column + span).reduce((sum, value) => sum + value, 0);
            column += span;
            return this.cellXml({ ...cell, colSpan: span }, width, cell.rowSpan > 1);
          })
          .join('');
        const header = rowIndex === 0 && row.some((cell) => cell.header);
        return `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells}</w:tr>`;
      })
      .join('');
    const borders = table.bordered ? `<w:tblBorders>${TABLE_BORDERS}</w:tblBorders>` : '';
    const props = `<w:tblPr><w:tblW w:w="${widths.reduce((sum, value) => sum + value, 0)}" w:type="dxa"/>${borders}<w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>`;
    return `<w:tbl>${props}<w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`;
  }

  // -------------------------------------------------------------------------------------------
  // Blocks
  // -------------------------------------------------------------------------------------------

  /** The paragraphs and tables of `block`, one piece per element the schema holds at body level. */
  pieces(block: Block, quoted: boolean, nextIsTable: boolean, last: boolean): Piece[] {
    const quoteStyle = quoted ? 'Quote' : undefined;
    switch (block.type) {
      case 'heading':
        return [
          {
            carriesSection: true,
            render: (sectPr?: string) => this.paragraph(block.runs, { style: `Heading${Math.min(block.level, HEADING_LEVELS)}`, rtl: block.rtl, sectPr }),
          },
        ];
      case 'paragraph':
        return [
          {
            carriesSection: true,
            render: (sectPr?: string) => this.paragraph(block.runs, { style: quoteStyle, rtl: block.rtl, align: block.align, sectPr }, block.size),
          },
        ];
      case 'list':
        return block.items.map((item) => ({
          carriesSection: true,
          render: (sectPr?: string) =>
            this.paragraph(item.runs, { style: 'ListParagraph', numbering: { level: Math.min(item.level, LIST_LEVELS - 1), id: block.id }, rtl: item.rtl, sectPr }),
        }));
      case 'table': {
        const pieces: Piece[] = [{ carriesSection: false, render: () => this.tableXml(block) }];
        // Two tables never touch, and a container never ends with a table: Word needs a paragraph between and after.
        if (nextIsTable || last) pieces.push({ carriesSection: true, render: (sectPr?: string) => `<w:p>${paragraphProperties({ sectPr })}</w:p>` });
        return pieces;
      }
      case 'image': {
        const media = this.state.media.get(block.imageId);
        if (!media) return [];
        return [
          {
            carriesSection: false,
            render: () => `<w:p>${this.drawing({ imageId: block.imageId, widthPt: block.widthPt, heightPt: block.heightPt, alt: block.alt ?? '' }, this.state.drawingId())}</w:p>`,
          },
        ];
      }
      case 'code':
        return block.text.split('\n').map((line) => ({
          carriesSection: true,
          render: (sectPr?: string) => this.paragraph([{ text: line, bold: false, italic: false, monospace: true }], { style: 'Code', sectPr }),
        }));
      case 'quote':
        return this.blockPieces(block.blocks, true);
      case 'rule':
        return [
          {
            carriesSection: true,
            render: (sectPr?: string) => this.paragraph([], { border: '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>', sectPr }),
          },
        ];
      case 'pageBreak':
        return [{ carriesSection: false, render: () => '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' }];
    }
  }

  blockPieces(blocks: readonly Block[], quoted = false): Piece[] {
    return blocks.flatMap((block, index) => this.pieces(block, quoted, blocks[index + 1]?.type === 'table', index === blocks.length - 1));
  }

  blocksXml(blocks: readonly Block[]): string {
    return this.blockPieces(blocks)
      .map((piece) => piece.render())
      .join('');
  }
}

const TABLE_BORDERS = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
  .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`)
  .join('');

// ---------------------------------------------------------------------------------------------
// Lists (numbering.xml)
// ---------------------------------------------------------------------------------------------

const NUMBER_FORMATS: Record<ListLevelFormat['kind'], string> = {
  bullet: 'bullet',
  decimal: 'decimal',
  lowerLetter: 'lowerLetter',
  upperLetter: 'upperLetter',
  lowerRoman: 'lowerRoman',
  upperRoman: 'upperRoman',
};

function levelText(format: ListLevelFormat, level: number): string {
  if (format.kind === 'bullet') return format.glyph || BULLET_CYCLE[level % BULLET_CYCLE.length];
  const counter = `%${level + 1}`;
  if (format.punctuation === 'both') return `(${counter})`;
  return format.punctuation === 'paren' ? `${counter})` : `${counter}.`;
}

function levelFormatFor(list: ListBlock, level: number): ListLevelFormat {
  return list.levels[level] ?? list.levels[list.levels.length - 1] ?? { kind: 'bullet', punctuation: 'dot', glyph: BULLET_CYCLE[0] };
}

/** First counter value each level shows, so a list that begins at 5 keeps its numbers. */
function startValues(list: ListBlock): number[] {
  const starts: number[] = [];
  for (const item of list.items) if (starts[item.level] === undefined) starts[item.level] = Math.max(1, item.value);
  return starts;
}

function numberingXml(lists: ListBlock[]): string {
  const abstracts = lists
    .map((list) => {
      const starts = startValues(list);
      const levels = Array.from({ length: LIST_LEVELS }, (_, level) => {
        const format = levelFormatFor(list, level);
        const bullet = format.kind === 'bullet';
        const start = bullet ? 1 : (starts[level] ?? 1);
        const indent = LIST_INDENT_TWIPS * (level + 1);
        return (
          `<w:lvl w:ilvl="${level}"><w:start w:val="${start}"/><w:numFmt w:val="${bullet ? 'bullet' : (format.format ?? NUMBER_FORMATS[format.kind])}"/>` +
          `<w:lvlText w:val="${attr(levelText(format, level))}"/><w:lvlJc w:val="left"/>` +
          `<w:pPr><w:ind w:left="${indent}" w:hanging="${LIST_HANGING_TWIPS}"/></w:pPr>` +
          (bullet ? '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:hint="default"/></w:rPr>' : '') +
          '</w:lvl>'
        );
      }).join('');
      return `<w:abstractNum w:abstractNumId="${list.id}"><w:multiLevelType w:val="hybridMultilevel"/>${levels}</w:abstractNum>`;
    })
    .join('');
  const nums = lists.map((list) => `<w:num w:numId="${list.id}"><w:abstractNumId w:val="${list.id}"/></w:num>`).join('');
  return `${XML_HEADER}<w:numbering xmlns:w="${NS_W}">${abstracts}${nums}</w:numbering>`;
}

// ---------------------------------------------------------------------------------------------
// Styles, notes, section properties and the package
// ---------------------------------------------------------------------------------------------

function stylesXml(model: DocumentModel, language: string | undefined): string {
  const font = FONT_BY_FAMILY[model.bodyFont];
  const size = Math.round(model.bodySize * HALF_POINTS);
  const base = language?.split('-')[0];
  const eastAsia = base ? EAST_ASIAN_FONTS.get(base) : undefined;
  const eastFont = eastAsia ?? font;
  const lang = language ? `<w:lang w:val="${attr(language)}"${eastAsia ? ` w:eastAsia="${attr(language)}"` : ''}/>` : '<w:lang w:val="en-US" w:eastAsia="zh-CN" w:bidi="ar-SA"/>';
  const headings = Array.from({ length: HEADING_LEVELS }, (_, index) => {
    const points = model.headingSizes[index] ?? model.bodySize * DEFAULT_HEADING_SCALE[index];
    const level = index + 1;
    return (
      `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>` +
      `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${index}"/></w:pPr>` +
      `<w:rPr><w:b/><w:bCs/><w:sz w:val="${Math.round(points * HALF_POINTS)}"/><w:szCs w:val="${Math.round(points * HALF_POINTS)}"/></w:rPr></w:style>`
    );
  }).join('');
  return (
    `${XML_HEADER}<w:styles xmlns:w="${NS_W}"><w:docDefaults><w:rPrDefault><w:rPr>` +
    `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${eastFont}" w:cs="${font}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/>${lang}` +
    '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>' +
    headings +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:spacing w:after="40"/><w:contextualSpacing/></w:pPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720" w:right="720"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>' +
    `<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:rFonts w:ascii="${MONOSPACE_FONT}" w:hAnsi="${MONOSPACE_FONT}" w:cs="${MONOSPACE_FONT}"/><w:sz w:val="20"/></w:rPr></w:style>` +
    '<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:basedOn w:val="DefaultParagraphFont"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>' +
    '</w:styles>'
  );
}

/** References to the running header and footer parts; they come first in a section's properties. */
function furnitureReferences(model: DocumentModel): string {
  const header = model.pageHeader && model.pageHeader.length > 0 ? `<w:headerReference w:type="default" r:id="${HEADER_RELATIONSHIP_ID}"/>` : '';
  const footer = model.pageFooter && model.pageFooter.length > 0 ? `<w:footerReference w:type="default" r:id="${FOOTER_RELATIONSHIP_ID}"/>` : '';
  return header + footer;
}

function sectionProperties(model: DocumentModel, section: Section, first: boolean): string {
  const width = twips(model.pageWidthPt);
  const height = twips(model.pageHeightPt);
  const { margins } = model;
  const orient = width > height ? ' w:orient="landscape"' : '';
  const columns = section.columns > 1 ? `<w:cols w:num="${section.columns}" w:space="${DEFAULT_COLUMN_GAP_TWIPS}"/>` : '<w:cols w:space="720"/>';
  const type = first ? '' : `<w:type w:val="${section.breakType ?? 'continuous'}"/>`;
  return (
    `<w:sectPr>${furnitureReferences(model)}${type}<w:pgSz w:w="${width}" w:h="${height}"${orient}/>` +
    `<w:pgMar w:top="${twips(margins.top)}" w:right="${twips(margins.right)}" w:bottom="${twips(margins.bottom)}" w:left="${twips(margins.left)}" w:header="720" w:footer="720" w:gutter="0"/>` +
    `${columns}</w:sectPr>`
  );
}

/** A header (`w:hdr`) or footer (`w:ftr`) part holding one paragraph per running line. */
function furniturePartXml(tag: 'hdr' | 'ftr', lines: Inline[][], part: PartWriter): string {
  return `${XML_HEADER}<w:${tag} xmlns:w="${NS_W}" xmlns:r="${NS_R}">${lines.map((runs) => `<w:p>${part.runsXml(runs)}</w:p>`).join('')}</w:${tag}>`;
}

const DOCUMENT_NAMESPACES = `xmlns:w="${NS_W}" xmlns:r="${NS_R}" xmlns:wp="${NS_WP}" xmlns:a="${NS_A}" xmlns:pic="${NS_PIC}"`;

function relationshipsXml(relationships: readonly Relationship[]): string {
  const items = relationships.map(
    (rel) => `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${attr(rel.target)}"${rel.external ? ' TargetMode="External"' : ''}/>`
  );
  return `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`;
}

function notesXml(kind: 'footnote' | 'endnote', notes: readonly NoteDefinition[], part: PartWriter): string {
  const plural = `${kind}s`;
  const marker = kind === 'footnote' ? 'footnoteRef' : 'endnoteRef';
  let xml =
    `${XML_HEADER}<w:${plural} ${DOCUMENT_NAMESPACES}>` +
    `<w:${kind} w:type="separator" w:id="${FOOTNOTE_SEPARATOR_ID}"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:${kind}>` +
    `<w:${kind} w:type="continuationSeparator" w:id="${FOOTNOTE_CONTINUATION_ID}"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:${kind}>`;
  let id = 0;
  for (const note of notes) {
    id += 1;
    // The note's own number leads its first paragraph.
    const reference = `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:${marker}/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>`;
    const [first, ...rest] = note.blocks;
    let body: string;
    if (first && first.type === 'paragraph') {
      body = `<w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>${reference}${part.runsXml(first.runs)}</w:p>${part.blocksXml(rest)}`;
    } else {
      body = `<w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>${reference}</w:p>${part.blocksXml(note.blocks)}`;
    }
    xml += `<w:${kind} w:id="${id}">${body}</w:${kind}>`;
  }
  return `${xml}</w:${plural}>`;
}

function contentTypesXml(parts: { numbering: boolean; header: boolean; footer: boolean; settings: boolean; footnotes: boolean; endnotes: boolean; core: boolean; mediaTypes: Map<string, string> }): string {
  const defaults = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    ...[...parts.mediaTypes].map(([extension, mime]) => `<Default Extension="${extension}" ContentType="${mime}"/>`),
  ];
  const wordml = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
  const overrides = [
    `<Override PartName="/word/document.xml" ContentType="${wordml}.document.main+xml"/>`,
    `<Override PartName="/word/styles.xml" ContentType="${wordml}.styles+xml"/>`,
    ...(parts.numbering ? [`<Override PartName="/word/numbering.xml" ContentType="${wordml}.numbering+xml"/>`] : []),
    ...(parts.settings ? [`<Override PartName="/word/settings.xml" ContentType="${wordml}.settings+xml"/>`] : []),
    ...(parts.header ? [`<Override PartName="/word/header1.xml" ContentType="${wordml}.header+xml"/>`] : []),
    ...(parts.footer ? [`<Override PartName="/word/footer1.xml" ContentType="${wordml}.footer+xml"/>`] : []),
    ...(parts.footnotes ? [`<Override PartName="/word/footnotes.xml" ContentType="${wordml}.footnotes+xml"/>`] : []),
    ...(parts.endnotes ? [`<Override PartName="/word/endnotes.xml" ContentType="${wordml}.endnotes+xml"/>`] : []),
    ...(parts.core ? ['<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'] : []),
  ];
  return `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults.join('')}${overrides.join('')}</Types>`;
}

/** Notes get package-wide numbers in the order the body cites them. */
function numberNotes(model: DocumentModel, state: PackageState): { footnote: NoteDefinition[]; endnote: NoteDefinition[] } {
  const cited: { footnote: NoteDefinition[]; endnote: NoteDefinition[] } = { footnote: [], endnote: [] };
  const cite = (blocks: readonly Block[]): void => {
    walkRuns(blocks, (run) => {
      if (!run.note) return;
      const key = `${run.note.kind}:${run.note.id}`;
      if (state.noteNumbers.has(key)) return;
      const note = notesOf(model, run.note.kind).find((entry) => entry.id === run.note?.id);
      if (!note) return;
      cited[run.note.kind].push(note);
      state.noteNumbers.set(key, cited[run.note.kind].length);
    });
  };
  cite(bodyBlocks(model));
  // A note that cites another is numbered after the notes the body cites.
  for (let index = 0; index < cited.footnote.length; index += 1) cite(cited.footnote[index].blocks);
  return cited;
}

function documentLists(model: DocumentModel): ListBlock[] {
  const lists: ListBlock[] = [];
  const collect = (block: Block): void => {
    if (block.type === 'list') lists.push(block);
  };
  walkBlocks(bodyBlocks(model), collect);
  for (const note of [...(model.footnotes ?? []), ...(model.endnotes ?? [])]) walkBlocks(note.blocks, collect);
  return lists;
}

/**
 * Writes the document as a DOCX package.
 * @throws InvalidXmlCharacterError when text holds a character XML 1.0 does not allow.
 * @throws PayloadLimitError when the document carries more pictures than DOCX_WRITER_MAX_IMAGES.
 * @throws UnsupportedOptionError when the requested language is not a BCP 47 tag.
 */
export async function documentToDocx(model: DocumentModel, options: DocxWriteOptions = {}): Promise<Buffer> {
  // Word proofs by the language the document or the request names; text is not guessed at here.
  const language = options.language !== undefined || model.language ? resolveLanguage(model, options.language) : undefined;
  const title = (model.title ?? options.title)?.trim();
  const state = new PackageState();

  // Pictures first: their final type and size decide the markup, and the count is bounded before any is processed.
  const used = new Set<number>();
  const collectUsed = (blocks: readonly Block[]): void => {
    walkBlocks(blocks, (block) => {
      if (block.type === 'image') used.add(block.imageId);
    });
    walkRuns(blocks, (run) => {
      if (run.image) used.add(run.image.imageId);
    });
  };
  collectUsed(bodyBlocks(model));
  for (const entry of [...(model.footnotes ?? []), ...(model.endnotes ?? [])]) collectUsed(entry.blocks);
  const images = imagesById(model);
  const usedImages = [...used].flatMap((id) => {
    const image = images.get(id);
    return image ? [image] : [];
  });
  if (usedImages.length > DOCX_WRITER_MAX_IMAGES) throw new PayloadLimitError(`The document would embed more than ${DOCX_WRITER_MAX_IMAGES} pictures.`);
  for (const [index, image] of usedImages.entries()) state.media.set(image.id, await prepareMedia(image, index));

  const collectAnchors = (blocks: readonly Block[]): void =>
    walkRuns(blocks, (run) => {
      if (run.anchor !== undefined) state.anchors.add(run.anchor);
    });
  collectAnchors(bodyBlocks(model));
  for (const entry of [...(model.footnotes ?? []), ...(model.endnotes ?? [])]) collectAnchors(entry.blocks);
  const cited = numberNotes(model, state);

  const availableTwips = twips(model.pageWidthPt - model.margins.left - model.margins.right);
  const documentPart = new PartWriter(model, state, availableTwips);
  const bodyParts: string[] = [];
  model.sections.forEach((section, sectionIndex) => {
    const last = sectionIndex === model.sections.length - 1;
    const pieces = documentPart.blockPieces(section.blocks);
    pieces.forEach((piece, pieceIndex) => {
      const endsSection = !last && pieceIndex === pieces.length - 1;
      if (!endsSection) {
        bodyParts.push(piece.render());
      } else if (piece.carriesSection) {
        bodyParts.push(piece.render(sectionProperties(model, section, sectionIndex === 0)));
      } else {
        bodyParts.push(piece.render(), `<w:p><w:pPr>${sectionProperties(model, section, sectionIndex === 0)}</w:pPr></w:p>`);
      }
    });
    if (pieces.length === 0 && !last) bodyParts.push(`<w:p><w:pPr>${sectionProperties(model, section, sectionIndex === 0)}</w:pPr></w:p>`);
  });
  // A body ends with a paragraph or a section break; an empty document still needs one paragraph.
  if (bodyParts.length === 0) bodyParts.push('<w:p/>');
  const finalSection = model.sections[model.sections.length - 1] ?? { columns: 1, blocks: [] };
  const document =
    `${XML_HEADER}<w:document ${DOCUMENT_NAMESPACES}>` +
    `<w:body>${bodyParts.join('')}${sectionProperties(model, finalSection, model.sections.length <= 1)}</w:body></w:document>`;

  const footnotePart = new PartWriter(model, state, availableTwips);
  const endnotePart = new PartWriter(model, state, availableTwips);
  const hasFootnotes = cited.footnote.length > 0;
  const hasEndnotes = cited.endnote.length > 0;
  const footnotes = hasFootnotes ? notesXml('footnote', cited.footnote, footnotePart) : '';
  const endnotes = hasEndnotes ? notesXml('endnote', cited.endnote, endnotePart) : '';

  const lists = documentLists(model);
  const hasHeader = Boolean(model.pageHeader && model.pageHeader.length > 0);
  const hasFooter = Boolean(model.pageFooter && model.pageFooter.length > 0);
  const furniturePart = new PartWriter(model, state, availableTwips);
  const header = hasHeader && model.pageHeader ? furniturePartXml('hdr', model.pageHeader, furniturePart) : '';
  const footer = hasFooter && model.pageFooter ? furniturePartXml('ftr', model.pageFooter, furniturePart) : '';
  const hasSettings = hasFootnotes || hasEndnotes;
  const hasCore = Boolean(title || model.author || language);

  const zip = new JSZip();
  const add = (name: string, data: string | Uint8Array): void => {
    zip.file(name, data, { createFolders: false });
  };
  const mediaTypes = new Map<string, string>();
  for (const media of state.media.values()) mediaTypes.set(media.path.slice(media.path.lastIndexOf('.') + 1), IMAGE_MIME[media.format]);
  add('[Content_Types].xml', contentTypesXml({ numbering: lists.length > 0, header: hasHeader, footer: hasFooter, settings: hasSettings, footnotes: hasFootnotes, endnotes: hasEndnotes, core: hasCore, mediaTypes }));
  add(
    '_rels/.rels',
    relationshipsXml([
      { id: 'rId1', type: `${REL_BASE}/officeDocument`, target: 'word/document.xml', external: false },
      ...(hasCore ? [{ id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml', external: false }] : []),
    ])
  );
  if (hasCore) {
    const created = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    add(
      'docProps/core.xml',
      `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
        (title ? `<dc:title>${escapeXmlText(title)}</dc:title>` : '') +
        (model.author ? `<dc:creator>${escapeXmlText(model.author)}</dc:creator>` : '') +
        (language ? `<dc:language>${escapeXmlText(language)}</dc:language>` : '') +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created></cp:coreProperties>`
    );
  }
  const documentRelationships: Relationship[] = [
    { id: 'rIdStyles', type: `${REL_BASE}/styles`, target: 'styles.xml', external: false },
    ...(lists.length > 0 ? [{ id: 'rIdNumbering', type: `${REL_BASE}/numbering`, target: 'numbering.xml', external: false }] : []),
    ...(hasSettings ? [{ id: 'rIdSettings', type: `${REL_BASE}/settings`, target: 'settings.xml', external: false }] : []),
    ...(hasFootnotes ? [{ id: 'rIdFootnotes', type: `${REL_BASE}/footnotes`, target: 'footnotes.xml', external: false }] : []),
    ...(hasEndnotes ? [{ id: 'rIdEndnotes', type: `${REL_BASE}/endnotes`, target: 'endnotes.xml', external: false }] : []),
    ...(hasHeader ? [{ id: HEADER_RELATIONSHIP_ID, type: `${REL_BASE}/header`, target: 'header1.xml', external: false }] : []),
    ...(hasFooter ? [{ id: FOOTER_RELATIONSHIP_ID, type: `${REL_BASE}/footer`, target: 'footer1.xml', external: false }] : []),
    ...documentPart.relationships,
  ];
  add('word/_rels/document.xml.rels', relationshipsXml(documentRelationships));
  add('word/document.xml', document);
  add('word/styles.xml', stylesXml(model, language));
  if (lists.length > 0) add('word/numbering.xml', numberingXml(lists));
  if (hasSettings) {
    add(
      'word/settings.xml',
      `${XML_HEADER}<w:settings xmlns:w="${NS_W}"><w:defaultTabStop w:val="720"/>` +
        (hasFootnotes ? `<w:footnotePr><w:footnote w:id="${FOOTNOTE_SEPARATOR_ID}"/><w:footnote w:id="${FOOTNOTE_CONTINUATION_ID}"/></w:footnotePr>` : '') +
        (hasEndnotes ? `<w:endnotePr><w:endnote w:id="${FOOTNOTE_SEPARATOR_ID}"/><w:endnote w:id="${FOOTNOTE_CONTINUATION_ID}"/></w:endnotePr>` : '') +
        '</w:settings>'
    );
  }
  if (hasHeader) add('word/header1.xml', header);
  if (hasFooter) add('word/footer1.xml', footer);
  if (hasFootnotes) {
    add('word/footnotes.xml', footnotes);
    if (footnotePart.relationships.length > 0) add('word/_rels/footnotes.xml.rels', relationshipsXml(footnotePart.relationships));
  }
  if (hasEndnotes) {
    add('word/endnotes.xml', endnotes);
    if (endnotePart.relationships.length > 0) add('word/_rels/endnotes.xml.rels', relationshipsXml(endnotePart.relationships));
  }
  for (const media of state.media.values()) add(`word/${media.path}`, media.data);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
