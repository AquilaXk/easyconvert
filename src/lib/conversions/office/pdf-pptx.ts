import JSZip from 'jszip';
import { ConversionFailedError, type ConversionOptions } from '../../types';
import { escapeXmlText } from '../document-model/xml-text';
import { layoutPdfPages, type PageBlock } from '../pdf-layout';
import type { DetectedTable, LayoutLine, Paragraph, StyledRun, TableCell } from '../pdf-layout/types';
import { dominantRuleInk, ruleInside, UNIFORM_RULE_SHARE } from '../pdf-layout/ink';
import { readPdfContentForOffice } from '../pdf-office';
import type { PdfContentFont, PdfContentImage, PdfContentRule, PdfContentShape } from '../pdf-text-types';
import { shapeProperties } from '../document-model/shape-xml';
import { hexOf } from '../pdf-content-colours';

/**
 * A presentation from a PDF that keeps the pages: one slide for each page, as large as the page, with every line of text where the page
 * sets it (one text box for a line, so a renderer that breaks lines differently cannot move a word), every table of the layout analysis
 * as a table of the slide, every picture at its place and the rules of the page as lines. The package is the minimal valid one of
 * ECMA-376 Part 1 (presentation, one master, one blank layout, a theme, slides), so PowerPoint opens it without a repair.
 *
 * The colour of text and rules is the page's, and its filled rectangles and outlines of lines and curves are shapes, all in the order
 * the page paints them under the text. What stays out is the clipping of pictures and shapes, gradients and patterns, dashes and
 * shadows. A page read by OCR has no geometry: its text is one text box on its slide.
 */

const EMU_PER_POINT = 12_700;
/** The sizes PowerPoint accepts for a slide (ECMA-376 `ST_SlideSizeCoordinate`: 1 inch to 56 inches). */
const MIN_SLIDE_EMU = 914_400;
const MAX_SLIDE_EMU = 51_206_400;
const LETTER_WIDTH_PT = 612;
const LETTER_HEIGHT_PT = 792;
/** Text sizes in hundredths of a point that DrawingML allows (`ST_TextFontSize`: 1 to 4,000 points). */
const MIN_FONT_HUNDREDTHS = 100;
const MAX_FONT_HUNDREDTHS = 400_000;
/** The first line of a text box sits one ascent below its top; the share of the em that three font families use. */
const ASCENT_EM = { sans: 0.905, serif: 0.891, monospace: 0.833 } as const;
const LINE_HEIGHT_EM = 1.2;
/** Rules thicker than this (points) are drawn as filled rectangles, which is what a bar of that width is. */
const MAX_RULE_THICKNESS_PT = 3;
/** A line rule is a hairline at least as thick as this (EMU). */
const MIN_RULE_EMU = 3_175;
const TABLE_CELL_MARGIN_EMU = 22_860;
/** A ruled table's border when the page's rules give none: half a point, black. */
const DEFAULT_BORDER: TableBorder = { width: 6_350, color: '000000' };
/** The text box of an OCR page: its margin and the size of its text (points). */
const OCR_MARGIN_PT = 36;
const OCR_TEXT_SIZE_PT = 12;

type Family = keyof typeof ASCENT_EM;

/** The `pitchFamily` of a family (ECMA-376 21.1.2.3.7): the class PowerPoint falls back to when the named typeface is not installed. */
const PITCH_FAMILY: Readonly<Record<Family, number>> = { sans: 34, serif: 18, monospace: 49 };

