import JSZip from 'jszip';
import sharp from 'sharp';
import { PayloadLimitError } from '../../types';
import { resolveLanguage } from '../document-language';
import { MAX_HEADING_LEVEL, MAX_LIST_LEVELS } from './model';
import type { Block, DocumentImage, DocumentModel, ImageFormat, Inline, ListBlock, NoteDefinition, TableBlock } from './model';
import { IMAGE_EXTENSION, IMAGE_MIME, bodyBlocks, cellBlocks, imagesById, walkBlocks, walkRuns } from './support';
import { escapeXmlText } from './xml-text';

/**
 * Writes the document model as an OpenDocument text document (ODF 1.3): headings with outline levels, character
 * styles for emphasis, nested lists with their numbering formats and start values, tables with spanned and covered
 * cells, hyperlinks and bookmarks, footnotes and endnotes at their references, pictures in Pictures/ with their
 * original bytes, and page breaks.
 */

/** Most pictures one document may carry. */
export const ODT_WRITER_MAX_IMAGES = 5_000;
const ODF_VERSION = '1.3';
const ODT_MIME = 'application/vnd.oasis.opendocument.text';
const POINTS_PER_CM = 28.3465;
const POINTS_PER_PIXEL = 0.75;
const escapeXmlAttribute = escapeXmlText;
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
/** Section starts that begin a new page. */
const PAGE_STARTING_SECTIONS: ReadonlySet<string> = new Set(['nextPage', 'evenPage', 'oddPage']);

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
  data: Uint8Array;
  format: ImageFormat;
}

function textStyleKey(run: Inline): string {
  return [run.bold, run.italic, run.underline, run.strike, run.monospace, run.superscript, run.subscript, run.color, run.sizePt].map((value) => String(value ?? '')).join('|');
}

class OdtWriter {
  readonly pictures: Picture[] = [];
  private readonly pictureById = new Map<number, Picture>();
  private readonly textStyles = new Map<string, { name: string; xml: string }>();
  private readonly listStyles = new Map<number, string>();
  private frames = 0;
  private tables = 0;
  private readonly noteById: ReadonlyMap<string, NoteDefinition>;
  private noteCounter = 0;
  private readonly images: ReadonlyMap<number, DocumentImage>;

  constructor(
    private readonly model: DocumentModel,
    private readonly anchors: ReadonlySet<string>
  ) {
    const notes = new Map<string, NoteDefinition>();
    for (const note of model.footnotes ?? []) notes.set(`footnote:${note.id}`, note);
    for (const note of model.endnotes ?? []) notes.set(`endnote:${note.id}`, note);
    this.noteById = notes;
    this.images = imagesById(model);
  }

  automaticStyles(): string {
    const text = [...this.textStyles.values()].map((entry) => entry.xml).join('');
    const lists = [...this.listStyles.values()].join('');
    return text + lists;
  }

  private textStyle(run: Inline): string | undefined {
    const key = textStyleKey(run);
    if (key === '||||||||') return undefined;
    let entry = this.textStyles.get(key);
    if (!entry) {
      const name = `T${this.textStyles.size + 1}`;
      const props: string[] = [];
      if (run.bold) props.push('fo:font-weight="bold"');
      if (run.italic) props.push('fo:font-style="italic"');
      if (run.underline) props.push('style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"');
      if (run.strike) props.push('style:text-line-through-style="solid"');
      if (run.superscript) props.push('style:text-position="super 58%"');
      if (run.subscript) props.push('style:text-position="sub 58%"');
      if (run.color) props.push(`fo:color="#${run.color}"`);
      if (run.sizePt) props.push(`fo:font-size="${run.sizePt}pt"`);
      if (run.monospace) props.push('style:font-name="Courier New" fo:font-family="\'Courier New\'"');
      entry = { name, xml: `<style:style style:name="${name}" style:family="text"><style:text-properties ${props.join(' ')}/></style:style>` };
      this.textStyles.set(key, entry);
    }
    return entry.name;
  }

