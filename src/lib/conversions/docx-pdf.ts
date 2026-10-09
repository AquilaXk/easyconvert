import { EngineUnavailableError, type ConversionOptions } from '../types';
import { assertNoComplexScript } from './ctl';
import { redrawAsPng } from './image-to-png';
import { MAX_DOCUMENT_IMAGE_PIXELS, MAX_IMAGES_PER_DOCUMENT, prepareEmbeddedImage } from './html-blocks';
import { PDF_DOCUMENT_SPACING, renderPdfBlocks, type PdfBlock, type PdfRasterImage, type PdfTableCell } from './pdf-blocks';
import type { PdfTextSegment } from './pdf-fonts';
import {
  blockText,
  inlinesToText,
  tableSlots,
  walkBlocks,
  type DocBlock,
  type DocImage,
  type DocInline,
  type DocModel,
  type DocNote,
} from './document-model';

/**
 * Draws the block model with the in-process PDF writer: headings with their numbers, list items with the markers the
 * document shows ("1.", "a.", "III)"), tables with merged cells, links, pictures (a JPEG goes in byte for byte), page
 * and section breaks, footnotes below the block that cites them and endnotes on a last page. Text is drawn in the
 * regular face of an installed font that covers it; bold and italic are not drawn.
 */

const PX_PER_POINT = 4 / 3;
const TAB_AS_SPACES = '    ';
const LINK_SCHEME = /^(?:https?|mailto):/i;
const PAGE_BREAK_SECTIONS: ReadonlySet<string> = new Set(['nextPage', 'oddPage', 'evenPage']);

type ListItem = Extract<DocBlock, { kind: 'listItem' }>;

class PdfBlockBuilder {
  private readonly images = new Map<Buffer, Promise<PdfRasterImage>>();
  private pixels = 0;

  private async rasterImage(image: DocImage): Promise<PdfBlock | undefined> {
    let prepared = this.images.get(image.data);
    if (!prepared) {
      if (this.images.size >= MAX_IMAGES_PER_DOCUMENT) {
        throw new EngineUnavailableError(
          'soffice',
          `the document embeds more than ${MAX_IMAGES_PER_DOCUMENT} pictures, which the in-process PDF renderer does not draw`
        );
      }
      prepared = (image.mime === 'image/bmp' ? redrawAsPng(image.data, image.mime) : Promise.resolve(image.data)).then((bytes) => prepareEmbeddedImage(bytes, 'A document picture'));
      this.images.set(image.data, prepared);
    }
    const raster = await prepared;
    this.pixels += raster.widthPx * raster.heightPx;
    if (this.pixels > MAX_DOCUMENT_IMAGE_PIXELS) {
      throw new EngineUnavailableError('soffice', `the document's pictures total more than ${MAX_DOCUMENT_IMAGE_PIXELS} pixels, above the in-process PDF renderer's limit`);
    }
    const shown =
      image.widthPt && image.heightPt
        ? { data: raster.data, widthPx: image.widthPt * PX_PER_POINT, heightPx: image.heightPt * PX_PER_POINT }
        : raster;
    return { kind: 'image', image: shown };
  }

  /** Text segments of inlines that hold no picture. */
  private segments(inlines: readonly DocInline[]): PdfTextSegment[] {
    const segments: PdfTextSegment[] = [];
    for (const inline of inlines) {
      if (inline.kind === 'text') {
        const link = inline.href !== undefined && LINK_SCHEME.test(inline.href) ? inline.href : undefined;
        segments.push({ text: inline.text.replace(/\t/g, TAB_AS_SPACES), link });
      } else if (inline.kind === 'break') {
        segments.push({ text: '\n' });
      } else if (inline.kind === 'noteRef') {
        segments.push({ text: inline.label });
      }
    }
    return segments;
  }

