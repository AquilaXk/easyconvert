import crypto from 'node:crypto';
import JSZip from 'jszip';
import sharp from 'sharp';
import { PayloadLimitError } from '../types';
import { resolveLanguage } from './document-language';
import {
  IMAGE_FILE_EXTENSION,
  escapeXmlAttribute,
  escapeXmlText,
  stripXmlForbidden,
  tableSlots,
  walkBlocks,
  type DocBlock,
  type DocImage,
  type DocInline,
  type DocModel,
  type DocNote,
  type DocTableCell,
  type DocTextInline,
  MAX_HEADING_LEVEL,
} from './document-model';

/**
 * Writes the block model as a WordprocessingML package (ECMA-376 Part 1, transitional): real paragraph and character
 * styles for headings, a numbering part with one numbering instance per list, `w:tbl` tables with `w:gridSpan` and
 * `w:vMerge`, hyperlinks through relationships, bookmarks, footnotes and endnotes parts, pictures in `word/media`
 * with their original bytes, page and section breaks, and core properties.
 */

/** Most pictures one document may carry. */
export const DOCX_WRITER_MAX_IMAGES = 5_000;
const W_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RELATIONSHIP_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const EMU_PER_POINT = 12700;
const EMU_PER_PIXEL = 9525;
const TWIPS_PER_POINT = 20;
const HALF_POINTS_PER_POINT = 2;
const A4_WIDTH_TWIPS = 11906;
const A4_HEIGHT_TWIPS = 16838;
const DEFAULT_MARGIN_TWIPS = 1440;
const LEVEL_INDENT_TWIPS = 720;
const LEVEL_HANGING_TWIPS = 360;
const MAX_LEVELS = 9;
const BOOKMARK_NAME_LIMIT = 40;
const FOOTNOTE_SEPARATOR_ID = -1;
const FOOTNOTE_CONTINUATION_ID = 0;
const TABLE_WIDTH_TWIPS = 9000;
const IMAGE_TYPES_IN_WORD: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/tiff']);
const EAST_ASIAN_FONTS: ReadonlyMap<string, string> = new Map([
  ['ko', 'Malgun Gothic'],
  ['ja', 'Yu Mincho'],
  ['zh', 'SimSun'],
]);
const ORDERED_FORMATS: readonly string[] = ['decimal', 'lowerLetter', 'lowerRoman'];
const BULLET_GLYPHS: readonly string[] = ['•', '◦', '▪'];
const SECTION_TYPE_NAMES: ReadonlyMap<string, string> = new Map([
  ['nextPage', 'nextPage'],
  ['continuous', 'continuous'],
  ['evenPage', 'evenPage'],
  ['oddPage', 'oddPage'],
  ['nextColumn', 'nextColumn'],
]);
const MONOSPACE_FONT = 'Courier New';

export interface DocxWriteOptions {
  title: string;
  /** Requested content language; validated as a BCP 47 tag. */
  language?: string;
}

interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

interface MediaFile {
  path: string;
  mime: string;
  data: Buffer;
}

type ListItem = Extract<DocBlock, { kind: 'listItem' }>;

interface ListDefinition {
  listId: number;
  ordered: boolean;
  /** Per level: the numbering format, start value and marker text template. */
  levels: { format: string; start: number; text: string; ordered: boolean }[];
}

/** Everything shared by the parts of one package: pictures, bookmarks, numbering and the running ids. */
class PackageState {
  readonly media: MediaFile[] = [];
  private readonly mediaByHash = new Map<string, MediaFile>();
  readonly lists = new Map<number, ListDefinition>();
  readonly bookmarks = new Map<string, { name: string; id: number }>();
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

  async addMedia(image: DocImage): Promise<MediaFile> {
    const hash = crypto.createHash('sha256').update(image.data).digest('hex');
    const known = this.mediaByHash.get(hash);
    if (known) return known;
    if (this.media.length >= DOCX_WRITER_MAX_IMAGES) throw new PayloadLimitError(`The document would embed more than ${DOCX_WRITER_MAX_IMAGES} pictures.`);
    let { data } = image;
    let mime: string = image.mime;
    if (!IMAGE_TYPES_IN_WORD.has(mime)) {
      data = await sharp(image.data).png().toBuffer();
      mime = 'image/png';
    }
    const file: MediaFile = { path: `word/media/image${this.media.length + 1}.${IMAGE_FILE_EXTENSION[mime as DocImage['mime']]}`, mime, data };
    this.media.push(file);
    this.mediaByHash.set(hash, file);
    return file;
  }
}

