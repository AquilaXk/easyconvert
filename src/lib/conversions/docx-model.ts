import type JSZip from 'jszip';
import { ConversionFailedError, PayloadLimitError } from '../types';
import { assertEmbeddableImageWithinLimit } from './image-input-limits';
import { BlockSink, BodySink, DocumentContext, assembleDocument, listFormatOf, type TableDraftCell } from './document-model/build';
import { DocumentFormatError, type Block, type DocumentModel, type ImageFormat, type Inline, type NoteDefinition, type SectionBreakType } from './document-model/model';
import { anchorRun, imageRun, noteRun, normalizeBodySize, safeHref, sameRunFormat, sniffImageFormat, textRun } from './document-model/support';
import { NumberingDefinitions } from './docx-numbering';
import { mergeRunProps, readParagraphProps, readRunProps, sizePoints, StyleSheet, type RunProps } from './docx-styles';
import { childElements, firstChild, ownText, parseXmlTree, type XmlElement } from './xml-tree';

/**
 * Reads a WordprocessingML package (ECMA-376 Part 1) into the shared block model: paragraphs with resolved style
 * inheritance, headings, list items with their rendered markers, tables with merged cells, images with their
 * original bytes, hyperlinks, footnotes and endnotes, and page and section breaks. DrawingML shapes and charts are
 * not part of the model; their presence is reported so a caller can route the document to a renderer that draws them.
 */

const PACKAGE_LABEL = 'DOCX';
const MAIN_PART_FALLBACK = 'word/document.xml';
const ROOT_RELATIONSHIPS = '_rels/.rels';
const CORE_PROPERTIES_PART = 'docProps/core.xml';
const OFFICE_DOCUMENT_RELATIONSHIP = '/officeDocument';
const IMAGE_RELATIONSHIP = '/image';
const FOOTNOTES_RELATIONSHIP = '/footnotes';
const ENDNOTES_RELATIONSHIP = '/endnotes';
const STYLES_RELATIONSHIP = '/styles';
const NUMBERING_RELATIONSHIP = '/numbering';

/** Largest XML part read; the main document is the one that grows with the text. */
export const DOCX_MAX_XML_PART_BYTES = 128 * 1024 * 1024;
export const DOCX_MAX_IMAGE_BYTES = 64 * 1024 * 1024;
export const DOCX_MAX_TOTAL_IMAGE_BYTES = 256 * 1024 * 1024;
export const DOCX_MAX_IMAGES = 2000;
/** Most blocks (paragraphs and tables, nested ones included) one document may hold. */
export const DOCX_MAX_BLOCKS = 2_000_000;
/** Most inline items (runs of one format, images, breaks) one document may hold. */
export const DOCX_MAX_INLINES = 20_000_000;
/** Deepest table-in-table nesting. */
export const DOCX_MAX_TABLE_DEPTH = 16;
/** Most columns one table may span, as in HTML. */
export const DOCX_MAX_TABLE_COLUMNS = 1000;
/** Most text columns one section may declare. */
export const DOCX_MAX_SECTION_COLUMNS = 45;
/** Most notes one document may reference. */
export const DOCX_MAX_NOTES = 100_000;

const EMU_PER_POINT = 12700;
const TWIPS_PER_POINT = 20;
const DEFAULT_SECTION_TYPE: SectionBreakType = 'nextPage';
const SECTION_TYPES: ReadonlySet<string> = new Set(['nextPage', 'continuous', 'evenPage', 'oddPage', 'nextColumn']);
const FIELD_HYPERLINK = /^\s*HYPERLINK\s+(?:"([^"]*)"|(\S+))(.*)$/is;
const FIELD_ANCHOR_SWITCH = /\\l\s+"([^"]*)"/i;
const SYMBOL_PRIVATE_USE = /^[0-9a-f]{4}$/i;

export interface DocxReadResult {
  model: DocumentModel;
  /** The body holds charts or drawing shapes, which the model does not carry. */
  drawsShapes: boolean;
}

interface Relationship {
  readonly type: string;
  /** Package path (internal) or URL (external). */
  readonly target: string;
  readonly external: boolean;
}

interface PartContext {
  readonly relationships: ReadonlyMap<string, Relationship>;
}


interface FieldState {
  instruction: string;
  inResult: boolean;
  href?: string;
}

interface ParagraphState {
  inlines: Inline[];
  /** Indexes into `inlines` at which a page break ends a segment. */
  pageBreaks: number[];
  fields: FieldState[];
  hrefs: string[];
  /** Blocks of text boxes drawn in the paragraph; they follow it. */
  sidecar: BlockSink;
  baseRun: RunProps;
  heading: boolean;
}