  /** A paragraph split at its pictures: text before, the picture, text after. */
  private async flow(inlines: readonly DocInline[], make: (content: PdfTextSegment[]) => PdfBlock): Promise<PdfBlock[]> {
    const blocks: PdfBlock[] = [];
    let run: DocInline[] = [];
    const flush = (): void => {
      const content = this.segments(run);
      if (content.some((segment) => segment.text.trim() !== '')) blocks.push(make(content));
      run = [];
    };
    for (const inline of inlines) {
      if (inline.kind !== 'image') {
        run.push(inline);
        continue;
      }
      flush();
      const picture = await this.rasterImage(inline.image);
      if (picture) blocks.push(picture);
    }
    flush();
    return blocks;
  }

  private cellContent(blocks: readonly DocBlock[]): PdfTextSegment[] {
    const content: PdfTextSegment[] = [];
    for (const block of blocks) {
      let segments: PdfTextSegment[];
      if (block.kind === 'heading' || block.kind === 'paragraph') segments = this.segments(block.inlines);
      else if (block.kind === 'listItem') segments = [{ text: `${block.marker} ` }, ...this.segments(block.inlines)];
      else segments = [{ text: blockText(block) }];
      if (segments.every((segment) => segment.text.trim() === '')) continue;
      if (content.length > 0) content.push({ text: '\n' });
      content.push(...segments);
    }
    return content;
  }

  private table(block: Extract<DocBlock, { kind: 'table' }>): PdfBlock {
    const rows: PdfTableCell[][] = tableSlots(block).map((slots) => {
      const cells: PdfTableCell[] = [];
      for (let column = 0; column < slots.length; column += 1) {
        const slot = slots[column];
        if (slot === null || slot.kind === 'colspan') continue;
        if (slot.kind === 'origin') {
          cells.push({ content: this.cellContent(slot.cell.blocks), span: slot.cell.colSpan, rowSpan: slot.cell.rowSpan });
          continue;
        }
        let span = 1;
        while (slots[column + span]?.kind === 'rowspan' && slots[column + span]?.cell === slot.cell) span += 1;
        cells.push({ content: [], span, covered: true });
        column += span - 1;
      }
      return cells;
    });
    return { kind: 'table', rows };
  }

  private async lists(items: readonly ListItem[]): Promise<PdfBlock[]> {
    interface Open {
      list: Extract<PdfBlock, { kind: 'list' }>;
      listId: number;
      item: PdfBlock[];
    }
    const result: PdfBlock[] = [];
    const stack: Open[] = [];
    for (const item of items) {
      const level = Math.min(item.level, stack.length);
      stack.length = Math.min(stack.length, level + 1);
      const top = stack[level];
      if (top && (top.list.ordered !== item.ordered || top.listId !== item.listId)) stack.length = level;
      if (!stack[level]) {
        const list: Extract<PdfBlock, { kind: 'list' }> = { kind: 'list', ordered: item.ordered, start: item.number, items: [], markers: [] };
        if (level === 0) result.push(list);
        else stack[level - 1].item.push(list);
        stack[level] = { list, listId: item.listId, item: [] };
      }
      const open = stack[level];
      const content = await this.flow(item.inlines, (segments) => ({ kind: 'paragraph', content: segments }));
      open.item = content;
      open.list.items.push(content);
      (open.list.markers as string[]).push(item.marker === '' ? ' ' : item.marker);
    }
    return result;
  }

