import type JSZip from 'jszip';
import { ConversionFailedError, PayloadLimitError } from '../types';
import { assertEmbeddableImageWithinLimit } from './image-input-limits';
import {
  DocumentFormatError,
  emptyDocModel,
  normalizeBodySize,
  safeHref,
  sniffImageMime,
  type DocBlock,
  type DocImage,
  type DocInline,
  type DocModel,
  type DocNote,
  type DocTableCell,
  type DocTableRow,
  type DocTextInline,
} from './document-model';
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
/** Most notes one document may reference. */
export const DOCX_MAX_NOTES = 100_000;

const EMU_PER_POINT = 12700;
const TWIPS_PER_POINT = 20;
const DEFAULT_SECTION_TYPE = 'nextPage';
const SECTION_TYPES: ReadonlySet<string> = new Set(['nextPage', 'continuous', 'evenPage', 'oddPage', 'nextColumn']);
const FIELD_HYPERLINK = /^\s*HYPERLINK\s+(?:"([^"]*)"|(\S+))(.*)$/is;
const FIELD_ANCHOR_SWITCH = /\\l\s+"([^"]*)"/i;
const SYMBOL_PRIVATE_USE = /^[0-9a-f]{4}$/i;

export interface DocxReadResult {
  model: DocModel;
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

interface MutableTextInline {
  kind: 'text';
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  href?: string;
  sizePt?: number;
  color?: string;
}

interface MutableCell {
  blocks: DocBlock[];
  colSpan: number;
  rowSpan: number;
  header: boolean;
  shading?: string;
}

interface MutableSectionBreak {
  kind: 'sectionBreak';
  sectionType: 'nextPage' | 'continuous' | 'evenPage' | 'oddPage' | 'nextColumn';
}

interface FieldState {
  instruction: string;
  inResult: boolean;
  href?: string;
}

interface ParagraphState {
  inlines: DocInline[];
  /** Indexes into `inlines` at which a page break ends a segment. */
  pageBreaks: number[];
  fields: FieldState[];
  hrefs: string[];
  sidecar: DocBlock[];
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

class DocxReader {
  private blockCount = 0;
  private inlineCount = 0;
  private readonly sectionBreaks: MutableSectionBreak[] = [];
  private readonly sectionProperties: XmlElement[] = [];
  readonly noteOrder: { footnote: number[]; endnote: number[] } = { footnote: [], endnote: [] };
  drawsShapes = false;
  private currentListNumId: number | undefined;
  private listId = 0;
  readonly warnings: string[] = [];

  constructor(
    private readonly styles: StyleSheet,
    private readonly numbering: NumberingDefinitions,
    private readonly images: ReadonlyMap<string, { data: Buffer; mime: NonNullable<ReturnType<typeof sniffImageMime>> }>
  ) {}

  private countBlock(): void {
    this.blockCount += 1;
    if (this.blockCount > DOCX_MAX_BLOCKS) throw new PayloadLimitError(`The document holds more than ${DOCX_MAX_BLOCKS} paragraphs and tables.`);
  }

  private countInline(): void {
    this.inlineCount += 1;
    if (this.inlineCount > DOCX_MAX_INLINES) throw new PayloadLimitError(`The document holds more than ${DOCX_MAX_INLINES} text runs.`);
  }

  /** Section type of the section that follows each paragraph-level section break (17.6.22: the type belongs to the section it starts). */
  finishSections(bodySectPr: XmlElement | undefined): void {
    if (bodySectPr) this.sectionProperties.push(bodySectPr);
    this.sectionBreaks.forEach((block, index) => {
      const next = this.sectionProperties[index + 1];
      const type = next ? firstChild(next, 'type')?.attrs.get('val') : undefined;
      block.sectionType = (type !== undefined && SECTION_TYPES.has(type) ? type : DEFAULT_SECTION_TYPE) as MutableSectionBreak['sectionType'];
    });
  }

