import crypto from 'node:crypto';
import JSZip from 'jszip';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { emptyStructure, normalizeText, structureOfHtml, type DocumentStructure } from './structure-metrics';

/**
 * Reads the structure of finished DOCX, ODT and EPUB files for the benchmark: headings with their level, list items
 * with their nesting level, table cells with their spans, pictures by content hash and note texts. The readers walk
 * the XML parts with a generic SAX parser and use no code of the converters, so the same reader scores this
 * project's output and the reference tool's.
 */

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const TEXT = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const TABLE = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
const DRAW = 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0';
const XLINK = 'http://www.w3.org/1999/xlink';
const HEADING_STYLE = /^(?:heading|überschrift)\s*(\d)$/i;

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function attr(tag: SaxesTagNS, uri: string, local: string): string | undefined {
  for (const entry of Object.values(tag.attributes)) if (entry.uri === uri && entry.local === local) return entry.value;
  return undefined;
}

function walk(xml: string, onOpen: (tag: SaxesTagNS) => void, onClose: (tag: SaxesTagNS) => void, onText: (text: string) => void): void {
  const parser = new SaxesParser({ xmlns: true });
  parser.on('error', (error) => {
    throw error;
  });
  parser.on('opentag', onOpen);
  parser.on('closetag', onClose);
  parser.on('text', onText);
  parser.write(xml).close();
}

async function text(zip: JSZip, name: string): Promise<string | undefined> {
  const entry = zip.file(name);
  return entry ? entry.async('string') : undefined;
}

function relationships(xml: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!xml) return map;
  walk(xml, (tag) => {
    const id = attr(tag, '', 'Id');
    const target = attr(tag, '', 'Target');
    if (tag.local === 'Relationship' && id && target) map.set(id, target);
  }, () => undefined, () => undefined);
  return map;
}

interface DocxCell {
  column: number;
  colSpan: number;
  merge: 'restart' | 'continue' | null;
  text: string;
  rowSpan: number;
}

