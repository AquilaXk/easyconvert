import JSZip from 'jszip';
import { escapeXmlText } from './xml-text';
import type {
  Block,
  DocumentImage,
  DocumentModel,
  HeadingBlock,
  Inline,
  ListBlock,
  ListLevelFormat,
  ParagraphBlock,
  Section,
  TableBlock,
  TableCellBlock,
} from './model';

/**
 * DOCX (ECMA-376 Part 1, WordprocessingML) from a structured document: headings use the Heading1 to Heading4 styles
 * (`w:pStyle`), lists use `numbering.xml` abstract and concrete numbering (section 17.9), tables are `w:tbl` with
 * `gridSpan` and `vMerge`, columns are `w:cols` of the section properties (section 17.6.4), and images are
 * `w:drawing` inline pictures whose bytes are the files in `word/media`.
 */

const TWIPS_PER_POINT = 20;
const EMU_PER_POINT = 12_700;
const HALF_POINTS = 2;
const DEFAULT_COLUMN_GAP_TWIPS = 720;
const HEADING_LEVELS = 4;
const LIST_LEVELS = 9;
const LIST_INDENT_TWIPS = 720;
const LIST_HANGING_TWIPS = 360;
const MIN_TABLE_COLUMN_TWIPS = 240;
/** Body size scale for a heading level whose size the PDF did not provide (level 1 first). */
const DEFAULT_HEADING_SCALE = [1.6, 1.35, 1.2, 1.1];
const BULLET_CYCLE = ['•', '◦', '▪'];
const FONT_BY_FAMILY: Record<DocumentModel['bodyFont'], string> = {
  serif: 'Times New Roman',
  sans: 'Arial',
  monospace: 'Courier New',
};
const MONOSPACE_FONT = 'Courier New';
const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const RTL_LETTER = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const LINE_OR_TAB = /[\n\t]/;

const twips = (points: number): number => Math.round(points * TWIPS_PER_POINT);
const attr = (value: string | number): string => escapeXmlText(String(value));

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

function runXml(run: Inline, size: number | undefined): string {
  if (run.text === '') return '';
  const props: string[] = [];
  if (run.monospace) props.push(`<w:rFonts w:ascii="${MONOSPACE_FONT}" w:hAnsi="${MONOSPACE_FONT}" w:cs="${MONOSPACE_FONT}"/>`);
  if (run.bold) props.push('<w:b/><w:bCs/>');
  if (run.italic) props.push('<w:i/><w:iCs/>');
  if (size !== undefined) props.push(`<w:sz w:val="${Math.round(size * HALF_POINTS)}"/><w:szCs w:val="${Math.round(size * HALF_POINTS)}"/>`);
  if (RTL_LETTER.test(run.text)) props.push('<w:rtl/>');
  return `<w:r>${props.length > 0 ? `<w:rPr>${props.join('')}</w:rPr>` : ''}${textElements(run.text)}</w:r>`;
}

function runsXml(runs: Inline[], size?: number): string {
  return runs.map((run) => runXml(run, size)).join('');
}

interface ParagraphProperties {
  style?: string;
  numbering?: { level: number; id: number };
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
  if (props.rtl) xml += '<w:bidi/>';
  if (props.align && props.align !== 'left') xml += `<w:jc w:val="${JUSTIFICATION[props.align]}"/>`;
  if (props.sectPr) xml += props.sectPr;
  return xml === '' ? '' : `<w:pPr>${xml}</w:pPr>`;
}

function paragraphXml(runs: Inline[], props: ParagraphProperties, size?: number): string {
  return `<w:p>${paragraphProperties(props)}${runsXml(runs, size)}</w:p>`;
}

// ---------------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------------