  async blocks(blocks: readonly DocBlock[], model: DocModel): Promise<PdfBlock[]> {
    const out: PdfBlock[] = [];
    let index = 0;
    while (index < blocks.length) {
      const block = blocks[index];
      const start = index;
      if (block.kind === 'listItem') {
        let end = index;
        while (end < blocks.length && blocks[end].kind === 'listItem') end += 1;
        out.push(...(await this.lists(blocks.slice(index, end) as ListItem[])));
        index = end;
      } else {
        index += 1;
        switch (block.kind) {
          case 'heading': {
            const label: PdfTextSegment[] = block.label ? [{ text: `${block.label} ` }] : [];
            out.push(...(await this.flow(block.inlines, (content) => ({ kind: 'heading', level: block.level, content: [...label, ...content] }))));
            break;
          }
          case 'paragraph':
            out.push(...(await this.flow(block.inlines, (content) => ({ kind: 'paragraph', content }))));
            break;
          case 'table':
            out.push(this.table(block));
            break;
          case 'code':
            out.push({ kind: 'preformatted', text: block.text });
            break;
          case 'quote':
            out.push({ kind: 'quote', blocks: await this.blocks(block.blocks, model) });
            break;
          case 'rule':
            out.push({ kind: 'rule' });
            break;
          case 'pageBreak':
            out.push({ kind: 'pageBreak' });
            break;
          case 'sectionBreak':
            if (PAGE_BREAK_SECTIONS.has(block.sectionType)) out.push({ kind: 'pageBreak' });
            break;
        }
      }
      out.push(...this.footnotesCitedBy(blocks.slice(start, index), model));
    }
    return out;
  }

  /** The footnotes cited in `blocks`, as a rule and one paragraph per note, to follow them. */
  private footnotesCitedBy(blocks: readonly DocBlock[], model: DocModel): PdfBlock[] {
    const ids: number[] = [];
    walkBlocks(blocks, (block) => {
      if (block.kind !== 'heading' && block.kind !== 'paragraph' && block.kind !== 'listItem') return;
      for (const inline of block.inlines) if (inline.kind === 'noteRef' && inline.noteKind === 'footnote') ids.push(inline.id);
    });
    const notes = ids.map((id) => model.footnotes.find((note) => note.id === id)).filter((note): note is DocNote => note !== undefined);
    if (notes.length === 0) return [];
    return [{ kind: 'rule' }, ...notes.map((note): PdfBlock => ({ kind: 'paragraph', content: [{ text: `${note.label} ${noteText(note)}` }] }))];
  }
}

function noteText(note: DocNote): string {
  return note.blocks.map(blockText).filter((text) => text !== '').join(' ');
}

/** Drops page breaks at the start and end of the document and collapses runs of them into one. */
function tidyPageBreaks(blocks: PdfBlock[]): PdfBlock[] {
  const tidy: PdfBlock[] = [];
  for (const block of blocks) {
    if (block.kind === 'pageBreak' && (tidy.length === 0 || tidy[tidy.length - 1].kind === 'pageBreak')) continue;
    tidy.push(block);
  }
  while (tidy.length > 0 && tidy[tidy.length - 1].kind === 'pageBreak') tidy.pop();
  return tidy;
}

function assertDrawableScripts(model: DocModel, title: string): void {
  const context = 'Pure-TS DOCX to PDF';
  assertNoComplexScript(title, context);
  const check = (block: DocBlock): void => {
    if (block.kind === 'heading' || block.kind === 'paragraph' || block.kind === 'listItem') assertNoComplexScript(inlinesToText(block.inlines), context);
    else if (block.kind === 'code') assertNoComplexScript(block.text, context);
  };
  walkBlocks(model.blocks, check);
  for (const note of [...model.footnotes, ...model.endnotes]) walkBlocks(note.blocks, check);
}

/** Renders the model to a PDF. */
export async function renderModelPdf(model: DocModel, options: ConversionOptions, title: string): Promise<Buffer> {
  const documentTitle = model.title ?? title;
  assertDrawableScripts(model, documentTitle);
  const builder = new PdfBlockBuilder();
  const blocks = await builder.blocks(model.blocks, model);
  if (model.endnotes.length > 0) {
    blocks.push({ kind: 'pageBreak' });
    for (const note of model.endnotes) blocks.push({ kind: 'paragraph', content: [{ text: `${note.label} ${noteText(note)}` }] });
  }
  return renderPdfBlocks(tidyPageBreaks(blocks), { orientation: options.orientation, title: documentTitle, page: model.page, spacing: PDF_DOCUMENT_SPACING, customFontPath: (options as { fontPath?: string }).fontPath });
}
