import crypto from 'node:crypto';
import JSZip from 'jszip';
import sharp from 'sharp';
import { PayloadLimitError } from '../types';
import { resolveLanguage } from './document-language';
import { redrawAsPng } from './image-to-png';
import {
  IMAGE_FILE_EXTENSION,
  MAX_HEADING_LEVEL,
  MAX_LIST_LEVELS,
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
  type DocTextInline,
} from './document-model';

/**
 * Writes the block model as an OpenDocument text document (ODF 1.3): headings with outline levels, character styles
 * for emphasis, nested lists with their numbering formats and start values, tables with spanned and covered cells,
 * hyperlinks and bookmarks, footnotes and endnotes at their references, pictures in Pictures/ with their original
 * bytes, and page breaks.
 */

/** Most pictures one document may carry. */
export const ODT_WRITER_MAX_IMAGES = 5_000;
const ODF_VERSION = '1.3';
const ODT_MIME = 'application/vnd.oasis.opendocument.text';
const POINTS_PER_CM = 28.3465;
const ODF_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/tiff', 'image/svg+xml']);
const ORDERED_FORMATS: ReadonlyMap<string, string> = new Map([
  ['decimal', '1'],
  ['decimalZero', '1'],
  ['lowerLetter', 'a'],
  ['upperLetter', 'A'],
  ['lowerRoman', 'i'],
  ['upperRoman', 'I'],
  ['ganada', '가, 나, 다, ...'],
  ['chosung', 'ㄱ, ㄴ, ㄷ, ...'],
]);
const ALIGN_STYLES: ReadonlyMap<string, string> = new Map([
  ['center', 'AlignCenter'],
  ['right', 'AlignRight'],
  ['justify', 'AlignJustify'],
]);
const BULLETS: readonly string[] = ['•', '◦', '▪'];
const LEVEL_INDENT_CM = 0.63;

const NAMESPACES = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
  'xmlns:xlink="http://www.w3.org/1999/xlink"',
  'xmlns:dc="http://purl.org/dc/elements/1.1/"',
  'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"',
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
].join(' ');

export interface OdtWriteOptions {
  title: string;
  language?: string;
}

interface Picture {
  path: string;
  mime: string;
  data: Buffer;
}

type ListItem = Extract<DocBlock, { kind: 'listItem' }>;

function textStyleKey(inline: DocTextInline): string {
  return [inline.bold, inline.italic, inline.underline, inline.strike, inline.code, inline.superscript, inline.subscript, inline.color, inline.sizePt].map((value) => String(value ?? '')).join('|');
}

class OdtWriter {
  readonly pictures: Picture[] = [];
  private readonly pictureByHash = new Map<string, Picture>();
  private readonly textStyles = new Map<string, { name: string; xml: string }>();
  private readonly listStyles = new Map<number, string>();
  private frames = 0;
  private bookmarks = 0;
  private tables = 0;
  private readonly noteIds: ReadonlyMap<string, DocNote>;
  private noteCounter = 0;

  constructor(
    private readonly model: DocModel,
    private readonly anchors: ReadonlySet<string>
  ) {
    const notes = new Map<string, DocNote>();
    for (const note of model.footnotes) notes.set(`footnote:${note.id}`, note);
    for (const note of model.endnotes) notes.set(`endnote:${note.id}`, note);
    this.noteIds = notes;
  }

  automaticStyles(): string {
    const text = [...this.textStyles.values()].map((entry) => entry.xml).join('');
    const lists = [...this.listStyles.values()].join('');
    return text + lists;
  }

  private textStyle(inline: DocTextInline): string | undefined {
    const key = textStyleKey(inline);
    if (key === '||||||||') return undefined;
    let entry = this.textStyles.get(key);
    if (!entry) {
      const name = `T${this.textStyles.size + 1}`;
      const props: string[] = [];
      if (inline.bold) props.push('fo:font-weight="bold"');
      if (inline.italic) props.push('fo:font-style="italic"');
      if (inline.underline) props.push('style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"');
      if (inline.strike) props.push('style:text-line-through-style="solid"');
      if (inline.superscript) props.push('style:text-position="super 58%"');
      if (inline.subscript) props.push('style:text-position="sub 58%"');
      if (inline.color) props.push(`fo:color="#${inline.color}"`);
      if (inline.sizePt) props.push(`fo:font-size="${inline.sizePt}pt"`);
      if (inline.code) props.push('style:font-name="Courier New" fo:font-family="\'Courier New\'"');
      entry = { name, xml: `<style:style style:name="${name}" style:family="text"><style:text-properties ${props.join(' ')}/></style:style>` };
      this.textStyles.set(key, entry);
    }
    return entry.name;
  }