  private picture(image: DocumentImage): Picture {
    const known = this.pictureById.get(image.id);
    if (known) return known;
    if (this.pictures.length >= ODT_WRITER_MAX_IMAGES) throw new PayloadLimitError(`The document would embed more than ${ODT_WRITER_MAX_IMAGES} pictures.`);
    const picture: Picture = { path: `Pictures/image${this.pictures.length + 1}.${IMAGE_EXTENSION[image.format]}`, mime: IMAGE_MIME[image.format], data: image.data, format: image.format };
    this.pictures.push(picture);
    this.pictureById.set(image.id, picture);
    return picture;
  }

  private async frame(imageId: number, widthPt: number | undefined, heightPt: number | undefined, alt: string): Promise<string> {
    const image = this.images.get(imageId);
    if (!image) return '';
    const picture = this.picture(image);
    let width = widthPt;
    let height = heightPt;
    if (!width || !height) {
      const metadata = await sharp(Buffer.from(picture.data)).metadata();
      width = (metadata.width ?? 1) * POINTS_PER_PIXEL;
      height = (metadata.height ?? 1) * POINTS_PER_PIXEL;
    }
    this.frames += 1;
    const title = alt === '' ? '' : `<svg:title>${escapeXmlText(alt)}</svg:title>`;
    return (
      `<draw:frame draw:name="Image${this.frames}" text:anchor-type="as-char" svg:width="${(width / POINTS_PER_CM).toFixed(3)}cm" svg:height="${(height / POINTS_PER_CM).toFixed(3)}cm">` +
      `<draw:image xlink:href="${picture.path}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>${title}</draw:frame>`
    );
  }

  private async runs(runs: readonly Inline[]): Promise<string> {
    let xml = '';
    let index = 0;
    while (index < runs.length) {
      const run = runs[index];
      const isObject = run.image !== undefined || run.note !== undefined || run.anchor !== undefined;
      if (!isObject && run.href !== undefined && (!run.href.startsWith('#') || this.anchors.has(run.href.slice(1)))) {
        const { href } = run;
        let linked = '';
        while (index < runs.length && runs[index].href === href && runs[index].image === undefined && runs[index].note === undefined && runs[index].anchor === undefined) {
          linked += this.run(runs[index]);
          index += 1;
        }
        xml += `<text:a xlink:type="simple" xlink:href="${escapeXmlAttribute(href)}">${linked}</text:a>`;
        continue;
      }
      if (run.image) {
        xml += await this.frame(run.image.imageId, run.image.widthPt, run.image.heightPt, run.image.alt);
      } else if (run.note) {
        const note = this.noteById.get(`${run.note.kind}:${run.note.id}`);
        if (note) xml += await this.note(run.note.kind, note);
      } else if (run.anchor !== undefined) {
        xml += `<text:bookmark text:name="${escapeXmlAttribute(run.anchor)}"/>`;
      } else {
        xml += this.run(run);
      }
      index += 1;
    }
    return xml;
  }

  private run(run: Inline): string {
    // Spaces and tabs are written as the ODF elements; a run of spaces would otherwise collapse.
    const text = escapeXmlText(run.text)
      .replace(/\t/g, '<text:tab/>')
      .replace(/\n/g, '<text:line-break/>')
      .replace(/ {2,}/g, (spaces) => ` <text:s text:c="${spaces.length - 1}"/>`);
    const style = this.textStyle(run);
    return style ? `<text:span text:style-name="${style}">${text}</text:span>` : text;
  }

  private async note(kind: 'footnote' | 'endnote', note: NoteDefinition): Promise<string> {
    this.noteCounter += 1;
    const body = await this.blocks(note.blocks);
    return `<text:note text:id="${kind}${this.noteCounter}" text:note-class="${kind}"><text:note-citation>${escapeXmlText(note.label)}</text:note-citation><text:note-body>${body}</text:note-body></text:note>`;
  }