function readInt(element: XmlElement | undefined, name: string): number | undefined {
  const raw = element?.attrs.get(name);
  if (raw === undefined || !/^-?\d+$/.test(raw)) return undefined;
  return Number(raw);
}

/** Depth-first search for the first descendant with local name `local`; iterative so nesting cannot exhaust the stack. */
function findDescendant(root: XmlElement, local: string): XmlElement | undefined {
  const stack: XmlElement[] = [root];
  while (stack.length > 0) {
    const element = stack.pop() as XmlElement;
    for (let index = element.children.length - 1; index >= 0; index -= 1) {
      const child = element.children[index];
      if (typeof child !== 'string') stack.push(child);
    }
    if (element !== root && element.local === local) return element;
  }
  return undefined;
}

function findDescendants(root: XmlElement, local: string): XmlElement[] {
  const found: XmlElement[] = [];
  const stack: XmlElement[] = [root];
  while (stack.length > 0) {
    const element = stack.pop() as XmlElement;
    if (element !== root && element.local === local) found.push(element);
    for (let index = element.children.length - 1; index >= 0; index -= 1) {
      const child = element.children[index];
      if (typeof child !== 'string') stack.push(child);
    }
  }
  return found;
}

async function readPart(zip: JSZip, partPath: string, limit: number): Promise<Buffer | undefined> {
  const entry = zip.file(partPath);
  if (!entry) return undefined;
  const declared = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  if (declared !== undefined && declared > limit) {
    throw new PayloadLimitError(`"${partPath}" declares ${declared} bytes, more than the ${limit} byte limit.`);
  }
  const bytes = await entry.async('nodebuffer');
  if (bytes.length > limit) throw new PayloadLimitError(`"${partPath}" holds ${bytes.length} bytes, more than the ${limit} byte limit.`);
  return bytes;
}

async function readXmlPart(zip: JSZip, partPath: string): Promise<XmlElement | undefined> {
  const bytes = await readPart(zip, partPath, DOCX_MAX_XML_PART_BYTES);
  if (!bytes) return undefined;
  const text = bytes.toString('utf8').replace(/^﻿/, '');
  return parseXmlTree(text, partPath, PACKAGE_LABEL);
}

/** The package path `target` names, relative to the directory `baseDirectory` (ending in "/"); never above the root. */
function resolveTarget(baseDirectory: string, target: string): string {
  const raw = target.split('#')[0];
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new DocumentFormatError(`The relationship target "${target}" is not a valid URI.`);
  }
  const segments = (decoded.startsWith('/') ? decoded.slice(1) : `${baseDirectory}${decoded}`).split('/');
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (resolved.pop() === undefined) throw new DocumentFormatError(`The relationship target "${target}" points outside the package.`);
    } else {
      resolved.push(segment);
    }
  }
  return resolved.join('/');
}

function directoryOf(partPath: string): string {
  const slash = partPath.lastIndexOf('/');
  return slash < 0 ? '' : partPath.slice(0, slash + 1);
}

async function readRelationships(zip: JSZip, partPath: string): Promise<Map<string, Relationship>> {
  const directory = directoryOf(partPath);
  const name = partPath.slice(directory.length);
  const root = await readXmlPart(zip, `${directory}_rels/${name}.rels`);
  const relationships = new Map<string, Relationship>();
  if (!root) return relationships;
  for (const rel of childElements(root, 'Relationship')) {
    const id = rel.attrs.get('Id');
    const target = rel.attrs.get('Target');
    if (id === undefined || target === undefined) continue;
    const external = rel.attrs.get('TargetMode') === 'External';
    relationships.set(id, {
      type: rel.attrs.get('Type') ?? '',
      target: external ? target : resolveTarget(directory, target),
      external,
    });
  }
  return relationships;
}

function relationshipOfType(relationships: ReadonlyMap<string, Relationship>, suffix: string): Relationship | undefined {
  for (const rel of relationships.values()) if (!rel.external && rel.type.endsWith(suffix)) return rel;
  return undefined;
}

interface LoadedImage {
  readonly data: Buffer;
  readonly format: ImageFormat;
}

class DocxReader {
  private blockCount = 0;
  private inlineCount = 0;
  /** The section properties of each section in order: those of paragraph-level breaks, then the body's own. */
  readonly sectionProperties: XmlElement[] = [];
  readonly noteOrder: { footnote: number[]; endnote: number[] } = { footnote: [], endnote: [] };
  drawsShapes = false;
  private currentListNumId: number | undefined;
  private listId = 0;

  constructor(
    private readonly context: DocumentContext,
    private readonly styles: StyleSheet,
    private readonly numbering: NumberingDefinitions,
    private readonly images: ReadonlyMap<string, LoadedImage>
  ) {}

