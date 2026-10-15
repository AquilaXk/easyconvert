import JSZip from 'jszip';
import { SaxesParser, type SaxesTagPlain } from 'saxes';

/**
 * An independent reader of the structure of a DOCX file (ECMA-376 Part 1): headings, list paragraphs, tables and
 * the number of columns, from `word/document.xml`, `styles.xml` and `numbering.xml`. It shares no code with the writer
 * under test and reads files written by other producers too, so the same reader scores both sides of a comparison.
 */

export interface DocxParagraph {
  text: string;
  /** 1 to 9 for a heading (a heading style or an outline level), else null. */
  headingLevel: number | null;
  /** The kind of list the paragraph belongs to, from its numbering definition, else null. */
  list: 'bullet' | 'ordered' | null;
  inTable: boolean;
}

export interface DocxStructure {
  /** Body paragraphs in document order (those inside table cells are flagged `inTable`). */
  paragraphs: DocxParagraph[];
  /** Tables as rows of cell texts; merged cells appear once. */
  tables: string[][][];
  /** The most columns any section of the document sets. */
  maxColumns: number;
}

interface StyleInfo {
  name: string;
  outlineLevel: number | null;
}

const OUTLINE_TO_HEADING = 1;
const HEADING_STYLE_NAME = /^heading\s*(\d)$/i;

function attrOf(tag: SaxesTagPlain, name: string): string | undefined {
  const value = tag.attributes[name];
  return typeof value === 'string' ? value : undefined;
}

function parseXml(xml: string, onOpen: (tag: SaxesTagPlain) => void, onClose: (tag: SaxesTagPlain) => void, onText: (text: string) => void): void {
  const parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', (tag) => onOpen(tag as SaxesTagPlain));
  parser.on('closetag', (tag) => onClose(tag as SaxesTagPlain));
  parser.on('text', onText);
  parser.on('error', (error) => {
    throw error;
  });
  parser.write(xml).close();
}

function readStyles(xml: string | undefined): Map<string, StyleInfo> {
  const styles = new Map<string, StyleInfo>();
  if (!xml) return styles;
  let current: { id: string; name: string; outline: number | null } | null = null;
  parseXml(
    xml,
    (tag) => {
      if (tag.name === 'w:style') current = { id: attrOf(tag, 'w:styleId') ?? '', name: '', outline: null };
      else if (current && tag.name === 'w:name') current.name = attrOf(tag, 'w:val') ?? '';
      else if (current && tag.name === 'w:outlineLvl') current.outline = Number(attrOf(tag, 'w:val'));
    },
    (tag) => {
      if (tag.name === 'w:style' && current) {
        styles.set(current.id, { name: current.name, outlineLevel: current.outline });
        current = null;
      }
    },
    () => undefined
  );
  return styles;
}

/** For each numId, whether the first numbering format of its abstract definition is a bullet. */
function readNumbering(xml: string | undefined): Map<string, 'bullet' | 'ordered'> {
  const kinds = new Map<string, 'bullet' | 'ordered'>();
  if (!xml) return kinds;
  const abstractKinds = new Map<string, 'bullet' | 'ordered'>();
  let abstractId = '';
  let numId = '';
  parseXml(
    xml,
    (tag) => {
      if (tag.name === 'w:abstractNum') {
        abstractId = attrOf(tag, 'w:abstractNumId') ?? '';
      } else if (tag.name === 'w:numFmt' && abstractId !== '' && !abstractKinds.has(abstractId)) {
        abstractKinds.set(abstractId, attrOf(tag, 'w:val') === 'bullet' ? 'bullet' : 'ordered');
      } else if (tag.name === 'w:num') {
        numId = attrOf(tag, 'w:numId') ?? '';
      } else if (tag.name === 'w:abstractNumId' && numId !== '') {
        const kind = abstractKinds.get(attrOf(tag, 'w:val') ?? '');
        if (kind) kinds.set(numId, kind);
      }
    },
    (tag) => {
      if (tag.name === 'w:abstractNum') abstractId = '';
      if (tag.name === 'w:num') numId = '';
    },
    () => undefined
  );
  return kinds;
}