function cellXml(cell: TableCellBlock, widthTwips: number, rowSpanContinues: boolean): string {
  let props = `<w:tcW w:w="${widthTwips}" w:type="dxa"/>`;
  if (cell.colSpan > 1) props += `<w:gridSpan w:val="${cell.colSpan}"/>`;
  if (cell.continuation) props += '<w:vMerge/>';
  else if (rowSpanContinues) props += '<w:vMerge w:val="restart"/>';
  let content = '';
  if (!cell.continuation) {
    for (const paragraph of cell.paragraphs) {
      const runs = cell.header ? paragraph.runs.map((run) => ({ ...run, bold: true })) : paragraph.runs;
      content += paragraphXml(runs, { rtl: paragraph.rtl, align: paragraph.align }, paragraph.size);
    }
  }
  // A cell must hold at least one paragraph.
  if (content === '') content = '<w:p/>';
  return `<w:tc><w:tcPr>${props}</w:tcPr>${content}</w:tc>`;
}

const TABLE_BORDERS = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
  .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`)
  .join('');

function tableXml(table: TableBlock, availableTwips: number): string {
  const columns = table.columnWidths.length;
  let widths = table.columnWidths.map((width) => Math.max(MIN_TABLE_COLUMN_TWIPS, twips(width)));
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (total > availableTwips && availableTwips > 0) widths = widths.map((width) => Math.max(MIN_TABLE_COLUMN_TWIPS, Math.floor((width * availableTwips) / total)));
  const grid = widths.map((width) => `<w:gridCol w:w="${width}"/>`).join('');
  const rows = table.rows
    .map((row, rowIndex) => {
      let column = 0;
      const cells = row
        .map((cell) => {
          const span = Math.min(cell.colSpan, Math.max(1, columns - column));
          const width = widths.slice(column, column + span).reduce((sum, value) => sum + value, 0);
          column += span;
          return cellXml({ ...cell, colSpan: span }, width, cell.rowSpan > 1);
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
          `<w:lvl w:ilvl="${level}"><w:start w:val="${start}"/><w:numFmt w:val="${NUMBER_FORMATS[format.kind]}"/>` +
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
// Images
// ---------------------------------------------------------------------------------------------

interface ImagePart {
  image: DocumentImage;
  relationshipId: string;
  path: string;
}

function imageXml(part: ImagePart, widthPt: number, heightPt: number, drawingId: number): string {
  const cx = Math.max(1, Math.round(widthPt * EMU_PER_POINT));
  const cy = Math.max(1, Math.round(heightPt * EMU_PER_POINT));
  const name = `Picture ${drawingId}`;
  return (
    '<w:p><w:r><w:drawing>' +
    `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${drawingId}" name="${name}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic><a:graphicData uri="${NS_PIC}"><pic:pic><pic:nvPicPr><pic:cNvPr id="${drawingId}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${part.relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
  );
}

// ---------------------------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------------------------

const HEADER_RELATIONSHIP_ID = 'rIdHeader1';
const FOOTER_RELATIONSHIP_ID = 'rIdFooter1';

/** References to the running header and footer parts; they come first in a section's properties. */
function furnitureReferences(model: DocumentModel): string {
  const header = model.pageHeader && model.pageHeader.length > 0 ? `<w:headerReference w:type="default" r:id="${HEADER_RELATIONSHIP_ID}"/>` : '';
  const footer = model.pageFooter && model.pageFooter.length > 0 ? `<w:footerReference w:type="default" r:id="${FOOTER_RELATIONSHIP_ID}"/>` : '';
  return header + footer;
}

/** A header (`w:hdr`) or footer (`w:ftr`) part holding one paragraph per running line. */
function furniturePartXml(tag: 'hdr' | 'ftr', lines: Inline[][]): string {
  return `${XML_HEADER}<w:${tag} xmlns:w="${NS_W}" xmlns:r="${NS_R}">${lines.map((runs) => paragraphXml(runs, {})).join('')}</w:${tag}>`;
}