  /** Registers the numbering of `list`: the format and start value of each level it uses. */
  private defineList(list: ListBlock): void {
    const firstAtLevel = new Map<number, number>();
    for (const item of list.items) if (!firstAtLevel.has(item.level)) firstAtLevel.set(item.level, item.value);
    let xml = `<text:list-style style:name="L${list.id}">`;
    for (let level = 0; level < MAX_LIST_LEVELS; level += 1) {
      const format = list.levels[level];
      const spacing = `<style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="${((level + 1) * LEVEL_INDENT_CM).toFixed(2)}cm" fo:text-indent="-0.5cm" fo:margin-left="${((level + 1) * LEVEL_INDENT_CM).toFixed(2)}cm"/></style:list-level-properties>`;
      if (format && format.kind !== 'bullet') {
        const numeral = ORDERED_FORMATS.get(format.format ?? format.kind) ?? '1';
        const prefix = format.punctuation === 'both' ? ' style:num-prefix="("' : '';
        const suffix = format.punctuation === 'dot' ? '.' : ')';
        xml += `<text:list-level-style-number text:level="${level + 1}" style:num-format="${escapeXmlAttribute(numeral)}"${prefix} style:num-suffix="${suffix}" text:start-value="${firstAtLevel.get(level) ?? 1}">${spacing}</text:list-level-style-number>`;
      } else {
        const glyph = format?.glyph || BULLETS[level % BULLETS.length];
        xml += `<text:list-level-style-bullet text:level="${level + 1}" text:bullet-char="${escapeXmlAttribute(glyph)}">${spacing}</text:list-level-style-bullet>`;
      }
    }
    xml += '</text:list-style>';
    this.listStyles.set(list.id, xml);
  }

  private async list(list: ListBlock): Promise<string> {
    // Per open list: whether its last item is still open.
    const stack: { itemOpen: boolean }[] = [];
    let xml = '';
    const closeList = (): void => {
      const top = stack.pop() as { itemOpen: boolean };
      xml += `${top.itemOpen ? '</text:list-item>' : ''}</text:list>`;
    };
    for (const item of list.items) {
      // A list nests at most one level below the open one.
      const level = Math.min(item.level, stack.length);
      while (stack.length > level + 1) closeList();
      if (stack.length === level + 1) {
        xml += stack[level].itemOpen ? '</text:list-item>' : '';
        stack[level].itemOpen = false;
      } else {
        // Only the outermost list names the style; nested lists inherit it level by level.
        xml += level === 0 ? `<text:list text:style-name="L${list.id}">` : '<text:list>';
        stack.push({ itemOpen: false });
      }
      xml += `<text:list-item><text:p>${await this.runs(item.runs)}</text:p>`;
      stack[stack.length - 1].itemOpen = true;
    }
    while (stack.length > 0) closeList();
    return xml;
  }