interface OpenParagraph {
  text: string;
  style: string | null;
  numId: string | null;
  outline: number | null;
}

export async function readDocxStructure(docx: Buffer): Promise<DocxStructure> {
  const zip = await JSZip.loadAsync(docx);
  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (!documentXml) throw new Error('word/document.xml is missing');
  const styles = readStyles(await zip.file('word/styles.xml')?.async('string'));
  const numbering = readNumbering(await zip.file('word/numbering.xml')?.async('string'));

  const paragraphs: DocxParagraph[] = [];
  const tables: string[][][] = [];
  let maxColumns = 1;
  let tableDepth = 0;
  let table: string[][] | null = null;
  let row: string[] | null = null;
  let cell: string[] | null = null;
  let paragraph: OpenParagraph | null = null;
  let inText = false;

  const headingLevelOf = (open: OpenParagraph): number | null => {
    const style = open.style ? styles.get(open.style) : undefined;
    const named = HEADING_STYLE_NAME.exec(style?.name ?? open.style ?? '');
    if (named) return Number(named[1]);
    const outline = open.outline ?? style?.outlineLevel ?? null;
    return outline !== null && outline < 9 ? outline + OUTLINE_TO_HEADING : null;
  };

  parseXml(
    documentXml,
    (tag) => {
      switch (tag.name) {
        case 'w:tbl':
          tableDepth++;
          if (tableDepth === 1) table = [];
          break;
        case 'w:tr':
          if (tableDepth === 1) row = [];
          break;
        case 'w:tc':
          if (tableDepth === 1) cell = [];
          break;
        case 'w:p':
          paragraph = { text: '', style: null, numId: null, outline: null };
          break;
        case 'w:pStyle':
          if (paragraph) paragraph.style = attrOf(tag, 'w:val') ?? null;
          break;
        case 'w:numId':
          if (paragraph && attrOf(tag, 'w:val') !== '0') paragraph.numId = attrOf(tag, 'w:val') ?? null;
          break;
        case 'w:outlineLvl':
          if (paragraph) paragraph.outline = Number(attrOf(tag, 'w:val'));
          break;
        case 'w:t':
          inText = true;
          break;
        case 'w:tab':
          if (paragraph) paragraph.text += ' ';
          break;
        case 'w:cols': {
          const count = Number(attrOf(tag, 'w:num') ?? '1');
          if (Number.isFinite(count)) maxColumns = Math.max(maxColumns, count);
          break;
        }
        default:
          break;
      }
    },
    (tag) => {
      switch (tag.name) {
        case 'w:t':
          inText = false;
          break;
        case 'w:p':
          if (paragraph) {
            const inTable = tableDepth > 0;
            if (inTable && cell) cell.push(paragraph.text);
            paragraphs.push({
              text: paragraph.text,
              headingLevel: headingLevelOf(paragraph),
              list: paragraph.numId ? (numbering.get(paragraph.numId) ?? 'ordered') : null,
              inTable,
            });
            paragraph = null;
          }
          break;
        case 'w:tc':
          if (tableDepth === 1 && row && cell) {
            row.push(cell.filter((text) => text.trim() !== '').join(' '));
            cell = null;
          }
          break;
        case 'w:tr':
          if (tableDepth === 1 && table && row) {
            table.push(row);
            row = null;
          }
          break;
        case 'w:tbl':
          if (tableDepth === 1 && table) {
            tables.push(table);
            table = null;
          }
          tableDepth--;
          break;
        default:
          break;
      }
    },
    (text) => {
      if (inText && paragraph) paragraph.text += text;
    }
  );
  return { paragraphs, tables, maxColumns };
}