  private async picture(image: DocImage): Promise<Picture> {
    const hash = crypto.createHash('sha256').update(image.data).digest('hex');
    const known = this.pictureByHash.get(hash);
    if (known) return known;
    if (this.pictures.length >= ODT_WRITER_MAX_IMAGES) throw new PayloadLimitError(`The document would embed more than ${ODT_WRITER_MAX_IMAGES} pictures.`);
    let { data } = image;
    let mime: string = image.mime;
    if (!ODF_IMAGE_TYPES.has(mime)) {
      data = await redrawAsPng(data, mime);
      mime = 'image/png';
    }
    const picture: Picture = { path: `Pictures/image${this.pictures.length + 1}.${IMAGE_FILE_EXTENSION[mime as DocImage['mime']]}`, mime, data };
    this.pictures.push(picture);
    this.pictureByHash.set(hash, picture);
    return picture;
  }

  private async frame(image: DocImage): Promise<string> {
    const picture = await this.picture(image);
    let widthPt = image.widthPt;
    let heightPt = image.heightPt;
    if (!widthPt || !heightPt) {
      const metadata = await sharp(picture.data).metadata();
      widthPt = (metadata.width ?? 1) * 0.75;
      heightPt = (metadata.height ?? 1) * 0.75;
    }
    this.frames += 1;
    const alt = image.alt === '' ? '' : `<svg:title>${escapeXmlText(stripXmlForbidden(image.alt))}</svg:title>`;
    return (
      `<draw:frame draw:name="Image${this.frames}" text:anchor-type="as-char" svg:width="${(widthPt / POINTS_PER_CM).toFixed(3)}cm" svg:height="${(heightPt / POINTS_PER_CM).toFixed(3)}cm">` +
      `<draw:image xlink:href="${picture.path}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>${alt}</draw:frame>`
    );
  }

  private async inlines(inlines: readonly DocInline[]): Promise<string> {
    let xml = '';
    let index = 0;
    while (index < inlines.length) {
      const inline = inlines[index];
      if (inline.kind === 'text' && inline.href !== undefined && (!inline.href.startsWith('#') || this.anchors.has(inline.href.slice(1)))) {
        const href = inline.href;
        let runs = '';
        while (index < inlines.length) {
          const next = inlines[index];
          if (next.kind !== 'text' || next.href !== href) break;
          runs += this.run(next);
          index += 1;
        }
        xml += `<text:a xlink:type="simple" xlink:href="${escapeXmlAttribute(href)}">${runs}</text:a>`;
        continue;
      }
      switch (inline.kind) {
        case 'text':
          xml += this.run(inline);
          break;
        case 'break':
          xml += '<text:line-break/>';
          break;
        case 'image':
          xml += await this.frame(inline.image);
          break;
        case 'noteRef': {
          const note = this.noteIds.get(`${inline.noteKind}:${inline.id}`);
          if (note) xml += await this.note(inline.noteKind, note);
          break;
        }
        case 'anchor':
          this.bookmarks += 1;
          xml += `<text:bookmark text:name="${escapeXmlAttribute(inline.name)}"/>`;
          break;
      }
      index += 1;
    }
    return xml;
  }

  private run(inline: DocTextInline): string {
    // Spaces and tabs are written as the ODF elements; a run of spaces would otherwise collapse.
    const text = escapeXmlText(stripXmlForbidden(inline.text))
      .replace(/\t/g, '<text:tab/>')
      .replace(/\n/g, '<text:line-break/>')
      .replace(/ {2,}/g, (spaces) => ` <text:s text:c="${spaces.length - 1}"/>`);
    const style = this.textStyle(inline);
    return style ? `<text:span text:style-name="${style}">${text}</text:span>` : text;
  }

