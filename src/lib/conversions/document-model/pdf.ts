import { EngineUnavailableError, type ConversionOptions } from '../../types';
import { redrawAsPng } from '../image-to-png';
import { MAX_DOCUMENT_IMAGE_PIXELS, MAX_IMAGES_PER_DOCUMENT, prepareEmbeddedImage } from '../html-blocks';
import { PDF_DOCUMENT_SPACING, renderPdfBlocks, type PdfBlock, type PdfPageGeometry, type PdfRasterImage, type PdfTableCell } from '../pdf-blocks';
import type { PdfTextSegment } from '../pdf-fonts';
import type { Block, DocumentImage, DocumentModel, Inline, ListBlock, NoteDefinition, TableBlock } from './model';
import { cellBlocks, imagesById, walkRuns } from './support';
import { blockText, listMarkers } from './text';

/**
 * Draws the document model with the in-process PDF writer: headings with their numbers, list items with the markers
 * the document shows ("1.", "a.", "III)"), tables with merged cells, links, pictures (a JPEG goes in byte for byte),
 * page and section breaks, footnotes below the block that cites them and endnotes on a last page. Text is drawn in
 * the regular face of an installed font that covers it; bold and italic are not drawn.
 */

const PX_PER_POINT = 4 / 3;
const TAB_AS_SPACES = '    ';
const LINK_SCHEME = /^(?:https?|mailto):/i;
const PAGE_BREAK_SECTIONS: ReadonlySet<string> = new Set(['nextPage', 'oddPage', 'evenPage']);

class PdfBlockBuilder {
  private readonly rasters = new Map<number, Promise<PdfRasterImage>>();
  private pixels = 0;

  constructor(private readonly images: ReadonlyMap<number, DocumentImage>) {}

  private async rasterImage(imageId: number, widthPt: number | undefined, heightPt: number | undefined): Promise<PdfBlock | undefined> {
    const image = this.images.get(imageId);
    if (!image) return undefined;
    let prepared = this.rasters.get(imageId);
    if (!prepared) {
      if (this.rasters.size >= MAX_IMAGES_PER_DOCUMENT) {
        throw new EngineUnavailableError(
          'soffice',
          `the document embeds more than ${MAX_IMAGES_PER_DOCUMENT} pictures, which the in-process PDF renderer does not draw`
        );
      }
      const data = Buffer.from(image.data);
      prepared = (image.format === 'bmp' ? redrawAsPng(data, 'image/bmp') : Promise.resolve(data)).then((bytes) => prepareEmbeddedImage(bytes, 'A document picture'));
      this.rasters.set(imageId, prepared);
    }
    const raster = await prepared;
    this.pixels += raster.widthPx * raster.heightPx;
    if (this.pixels > MAX_DOCUMENT_IMAGE_PIXELS) {
      throw new EngineUnavailableError('soffice', `the document's pictures total more than ${MAX_DOCUMENT_IMAGE_PIXELS} pixels, above the in-process PDF renderer's limit`);
    }
    const shown = widthPt && heightPt ? { data: raster.data, widthPx: widthPt * PX_PER_POINT, heightPx: heightPt * PX_PER_POINT } : raster;
    return { kind: 'image', image: shown };
  }

  /** Text segments of runs that hold no picture. */
  private segments(runs: readonly Inline[]): PdfTextSegment[] {
    const segments: PdfTextSegment[] = [];
    for (const run of runs) {
      if (run.image || run.anchor !== undefined) continue;
      if (run.note) {
        segments.push({ text: run.note.label });
        continue;
      }
      const link = run.href !== undefined && LINK_SCHEME.test(run.href) ? run.href : undefined;
      segments.push({ text: run.text.replace(/\t/g, TAB_AS_SPACES), link });
    }
    return segments;
  }

  /** A paragraph split at its pictures: text before, the picture, text after. */
  private async flow(runs: readonly Inline[], make: (content: PdfTextSegment[]) => PdfBlock): Promise<PdfBlock[]> {
    const blocks: PdfBlock[] = [];
    let pending: Inline[] = [];
    const flush = (): void => {
      const content = this.segments(pending);
      if (content.some((segment) => segment.text.trim() !== '')) blocks.push(make(content));
      pending = [];
    };
    for (const run of runs) {
      if (!run.image) {
        pending.push(run);
        continue;
      }
      flush();
      const picture = await this.rasterImage(run.image.imageId, run.image.widthPt, run.image.heightPt);
      if (picture) blocks.push(picture);
    }
    flush();
    return blocks;
  }

  private cellContent(blocks: readonly Block[]): PdfTextSegment[] {
    const content: PdfTextSegment[] = [];
    for (const block of blocks) {
      const segments: PdfTextSegment[] = block.type === 'heading' || block.type === 'paragraph' ? this.segments(block.runs) : [{ text: blockText(block) }];
      if (segments.every((segment) => segment.text.trim() === '')) continue;
      if (content.length > 0) content.push({ text: '\n' });
      content.push(...segments);
    }
    return content;
  }