  private get warnings(): string[] {
    return this.context.warnings;
  }

  private countBlock(): void {
    this.blockCount += 1;
    if (this.blockCount > DOCX_MAX_BLOCKS) throw new PayloadLimitError(`The document holds more than ${DOCX_MAX_BLOCKS} paragraphs and tables.`);
  }

  private countInline(): void {
    this.inlineCount += 1;
    if (this.inlineCount > DOCX_MAX_INLINES) throw new PayloadLimitError(`The document holds more than ${DOCX_MAX_INLINES} text runs.`);
  }

  /** Reads the block-level children of a body, table cell, note or text box into `out`. */
  readBlocks(container: XmlElement, part: PartContext, out: BlockSink, tableDepth: number): void {
    for (const child of container.children) {
      if (typeof child === 'string') continue;
      switch (child.local) {
        case 'p':
          this.readParagraph(child, part, out);
          break;
        case 'tbl':
          this.readTable(child, part, out, tableDepth);
          break;
        case 'drawing': {
          // Not valid at block level, but written by some generators: a picture becomes its own paragraph.
          const state = this.newState(this.styles.defaultRun, false, out);
          this.readDrawing(child, part, state);
          if (state.inlines.length > 0) out.paragraph(state.inlines);
          out.appendAll(state.sidecar.blocks);
          break;
        }
        case 'sdt': {
          const content = firstChild(child, 'sdtContent');
          if (content) this.readBlocks(content, part, out, tableDepth);
          break;
        }
        case 'ins':
        case 'moveTo':
        case 'customXml':
        case 'smartTag':
          this.readBlocks(child, part, out, tableDepth);
          break;
        case 'AlternateContent': {
          const choice = firstChild(child, 'Choice') ?? firstChild(child, 'Fallback');
          if (choice) this.readBlocks(choice, part, out, tableDepth);
          break;
        }
        default:
          break;
      }
    }
  }

  private readTable(tbl: XmlElement, part: PartContext, out: BlockSink, depth: number): void {
    if (depth >= DOCX_MAX_TABLE_DEPTH) {
      // Deeper tables keep their text, one paragraph per cell paragraph, but no table structure.
      this.warnings.push(`Tables nested deeper than ${DOCX_MAX_TABLE_DEPTH} levels were flattened to text.`);
      for (const paragraphElement of findDescendants(tbl, 'p')) {
        const text = findDescendants(paragraphElement, 't').map((t) => ownText(t)).join('');
        if (text.trim() !== '') {
          this.countBlock();
          out.paragraph([textRun(text.trim())]);
        }
      }
      return;
    }
    this.countBlock();
    this.currentListNumId = undefined;
    const rows: TableDraftCell[][] = [];
    // Cell that a vertical merge continues, by grid column.
    const openByColumn = new Map<number, TableDraftCell>();
    const gridColumns = childElements(firstChild(tbl, 'tblGrid') ?? tbl, 'gridCol');
    let columnCount = gridColumns.length;

    const readRow = (tr: XmlElement): void => {
      const trPr = firstChild(tr, 'trPr');
      const cells: TableDraftCell[] = [];
      let column = readInt(trPr ? firstChild(trPr, 'gridBefore') : undefined, 'val') ?? 0;
      const cellElements: XmlElement[] = [];
      for (const child of tr.children) {
        if (typeof child === 'string') continue;
        if (child.local === 'tc') cellElements.push(child);
        else if (child.local === 'sdt') {
          const content = firstChild(child, 'sdtContent');
          if (content) cellElements.push(...childElements(content, 'tc'));
        }
      }
      for (const tc of cellElements) {
        const tcPr = firstChild(tc, 'tcPr');
        const span = Math.max(1, readInt(tcPr ? firstChild(tcPr, 'gridSpan') : undefined, 'val') ?? 1);
        if (column + span > DOCX_MAX_TABLE_COLUMNS) throw new PayloadLimitError(`A table spans more than ${DOCX_MAX_TABLE_COLUMNS} columns.`);
        const vMerge = tcPr ? firstChild(tcPr, 'vMerge') : undefined;
        const continues = vMerge !== undefined && (vMerge.attrs.get('val') ?? 'continue') === 'continue';
        const hMergeContinues = tcPr ? firstChild(tcPr, 'hMerge')?.attrs.get('val') !== 'restart' && firstChild(tcPr, 'hMerge') !== undefined : false;
        const above = openByColumn.get(column);
        if (continues && above) {
          above.rowSpan += 1;
          column += span;
          continue;
        }
        if (hMergeContinues && cells.length > 0) {
          cells[cells.length - 1].colSpan += span;
          column += span;
          continue;
        }
        const content = out.nested();
        this.readBlocks(tc, part, content, depth + 1);
        const fill = tcPr ? firstChild(tcPr, 'shd')?.attrs.get('fill') : undefined;
        const cell: TableDraftCell = {
          blocks: content.blocks,
          colSpan: span,
          rowSpan: 1,
          header: false,
          shading: fill !== undefined && /^[0-9a-fA-F]{6}$/.test(fill) ? fill.toUpperCase() : undefined,
        };
        cells.push(cell);
        for (let offset = 0; offset < span; offset += 1) openByColumn.set(column + offset, cell);
        column += span;
      }
      columnCount = Math.max(columnCount, column);
      const header = trPr !== undefined && firstChild(trPr, 'tblHeader') !== undefined;
      for (const cell of cells) cell.header = header;
      rows.push(cells);
    };

    for (const child of tbl.children) {
      if (typeof child !== 'string' && child.local === 'tr') readRow(child);
    }
    // Column widths are the grid's when it covers every column; otherwise the table spreads over the text width.
    const widths = gridColumns.map((gridCol) => (readInt(gridCol, 'w') ?? 0) / TWIPS_PER_POINT);
    const columnWidthsPt = widths.length === columnCount && widths.every((width) => width > 0) ? widths : undefined;
    out.table({ rows, columnCount, columnWidthsPt });
  }