/** Typefaces the PDF names by their PostScript names, with the name Office knows them by; the first match of the name without spaces and punctuation wins. */
const OFFICE_TYPEFACES: readonly (readonly [string, string])[] = [
  ['timesnewroman', 'Times New Roman'],
  ['times', 'Times New Roman'],
  ['arial', 'Arial'],
  ['helvetica', 'Arial'],
  ['couriernew', 'Courier New'],
  ['courier', 'Courier New'],
  ['calibri', 'Calibri'],
  ['cambria', 'Cambria'],
  ['verdana', 'Verdana'],
  ['tahoma', 'Tahoma'],
  ['georgia', 'Georgia'],
  ['consolas', 'Consolas'],
  ['trebuchet', 'Trebuchet MS'],
  ['segoeui', 'Segoe UI'],
  ['palatino', 'Palatino Linotype'],
  ['garamond', 'Garamond'],
];
/** What follows the family in a PostScript name: the style (`-Bold`, `,Italic`) and the Windows suffix (`PSMT`, `MT`). */
const FONT_NAME_STYLE = /[-,].*$|(PS)?MT$/;

/** The typeface a font is written as: Office's name for a common family, else the PDF's own name without its style. */
function typefaceOf(font: PdfContentFont | undefined, family: Family): string {
  if (font === undefined) return GENERIC_TYPEFACE[family];
  const base = font.name.replace(FONT_NAME_STYLE, '');
  const squeezed = base.toLowerCase().replace(/[^a-z]/g, '');
  return OFFICE_TYPEFACES.find(([prefix]) => squeezed.startsWith(prefix))?.[1] ?? (base === '' ? GENERIC_TYPEFACE[family] : base);
}

const GENERIC_TYPEFACE: Readonly<Record<Family, string>> = { sans: 'Arial', serif: 'Times New Roman', monospace: 'Courier New' };

const NAMESPACES =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const EMPTY_GROUP =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

/** A page as the writer places it: its size and what stands on it, in page points with the origin at the top left. */
interface SlidePage {
  width: number;
  height: number;
  images: PdfContentImage[];
  rules: PdfContentRule[];
  shapes: PdfContentShape[];
  blocks: PageBlock[];
  /** The text of a page that has no geometry (read by OCR). */
  plainText?: string;
}

interface Placement {
  scale: number;
  offsetX: number;
  offsetY: number;
}

const emu = (points: number): number => Math.round(points * EMU_PER_POINT);

/** Names of typefaces that are serif though a font descriptor that leaves out the Serif flag does not say so (DejaVu Serif, Times, Georgia). */
const SERIF_NAME = /^(?!.*sans)(?=.*(serif|times|georgia|garamond|palatino|cambria|minion|bookman|century|roman))/i;

/** The typeface a run is set in and the class it falls back to. */
interface Face {
  typeface: string;
  family: Family;
}

function faceOf(font: PdfContentFont | undefined, monospace: boolean): Face {
  let family: Family = 'sans';
  if (monospace || font?.monospace) family = 'monospace';
  else if (font?.serif || (font !== undefined && SERIF_NAME.test(font.name))) family = 'serif';
  return { typeface: typefaceOf(font, family), family };
}

/** The slide size in EMU: the size of the first page, kept inside what PowerPoint accepts. */
function slideSizeOf(page: { width: number; height: number }): { cx: number; cy: number } {
  const grow = Math.max(MIN_SLIDE_EMU / emu(page.width), MIN_SLIDE_EMU / emu(page.height), 1);
  const shrink = Math.min(MAX_SLIDE_EMU / emu(page.width), MAX_SLIDE_EMU / emu(page.height), 1);
  const factor = grow > 1 ? grow : shrink;
  return { cx: Math.round(emu(page.width) * factor), cy: Math.round(emu(page.height) * factor) };
}

/** Maps a page onto the slide: the uniform scale that fits it, centred. A page of the slide's own size maps to itself. */
function placementOf(page: { width: number; height: number }, slide: { cx: number; cy: number }): Placement {
  const scale = Math.min(slide.cx / emu(page.width), slide.cy / emu(page.height));
  return { scale, offsetX: (slide.cx / EMU_PER_POINT - page.width * scale) / 2, offsetY: (slide.cy / EMU_PER_POINT - page.height * scale) / 2 };
}

class SlideXml {
  private readonly shapes: string[] = [];
  private nextId = 2;

  constructor(
    private readonly placement: Placement,
    private readonly mediaRelation: (image: PdfContentImage) => string | null
  ) {}