  /** Reads the block-level children of a body, table cell, note or text box into `out`. */
  readBlocks(container: XmlElement, part: PartContext, out: DocBlock[], tableDepth: number): void {
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
          const state = this.newState(this.styles.defaultRun, false);
          this.readDrawing(child, part, state);
          if (state.inlines.length > 0) out.push({ kind: 'paragraph', inlines: state.inlines });
          out.push(...state.sidecar);
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

  private readTable(tbl: XmlElement, part: PartContext, out: DocBlock[], depth: number): void {
    if (depth >= DOCX_MAX_TABLE_DEPTH) {
      // Deeper tables keep their text, one paragraph per cell paragraph, but no table structure.
      this.warnings.push(`Tables nested deeper than ${DOCX_MAX_TABLE_DEPTH} levels were flattened to text.`);
      for (const paragraphElement of findDescendants(tbl, 'p')) {
        const text = findDescendants(paragraphElement, 't').map((t) => ownText(t)).join('');
        if (text.trim() !== '') {
          this.countBlock();
          out.push({ kind: 'paragraph', inlines: [{ kind: 'text', text: text.trim() }] });
        }
      }
      return;
    }
    this.countBlock();
    this.currentListNumId = undefined;
    const rows: DocTableRow[] = [];
    // Cell that a vertical merge continues, by grid column.
    const openByColumn = new Map<number, MutableCell>();
    let columnCount = childElements(firstChild(tbl, 'tblGrid') ?? tbl, 'gridCol').length;

    const readRow = (tr: XmlElement): void => {
      const trPr = firstChild(tr, 'trPr');
      const cells: MutableCell[] = [];
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
        const blocks: DocBlock[] = [];
        this.readBlocks(tc, part, blocks, depth + 1);
        const fill = tcPr ? firstChild(tcPr, 'shd')?.attrs.get('fill') : undefined;
        const cell: MutableCell = {
          blocks,
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
      rows.push({ cells: cells as DocTableCell[], header });
    };

    for (const child of tbl.children) {
      if (typeof child !== 'string' && child.local === 'tr') readRow(child);
    }
    // A merge continues only into the row directly below, so a column's open cell is dropped when a row skips it.
    out.push({ kind: 'table', rows, columnCount });
  }

  private readParagraph(p: XmlElement, part: PartContext, out: DocBlock[]): void {
    const pPr = firstChild(p, 'pPr');
    const styleId = pPr ? firstChild(pPr, 'pStyle')?.attrs.get('val') : undefined;
    const style = this.styles.paragraphStyle(styleId);
    const props = { ...style.paragraph, ...stripUndefined(readParagraphProps(pPr)) };
    const headingLevel = this.styles.headingLevel(style.name, props.outlineLevel);

    let marker: ReturnType<NumberingDefinitions['next']>;
    if (props.numId !== undefined && props.numId !== 0 && this.numbering.has(props.numId)) {
      marker = this.numbering.next(props.numId, props.ilvl ?? 0);
    }

    const state = this.newState(mergeRunProps(this.styles.defaultRun, style.run), headingLevel !== undefined);
    this.readInlineChildren(p, part, state);

    if (marker === undefined) this.currentListNumId = undefined;

    const segments: DocInline[][] = [];
    let from = 0;
    for (const at of state.pageBreaks) {
      segments.push(state.inlines.slice(from, at));
      from = at;
    }
    segments.push(state.inlines.slice(from));

    if (props.pageBreakBefore) out.push({ kind: 'pageBreak' });
    segments.forEach((segment, index) => {
      const inlines = trimEdges(segment);
      if (index > 0) out.push({ kind: 'pageBreak' });
      if (inlines.length === 0) return;
      this.countBlock();
      const first = index === 0;
      if (first && headingLevel !== undefined) {
        out.push({ kind: 'heading', level: headingLevel, inlines, label: marker && marker.marker !== '' ? marker.marker : undefined });
      } else if (first && marker !== undefined) {
        const numId = props.numId as number;
        if (this.currentListNumId !== numId) {
          this.currentListNumId = numId;
          this.listId += 1;
        }
        out.push({
          kind: 'listItem',
          level: props.ilvl ?? 0,
          ordered: marker.ordered,
          marker: marker.marker,
          number: marker.number,
          format: marker.format,
          listId: this.listId,
          inlines,
        });
      } else {
        out.push({ kind: 'paragraph', inlines, align: props.align });
      }
    });
    for (const block of state.sidecar) out.push(block);

    const sectPr = pPr ? firstChild(pPr, 'sectPr') : undefined;
    if (sectPr) {
      this.sectionProperties.push(sectPr);
      const block: MutableSectionBreak = { kind: 'sectionBreak', sectionType: DEFAULT_SECTION_TYPE };
      this.sectionBreaks.push(block);
      out.push(block);
    }
  }

  private newState(baseRun: RunProps, heading: boolean): ParagraphState {
    return {
      inlines: [],
      pageBreaks: [],
      fields: [],
      hrefs: [],
      sidecar: [],
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
            state.inlines.push({ kind: 'anchor', name });
          }
          break;
        }
        default:
          break;
      }
    }
  }