  private readParagraph(p: XmlElement, part: PartContext, out: BlockSink): void {
    const pPr = firstChild(p, 'pPr');
    const styleId = pPr ? firstChild(pPr, 'pStyle')?.attrs.get('val') : undefined;
    const style = this.styles.paragraphStyle(styleId);
    const props = { ...style.paragraph, ...stripUndefined(readParagraphProps(pPr)) };
    const headingLevel = this.styles.headingLevel(style.name, props.outlineLevel);

    let marker: ReturnType<NumberingDefinitions['next']>;
    if (props.numId !== undefined && props.numId !== 0 && this.numbering.has(props.numId)) {
      marker = this.numbering.next(props.numId, props.ilvl ?? 0);
    }

    const state = this.newState(mergeRunProps(this.styles.defaultRun, style.run), headingLevel !== undefined, out);
    this.readInlineChildren(p, part, state);

    if (marker === undefined) this.currentListNumId = undefined;

    const segments: Inline[][] = [];
    let from = 0;
    for (const at of state.pageBreaks) {
      segments.push(state.inlines.slice(from, at));
      from = at;
    }
    segments.push(state.inlines.slice(from));

    const rtl = props.rtl === true;
    if (props.pageBreakBefore) out.pageBreak();
    segments.forEach((segment, index) => {
      const inlines = trimEdges(segment);
      if (index > 0) out.pageBreak();
      if (inlines.length === 0) return;
      this.countBlock();
      const first = index === 0;
      if (first && headingLevel !== undefined) {
        out.heading(headingLevel, inlines, { label: marker && marker.marker !== '' ? marker.marker : undefined, rtl });
      } else if (first && marker !== undefined) {
        const numId = props.numId as number;
        if (this.currentListNumId !== numId) {
          this.currentListNumId = numId;
          this.listId += 1;
        }
        out.listItem({
          sourceId: this.listId,
          level: props.ilvl ?? 0,
          ...listFormatOf(marker.ordered, marker.format, marker.marker),
          value: marker.number,
          marker: marker.marker,
          runs: inlines,
          rtl,
        });
      } else {
        out.paragraph(inlines, { align: props.align, rtl });
      }
    });
    out.appendAll(state.sidecar.blocks);

    const sectPr = pPr ? firstChild(pPr, 'sectPr') : undefined;
    if (sectPr && out instanceof BodySink) {
      this.sectionProperties.push(sectPr);
      out.endSection(columnsOf(sectPr));
    }
  }

  private newState(baseRun: RunProps, heading: boolean, out: BlockSink): ParagraphState {
    return {
      inlines: [],
      pageBreaks: [],
      fields: [],
      hrefs: [],
      sidecar: out.nested(),
      baseRun: heading ? { ...baseRun, bold: undefined } : baseRun,
      heading,
    };
  }

  private currentHref(state: ParagraphState): string | undefined {
    for (let index = state.fields.length - 1; index >= 0; index -= 1) {
      const href = state.fields[index].href;
      if (href !== undefined) return href;
    }
    return state.hrefs[state.hrefs.length - 1];
  }