  x(points: number): number {
    return emu(points * this.placement.scale + this.placement.offsetX);
  }

  y(points: number): number {
    return emu(points * this.placement.scale + this.placement.offsetY);
  }

  length(points: number): number {
    return Math.max(0, emu(points * this.placement.scale));
  }

  private id(): number {
    return this.nextId++;
  }

  picture(image: PdfContentImage): void {
    const relation = this.mediaRelation(image);
    if (relation === null) return;
    const id = this.id();
    this.shapes.push(
      `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}" descr=""/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
        `<p:blipFill><a:blip r:embed="${relation}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
        `<p:spPr><a:xfrm><a:off x="${this.x(image.x)}" y="${this.y(image.y)}"/><a:ext cx="${this.length(image.width)}" cy="${this.length(image.height)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
    );
  }

  rule(rule: PdfContentRule): void {
    const width = this.length(rule.x1 - rule.x0);
    const height = this.length(rule.y1 - rule.y0);
    const horizontal = width >= height;
    const id = this.id();
    const thickness = Math.max(MIN_RULE_EMU, this.length(rule.thickness));
    const offX = this.x(rule.x0);
    const offY = this.y(rule.y0);
    const extent = horizontal ? `<a:off x="${offX}" y="${offY}"/><a:ext cx="${width}" cy="0"/>` : `<a:off x="${offX}" y="${offY}"/><a:ext cx="0" cy="${height}"/>`;
    this.shapes.push(
      `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="Line ${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm>${extent}</a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom>` +
        `<a:ln w="${thickness}"><a:solidFill><a:srgbClr val="${hexOf(rule.color ?? 0)}"/></a:solidFill></a:ln></p:spPr></p:cxnSp>`
    );
  }