/** The relationships and numbering references of one part (document, footnotes or endnotes). */
class PartWriter {
  readonly relationships: Relationship[] = [];
  private nextRelationship = 0;

  constructor(
    private readonly state: PackageState,
    private readonly noteIds: ReadonlyMap<string, number>,
    private readonly anchors: ReadonlySet<string>,
    private readonly page: DocModel['page']
  ) {}

  private relate(type: string, target: string, external: boolean): string {
    const existing = this.relationships.find((rel) => rel.type === type && rel.target === target && rel.external === external);
    if (existing) return existing.id;
    this.nextRelationship += 1;
    const id = `rId${this.nextRelationship}`;
    this.relationships.push({ id, type, target, external });
    return id;
  }

  private runProperties(inline: DocTextInline, linked: boolean): string {
    let props = '';
    if (linked) props += '<w:rStyle w:val="Hyperlink"/>';
    if (inline.code) props += `<w:rFonts w:ascii="${MONOSPACE_FONT}" w:hAnsi="${MONOSPACE_FONT}" w:cs="${MONOSPACE_FONT}"/>`;
    if (inline.bold) props += '<w:b/>';
    if (inline.italic) props += '<w:i/>';
    if (inline.strike) props += '<w:strike/>';
    if (inline.color) props += `<w:color w:val="${inline.color}"/>`;
    if (inline.sizePt) props += `<w:sz w:val="${Math.round(inline.sizePt * HALF_POINTS_PER_POINT)}"/>`;
    if (inline.underline) props += '<w:u w:val="single"/>';
    if (inline.superscript) props += '<w:vertAlign w:val="superscript"/>';
    if (inline.subscript) props += '<w:vertAlign w:val="subscript"/>';
    return props === '' ? '' : `<w:rPr>${props}</w:rPr>`;
  }

  /** The runs of one text inline: tabs and line feeds become their own elements. */
  private textRuns(inline: DocTextInline, linked: boolean): string {
    const properties = this.runProperties(inline, linked);
    const pieces = stripXmlForbidden(inline.text).split(/(\t|\n)/);
    let xml = '';
    for (const piece of pieces) {
      if (piece === '') continue;
      let content: string;
      if (piece === '\t') content = '<w:tab/>';
      else if (piece === '\n') content = '<w:br/>';
      else content = `<w:t xml:space="preserve">${escapeXmlText(piece)}</w:t>`;
      xml += `<w:r>${properties}${content}</w:r>`;
    }
    return xml;
  }