  private readInlineChildren(parent: XmlElement, part: PartContext, state: ParagraphState): void {
    for (const child of parent.children) {
      if (typeof child === 'string') continue;
      switch (child.local) {
        case 'r':
          this.readRun(child, part, state);
          break;
        case 'hyperlink': {
          const id = child.attrs.get('id');
          const anchor = child.attrs.get('anchor');
          const relationship = id === undefined ? undefined : part.relationships.get(id);
          let href: string | undefined;
          if (relationship && relationship.external) href = safeHref(relationship.target);
          else if (anchor !== undefined && anchor !== '') href = `#${anchor}`;
          state.hrefs.push(href ?? '');
          this.readInlineChildren(child, part, state);
          state.hrefs.pop();
          break;
        }
        case 'fldSimple': {
          const href = hrefOfInstruction(child.attrs.get('instr') ?? '');
          state.fields.push({ instruction: '', inResult: true, href });
          this.readInlineChildren(child, part, state);
          state.fields.pop();
          break;
        }
        case 'ins':
        case 'moveTo':
        case 'smartTag':
        case 'customXml':
        case 'dir':
        case 'bdo':
          this.readInlineChildren(child, part, state);
          break;
        case 'sdt': {
          const content = firstChild(child, 'sdtContent');
          if (content) this.readInlineChildren(content, part, state);
          break;
        }
        case 'AlternateContent': {
          const choice = firstChild(child, 'Choice') ?? firstChild(child, 'Fallback');
          if (choice) this.readInlineChildren(choice, part, state);
          break;
        }
        case 'bookmarkStart': {
          const name = child.attrs.get('name');
          if (name !== undefined && !name.startsWith('_GoBack')) {
            this.countInline();
            state.inlines.push(anchorRun(name));
          }
          break;
        }
        default:
          break;
      }
    }
  }

  /** Adds `run`, joining it to the run before when the two have one format. */
  private pushRun(state: ParagraphState, run: Inline): void {
    const last = state.inlines[state.inlines.length - 1];
    if (last && sameRunFormat(last, run) && run.text !== '') {
      state.inlines[state.inlines.length - 1] = { ...last, text: last.text + run.text };
      return;
    }
    this.countInline();
    state.inlines.push(run);
  }

  private pushText(state: ParagraphState, text: string, props: RunProps, href: string | undefined): void {
    if (text === '') return;
    const sizePt = sizePoints(props.sizeHalfPoints);
    const baseSize = sizePoints(state.baseRun.sizeHalfPoints);
    const run = textRun(text, { bold: props.bold === true, italic: props.italic === true, monospace: props.monospace === true });
    if (props.underline && href === undefined) run.underline = true;
    if (props.strike) run.strike = true;
    if (props.vertAlign === 'superscript') run.superscript = true;
    if (props.vertAlign === 'subscript') run.subscript = true;
    if (sizePt !== undefined && sizePt !== baseSize && !state.heading) run.sizePt = sizePt;
    if (props.color !== undefined && href === undefined && props.color !== '000000') run.color = props.color;
    if (href !== undefined && href !== '') run.href = href;
    this.pushRun(state, run);
  }

  private readRun(r: XmlElement, part: PartContext, state: ParagraphState): void {
    const rPrElement = firstChild(r, 'rPr');
    const direct = readRunProps(rPrElement);
    const characterStyle = this.styles.characterStyle(rPrElement ? firstChild(rPrElement, 'rStyle')?.attrs.get('val') : undefined);
    let props = mergeRunProps(mergeRunProps(state.baseRun, characterStyle), direct);
    if (state.heading) props = { ...props, bold: undefined };
    if (props.vanish) return;
    const href = this.currentHref(state);
    const inInstruction = state.fields.some((field) => !field.inResult);

    for (const child of r.children) {
      if (typeof child === 'string') continue;
      switch (child.local) {
        case 't':
          if (!inInstruction) this.pushText(state, ownText(child), props, href);
          break;
        case 'tab':
        case 'ptab':
          if (!inInstruction) this.pushText(state, '\t', props, href);
          break;
        case 'noBreakHyphen':
          if (!inInstruction) this.pushText(state, '‑', props, href);
          break;
        case 'sym': {
          const code = child.attrs.get('char');
          if (!inInstruction && code !== undefined && SYMBOL_PRIVATE_USE.test(code)) {
            this.pushText(state, String.fromCodePoint(Number.parseInt(code, 16)), props, href);
          }
          break;
        }
        case 'br': {
          const type = child.attrs.get('type');
          if (type === 'page') state.pageBreaks.push(state.inlines.length);
          else if (type !== 'column') this.pushRun(state, textRun('\n'));
          break;
        }
        case 'cr':
          this.pushRun(state, textRun('\n'));
          break;
        case 'drawing':
          this.readDrawing(child, part, state);
          break;
        case 'pict':
        case 'object':
          this.readPicture(child, part, state);
          break;
        case 'AlternateContent': {
          const choice = firstChild(child, 'Choice') ?? firstChild(child, 'Fallback');
          if (choice) this.readRun(choice, part, state);
          break;
        }
        case 'footnoteReference':
        case 'endnoteReference':
          this.readNoteReference(child, state);
          break;
        case 'fldChar': {
          const type = child.attrs.get('fldCharType');
          if (type === 'begin') state.fields.push({ instruction: '', inResult: false });
          else if (type === 'separate') {
            const field = state.fields[state.fields.length - 1];
            if (field) {
              field.inResult = true;
              field.href = hrefOfInstruction(field.instruction);
            }
          } else if (type === 'end') state.fields.pop();
          break;
        }
        case 'instrText': {
          const field = state.fields[state.fields.length - 1];
          if (field && !field.inResult) field.instruction += ownText(child);
          break;
        }
        default:
          break;
      }
    }
  }