  private table(table: TableBlock): PdfBlock {
    const rows: PdfTableCell[][] = table.rows.map((row) =>
      row.map((cell): PdfTableCell => (cell.continuation ? { content: [], span: cell.colSpan, covered: true } : { content: this.cellContent(cellBlocks(cell)), span: cell.colSpan, rowSpan: cell.rowSpan }))
    );
    return { kind: 'table', rows };
  }

  private async list(list: ListBlock): Promise<PdfBlock[]> {
    const result: PdfBlock[] = [];
    const markers = listMarkers(list);
    // The open list and item of each level.
    const stack: { list: Extract<PdfBlock, { kind: 'list' }>; item: PdfBlock[] }[] = [];
    for (const [position, item] of list.items.entries()) {
      const level = Math.min(item.level, stack.length);
      stack.length = Math.min(stack.length, level + 1);
      if (!stack[level]) {
        const ordered = list.levels[item.level].kind !== 'bullet';
        const pdfList: Extract<PdfBlock, { kind: 'list' }> = { kind: 'list', ordered, start: item.value, items: [], markers: [] };
        if (level === 0) result.push(pdfList);
        else stack[level - 1].item.push(pdfList);
        stack[level] = { list: pdfList, item: [] };
      }
      const open = stack[level];
      const content = await this.flow(item.runs, (segments) => ({ kind: 'paragraph', content: segments }));
      open.item = content;
      open.list.items.push(content);
      (open.list.markers as string[]).push(markers[position] === '' ? ' ' : markers[position]);
    }
    return result;
  }

  async blocks(blocks: readonly Block[], model: DocumentModel): Promise<PdfBlock[]> {
    const out: PdfBlock[] = [];
    for (const block of blocks) {
      switch (block.type) {
        case 'heading': {
          const label: PdfTextSegment[] = block.label ? [{ text: `${block.label} ` }] : [];
          out.push(...(await this.flow(block.runs, (content) => ({ kind: 'heading', level: block.level, content: [...label, ...content] }))));
          break;
        }
        case 'paragraph':
          out.push(...(await this.flow(block.runs, (content) => ({ kind: 'paragraph', content }))));
          break;
        case 'list':
          out.push(...(await this.list(block)));
          break;
        case 'table':
          out.push(this.table(block));
          break;
        case 'image': {
          const picture = await this.rasterImage(block.imageId, block.widthPt, block.heightPt);
          if (picture) out.push(picture);
          break;
        }
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
      }
      out.push(...this.footnotesCitedBy([block], model));
    }
    return out;
  }

  /** The footnotes cited in `blocks`, as a rule and one paragraph per note, to follow them. */
  private footnotesCitedBy(blocks: readonly Block[], model: DocumentModel): PdfBlock[] {
    const ids: number[] = [];
    walkRuns(blocks, (run) => {
      if (run.note && run.note.kind === 'footnote') ids.push(run.note.id);
    });
    const notes = ids.map((id) => (model.footnotes ?? []).find((note) => note.id === id)).filter((note): note is NoteDefinition => note !== undefined);
    if (notes.length === 0) return [];
    return [{ kind: 'rule' }, ...notes.map((note): PdfBlock => ({ kind: 'paragraph', content: [{ text: `${note.label} ${noteText(note)}` }] }))];
  }
}

function noteText(note: NoteDefinition): string {
  return note.blocks
    .map(blockText)
    .filter((text) => text !== '')
    .join(' ');
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

function pageGeometryOf(model: DocumentModel): PdfPageGeometry | undefined {
  if (!model.pageStated) return undefined;
  return {
    widthPt: model.pageWidthPt,
    heightPt: model.pageHeightPt,
    marginTopPt: model.margins.top,
    marginRightPt: model.margins.right,
    marginBottomPt: model.margins.bottom,
    marginLeftPt: model.margins.left,
  };
}

/** Renders the model to a PDF. */
export async function documentToPdf(model: DocumentModel, options: ConversionOptions, title: string): Promise<Buffer> {
  const documentTitle = model.title ?? title;
  const builder = new PdfBlockBuilder(imagesById(model));
  const blocks: PdfBlock[] = [];
  for (const [index, section] of model.sections.entries()) {
    if (index > 0 && PAGE_BREAK_SECTIONS.has(section.breakType ?? 'continuous')) blocks.push({ kind: 'pageBreak' });
    blocks.push(...(await builder.blocks(section.blocks, model)));
  }
  const endnotes = model.endnotes ?? [];
  if (endnotes.length > 0) {
    blocks.push({ kind: 'pageBreak' });
    for (const note of endnotes) blocks.push({ kind: 'paragraph', content: [{ text: `${note.label} ${noteText(note)}` }] });
  }
  return renderPdfBlocks(tidyPageBreaks(blocks), {
    orientation: options.orientation,
    title: documentTitle,
    page: pageGeometryOf(model),
    spacing: PDF_DOCUMENT_SPACING,
    customFontPath: (options as { fontPath?: string }).fontPath,
  });
}