  private async drawing(image: DocImage): Promise<string> {
    const media = await this.state.addMedia(image);
    const relationshipId = this.relate(`${RELATIONSHIP_BASE}/image`, media.path.replace(/^word\//, ''), false);
    let widthEmu: number;
    let heightEmu: number;
    if (image.widthPt && image.heightPt) {
      widthEmu = Math.round(image.widthPt * EMU_PER_POINT);
      heightEmu = Math.round(image.heightPt * EMU_PER_POINT);
    } else {
      const metadata = await sharp(media.data).metadata();
      widthEmu = (metadata.width ?? 1) * EMU_PER_PIXEL;
      heightEmu = (metadata.height ?? 1) * EMU_PER_PIXEL;
    }
    const id = this.state.drawingId();
    const alt = escapeXmlAttribute(stripXmlForbidden(image.alt));
    const name = `Picture ${id}`;
    return (
      '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
      `<wp:extent cx="${widthEmu}" cy="${heightEmu}"/><wp:docPr id="${id}" name="${name}" descr="${alt}"/>` +
      '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
    );
  }

  async inlines(inlines: readonly DocInline[]): Promise<string> {
    let xml = '';
    let index = 0;
    while (index < inlines.length) {
      const inline = inlines[index];
      if (inline.kind === 'text' && inline.href !== undefined) {
        // Consecutive runs of one link share one w:hyperlink.
        const href = inline.href;
        let runs = '';
        while (index < inlines.length) {
          const next = inlines[index];
          if (next.kind !== 'text' || next.href !== href) break;
          runs += this.textRuns(next, true);
          index += 1;
        }
        if (href.startsWith('#')) {
          // A link to a bookmark the document does not hold is plain text.
          xml += this.anchors.has(href.slice(1))
            ? `<w:hyperlink w:anchor="${escapeXmlAttribute(this.state.bookmark(href.slice(1)).name)}" w:history="1">${runs}</w:hyperlink>`
            : runs;
        } else {
          const id = this.relate(`${RELATIONSHIP_BASE}/hyperlink`, href, true);
          xml += `<w:hyperlink r:id="${id}" w:history="1">${runs}</w:hyperlink>`;
        }
        continue;
      }
      switch (inline.kind) {
        case 'text':
          xml += this.textRuns(inline, false);
          break;
        case 'break':
          xml += '<w:r><w:br/></w:r>';
          break;
        case 'image':
          xml += await this.drawing(inline.image);
          break;
        case 'noteRef': {
          const noteId = this.noteIds.get(`${inline.noteKind}:${inline.id}`);
          if (noteId !== undefined) {
            const element = inline.noteKind === 'footnote' ? 'footnoteReference' : 'endnoteReference';
            xml += `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:${element} w:id="${noteId}"/></w:r>`;
          }
          break;
        }
        case 'anchor': {
          const mark = this.state.bookmark(inline.name);
          xml += `<w:bookmarkStart w:id="${mark.id}" w:name="${escapeXmlAttribute(mark.name)}"/><w:bookmarkEnd w:id="${mark.id}"/>`;
          break;
        }
      }
      index += 1;
    }
    return xml;
  }

  private listNumberId(item: ListItem): number {
    let definition = this.state.lists.get(item.listId);
    if (!definition) {
      definition = { listId: item.listId, ordered: item.ordered, levels: [] };
      this.state.lists.set(item.listId, definition);
    }
    if (!definition.levels[item.level]) {
      const template = /\)\s*$/.test(item.marker) ? `%${item.level + 1})` : `%${item.level + 1}.`;
      definition.levels[item.level] = {
        format: item.ordered ? (item.format === 'bullet' ? 'decimal' : item.format) : 'bullet',
        start: item.ordered ? item.number : 1,
        text: item.ordered ? template : item.marker || BULLET_GLYPHS[item.level % BULLET_GLYPHS.length],
        ordered: item.ordered,
      };
    }
    return item.listId;
  }

  private async tableCell(
    cell: DocTableCell,
    options: { merge: 'restart' | 'continue' | null; span: number; width: number }
  ): Promise<string> {
    let props = `<w:tcW w:w="${options.width}" w:type="dxa"/>`;
    if (options.span > 1) props += `<w:gridSpan w:val="${options.span}"/>`;
    if (options.merge === 'restart') props += '<w:vMerge w:val="restart"/>';
    else if (options.merge === 'continue') props += '<w:vMerge/>';
    if (cell.shading) props += `<w:shd w:val="clear" w:color="auto" w:fill="${cell.shading}"/>`;
    const content = options.merge === 'continue' ? '' : await this.blocks(cell.blocks);
    // A table cell must end with a paragraph.
    const tail = content.endsWith('</w:p>') ? '' : '<w:p/>';
    return `<w:tc><w:tcPr>${props}</w:tcPr>${content}${tail}</w:tc>`;
  }

  private async table(block: Extract<DocBlock, { kind: 'table' }>): Promise<string> {
    const columns = Math.max(block.columnCount, 1);
    const columnWidth = Math.floor(TABLE_WIDTH_TWIPS / columns);
    const slots = tableSlots(block);
    let xml =
      '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>' +
      `<w:tblGrid>${Array.from({ length: columns }, () => `<w:gridCol w:w="${columnWidth}"/>`).join('')}</w:tblGrid>`;
    for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex += 1) {
      const row = block.rows[rowIndex];
      xml += `<w:tr>${row.header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}`;
      const line = slots[rowIndex];
      for (let column = 0; column < line.length; column += 1) {
        const slot = line[column];
        if (slot === null || slot.kind === 'colspan') continue;
        const width = columnWidth * slot.cell.colSpan;
        if (slot.kind === 'origin') {
          xml += await this.tableCell(slot.cell, { merge: slot.cell.rowSpan > 1 ? 'restart' : null, span: slot.cell.colSpan, width });
        } else {
          xml += await this.tableCell(slot.cell, { merge: 'continue', span: slot.cell.colSpan, width });
          column += slot.cell.colSpan - 1;
        }
      }
      xml += '</w:tr>';
    }
    return `${xml}</w:tbl>`;
  }

  private paragraph(styleXml: string, content: string): string {
    return `<w:p>${styleXml === '' ? '' : `<w:pPr>${styleXml}</w:pPr>`}${content}</w:p>`;
  }