  private pushText(state: ParagraphState, text: string, props: RunProps, href: string | undefined): void {
    if (text === '') return;
    const sizePt = sizePoints(props.sizeHalfPoints);
    const baseSize = sizePoints(state.baseRun.sizeHalfPoints);
    const inline: MutableTextInline = { kind: 'text', text };
    if (props.bold) inline.bold = true;
    if (props.italic) inline.italic = true;
    if (props.underline && href === undefined) inline.underline = true;
    if (props.strike) inline.strike = true;
    if (props.monospace) inline.code = true;
    if (props.vertAlign === 'superscript') inline.superscript = true;
    if (props.vertAlign === 'subscript') inline.subscript = true;
    if (sizePt !== undefined && sizePt !== baseSize && !state.heading) inline.sizePt = sizePt;
    if (props.color !== undefined && href === undefined && props.color !== '000000') inline.color = props.color;
    if (href !== undefined && href !== '') inline.href = href;

    const last = state.inlines[state.inlines.length - 1];
    if (last && last.kind === 'text' && sameFormat(last, inline)) {
      state.inlines[state.inlines.length - 1] = { ...last, text: last.text + text };
      return;
    }
    this.countInline();
    state.inlines.push(inline as DocTextInline);
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
          else if (type !== 'column') {
            this.countInline();
            state.inlines.push({ kind: 'break' });
          }
          break;
        }
        case 'cr':
          this.countInline();
          state.inlines.push({ kind: 'break' });
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
    const noteKind = reference.local === 'footnoteReference' ? 'footnote' : 'endnote';
    const order = this.noteOrder[noteKind];
    if (order.length >= DOCX_MAX_NOTES) throw new PayloadLimitError(`The document references more than ${DOCX_MAX_NOTES} ${noteKind}s.`);
    order.push(id);
    this.countInline();
    state.inlines.push({ kind: 'noteRef', noteKind, id, label: String(order.length) });
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
    const image: DocImage = {
      data: loaded.data,
      mime: loaded.mime,
      alt,
      widthPt: extentEmu ? extentEmu[0] / EMU_PER_POINT : undefined,
      heightPt: extentEmu ? extentEmu[1] / EMU_PER_POINT : undefined,
    };
    this.countInline();
    state.inlines.push({ kind: 'image', image });
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

function sameFormat(a: MutableTextInline | DocTextInline, b: MutableTextInline): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.code === b.code &&
    a.superscript === b.superscript &&
    a.subscript === b.subscript &&
    a.href === b.href &&
    a.sizePt === b.sizePt &&
    a.color === b.color
  );
}

/** Drops whitespace at both ends of a paragraph's inline content and empty text runs left by it. */
function trimEdges(inlines: DocInline[]): DocInline[] {
  const result = inlines.slice();
  while (result.length > 0) {
    const head = result[0];
    if (head.kind === 'break' || head.kind === 'anchor') {
      if (head.kind === 'break') {
        result.shift();
        continue;
      }
      break;
    }
    if (head.kind !== 'text') break;
    const trimmed = head.text.replace(/^\s+/, '');
    if (trimmed === '') result.shift();
    else {
      result[0] = { ...head, text: trimmed };
      break;
    }
  }
  while (result.length > 0) {
    const tail = result[result.length - 1];
    if (tail.kind === 'break') {
      result.pop();
      continue;
    }
    if (tail.kind !== 'text') break;
    const trimmed = tail.text.replace(/\s+$/, '');
    if (trimmed === '') result.pop();
    else {
      result[result.length - 1] = { ...tail, text: trimmed };
      break;
    }
  }
  // A paragraph holding only anchors has no content.
  return result.every((inline) => inline.kind === 'anchor') ? [] : result;
}