  private async note(kind: 'footnote' | 'endnote', note: DocNote): Promise<string> {
    this.noteCounter += 1;
    const body = await this.blocks(note.blocks);
    return `<text:note text:id="${kind}${this.noteCounter}" text:note-class="${kind}"><text:note-citation>${escapeXmlText(note.label)}</text:note-citation><text:note-body>${body}</text:note-body></text:note>`;
  }

  /** Registers the numbering of list `listId` from its items (level formats and start values). */
  private defineLists(blocks: readonly DocBlock[]): void {
    const levels = new Map<number, Map<number, ListItem>>();
    walkBlocks(blocks, (block) => {
      if (block.kind !== 'listItem') return;
      const byLevel = levels.get(block.listId) ?? new Map<number, ListItem>();
      if (!byLevel.has(block.level)) byLevel.set(block.level, block);
      levels.set(block.listId, byLevel);
    });
    for (const [listId, byLevel] of levels) {
      let xml = `<text:list-style style:name="L${listId}">`;
      for (let level = 0; level < MAX_LIST_LEVELS; level += 1) {
        const item = byLevel.get(level);
        const ordered = item ? item.ordered : false;
        const spacing = `<style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="${((level + 1) * LEVEL_INDENT_CM).toFixed(2)}cm" fo:text-indent="-0.5cm" fo:margin-left="${((level + 1) * LEVEL_INDENT_CM).toFixed(2)}cm"/></style:list-level-properties>`;
        if (item && ordered) {
          const format = ORDERED_FORMATS.get(item.format) ?? '1';
          const suffix = item.marker.endsWith(')') ? ')' : '.';
          xml += `<text:list-level-style-number text:level="${level + 1}" style:num-format="${escapeXmlAttribute(format)}" style:num-suffix="${suffix}" text:start-value="${item.number}">${spacing}</text:list-level-style-number>`;
        } else {
          const glyph = item?.marker || BULLETS[level % BULLETS.length];
          xml += `<text:list-level-style-bullet text:level="${level + 1}" text:bullet-char="${escapeXmlAttribute(glyph)}">${spacing}</text:list-level-style-bullet>`;
        }
      }
      xml += '</text:list-style>';
      this.listStyles.set(listId, xml);
    }
  }

  private async list(items: readonly ListItem[]): Promise<string> {
    interface Open {
      ordered: boolean;
      listId: number;
      itemOpen: boolean;
    }
    const stack: Open[] = [];
    let xml = '';
    const closeList = (): void => {
      const top = stack.pop() as Open;
      xml += `${top.itemOpen ? '</text:list-item>' : ''}</text:list>`;
    };
    for (const item of items) {
      const level = Math.min(item.level, stack.length);
      while (stack.length > level + 1) closeList();
      const same = stack.length === level + 1 && stack[level].ordered === item.ordered && stack[level].listId === item.listId;
      if (stack.length === level + 1 && !same) closeList();
      if (stack.length === level + 1) {
        xml += stack[level].itemOpen ? '</text:list-item>' : '';
        stack[level].itemOpen = false;
      } else {
        // Only the outermost list names the style; nested lists inherit it level by level.
        xml += level === 0 ? `<text:list text:style-name="L${item.listId}">` : '<text:list>';
        stack.push({ ordered: item.ordered, listId: item.listId, itemOpen: false });
      }
      xml += `<text:list-item><text:p>${await this.inlines(item.inlines)}</text:p>`;
      stack[stack.length - 1].itemOpen = true;
    }
    while (stack.length > 0) closeList();
    return xml;
  }