  private readNoteReference(reference: XmlElement, state: ParagraphState): void {
    const id = readInt(reference, 'id');
    if (id === undefined) return;
    const kind = reference.local === 'footnoteReference' ? 'footnote' : 'endnote';
    const order = this.noteOrder[kind];
    if (order.length >= DOCX_MAX_NOTES) throw new PayloadLimitError(`The document references more than ${DOCX_MAX_NOTES} ${kind}s.`);
    order.push(id);
    this.countInline();
    state.inlines.push(noteRun({ kind, id, label: String(order.length) }));
  }

  private pushImage(state: ParagraphState, part: PartContext, relationshipId: string | undefined, alt: string, extentEmu: [number, number] | undefined): void {
    if (relationshipId === undefined) return;
    const relationship = part.relationships.get(relationshipId);
    if (!relationship || relationship.external) {
      this.warnings.push(`An image refers to ${relationship ? 'an external file' : `the missing relationship ${relationshipId}`} and was left out.`);
      return;
    }
    const loaded = this.images.get(relationship.target);
    if (!loaded) {
      this.warnings.push(`The image ${relationship.target} is in a format the converter does not carry and was left out.`);
      return;
    }
    this.countInline();
    state.inlines.push(
      imageRun({
        imageId: this.context.addImage(loaded.data, loaded.format),
        alt,
        widthPt: extentEmu ? extentEmu[0] / EMU_PER_POINT : undefined,
        heightPt: extentEmu ? extentEmu[1] / EMU_PER_POINT : undefined,
      })
    );
  }

  private readDrawing(drawing: XmlElement, part: PartContext, state: ParagraphState): void {
    const container = firstChild(drawing, 'inline') ?? firstChild(drawing, 'anchor');
    const docPr = container ? firstChild(container, 'docPr') : undefined;
    const alt = docPr?.attrs.get('descr') ?? docPr?.attrs.get('title') ?? '';
    const extent = container ? firstChild(container, 'extent') : undefined;
    const cx = readInt(extent, 'cx');
    const cy = readInt(extent, 'cy');
    const blip = findDescendant(drawing, 'blip');

    for (const textBox of findDescendants(drawing, 'txbxContent')) this.readBlocks(textBox, part, state.sidecar, 0);

    if (blip) {
      this.pushImage(state, part, blip.attrs.get('embed'), alt, cx !== undefined && cy !== undefined ? [cx, cy] : undefined);
      return;
    }
    // Anything drawn that is not a picture (chart, shape, group, diagram) is outside the model; a text box alone is text.
    const hasTextBox = findDescendant(drawing, 'txbxContent') !== undefined;
    if (findDescendant(drawing, 'chart') || findDescendant(drawing, 'wgp') || findDescendant(drawing, 'relIds') || !hasTextBox) {
      this.drawsShapes = true;
    }
  }

  private readPicture(pict: XmlElement, part: PartContext, state: ParagraphState): void {
    for (const textBox of findDescendants(pict, 'txbxContent')) this.readBlocks(textBox, part, state.sidecar, 0);
    const imageData = findDescendant(pict, 'imagedata');
    if (imageData) {
      const id = imageData.attrs.get('id') ?? imageData.attrs.get('relid');
      this.pushImage(state, part, id, imageData.attrs.get('title') ?? '', undefined);
      return;
    }
    if (!findDescendant(pict, 'textbox')) this.drawsShapes = true;
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) (result as Record<string, unknown>)[key] = entry;
  }
  return result;
}

function hrefOfInstruction(instruction: string): string | undefined {
  const match = FIELD_HYPERLINK.exec(instruction);
  if (!match) return undefined;
  const anchor = FIELD_ANCHOR_SWITCH.exec(match[3] ?? '');
  if (anchor) return `#${anchor[1]}`;
  return safeHref(match[1] ?? match[2]);
}