  async blocks(blocks: readonly DocBlock[], inQuote = false): Promise<string> {
    let xml = '';
    const quoteStyle = inQuote ? '<w:pStyle w:val="Quote"/>' : '';
    for (const block of blocks) {
      switch (block.kind) {
        case 'heading': {
          const level = Math.min(Math.max(block.level, 1), MAX_HEADING_LEVEL);
          xml += this.paragraph(`<w:pStyle w:val="Heading${level}"/>`, await this.inlines(block.inlines));
          break;
        }
        case 'paragraph': {
          const align = block.align === 'justify' ? 'both' : block.align;
          xml += this.paragraph(`${quoteStyle}${align && align !== 'left' ? `<w:jc w:val="${align}"/>` : ''}`, await this.inlines(block.inlines));
          break;
        }
        case 'listItem': {
          const numId = this.listNumberId(block);
          const level = Math.min(block.level, MAX_LEVELS - 1);
          xml += this.paragraph(`<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`, await this.inlines(block.inlines));
          break;
        }
        case 'table':
          xml += await this.table(block);
          // Two tables never touch: Word merges adjacent tables unless a paragraph separates them.
          xml += '<w:p/>';
          break;
        case 'code':
          for (const line of block.text.split('\n')) {
            xml += this.paragraph('<w:pStyle w:val="Code"/>', this.textRuns({ kind: 'text', text: line, code: true }, false));
          }
          break;
        case 'quote':
          xml += await this.blocks(block.blocks, true);
          break;
        case 'rule':
          xml += this.paragraph('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>', '');
          break;
        case 'pageBreak':
          xml += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
          break;
        case 'sectionBreak':
          xml += this.paragraph(`<w:sectPr><w:type w:val="${SECTION_TYPE_NAMES.get(block.sectionType) ?? 'nextPage'}"/>${pageGeometry(this.page)}</w:sectPr>`, '');
          break;
      }
    }
    return xml;
  }
}

function pageGeometry(page: DocModel['page']): string {
  if (!page) {
    return `<w:pgSz w:w="${A4_WIDTH_TWIPS}" w:h="${A4_HEIGHT_TWIPS}"/><w:pgMar w:top="${DEFAULT_MARGIN_TWIPS}" w:right="${DEFAULT_MARGIN_TWIPS}" w:bottom="${DEFAULT_MARGIN_TWIPS}" w:left="${DEFAULT_MARGIN_TWIPS}" w:header="708" w:footer="708" w:gutter="0"/>`;
  }
  const twips = (points: number): number => Math.round(points * TWIPS_PER_POINT);
  const landscape = page.widthPt > page.heightPt ? ' w:orient="landscape"' : '';
  return (
    `<w:pgSz w:w="${twips(page.widthPt)}" w:h="${twips(page.heightPt)}"${landscape}/>` +
    `<w:pgMar w:top="${twips(page.marginTopPt)}" w:right="${twips(page.marginRightPt)}" w:bottom="${twips(page.marginBottomPt)}" w:left="${twips(page.marginLeftPt)}" w:header="708" w:footer="708" w:gutter="0"/>`
  );
}

function stylesXml(language: string | undefined): string {
  const base = language?.split('-')[0];
  const eastAsia = base ? EAST_ASIAN_FONTS.get(base) : undefined;
  const fonts = `<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"${eastAsia ? ` w:eastAsia="${eastAsia}"` : ''}/>`;
  const lang = language ? `<w:lang w:val="${escapeXmlAttribute(language)}"${eastAsia ? ` w:eastAsia="${escapeXmlAttribute(language)}"` : ''}/>` : '';
  const heading = (level: number, size: number): string =>
    `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="${W_NAMESPACE}">` +
    `<w:docDefaults><w:rPrDefault><w:rPr>${fonts}<w:sz w:val="22"/><w:szCs w:val="22"/>${lang}</w:rPr></w:rPrDefault>` +
    '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>' +
    '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
    '<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/></w:style>' +
    heading(1, 32) +
    heading(2, 28) +
    heading(3, 26) +
    heading(4, 24) +
    heading(5, 22) +
    heading(6, 22) +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="40"/></w:pPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720" w:right="720"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>' +
    `<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:rFonts w:ascii="${MONOSPACE_FONT}" w:hAnsi="${MONOSPACE_FONT}" w:cs="${MONOSPACE_FONT}"/><w:sz w:val="20"/></w:rPr></w:style>` +
    '<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:basedOn w:val="DefaultParagraphFont"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>' +
    '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>' +
    '</w:styles>'
  );
}