  private async table(table: TableBlock): Promise<string> {
    this.tables += 1;
    const columns = Math.max(table.columnWidths.length, 1);
    let xml = `<table:table table:name="Table${this.tables}" table:style-name="Tbl"><table:table-column table:number-columns-repeated="${columns}"/>`;
    const headerRows = table.rows.findIndex((row) => !row.some((cell) => cell.header));
    const headerCount = headerRows < 0 ? table.rows.length : headerRows;
    if (headerCount > 0) xml += '<table:table-header-rows>';
    for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
      if (rowIndex === headerCount && headerCount > 0) xml += '</table:table-header-rows>';
      xml += '<table:table-row>';
      let covered = 0;
      for (const cell of table.rows[rowIndex]) {
        covered += cell.colSpan;
        if (cell.continuation) {
          xml += '<table:covered-table-cell/>'.repeat(cell.colSpan);
          continue;
        }
        const span = `${cell.colSpan > 1 ? ` table:number-columns-spanned="${cell.colSpan}"` : ''}${cell.rowSpan > 1 ? ` table:number-rows-spanned="${cell.rowSpan}"` : ''}`;
        const content = await this.blocks(cellBlocks(cell));
        xml += `<table:table-cell table:style-name="Cell" office:value-type="string"${span}>${content === '' ? '<text:p/>' : content}</table:table-cell>`;
        xml += '<table:covered-table-cell/>'.repeat(cell.colSpan - 1);
      }
      // A row covers every column of the table.
      for (; covered < columns; covered += 1) xml += '<table:table-cell table:style-name="Cell" office:value-type="string"><text:p/></table:table-cell>';
      xml += '</table:table-row>';
    }
    if (headerCount > 0 && headerCount >= table.rows.length) xml += '</table:table-header-rows>';
    return `${xml}</table:table>`;
  }

  async blocks(blocks: readonly Block[]): Promise<string> {
    let xml = '';
    for (const block of blocks) {
      switch (block.type) {
        case 'heading': {
          const level = Math.min(Math.max(block.level, 1), MAX_HEADING_LEVEL);
          xml += `<text:h text:style-name="Heading_20_${level}" text:outline-level="${level}">${await this.runs(block.runs)}</text:h>`;
          break;
        }
        case 'paragraph': {
          const align = block.align !== 'left' ? ALIGN_STYLES.get(block.align) : undefined;
          xml += `<text:p${align ? ` text:style-name="${align}"` : ''}>${await this.runs(block.runs)}</text:p>`;
          break;
        }
        case 'list':
          xml += await this.list(block);
          break;
        case 'table':
          xml += await this.table(block);
          break;
        case 'image':
          xml += `<text:p>${await this.frame(block.imageId, block.widthPt, block.heightPt, block.alt ?? '')}</text:p>`;
          break;
        case 'code':
          xml += block.text
            .split('\n')
            .map((line) => `<text:p text:style-name="Code">${escapeXmlText(line).replace(/ {2,}/g, (spaces) => ` <text:s text:c="${spaces.length - 1}"/>`)}</text:p>`)
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
      }
    }
    return xml;
  }

  prepare(): void {
    const define = (block: Block): void => {
      if (block.type === 'list') this.defineList(block);
    };
    walkBlocks(bodyBlocks(this.model), define);
    for (const note of [...(this.model.footnotes ?? []), ...(this.model.endnotes ?? [])]) walkBlocks(note.blocks, define);
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

/**
 * Writes the document.
 * @throws UnsupportedOptionError when the language is not a BCP 47 tag.
 * @throws PayloadLimitError when the document carries more pictures than ODT_WRITER_MAX_IMAGES.
 * @throws InvalidXmlCharacterError when text holds a character XML 1.0 does not allow.
 */
export async function documentToOdt(model: DocumentModel, options: OdtWriteOptions): Promise<Buffer> {
  const language = resolveLanguage(model, options.language);
  const title = (model.title ?? options.title).trim() || options.title;
  const anchors = new Set<string>();
  const collect = (blocks: readonly Block[]): void =>
    walkRuns(blocks, (run) => {
      if (run.anchor !== undefined) anchors.add(run.anchor);
    });
  collect(bodyBlocks(model));
  for (const note of [...(model.footnotes ?? []), ...(model.endnotes ?? [])]) collect(note.blocks);

  const writer = new OdtWriter(model, anchors);
  writer.prepare();
  let body = '';
  for (const [index, section] of model.sections.entries()) {
    if (index > 0 && PAGE_STARTING_SECTIONS.has(section.breakType ?? 'continuous')) body += '<text:p text:style-name="PageBreak"/>';
    body += await writer.blocks(section.blocks);
  }

  const zip = new JSZip();
  const add = (name: string, data: string | Uint8Array, extra: JSZip.JSZipFileOptions = {}): void => {
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
      (model.author ? `<dc:creator>${escapeXmlText(model.author)}</dc:creator>` : '') +
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