  /** A filled rectangle, or an outline of lines and curves, with its fill and stroke. */
  shape(shape: PdfContentShape): void {
    const id = this.id();
    this.shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>${shapeProperties(shape, this)}</p:sp>`);
  }

  /** The text box of one line, at the place the line's baseline gives. */
  line(line: LayoutLine, fonts: ReadonlyMap<string, PdfContentFont>): void {
    if (line.text.trim() === '') return;
    const face = faceOf(fonts.get(line.fontKey), line.monospace);
    const size = line.size * this.placement.scale;
    const box = line.vertical && line.pageBox ? line.pageBox : line.box;
    const width = this.length(box.x1 - box.x0) * 1.02;
    const id = this.id();
    const top = line.vertical ? box.y0 : line.baseline - ASCENT_EM[face.family] * line.size;
    const height = line.vertical ? box.y1 - box.y0 : line.size * LINE_HEIGHT_EM;
    const left = line.rtl ? this.x(box.x1) - Math.round(width) : this.x(box.x0);
    this.shapes.push(
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr><a:xfrm><a:off x="${left}" y="${this.y(top)}"/><a:ext cx="${Math.round(width)}" cy="${this.length(height)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
        `<p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="${line.rtl ? 1 : 0}" anchor="t"${line.vertical ? ' vert="eaVert"' : ''}><a:noAutofit/></a:bodyPr><a:lstStyle/>` +
        `${paragraphXml(line.runs, size, face, line.rtl)}</p:txBody></p:sp>`
    );
  }

  /** A block of text with no geometry (a page read by OCR): the text of the page, one paragraph for each line. */
  plainText(text: string, page: { width: number; height: number }): void {
    const id = this.id();
    const size = OCR_TEXT_SIZE_PT * this.placement.scale;
    const paragraphs = text
      .split(/\r?\n/)
      .map((row) => paragraphXml([{ text: row, bold: false, italic: false, monospace: false }], size, faceOf(undefined, false), false))
      .join('');
    this.shapes.push(
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr><a:xfrm><a:off x="${this.x(OCR_MARGIN_PT)}" y="${this.y(OCR_MARGIN_PT)}"/><a:ext cx="${this.length(page.width - 2 * OCR_MARGIN_PT)}" cy="${this.length(page.height - 2 * OCR_MARGIN_PT)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
        `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="t"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
    );
  }

  table(table: DetectedTable, fonts: ReadonlyMap<string, PdfContentFont>, border: TableBorder): void {
    const id = this.id();
    const grid = table.columnWidths.map((width) => `<a:gridCol w="${this.length(width)}"/>`).join('');
    const rowTops = table.rows.map((row) => rowTopOf(row, table.box.y0));
    const rows = table.rows.map((row, index) => {
      const bottom = index + 1 < rowTops.length ? rowTops[index + 1] : table.box.y1;
      const cells = row.map((cell) => this.cell(cell, table.kind === 'lattice' ? border : null, fonts)).join('');
      return `<a:tr h="${this.length(Math.max(bottom - rowTops[index], 1))}">${cells}</a:tr>`;
    });
    const width = table.columnWidths.reduce((sum, value) => sum + value, 0);
    this.shapes.push(
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
        `<p:xfrm><a:off x="${this.x(table.box.x0)}" y="${this.y(table.box.y0)}"/><a:ext cx="${this.length(width)}" cy="${this.length(table.box.y1 - table.box.y0)}"/></p:xfrm>` +
        `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="0" bandRow="0"/><a:tblGrid>${grid}</a:tblGrid>${rows.join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
    );
  }

  private cell(cell: TableCell, border: TableBorder | null, fonts: ReadonlyMap<string, PdfContentFont>): string {
    const attributes = (cell.colSpan > 1 ? ` gridSpan="${cell.colSpan}"` : '') + rowMergeOf(cell);
    const text = cell.paragraphs.length > 0 ? cell.paragraphs.map((paragraph) => this.cellParagraph(paragraph, fonts)).join('') : '<a:p><a:endParaRPr lang="en-US"/></a:p>';
    const edge = (tag: string): string =>
      border ? `<a:${tag} w="${border.width}"><a:solidFill><a:srgbClr val="${border.color}"/></a:solidFill></a:${tag}>` : `<a:${tag} w="0"><a:noFill/></a:${tag}>`;
    const margins = `marL="${TABLE_CELL_MARGIN_EMU}" marR="${TABLE_CELL_MARGIN_EMU}" marT="${TABLE_CELL_MARGIN_EMU}" marB="${TABLE_CELL_MARGIN_EMU}" anchor="t"`;
    const cells = [`<a:tc${attributes}><a:txBody><a:bodyPr/><a:lstStyle/>${text}</a:txBody><a:tcPr ${margins}>${edge('lnL')}${edge('lnR')}${edge('lnT')}${edge('lnB')}<a:noFill/></a:tcPr></a:tc>`];
    // A cell that spans columns is followed by the grid slots it covers.
    for (let covered = 1; covered < cell.colSpan; covered++) cells.push(`<a:tc hMerge="1"><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></a:txBody><a:tcPr/></a:tc>`);
    return cells.join('');
  }

  private cellParagraph(paragraph: Paragraph, fonts: ReadonlyMap<string, PdfContentFont>): string {
    return paragraphXml(paragraph.runs, paragraph.size * this.placement.scale, faceOf(fonts.get(paragraph.fontKey), paragraph.monospace), paragraph.rtl);
  }

  toXml(): string {
    return (
      `${XML_DECLARATION}<p:sld ${NAMESPACES}><p:cSld><p:spTree>${EMPTY_GROUP}${this.shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
    );
  }
}

/** The line the borders of a ruled table are drawn with: width in EMU and colour as six hex digits. */
interface TableBorder {
  width: number;
  color: string;
}

/**
 * Whether the table is one grid in one colour. A page that boxes its text in several colours (a diagram of labelled boxes) has
 * rules the layout analysis reads as a table, but the slide's table has one border colour, so its text stays in text boxes and its
 * rules stay lines.
 */