function sectionProperties(model: DocumentModel, section: Section, first: boolean): string {
  const width = twips(model.pageWidthPt);
  const height = twips(model.pageHeightPt);
  const { margins } = model;
  const orient = width > height ? ' w:orient="landscape"' : '';
  const columns = section.columns > 1 ? `<w:cols w:num="${section.columns}" w:space="${DEFAULT_COLUMN_GAP_TWIPS}"/>` : '<w:cols w:space="720"/>';
  return (
    `<w:sectPr>${furnitureReferences(model)}${first ? '' : '<w:type w:val="continuous"/>'}<w:pgSz w:w="${width}" w:h="${height}"${orient}/>` +
    `<w:pgMar w:top="${twips(margins.top)}" w:right="${twips(margins.right)}" w:bottom="${twips(margins.bottom)}" w:left="${twips(margins.left)}" w:header="720" w:footer="720" w:gutter="0"/>` +
    `${columns}</w:sectPr>`
  );
}

interface BlockXml {
  /** XML of the block; a paragraph-like block takes the section properties that end its section. */
  render(sectPr?: string): string;
  /** The block can carry section properties in its own paragraph. */
  carriesSection: boolean;
}

function listItemBlocks(list: ListBlock): BlockXml[] {
  return list.items.map((item) => ({
    carriesSection: true,
    render: (sectPr?: string) =>
      paragraphXml(item.runs, { style: 'ListParagraph', numbering: { level: item.level, id: list.id }, rtl: item.rtl, sectPr }),
  }));
}

function blockXml(block: Block, imageParts: Map<number, ImagePart>, availableTwips: number, drawingIds: { next: number }): BlockXml[] {
  switch (block.type) {
    case 'heading': {
      const heading: HeadingBlock = block;
      return [
        {
          carriesSection: true,
          render: (sectPr?: string) => paragraphXml(heading.runs, { style: `Heading${Math.min(heading.level, HEADING_LEVELS)}`, rtl: heading.rtl, sectPr }),
        },
      ];
    }
    case 'paragraph':
      return [
        {
          carriesSection: true,
          render: (sectPr?: string) => paragraphXml(block.runs, { rtl: block.rtl, align: block.align, sectPr }, block.size),
        },
      ];
    case 'list':
      return listItemBlocks(block);
    case 'table':
      return [{ carriesSection: false, render: () => tableXml(block, availableTwips) }];
    case 'image': {
      const part = imageParts.get(block.imageId);
      if (!part) return [];
      return [{ carriesSection: false, render: () => imageXml(part, block.widthPt, block.heightPt, drawingIds.next++) }];
    }
    default:
      return [];
  }
}

function stylesXml(model: DocumentModel): string {
  const font = FONT_BY_FAMILY[model.bodyFont];
  const size = Math.round(model.bodySize * HALF_POINTS);
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
    `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:lang w:val="en-US" w:eastAsia="zh-CN" w:bidi="ar-SA"/>` +
    '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    headings +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:spacing w:after="40"/><w:contextualSpacing/></w:pPr></w:style>' +
    '</w:styles>'
  );
}

function contentTypesXml(hasNumbering: boolean, formats: Set<string>, hasHeader = false, hasFooter = false): string {
  const defaults = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    ...(formats.has('jpeg') ? ['<Default Extension="jpeg" ContentType="image/jpeg"/>'] : []),
    ...(formats.has('png') ? ['<Default Extension="png" ContentType="image/png"/>'] : []),
  ];
  const overrides = [
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    ...(hasNumbering ? ['<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'] : []),
    ...(hasHeader ? ['<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>'] : []),
    ...(hasFooter ? ['<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'] : []),
  ];
  return `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults.join('')}${overrides.join('')}</Types>`;
}

const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/**
 * Writes the document as a DOCX package.
 * @throws InvalidXmlCharacterError when text holds a character XML 1.0 does not allow.
 */