/** Drops whitespace at both ends of a paragraph's content and the empty text runs left by it. */
function trimEdges(runs: Inline[]): Inline[] {
  const isText = (run: Inline): boolean => run.image === undefined && run.note === undefined && run.anchor === undefined;
  const result = runs.slice();
  while (result.length > 0) {
    const head = result[0];
    if (!isText(head)) break;
    const trimmed = head.text.replace(/^\s+/, '');
    if (trimmed === '') result.shift();
    else {
      result[0] = { ...head, text: trimmed };
      break;
    }
  }
  while (result.length > 0) {
    const tail = result[result.length - 1];
    if (!isText(tail)) break;
    const trimmed = tail.text.replace(/\s+$/, '');
    if (trimmed === '') result.pop();
    else {
      result[result.length - 1] = { ...tail, text: trimmed };
      break;
    }
  }
  // A paragraph holding only anchors has no content.
  return result.every((run) => run.anchor !== undefined) ? [] : result;
}

async function loadImages(
  zip: JSZip,
  relationshipSets: readonly ReadonlyMap<string, Relationship>[],
  warnings: string[]
): Promise<Map<string, LoadedImage>> {
  const images = new Map<string, LoadedImage>();
  let total = 0;
  for (const relationships of relationshipSets) {
    for (const rel of relationships.values()) {
      if (rel.external || !rel.type.endsWith(IMAGE_RELATIONSHIP) || images.has(rel.target)) continue;
      if (images.size >= DOCX_MAX_IMAGES) throw new PayloadLimitError(`The document embeds more than ${DOCX_MAX_IMAGES} images.`);
      const data = await readPart(zip, rel.target, DOCX_MAX_IMAGE_BYTES);
      if (!data) {
        throw new DocumentFormatError(`The image relationship names "${rel.target}", which is not in the package.`);
      }
      total += data.length;
      if (total > DOCX_MAX_TOTAL_IMAGE_BYTES) {
        throw new PayloadLimitError(`The document embeds more than ${DOCX_MAX_TOTAL_IMAGE_BYTES} bytes of images.`);
      }
      const format = sniffImageFormat(data);
      if (format === null) {
        warnings.push(`The image ${rel.target} is not PNG, JPEG, GIF, BMP, TIFF or SVG and was left out.`);
        continue;
      }
      await assertEmbeddableImageWithinLimit(data);
      images.set(rel.target, { data, format });
    }
  }
  return images;
}

interface PageGeometry {
  pageWidthPt: number;
  pageHeightPt: number;
  margins: { top: number; right: number; bottom: number; left: number };
}

function pageSetupOf(sectPr: XmlElement | undefined): PageGeometry | undefined {
  if (!sectPr) return undefined;
  const size = firstChild(sectPr, 'pgSz');
  const margins = firstChild(sectPr, 'pgMar');
  const width = readInt(size, 'w');
  const height = readInt(size, 'h');
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return undefined;
  const margin = (name: string): number => (readInt(margins, name) ?? 0) / TWIPS_PER_POINT;
  return {
    pageWidthPt: width / TWIPS_PER_POINT,
    pageHeightPt: height / TWIPS_PER_POINT,
    margins: { top: margin('top'), right: margin('right'), bottom: margin('bottom'), left: margin('left') },
  };
}

/** Number of text columns a section declares (`w:cols`); one when it declares none. */
function columnsOf(sectPr: XmlElement | undefined): number {
  const count = readInt(sectPr ? firstChild(sectPr, 'cols') : undefined, 'num');
  return count !== undefined && count > 1 ? Math.min(count, DOCX_MAX_SECTION_COLUMNS) : 1;
}

/** How a section starts, from its own section properties (17.6.22); next page when it states nothing. */
function breakTypeOf(sectPr: XmlElement | undefined): SectionBreakType {
  const type = sectPr ? firstChild(sectPr, 'type')?.attrs.get('val') : undefined;
  return (type !== undefined && SECTION_TYPES.has(type) ? type : DEFAULT_SECTION_TYPE) as SectionBreakType;
}

async function readCoreProperties(zip: JSZip): Promise<{ title?: string; author?: string; language?: string }> {
  const root = await readXmlPart(zip, CORE_PROPERTIES_PART);
  if (!root) return {};
  const text = (name: string): string | undefined => {
    const value = firstChild(root, name);
    const content = value ? ownText(value).trim() : '';
    return content === '' ? undefined : content;
  };
  return { title: text('title'), author: text('creator'), language: text('language') };
}

/** Resolves the main document part of the package: the target of the office-document relationship of `_rels/.rels`. */
async function mainPartPath(zip: JSZip): Promise<string> {
  const root = await readXmlPart(zip, ROOT_RELATIONSHIPS);
  if (root) {
    for (const rel of childElements(root, 'Relationship')) {
      const target = rel.attrs.get('Target');
      if (target !== undefined && (rel.attrs.get('Type') ?? '').endsWith(OFFICE_DOCUMENT_RELATIONSHIP) && rel.attrs.get('TargetMode') !== 'External') {
        return resolveTarget('', target);
      }
    }
  }
  return MAIN_PART_FALLBACK;
}