function isUniformlyRuled(table: DetectedTable, rules: readonly PdfContentRule[]): boolean {
  const ink = dominantRuleInk(rules, table.box);
  return table.kind !== 'lattice' || ink === null || ink.share >= UNIFORM_RULE_SHARE;
}

/** The border of a table: the colour and median width of the rules that lie inside its box, so a table ruled in grey stays grey. */
function borderOf(table: DetectedTable, rules: readonly PdfContentRule[]): TableBorder {
  const ink = dominantRuleInk(rules, table.box);
  return ink === null ? DEFAULT_BORDER : { width: Math.max(emu(ink.width), MIN_RULE_EMU), color: hexOf(ink.color) };
}

/** A rule thicker than a hairline as the filled rectangle it is: the line's length by its width, centred on the line. */
function barOf(rule: PdfContentRule): PdfContentShape {
  const half = rule.thickness / 2;
  const horizontal = rule.x1 - rule.x0 >= rule.y1 - rule.y0;
  return {
    kind: 'rect',
    x0: horizontal ? rule.x0 : rule.x0 - half,
    x1: horizontal ? rule.x1 : rule.x1 + half,
    y0: horizontal ? rule.y0 - half : rule.y0,
    y1: horizontal ? rule.y1 + half : rule.y1,
    fill: rule.color ?? 0,
    z: rule.z ?? -1,
  };
}

/** The lines of text of a table's cells, each at the place the page sets it. */
function linesOfTable(table: DetectedTable): LayoutLine[] {
  return table.rows.flatMap((row) => row.flatMap((cell) => cell.paragraphs.flatMap((paragraph) => paragraph.lines)));
}

/** The attribute that merges a cell with those below it (`vMerge` marks a slot a cell above covers). */
function rowMergeOf(cell: TableCell): string {
  if (cell.continuation) return ' vMerge="1"';
  return cell.rowSpan > 1 ? ` rowSpan="${cell.rowSpan}"` : '';
}

/** The top of a table row: the highest line of its cells, or the table's top for a row of empty cells. */
function rowTopOf(row: TableCell[], fallback: number): number {
  const tops = row.flatMap((cell) => cell.paragraphs.flatMap((paragraph) => paragraph.lines.map((line) => line.box.y0)));
  return tops.length === 0 ? fallback : Math.min(...tops);
}

function runXml(run: StyledRun, sizeHundredths: number, face: Face): string {
  const { typeface, family } = run.monospace && face.family !== 'monospace' ? faceOf(undefined, true) : face;
  const font = `typeface="${escapeXmlText(typeface)}" pitchFamily="${PITCH_FAMILY[family]}"`;
  return (
    `<a:r><a:rPr lang="en-US" sz="${sizeHundredths}"${run.bold ? ' b="1"' : ''}${run.italic ? ' i="1"' : ''} dirty="0">` +
    `<a:solidFill><a:srgbClr val="${run.color ?? '000000'}"/></a:solidFill><a:latin ${font}/><a:cs ${font}/></a:rPr><a:t>${escapeXmlText(run.text)}</a:t></a:r>`
  );
}

function paragraphXml(runs: readonly StyledRun[], sizePoints: number, face: Face, rtl: boolean): string {
  const size = Math.min(MAX_FONT_HUNDREDTHS, Math.max(MIN_FONT_HUNDREDTHS, Math.round(sizePoints * 100)));
  const body = runs.filter((run) => run.text !== '').map((run) => runXml(run, size, face)).join('');
  return `<a:p><a:pPr algn="${rtl ? 'r' : 'l'}" rtl="${rtl ? 1 : 0}"/>${body}<a:endParaRPr lang="en-US" sz="${size}"/></a:p>`;
}