export async function documentToDocx(model: DocumentModel): Promise<Buffer> {
  const lists = model.sections.flatMap((section) => section.blocks.filter((block): block is ListBlock => block.type === 'list'));
  const imageParts = new Map<number, ImagePart>();
  const formats = new Set<string>();
  model.images.forEach((image, index) => {
    const extension = image.format === 'jpeg' ? 'jpeg' : 'png';
    formats.add(extension);
    imageParts.set(image.id, { image, relationshipId: `rIdImage${index + 1}`, path: `media/image${index + 1}.${extension}` });
  });

  const availableTwips = twips(model.pageWidthPt - model.margins.left - model.margins.right);
  const drawingIds = { next: 1 };
  const bodyParts: string[] = [];
  model.sections.forEach((section, sectionIndex) => {
    const last = sectionIndex === model.sections.length - 1;
    const blocks = section.blocks.flatMap((block) => blockXml(block, imageParts, availableTwips, drawingIds));
    blocks.forEach((block, blockIndex) => {
      const endsSection = !last && blockIndex === blocks.length - 1;
      if (!endsSection) {
        bodyParts.push(block.render());
      } else if (block.carriesSection) {
        bodyParts.push(block.render(sectionProperties(model, section, sectionIndex === 0)));
      } else {
        bodyParts.push(block.render(), `<w:p><w:pPr>${sectionProperties(model, section, sectionIndex === 0)}</w:pPr></w:p>`);
      }
    });
    if (blocks.length === 0 && !last) bodyParts.push(`<w:p><w:pPr>${sectionProperties(model, section, sectionIndex === 0)}</w:pPr></w:p>`);
  });
  // A body ends with a paragraph or a section break; an empty document still needs one paragraph.
  if (bodyParts.length === 0) bodyParts.push('<w:p/>');
  const finalSection = model.sections[model.sections.length - 1] ?? { columns: 1, blocks: [] };
  const document =
    `${XML_HEADER}<w:document xmlns:w="${NS_W}" xmlns:r="${NS_R}" xmlns:wp="${NS_WP}" xmlns:a="${NS_A}" xmlns:pic="${NS_PIC}">` +
    `<w:body>${bodyParts.join('')}${sectionProperties(model, finalSection, model.sections.length <= 1)}</w:body></w:document>`;

  const hasHeader = Boolean(model.pageHeader && model.pageHeader.length > 0);
  const hasFooter = Boolean(model.pageFooter && model.pageFooter.length > 0);
  const relationships = [
    `<Relationship Id="rIdStyles" Type="${REL_BASE}/styles" Target="styles.xml"/>`,
    ...(lists.length > 0 ? [`<Relationship Id="rIdNumbering" Type="${REL_BASE}/numbering" Target="numbering.xml"/>`] : []),
    ...[...imageParts.values()].map((part) => `<Relationship Id="${part.relationshipId}" Type="${REL_BASE}/image" Target="${part.path}"/>`),
    ...(hasHeader ? [`<Relationship Id="${HEADER_RELATIONSHIP_ID}" Type="${REL_BASE}/header" Target="header1.xml"/>`] : []),
    ...(hasFooter ? [`<Relationship Id="${FOOTER_RELATIONSHIP_ID}" Type="${REL_BASE}/footer" Target="footer1.xml"/>`] : []),
  ];

  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypesXml(lists.length > 0, formats, hasHeader, hasFooter));
  zip.file(
    '_rels/.rels',
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_BASE}/officeDocument" Target="word/document.xml"/></Relationships>`
  );
  zip.file('word/document.xml', document);
  zip.file('word/styles.xml', stylesXml(model));
  if (lists.length > 0) zip.file('word/numbering.xml', numberingXml(lists));
  if (hasHeader && model.pageHeader) zip.file('word/header1.xml', furniturePartXml('hdr', model.pageHeader));
  if (hasFooter && model.pageFooter) zip.file('word/footer1.xml', furniturePartXml('ftr', model.pageFooter));
  zip.file('word/_rels/document.xml.rels', `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join('')}</Relationships>`);
  for (const part of imageParts.values()) zip.file(`word/${part.path}`, part.image.data);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