/**
 * Reads the DOCX package in `zip` into the document model. A package without a main document part, a part that is not
 * well-formed XML, a style or numbering definition that contradicts itself, or content beyond the named limits is
 * refused with a typed error.
 */
export async function readDocxModel(zip: JSZip): Promise<DocxReadResult> {
  const mainPath = await mainPartPath(zip);
  if (!zip.file(mainPath)) throw new ConversionFailedError('Invalid DOCX format: word/document.xml not found.');
  const documentRoot = await readXmlPart(zip, mainPath);
  if (!documentRoot) throw new ConversionFailedError('Invalid DOCX format: word/document.xml not found.');

  const documentRelationships = await readRelationships(zip, mainPath);
  const directory = directoryOf(mainPath);
  const partByRelationship = (suffix: string, fallback: string): string => relationshipOfType(documentRelationships, suffix)?.target ?? `${directory}${fallback}`;

  const stylesRoot = await readXmlPart(zip, partByRelationship(STYLES_RELATIONSHIP, 'styles.xml'));
  const styles = new StyleSheet(stylesRoot);
  const numberingRoot = await readXmlPart(zip, partByRelationship(NUMBERING_RELATIONSHIP, 'numbering.xml'));
  const numbering = new NumberingDefinitions(numberingRoot, styles.numberingStyles());

  const footnotesPath = partByRelationship(FOOTNOTES_RELATIONSHIP, 'footnotes.xml');
  const endnotesPath = partByRelationship(ENDNOTES_RELATIONSHIP, 'endnotes.xml');
  const footnoteRelationships = zip.file(footnotesPath) ? await readRelationships(zip, footnotesPath) : new Map<string, Relationship>();
  const endnoteRelationships = zip.file(endnotesPath) ? await readRelationships(zip, endnotesPath) : new Map<string, Relationship>();

  const context = new DocumentContext();
  const images = await loadImages(zip, [documentRelationships, footnoteRelationships, endnoteRelationships], context.warnings);
  const reader = new DocxReader(context, styles, numbering, images);

  const body = firstChild(documentRoot, 'body');
  if (!body) throw new DocumentFormatError(`Invalid DOCX package: ${mainPath} has no w:body element.`);
  const sink = new BodySink(context);
  reader.readBlocks(body, { relationships: documentRelationships }, sink, 0);
  const bodySectPr = firstChild(body, 'sectPr');
  if (bodySectPr) reader.sectionProperties.push(bodySectPr);
  const sections = sink.sections(columnsOf(bodySectPr));
  sections.forEach((section, index) => {
    if (index > 0) section.breakType = breakTypeOf(reader.sectionProperties[index]);
  });
  const page = pageSetupOf(bodySectPr);

  const readNotes = async (partPath: string, relationships: ReadonlyMap<string, Relationship>, order: readonly number[], elementName: string): Promise<NoteDefinition[]> => {
    if (order.length === 0) return [];
    const root = await readXmlPart(zip, partPath);
    const byId = new Map<number, XmlElement>();
    if (root) {
      for (const note of childElements(root, elementName)) {
        const id = readInt(note, 'id');
        if (id !== undefined && note.attrs.get('type') === undefined) byId.set(id, note);
      }
    }
    const notes: NoteDefinition[] = [];
    order.forEach((id, index) => {
      const element = byId.get(id);
      if (!element) {
        context.warnings.push(`A ${elementName} reference points at the missing note ${id}.`);
        return;
      }
      const noteSink = new BlockSink(context);
      reader.readBlocks(element, { relationships }, noteSink, 0);
      const blocks: Block[] = noteSink.blocks;
      notes.push({ id, label: String(index + 1), blocks });
    });
    return notes;
  };
  const footnotes = await readNotes(footnotesPath, footnoteRelationships, reader.noteOrder.footnote, 'footnote');
  const endnotes = await readNotes(endnotesPath, endnoteRelationships, reader.noteOrder.endnote, 'endnote');

  const core = await readCoreProperties(zip);
  const model = assembleDocument({
    sections,
    context,
    ...(page ?? {}),
    bodySize: sizePoints(styles.defaultRun.sizeHalfPoints),
    footnotes,
    endnotes,
    title: core.title,
    author: core.author,
    language: core.language ?? (stylesRoot ? styles.language : undefined),
  });
  normalizeBodySize(model);
  return { model, drawsShapes: reader.drawsShapes };
}