/** Structure of a DOCX: headings by style, list items by numbering, table cells with merges, pictures and note texts. */
export async function structureOfDocx(bytes: Buffer): Promise<DocumentStructure> {
  const zip = await JSZip.loadAsync(bytes);
  const structure = emptyStructure();
  interface StyleInfo {
    name: string;
    basedOn?: string;
    outline?: number;
    numId?: string;
  }
  const styles = new Map<string, StyleInfo>();
  const stylesXml = await text(zip, 'word/styles.xml');
  if (stylesXml) {
    let current = '';
    walk(stylesXml, (tag) => {
      if (tag.uri !== W) return;
      if (tag.local === 'style') {
        current = attr(tag, W, 'styleId') ?? '';
        styles.set(current, { name: current });
      } else if (!current) return;
      else if (tag.local === 'name') (styles.get(current) as StyleInfo).name = attr(tag, W, 'val') ?? current;
      else if (tag.local === 'basedOn') (styles.get(current) as StyleInfo).basedOn = attr(tag, W, 'val');
      else if (tag.local === 'outlineLvl') (styles.get(current) as StyleInfo).outline = Number(attr(tag, W, 'val') ?? '9');
      else if (tag.local === 'numId') (styles.get(current) as StyleInfo).numId = attr(tag, W, 'val');
    }, (tag) => {
      if (tag.uri === W && tag.local === 'style') current = '';
    }, () => undefined);
  }
  /** Style properties along the basedOn chain, closest first. */
  const chainOf = (id: string): StyleInfo[] => {
    const chain: StyleInfo[] = [];
    for (let at: string | undefined = id; at !== undefined && chain.length < 32; at = chain[chain.length - 1].basedOn) {
      const info = styles.get(at);
      if (!info) break;
      chain.push(info);
    }
    return chain;
  };
  const numberingXml = await text(zip, 'word/numbering.xml');
  const abstractOf = new Map<string, string>();
  const formats = new Map<string, string>();
  if (numberingXml) {
    let abstractId = '';
    let numId = '';
    let level = '';
    walk(numberingXml, (tag) => {
      if (tag.local === 'abstractNum') abstractId = attr(tag, W, 'abstractNumId') ?? '';
      else if (tag.local === 'lvl') level = attr(tag, W, 'ilvl') ?? '';
      else if (tag.local === 'numFmt' && abstractId) formats.set(`${abstractId}:${level}`, attr(tag, W, 'val') ?? '');
      else if (tag.local === 'num') numId = attr(tag, W, 'numId') ?? '';
      else if (tag.local === 'abstractNumId' && numId) abstractOf.set(numId, attr(tag, W, 'val') ?? '');
    }, (tag) => {
      if (tag.local === 'abstractNum') abstractId = '';
      if (tag.local === 'num') numId = '';
    }, () => undefined);
  }
  const rels = relationships(await text(zip, 'word/_rels/document.xml.rels'));
  const documentXml = await text(zip, 'word/document.xml');
  if (!documentXml) return structure;

  const imageTargets: string[] = [];
  let tableDepth = 0;
  const rows: DocxCell[][][] = [];
  let currentCell: DocxCell | null = null;
  let paragraph = { style: '', numId: '', level: '', text: '' };
  let cellColumn = 0;
  let inText = false;
  walk(documentXml, (tag) => {
    if (tag.uri === W) {
      if (tag.local === 'tbl') {
        tableDepth += 1;
        if (tableDepth === 1) rows.push([]);
      } else if (tag.local === 'tr' && tableDepth === 1) rows[rows.length - 1].push([]);
      else if (tag.local === 'tc' && tableDepth === 1) {
        currentCell = { column: cellColumn, colSpan: 1, merge: null, text: '', rowSpan: 1 };
      } else if (tag.local === 'gridSpan' && currentCell) currentCell.colSpan = Number(attr(tag, W, 'val') ?? '1');
      else if (tag.local === 'vMerge' && currentCell) currentCell.merge = attr(tag, W, 'val') === 'restart' ? 'restart' : 'continue';
      else if (tag.local === 'p') paragraph = { style: '', numId: '', level: '0', text: '' };
      else if (tag.local === 'pStyle') paragraph.style = attr(tag, W, 'val') ?? '';
      else if (tag.local === 'numId') paragraph.numId = attr(tag, W, 'val') ?? '';
      else if (tag.local === 'ilvl') paragraph.level = attr(tag, W, 'val') ?? '0';
      else if (tag.local === 't') inText = true;
    } else if (tag.uri === A && tag.local === 'blip') {
      const target = rels.get(attr(tag, R, 'embed') ?? '');
      if (target) imageTargets.push(target);
    }
  }, (tag) => {
    if (tag.uri !== W) return;
    if (tag.local === 't') inText = false;
    else if (tag.local === 'tc' && tableDepth === 1 && currentCell) {
      const row = rows[rows.length - 1].at(-1) as DocxCell[];
      row.push(currentCell);
      cellColumn = currentCell.column + currentCell.colSpan;
      currentCell = null;
    } else if (tag.local === 'tr' && tableDepth === 1) cellColumn = 0;
    else if (tag.local === 'tbl') tableDepth -= 1;
    else if (tag.local === 'p') {
      if (currentCell) {
        currentCell.text += `${currentCell.text === '' ? '' : ' '}${paragraph.text}`;
      } else if (tableDepth === 0) {
        const chain = chainOf(paragraph.style);
        const name = chain[0]?.name ?? paragraph.style;
        const heading = chain.map((info) => HEADING_STYLE.exec(info.name)).find((match) => match !== null);
        const outline = chain.find((info) => info.outline !== undefined && info.outline < 9)?.outline;
        const body = normalizeText(paragraph.text);
        if (paragraph.numId === '') paragraph.numId = chain.find((info) => info.numId !== undefined)?.numId ?? '';
        if (body === '') return;
        if (heading) structure.headings.push(`${heading[1]}|${body}`);
        else if (name.toLowerCase() === 'title') structure.headings.push(`1|${body}`);
        else if (outline !== undefined) structure.headings.push(`${outline + 1}|${body}`);
        else if (paragraph.numId !== '' && paragraph.numId !== '0') {
          const format = formats.get(`${abstractOf.get(paragraph.numId) ?? ''}:${paragraph.level}`) ?? 'decimal';
          structure.listItems.push(`${paragraph.level}|${format === 'bullet' ? 'ul' : 'ol'}|${body}`);
        }
      }
    }
  }, (value) => {
    if (inText) paragraph.text += value;
  });
  for (const table of rows) {
    table.forEach((row, rowIndex) => {
      for (const cell of row) {
        if (cell.merge === 'continue') continue;
        if (cell.merge === 'restart') {
          for (let below = rowIndex + 1; below < table.length; below += 1) {
            const continued = table[below].find((candidate) => candidate.column === cell.column && candidate.merge === 'continue');
            if (!continued) break;
            cell.rowSpan += 1;
          }
        }
        structure.tableCells.push(`${normalizeText(cell.text)}|${cell.colSpan}|${cell.rowSpan}`);
      }
    });
  }
  for (const target of imageTargets) {
    const entry = zip.file(`word/${target}`) ?? zip.file(target.replace(/^\//, ''));
    if (entry) structure.images.push(sha256(Buffer.from(await entry.async('uint8array'))));
  }
  for (const part of ['word/footnotes.xml', 'word/endnotes.xml']) {
    const xml = await text(zip, part);
    if (!xml) continue;
    let noteType: string | undefined;
    let inNote = false;
    let noteText = '';
    let inT = false;
    walk(xml, (tag) => {
      if (tag.uri !== W) return;
      if (tag.local === 'footnote' || tag.local === 'endnote') {
        noteType = attr(tag, W, 'type');
        inNote = noteType === undefined;
        noteText = '';
      } else if (tag.local === 't') inT = true;
    }, (tag) => {
      if (tag.uri !== W) return;
      if (tag.local === 't') inT = false;
      if ((tag.local === 'footnote' || tag.local === 'endnote') && inNote) {
        structure.notes.push(normalizeText(noteText).replace(/^(?:\d+\s*|[ivx]+\s+|[ivx]+(?=[A-Z]))/, ''));
        inNote = false;
      }
    }, (value) => {
      if (inNote && inT) noteText += value;
    });
  }
  return structure;
}

/** Structure of an ODT: headings by outline level, list items by list nesting, table cells with spans, pictures and notes. */
export async function structureOfOdt(bytes: Buffer): Promise<DocumentStructure> {
  const zip = await JSZip.loadAsync(bytes);
  const structure = emptyStructure();
  const content = await text(zip, 'content.xml');
  if (!content) return structure;
  const stylesXml = (await text(zip, 'styles.xml')) ?? '';
  // Which level of which list style is numbered: "style:level" to true.
  const numbered = new Map<string, boolean>();
  for (const xml of [content, stylesXml]) {
    if (xml === '') continue;
    let style = '';
    walk(xml, (tag) => {
      if (tag.uri === TEXT && tag.local === 'list-style') style = attr(tag, 'urn:oasis:names:tc:opendocument:xmlns:style:1.0', 'name') ?? '';
      else if (tag.uri === TEXT && tag.local.startsWith('list-level-style-') && style) {
        numbered.set(`${style}:${attr(tag, TEXT, 'level')}`, tag.local === 'list-level-style-number');
      }
    }, () => undefined, () => undefined);
  }

  interface Open {
    kind: 'h' | 'p' | 'cell' | 'note' | 'item';
    text: string;
    slot?: number;
    level?: number;
    ordered?: boolean;
    colSpan?: number;
    rowSpan?: number;
  }
  const stack: Open[] = [];
  const listStyles: string[] = [];
  let listDepth = 0;
  let noteDepth = 0;
  const pictures: string[] = [];
  const itemSlots: string[] = [];
  walk(content, (tag) => {
    if (tag.uri === TEXT && tag.local === 'list') {
      const style = attr(tag, TEXT, 'style-name');
      listStyles.push(style ?? listStyles.at(-1) ?? '');
      listDepth += 1;
    } else if (tag.uri === TEXT && tag.local === 'list-item') {
      const style = listStyles.at(-1) ?? '';
      // The item keeps its place in reading order; nested items finish before it does.
      itemSlots.push('');
      stack.push({ kind: 'item', text: '', level: listDepth - 1, ordered: numbered.get(`${style}:${listDepth}`) ?? false, slot: itemSlots.length - 1 });
    } else if (tag.uri === TEXT && tag.local === 'h') stack.push({ kind: 'h', text: '', level: Number(attr(tag, TEXT, 'outline-level') ?? '1') });
    else if (tag.uri === TEXT && tag.local === 'p') stack.push({ kind: 'p', text: '' });
    else if (tag.uri === TEXT && tag.local === 'note') {
      noteDepth += 1;
      stack.push({ kind: 'note', text: '' });
    }
    else if (tag.uri === TABLE && tag.local === 'table-cell') {
      stack.push({ kind: 'cell', text: '', colSpan: Number(attr(tag, TABLE, 'number-columns-spanned') ?? '1'), rowSpan: Number(attr(tag, TABLE, 'number-rows-spanned') ?? '1') });
    } else if (tag.uri === DRAW && tag.local === 'image') {
      const href = attr(tag, XLINK, 'href');
      if (href) pictures.push(href);
    }
  }, (tag) => {
    if (tag.uri === TEXT && tag.local === 'list') {
      listStyles.pop();
      listDepth -= 1;
    } else if (tag.uri === TEXT && tag.local === 'list-item') {
      const item = stack.pop() as Open;
      const body = normalizeText(item.text);
      if (body !== '' && noteDepth === 0) itemSlots[item.slot as number] = `${item.level}|${item.ordered ? 'ol' : 'ul'}|${body}`;
      const parent = [...stack].reverse().find((entry) => entry.kind === 'cell');
      if (parent) parent.text += ` ${item.text}`;
    } else if (tag.uri === TEXT && tag.local === 'h') {
      const heading = stack.pop() as Open;
      const body = normalizeText(heading.text);
      if (body !== '' && noteDepth === 0) structure.headings.push(`${heading.level}|${body}`);
    } else if (tag.uri === TEXT && tag.local === 'p') {
      const paragraph = stack.pop() as Open;
      const holder = stack.at(-1);
      if (holder) holder.text += ` ${paragraph.text}`;
    } else if (tag.uri === TEXT && tag.local === 'note') {
      const note = stack.pop() as Open;
      noteDepth -= 1;
      structure.notes.push(normalizeText(note.text).replace(/^(?:\d+\s*|[ivx]+\s+|[ivx]+(?=[A-Z]))/, ''));
    } else if (tag.uri === TABLE && tag.local === 'table-cell') {
      const cell = stack.pop() as Open;
      if (!stack.some((entry) => entry.kind === 'cell')) structure.tableCells.push(`${normalizeText(cell.text)}|${cell.colSpan}|${cell.rowSpan}`);
      const outer = stack.at(-1);
      if (outer) outer.text += ` ${cell.text}`;
    }
  }, (value) => {
    const top = stack.at(-1);
    if (top) top.text += value;
  });
  structure.listItems.push(...itemSlots.filter((entry) => entry !== ''));
  for (const href of pictures) {
    const entry = zip.file(href);
    if (entry) structure.images.push(sha256(Buffer.from(await entry.async('uint8array'))));
  }
  return structure;
}

function resolvePath(base: string, relative: string): string {
  const parts = `${base.slice(0, base.lastIndexOf('/') + 1)}${relative.split('#')[0]}`.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part !== '.' && part !== '') out.push(part);
  }
  return out.join('/');
}