  private async table(block: Extract<DocBlock, { kind: 'table' }>): Promise<string> {
    this.tables += 1;
    const columns = Math.max(block.columnCount, 1);
    let xml = `<table:table table:name="Table${this.tables}" table:style-name="Tbl"><table:table-column table:number-columns-repeated="${columns}"/>`;
    const slots = tableSlots(block);
    let inHeader = false;
    for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex += 1) {
      const row = block.rows[rowIndex];
      if (row.header && !inHeader) {
        xml += '<table:table-header-rows>';
        inHeader = true;
      } else if (!row.header && inHeader) {
        xml += '</table:table-header-rows>';
        inHeader = false;
      }
      xml += '<table:table-row>';
      for (const slot of slots[rowIndex]) {
        if (slot === null) {
          xml += '<table:table-cell table:style-name="Cell" office:value-type="string"><text:p/></table:table-cell>';
        } else if (slot.kind === 'origin') {
          const span = `${slot.cell.colSpan > 1 ? ` table:number-columns-spanned="${slot.cell.colSpan}"` : ''}${slot.cell.rowSpan > 1 ? ` table:number-rows-spanned="${slot.cell.rowSpan}"` : ''}`;
          const content = await this.blocks(slot.cell.blocks);
          xml += `<table:table-cell table:style-name="Cell" office:value-type="string"${span}>${content === '' ? '<text:p/>' : content}</table:table-cell>`;
        } else {
          xml += '<table:covered-table-cell/>';
        }
      }
      xml += '</table:table-row>';
    }
    if (inHeader) xml += '</table:table-header-rows>';
    return `${xml}</table:table>`;
  }

  async blocks(blocks: readonly DocBlock[]): Promise<string> {
    let xml = '';
    let index = 0;
    while (index < blocks.length) {
      const block = blocks[index];
      if (block.kind === 'listItem') {
        let end = index;
        while (end < blocks.length && blocks[end].kind === 'listItem') end += 1;
        xml += await this.list(blocks.slice(index, end) as ListItem[]);
        index = end;
        continue;
      }
      index += 1;
      switch (block.kind) {
        case 'heading': {
          const level = Math.min(Math.max(block.level, 1), MAX_HEADING_LEVEL);
          xml += `<text:h text:style-name="Heading_20_${level}" text:outline-level="${level}">${await this.inlines(block.inlines)}</text:h>`;
          break;
        }
        case 'paragraph': {
          const align = block.align && block.align !== 'left' ? ALIGN_STYLES.get(block.align) : undefined;
          xml += `<text:p${align ? ` text:style-name="${align}"` : ''}>${await this.inlines(block.inlines)}</text:p>`;
          break;
        }
        case 'table':
          xml += await this.table(block);
          break;
        case 'code':
          xml += block.text
            .split('\n')
            .map((line) => `<text:p text:style-name="Code">${escapeXmlText(stripXmlForbidden(line)).replace(/ {2,}/g, (spaces) => ` <text:s text:c="${spaces.length - 1}"/>`)}</text:p>`)
            .join('');
          break;
        case 'quote':
          xml += (await this.blocks(block.blocks)).replace(/<text:p>/g, '<text:p text:style-name="Quotations">');
          break;
        case 'rule':
          xml += '<text:p text:style-name="Rule"/>';
          break;
        case 'pageBreak':
          xml += '<text:p text:style-name="PageBreak"/>';
          break;
        case 'sectionBreak':
          if (block.sectionType !== 'continuous' && block.sectionType !== 'nextColumn') xml += '<text:p text:style-name="PageBreak"/>';
          break;
      }
    }
    return xml;
  }

  prepare(): void {
    this.defineLists(this.model.blocks);
    for (const note of [...this.model.footnotes, ...this.model.endnotes]) this.defineLists(note.blocks);
  }
}

function fixedStyles(language: string | undefined): string {
  const [languageCode, country] = (language ?? '').split('-');
  const locale = languageCode ? ` fo:language="${escapeXmlAttribute(languageCode)}"${country && country.length === 2 ? ` fo:country="${escapeXmlAttribute(country.toUpperCase())}"` : ''}` : '';
  const heading = (level: number, size: number): string =>
    `<style:style style:name="Heading_20_${level}" style:display-name="Heading ${level}" style:family="paragraph" style:parent-style-name="Standard" style:next-style-name="Standard" style:default-outline-level="${level}"><style:paragraph-properties fo:margin-top="0.4cm" fo:margin-bottom="0.15cm" fo:keep-with-next="always"/><style:text-properties fo:font-size="${size}pt" fo:font-weight="bold"/></style:style>`;
  return (
    '<style:default-style style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.2cm"/>' +
    `<style:text-properties fo:font-size="11pt"${locale}/></style:default-style>` +
    '<style:style style:name="Standard" style:family="paragraph" style:class="text"/>' +
    heading(1, 18) +
    heading(2, 16) +
    heading(3, 14) +
    heading(4, 12) +
    heading(5, 11) +
    heading(6, 11) +
    '<style:style style:name="Quotations" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-left="1cm" fo:margin-right="1cm"/></style:style>' +
    '<style:style style:name="Code" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-bottom="0cm"/><style:text-properties style:font-name="Courier New" fo:font-family="\'Courier New\'" fo:font-size="10pt"/></style:style>' +
    '<style:style style:name="Rule" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:border-bottom="0.5pt solid #000000" fo:padding-bottom="0.1cm"/></style:style>' +
    '<style:style style:name="PageBreak" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:break-after="page" fo:margin-bottom="0cm"/></style:style>' +
    '<style:style style:name="AlignCenter" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="center"/></style:style>' +
    '<style:style style:name="AlignRight" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="end"/></style:style>' +
    '<style:style style:name="AlignJustify" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="justify"/></style:style>'
  );
}