function numberingXml(state: PackageState): string {
  const definitions = [...state.lists.values()];
  const abstracts = definitions.map((definition, index) => {
    const levels = Array.from({ length: MAX_LEVELS }, (_unused, level) => {
      const given = definition.levels[level];
      const ordered = given ? given.ordered : definition.ordered;
      const format = given?.format ?? (ordered ? ORDERED_FORMATS[level % ORDERED_FORMATS.length] : 'bullet');
      const start = given?.start ?? 1;
      const text = given?.text ?? (ordered ? `%${level + 1}.` : BULLET_GLYPHS[level % BULLET_GLYPHS.length]);
      const left = LEVEL_INDENT_TWIPS * (level + 1);
      return (
        `<w:lvl w:ilvl="${level}"><w:start w:val="${start}"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${escapeXmlAttribute(text)}"/><w:lvlJc w:val="left"/>` +
        `<w:pPr><w:ind w:left="${left}" w:hanging="${LEVEL_HANGING_TWIPS}"/></w:pPr></w:lvl>`
      );
    }).join('');
    return `<w:abstractNum w:abstractNumId="${index}"><w:multiLevelType w:val="multilevel"/>${levels}</w:abstractNum>`;
  });
  const instances = definitions.map((definition, index) => `<w:num w:numId="${definition.listId}"><w:abstractNumId w:val="${index}"/></w:num>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="${W_NAMESPACE}">${abstracts.join('')}${instances.join('')}</w:numbering>`;
}

const DOCUMENT_NAMESPACES =
  `xmlns:w="${W_NAMESPACE}" xmlns:r="${R_NAMESPACE}" ` +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

function relationshipsXml(relationships: readonly Relationship[]): string {
  const items = relationships.map(
    (rel) => `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${escapeXmlAttribute(rel.target)}"${rel.external ? ' TargetMode="External"' : ''}/>`
  );
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`;
}

async function notesXml(kind: 'footnote' | 'endnote', notes: readonly DocNote[], part: PartWriter): Promise<string> {
  const plural = `${kind}s`;
  const marker = kind === 'footnote' ? 'footnoteRef' : 'endnoteRef';
  let xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:${plural} ${DOCUMENT_NAMESPACES}>` +
    `<w:${kind} w:type="separator" w:id="${FOOTNOTE_SEPARATOR_ID}"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:${kind}>` +
    `<w:${kind} w:type="continuationSeparator" w:id="${FOOTNOTE_CONTINUATION_ID}"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:${kind}>`;
  let id = 0;
  for (const note of notes) {
    id += 1;
    // The note's own number leads its first paragraph.
    const reference = `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:${marker}/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>`;
    const [first, ...rest] = note.blocks;
    let body: string;
    if (first && first.kind === 'paragraph') {
      body = `<w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>${reference}${await part.inlines(first.inlines)}</w:p>${await part.blocks(rest)}`;
    } else {
      body = `<w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>${reference}</w:p>${await part.blocks(note.blocks)}`;
    }
    xml += `<w:${kind} w:id="${id}">${body}</w:${kind}>`;
  }
  return `${xml}</w:${plural}>`;
}

/** Writes the package. Documents with more pictures than the limit are refused with a typed error. */
export async function writeDocx(model: DocModel, options: DocxWriteOptions): Promise<Buffer> {
  const language = resolveLanguage(model, options.language);
  const title = stripXmlForbidden((model.title ?? options.title).trim() || options.title);
  const state = new PackageState();

  // Notes get package-wide numbers in the order they are cited.
  const noteIds = new Map<string, number>();
  const cited: { footnote: DocNote[]; endnote: DocNote[] } = { footnote: [], endnote: [] };
  const sources = { footnote: model.footnotes, endnote: model.endnotes };
  walkBlocks(model.blocks, (block) => {
    if (block.kind !== 'heading' && block.kind !== 'paragraph' && block.kind !== 'listItem') return;
    for (const inline of block.inlines) {
      if (inline.kind !== 'noteRef') continue;
      const key = `${inline.noteKind}:${inline.id}`;
      if (noteIds.has(key)) continue;
      const note = sources[inline.noteKind].find((entry) => entry.id === inline.id);
      if (!note) continue;
      cited[inline.noteKind].push(note);
      noteIds.set(key, cited[inline.noteKind].length);
    }
  });

  const anchors = new Set<string>();
  const collectAnchors = (block: DocBlock): void => {
    if (block.kind !== 'heading' && block.kind !== 'paragraph' && block.kind !== 'listItem') return;
    for (const inline of block.inlines) if (inline.kind === 'anchor') anchors.add(inline.name);
  };
  walkBlocks(model.blocks, collectAnchors);
  for (const note of [...model.footnotes, ...model.endnotes]) walkBlocks(note.blocks, collectAnchors);

  const documentPart = new PartWriter(state, noteIds, anchors, model.page);
  const body = await documentPart.blocks(model.blocks);
  const footnotePart = new PartWriter(state, noteIds, anchors, model.page);
  const endnotePart = new PartWriter(state, noteIds, anchors, model.page);
  const hasFootnotes = cited.footnote.length > 0;
  const hasEndnotes = cited.endnote.length > 0;
  const footnotes = hasFootnotes ? await notesXml('footnote', cited.footnote, footnotePart) : '';
  const endnotes = hasEndnotes ? await notesXml('endnote', cited.endnote, endnotePart) : '';

  const documentRelationships: Relationship[] = [
    { id: 'rIdStyles', type: `${RELATIONSHIP_BASE}/styles`, target: 'styles.xml', external: false },
    { id: 'rIdNumbering', type: `${RELATIONSHIP_BASE}/numbering`, target: 'numbering.xml', external: false },
    { id: 'rIdSettings', type: `${RELATIONSHIP_BASE}/settings`, target: 'settings.xml', external: false },
    ...(hasFootnotes ? [{ id: 'rIdFootnotes', type: `${RELATIONSHIP_BASE}/footnotes`, target: 'footnotes.xml', external: false }] : []),
    ...(hasEndnotes ? [{ id: 'rIdEndnotes', type: `${RELATIONSHIP_BASE}/endnotes`, target: 'endnotes.xml', external: false }] : []),
    ...documentPart.relationships,
  ];

  const zip = new JSZip();
  const add = (name: string, data: string | Buffer): void => {
    zip.file(name, data, { createFolders: false });
  };
  const mediaTypes = new Map<string, string>();
  for (const file of state.media) mediaTypes.set(file.path.slice(file.path.lastIndexOf('.') + 1), file.mime);
  add(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      [...mediaTypes].map(([extension, mime]) => `<Default Extension="${extension}" ContentType="${mime}"/>`).join('') +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
      '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
      (hasFootnotes ? '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>' : '') +
      (hasEndnotes ? '<Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>' : '') +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '</Types>'
  );
  add(
    '_rels/.rels',
    relationshipsXml([
      { id: 'rId1', type: `${RELATIONSHIP_BASE}/officeDocument`, target: 'word/document.xml', external: false },
      { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml', external: false },
    ])
  );
  const created = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  add(
    'docProps/core.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:title>${escapeXmlText(title)}</dc:title>` +
      (model.author ? `<dc:creator>${escapeXmlText(stripXmlForbidden(model.author))}</dc:creator>` : '') +
      (language ? `<dc:language>${escapeXmlText(language)}</dc:language>` : '') +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created></cp:coreProperties>`
  );
  add('word/_rels/document.xml.rels', relationshipsXml(documentRelationships));
  add(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${DOCUMENT_NAMESPACES}><w:body>${body}<w:sectPr>${pageGeometry(model.page)}</w:sectPr></w:body></w:document>`
  );
  add('word/styles.xml', stylesXml(language));
  add('word/numbering.xml', numberingXml(state));
  add(
    'word/settings.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:settings xmlns:w="${W_NAMESPACE}"><w:defaultTabStop w:val="720"/>` +
      `<w:footnotePr><w:footnote w:id="${FOOTNOTE_SEPARATOR_ID}"/><w:footnote w:id="${FOOTNOTE_CONTINUATION_ID}"/></w:footnotePr>` +
      `<w:endnotePr><w:endnote w:id="${FOOTNOTE_SEPARATOR_ID}"/><w:endnote w:id="${FOOTNOTE_CONTINUATION_ID}"/></w:endnotePr></w:settings>`
  );
  if (hasFootnotes) {
    add('word/footnotes.xml', footnotes);
    if (footnotePart.relationships.length > 0) add('word/_rels/footnotes.xml.rels', relationshipsXml(footnotePart.relationships));
  }
  if (hasEndnotes) {
    add('word/endnotes.xml', endnotes);
    if (endnotePart.relationships.length > 0) add('word/_rels/endnotes.xml.rels', relationshipsXml(endnotePart.relationships));
  }
  for (const file of state.media) add(file.path, file.data);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