/** Structure of an EPUB: the content documents of its spine read as HTML, pictures resolved inside the package. */
export async function structureOfEpub(bytes: Buffer): Promise<DocumentStructure> {
  const zip = await JSZip.loadAsync(bytes);
  const structure = emptyStructure();
  const container = (await text(zip, 'META-INF/container.xml')) ?? '';
  const opfPath = /full-path="([^"]+)"/.exec(container)?.[1];
  if (!opfPath) return structure;
  const opf = (await text(zip, opfPath)) ?? '';
  const manifest = new Map<string, { href: string; properties: string }>();
  for (const match of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = /\bid="([^"]+)"/.exec(match[0])?.[1];
    const href = /\bhref="([^"]+)"/.exec(match[0])?.[1];
    if (id && href) manifest.set(id, { href, properties: /\bproperties="([^"]*)"/.exec(match[0])?.[1] ?? '' });
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)].map((match) => match[1]);
  const cache = new Map<string, Buffer>();
  for (const idref of spine) {
    const item = manifest.get(idref);
    if (!item || item.properties.split(' ').includes('nav')) continue;
    const path = resolvePath(opfPath, item.href);
    const html = await text(zip, path);
    if (!html) continue;
    for (const match of html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)) {
      const imagePath = resolvePath(path, match[1]);
      const entry = zip.file(imagePath);
      if (entry && !cache.has(match[1])) cache.set(match[1], Buffer.from(await entry.async('uint8array')));
    }
    const part = structureOfHtml(html, (src) => cache.get(src));
    for (const key of Object.keys(structure) as (keyof DocumentStructure)[]) structure[key].push(...part[key]);
  }
  return structure;
}