/** Writes the document. A language that is not a BCP 47 tag, or more pictures than the limit, is refused with a typed error. */
export async function writeOdt(model: DocModel, options: OdtWriteOptions): Promise<Buffer> {
  const language = resolveLanguage(model, options.language);
  const title = stripXmlForbidden((model.title ?? options.title).trim() || options.title);
  const anchors = new Set<string>();
  const collect = (block: DocBlock): void => {
    if (block.kind !== 'heading' && block.kind !== 'paragraph' && block.kind !== 'listItem') return;
    for (const inline of block.inlines) if (inline.kind === 'anchor') anchors.add(inline.name);
  };
  walkBlocks(model.blocks, collect);
  for (const note of [...model.footnotes, ...model.endnotes]) walkBlocks(note.blocks, collect);

  const writer = new OdtWriter(model, anchors);
  writer.prepare();
  const body = await writer.blocks(model.blocks);

  const zip = new JSZip();
  const add = (name: string, data: string | Buffer, extra: JSZip.JSZipFileOptions = {}): void => {
    zip.file(name, data, { createFolders: false, ...extra });
  };
  add('mimetype', ODT_MIME, { compression: 'STORE' });
  const manifest = [
    `<manifest:file-entry manifest:full-path="/" manifest:version="${ODF_VERSION}" manifest:media-type="${ODT_MIME}"/>`,
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>',
    '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>',
    '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>',
    ...writer.pictures.map((picture) => `<manifest:file-entry manifest:full-path="${picture.path}" manifest:media-type="${picture.mime}"/>`),
  ];
  add(
    'META-INF/manifest.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="${ODF_VERSION}">${manifest.join('')}</manifest:manifest>`
  );
  const created = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  add(
    'meta.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-meta ${NAMESPACES} office:version="${ODF_VERSION}"><office:meta><dc:title>${escapeXmlText(title)}</dc:title>` +
      (model.author ? `<dc:creator>${escapeXmlText(stripXmlForbidden(model.author))}</dc:creator>` : '') +
      (language ? `<dc:language>${escapeXmlText(language)}</dc:language>` : '') +
      `<meta:creation-date>${created}</meta:creation-date></office:meta></office:document-meta>`
  );
  add(
    'styles.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles ${NAMESPACES} office:version="${ODF_VERSION}">` +
      '<office:font-face-decls><style:font-face style:name="Courier New" svg:font-family="\'Courier New\'"/></office:font-face-decls>' +
      `<office:styles>${fixedStyles(language)}</office:styles></office:document-styles>`
  );
  add(
    'content.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${NAMESPACES} office:version="${ODF_VERSION}">` +
      '<office:font-face-decls><style:font-face style:name="Courier New" svg:font-family="\'Courier New\'"/></office:font-face-decls>' +
      `<office:automatic-styles>${writer.automaticStyles()}` +
      '<style:style style:name="Tbl" style:family="table"><style:table-properties style:width="17cm" table:align="margins"/></style:style>' +
      '<style:style style:name="Cell" style:family="table-cell"><style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.1cm"/></style:style>' +
      `</office:automatic-styles><office:body><office:text>${body}</office:text></office:body></office:document-content>`
  );
  for (const picture of writer.pictures) add(picture.path, picture.data);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