async function loadImages(
  zip: JSZip,
  relationshipSets: readonly ReadonlyMap<string, Relationship>[],
  warnings: string[]
): Promise<Map<string, { data: Buffer; mime: NonNullable<ReturnType<typeof sniffImageMime>> }>> {
  const images = new Map<string, { data: Buffer; mime: NonNullable<ReturnType<typeof sniffImageMime>> }>();
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
      const mime = sniffImageMime(data);
      if (mime === null) {
        warnings.push(`The image ${rel.target} is not PNG, JPEG, GIF, BMP, TIFF or SVG and was left out.`);
        continue;
      }
      await assertEmbeddableImageWithinLimit(data);
      images.set(rel.target, { data, mime });
    }
  }
  return images;
}

function pageSetupOf(sectPr: XmlElement | undefined): DocModel['page'] {
  if (!sectPr) return undefined;
  const size = firstChild(sectPr, 'pgSz');
  const margins = firstChild(sectPr, 'pgMar');
  const width = readInt(size, 'w');
  const height = readInt(size, 'h');
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return undefined;
  const margin = (name: string): number => (readInt(margins, name) ?? 0) / TWIPS_PER_POINT;
  return {
    widthPt: width / TWIPS_PER_POINT,
    heightPt: height / TWIPS_PER_POINT,
    marginTopPt: margin('top'),
    marginRightPt: margin('right'),
    marginBottomPt: margin('bottom'),
    marginLeftPt: margin('left'),
  };
}

async function readCoreProperties(zip: JSZip, model: DocModel): Promise<void> {
  const root = await readXmlPart(zip, CORE_PROPERTIES_PART);
  if (!root) return;
  const text = (name: string): string | undefined => {
    const value = firstChild(root, name);
    const content = value ? ownText(value).trim() : '';
    return content === '' ? undefined : content;
  };
  model.title = text('title');
  model.author = text('creator');
  const language = text('language');
  if (language !== undefined) model.language = language;
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
 * Reads the DOCX package in `zip` into the block model. A package without a main document part, a part that is not
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

  const model = emptyDocModel();
  const images = await loadImages(zip, [documentRelationships, footnoteRelationships, endnoteRelationships], model.warnings);
  const reader = new DocxReader(styles, numbering, images);

  const body = firstChild(documentRoot, 'body');
  if (!body) throw new DocumentFormatError(`Invalid DOCX package: ${mainPath} has no w:body element.`);
  reader.readBlocks(body, { relationships: documentRelationships }, model.blocks, 0);
  const bodySectPr = firstChild(body, 'sectPr');
  reader.finishSections(bodySectPr);
  model.page = pageSetupOf(bodySectPr);

  const readNotes = async (
    partPath: string,
    relationships: ReadonlyMap<string, Relationship>,
    order: readonly number[],
    elementName: string
  ): Promise<DocNote[]> => {
    if (order.length === 0) return [];
    const root = await readXmlPart(zip, partPath);
    const byId = new Map<number, XmlElement>();
    if (root) for (const note of childElements(root, elementName)) {
      const id = readInt(note, 'id');
      if (id !== undefined && note.attrs.get('type') === undefined) byId.set(id, note);
    }
    const notes: DocNote[] = [];
    order.forEach((id, index) => {
      const element = byId.get(id);
      if (!element) {
        reader.warnings.push(`A ${elementName} reference points at the missing note ${id}.`);
        return;
      }
      const blocks: DocBlock[] = [];
      reader.readBlocks(element, { relationships }, blocks, 0);
      notes.push({ id, label: String(index + 1), blocks });
    });
    return notes;
  };
  model.footnotes = await readNotes(footnotesPath, footnoteRelationships, reader.noteOrder.footnote, 'footnote');
  model.endnotes = await readNotes(endnotesPath, endnoteRelationships, reader.noteOrder.endnote, 'endnote');

  await readCoreProperties(zip, model);
  if (stylesRoot && styles.language !== undefined && model.language === undefined) model.language = styles.language;
  model.warnings.push(...reader.warnings);
  normalizeBodySize(model);
  if (model.bodySizePt === undefined) model.bodySizePt = sizePoints(styles.defaultRun.sizeHalfPoints);
  return { model, drawsShapes: reader.drawsShapes };
}