const THEME_COLOURS =
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>';
const SOLID_PLACEHOLDER = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
const LINE_STYLE = `<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr">${SOLID_PLACEHOLDER}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
const EFFECT_STYLE = '<a:effectStyle><a:effectLst/></a:effectStyle>';

const THEME_XML =
  `${XML_DECLARATION}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements>` +
  `<a:clrScheme name="Office">${THEME_COLOURS}</a:clrScheme>` +
  '<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
  `<a:fmtScheme name="Office"><a:fillStyleLst>${SOLID_PLACEHOLDER.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${LINE_STYLE.repeat(3)}</a:lnStyleLst>` +
  `<a:effectStyleLst>${EFFECT_STYLE.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${SOLID_PLACEHOLDER.repeat(3)}</a:bgFillStyleLst></a:fmtScheme>` +
  '</a:themeElements></a:theme>';

const MASTER_XML =
  `${XML_DECLARATION}<p:sldMaster ${NAMESPACES}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${EMPTY_GROUP}</p:spTree></p:cSld>` +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
  '<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:otherStyle></p:txStyles></p:sldMaster>';

const LAYOUT_XML =
  `${XML_DECLARATION}<p:sldLayout ${NAMESPACES} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${EMPTY_GROUP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

function relationships(entries: readonly { id: string; type: string; target: string }[]): string {
  const items = entries.map((entry) => `<Relationship Id="${entry.id}" Type="${REL_TYPE}/${entry.type}" Target="${entry.target}"/>`).join('');
  return `${XML_DECLARATION}<Relationships xmlns="${REL_NAMESPACE}">${items}</Relationships>`;
}

const MEDIA_TYPES = { jpeg: { extension: 'jpeg', mime: 'image/jpeg' }, png: { extension: 'png', mime: 'image/png' } } as const;

/** Writes the presentation of the pages. */
async function writePackage(pages: readonly SlidePage[], fonts: ReadonlyMap<string, PdfContentFont>, title: string): Promise<Buffer> {
  if (pages.length === 0) throw new ConversionFailedError('The PDF has no pages to put on slides.');
  const slide = slideSizeOf(pages[0]);
  const zip = new JSZip();
  // A picture the pages place more than once is one file of the package.
  const mediaOf = new Map<Uint8Array, { name: string; mime: string }>();
  const mediaNames: string[] = [];

  const slideEntries: string[] = [];
  pages.forEach((page, index) => {
    const number = index + 1;
    const relations: { id: string; type: string; target: string }[] = [{ id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' }];
    const relationOf = new Map<Uint8Array, string>();
    const slideXml = new SlideXml(placementOf(page, slide), (image) => {
      if (!image.data || !image.format) return null;
      const known = relationOf.get(image.data);
      if (known) return known;
      let media = mediaOf.get(image.data);
      if (!media) {
        const type = MEDIA_TYPES[image.format];
        media = { name: `image${mediaNames.length + 1}.${type.extension}`, mime: type.mime };
        mediaOf.set(image.data, media);
        mediaNames.push(media.name);
        zip.file(`ppt/media/${media.name}`, image.data);
      }
      const id = `rId${relations.length + 1}`;
      relations.push({ id, type: 'image', target: `../media/${media.name}` });
      relationOf.set(image.data, id);
      return id;
    });
    if (page.plainText !== undefined) {
      slideXml.plainText(page.plainText, page);
    } else {
      const tables = page.blocks.flatMap((block) => (block.kind === 'table' && isUniformlyRuled(block.table, page.rules) ? [block.table] : []));
      const rules = page.rules.filter((rule) => rule.inShape !== true && !tables.some((table) => ruleInside(rule, table.box)));
      // Pictures, shapes and rules go in the order the page paints them, so a band drawn over a picture stays over it.
      const painted: { z: number; draw: () => void }[] = [
        ...page.images.map((image) => ({ z: image.z ?? -1, draw: () => slideXml.picture(image) })),
        ...page.shapes.map((shape) => ({ z: shape.z, draw: () => slideXml.shape(shape) })),
        ...rules.map((rule) => ({ z: rule.z ?? -1, draw: () => (rule.thickness <= MAX_RULE_THICKNESS_PT ? slideXml.rule(rule) : slideXml.shape(barOf(rule))) })),
      ];
      for (const { draw } of painted.sort((a, b) => a.z - b.z)) draw();
      for (const block of page.blocks) {
        if (block.kind === 'table' && tables.includes(block.table)) slideXml.table(block.table, fonts, borderOf(block.table, page.rules));
        else if (block.kind === 'table') for (const line of linesOfTable(block.table)) slideXml.line(line, fonts);
        else if (block.kind === 'paragraph') for (const line of block.paragraph.lines) slideXml.line(line, fonts);
      }
    }
    zip.file(`ppt/slides/slide${number}.xml`, slideXml.toXml());
    zip.file(`ppt/slides/_rels/slide${number}.xml.rels`, relationships(relations));
    slideEntries.push(`<p:sldId id="${255 + number}" r:id="rId${number + 2}"/>`);
  });

  const mediaDefaults = [...new Set([...mediaOf.values()].map((media) => `<Default Extension="${media.name.split('.')[1]}" ContentType="${media.mime}"/>`))].join('');
  zip.file(
    '[Content_Types].xml',
    `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${mediaDefaults}` +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
      '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
      '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
      pages.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('') +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>'
  );
  zip.file(
    '_rels/.rels',
    `${XML_DECLARATION}<Relationships xmlns="${REL_NAMESPACE}"><Relationship Id="rId1" Type="${REL_TYPE}/officeDocument" Target="ppt/presentation.xml"/>` +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>'
  );
  zip.file(
    'docProps/core.xml',
    `${XML_DECLARATION}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escapeXmlText(title)}</dc:title></cp:coreProperties>`
  );
  zip.file(
    'ppt/presentation.xml',
    `${XML_DECLARATION}<p:presentation ${NAMESPACES}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideEntries.join('')}</p:sldIdLst>` +
      `<p:sldSz cx="${slide.cx}" cy="${slide.cy}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    relationships([
      { id: 'rId1', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' },
      { id: 'rId2', type: 'theme', target: 'theme/theme1.xml' },
      ...pages.map((_, index) => ({ id: `rId${index + 3}`, type: 'slide', target: `slides/slide${index + 1}.xml` })),
    ])
  );
  zip.file('ppt/slideMasters/slideMaster1.xml', MASTER_XML);
  zip.file(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    relationships([
      { id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', type: 'theme', target: '../theme/theme1.xml' },
    ])
  );
  zip.file('ppt/slideLayouts/slideLayout1.xml', LAYOUT_XML);
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', relationships([{ id: 'rId1', type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' }]));
  zip.file('ppt/theme/theme1.xml', THEME_XML);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * A presentation from a PDF: one slide for each page.
 * For the failures of reading the document see `readPdfContentForOffice`; a document that needs more than the layout analysis allows
 * a page is refused as it is for a Word document (`PdfLayoutLimitError`).
 */
export async function pdfToPptx(source: Buffer, options: ConversionOptions, title: string): Promise<Buffer> {
  const content = await readPdfContentForOffice(source, options, { images: true, colour: true });
  const fonts = new Map<string, PdfContentFont>();
  const noteFonts = (list: readonly PdfContentFont[]): void => list.forEach((font) => fonts.set(font.name, font));
  if (content.kind === 'layout') {
    noteFonts(content.extracted.fonts);
    const layouts = layoutPdfPages(content.extracted.pages, content.extracted.fonts);
    return writePackage(layouts.map(({ page, blocks }) => ({ width: page.width, height: page.height, images: page.images, rules: page.rules, shapes: page.shapes ?? [], blocks })), fonts, title);
  }
  // Pages read by OCR (and the pages of a scan's document that kept their text layer) have text and no geometry.
  const known = new Map((content.extracted?.pages ?? []).map((page) => [page.pageNumber, page]));
  const pages: SlidePage[] = content.pages.map(({ pageNumber, text }) => {
    const page = known.get(pageNumber);
    return { width: page?.width ?? LETTER_WIDTH_PT, height: page?.height ?? LETTER_HEIGHT_PT, images: [], rules: [], shapes: [], blocks: [], plainText: text };
  });
  return writePackage(pages, fonts, title);
}
