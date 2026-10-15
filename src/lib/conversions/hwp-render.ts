import { ConversionFailedError, PayloadLimitError } from '../types';
import type { HwpDocument } from './hwp';
import { MAX_RENDER_PIXELS } from './image-limits';
import { loadFontCoverageIndex, toDrawableText } from './pdf-fonts';
import { TextMeter, wrapText, type PlacedRun } from './text-wrap';

/**
 * SVG page for an HWP document: every paragraph and every table row, wrapped to the page width by the advance
 * widths of the fonts that draw them. The page grows to the height the content needs; a drawing that would pass
 * MAX_RENDER_PIXELS is refused with a typed 413 error. Nothing is added to the content (no title bar, no accent).
 */

/** A4 width at 96 dpi, in pixels. */
export const HWP_RENDER_WIDTH = 794;
const PAGE_MARGIN = 40;
const BODY_SIZE = 12;
const HEADING_SIZE = 15;
const TABLE_SIZE = 11;
const LINE_FACTOR = 1.5;
const PARAGRAPH_GAP = 8;
const TABLE_GAP = 16;
const CELL_PADDING = 5;
const CONTENT_WIDTH = HWP_RENDER_WIDTH - 2 * PAGE_MARGIN;
const TEXT_COLOR = '#1F2340';
const GRID_COLOR = '#888888';
const FALLBACK_FAMILY = 'sans-serif';
const SVG_NUMBER_DECIMALS = 2;
/** Share of the font size between the top of a line's text and its baseline. */
const ASCENT_RATIO = 0.9;
const TABLE_BORDER_WIDTH = 0.5;

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function round(value: number): number {
  return Number(value.toFixed(SVG_NUMBER_DECIMALS));
}

/** One wrapped line as a tspan with a nested tspan per font run. */
function lineMarkup(runs: readonly PlacedRun[], x: number, y: number): string {
  const body = runs
    .map((run) => {
      const family = run.face.font.familyName ? `'${escapeText(run.face.font.familyName).replace(/'/g, '&apos;')}', ${FALLBACK_FAMILY}` : FALLBACK_FAMILY;
      return `<tspan font-family="${family}">${escapeText(run.text)}</tspan>`;
    })
    .join('');
  return `<tspan class="line" x="${round(x)}" y="${round(y)}">${body}</tspan>`;
}

/** Baseline of a line whose box starts at `top`: the text sits centred in the line height. */
function baseline(top: number, lineHeight: number, size: number): number {
  return top + (lineHeight - size) / 2 + size * ASCENT_RATIO;
}

function wrappedLines(text: string, meter: TextMeter, width: number, size: number): string[] {
  const lines: string[] = [];
  for (const source of toDrawableText(text).split('\n')) {
    lines.push(...(source.trim() === '' ? [''] : wrapText(source, meter, width, size)));
  }
  return lines;
}

/**
 * Renders the document as one SVG page. Throws a ConversionFailedError for a document without content, a
 * PayloadLimitError (413) when the page would need more than MAX_RENDER_PIXELS pixels, and an
 * EngineUnavailableError when no installed font covers a character.
 */
export async function renderHwpToSvg(doc: HwpDocument): Promise<string> {
  const rows = doc.tables.filter((table) => table.rows.length > 0);
  if (doc.paragraphs.every((paragraph) => paragraph.text.trim() === '') && rows.length === 0) {
    throw new ConversionFailedError('The HWP document has no content to draw.');
  }
  await loadFontCoverageIndex();
  const meter = new TextMeter();
  const body: string[] = [];
  let y = PAGE_MARGIN;

  for (const paragraph of doc.paragraphs) {
    const size = paragraph.isHeading ? HEADING_SIZE : BODY_SIZE;
    const lineHeight = size * LINE_FACTOR;
    const lines = wrappedLines(paragraph.text, meter, CONTENT_WIDTH, size);
    if (lines.every((line) => line === '')) {
      y += lineHeight;
      continue;
    }
    const tspans = lines.map((line, i) => (line === '' ? '' : lineMarkup(meter.place(line, PAGE_MARGIN, size), PAGE_MARGIN, baseline(y + i * lineHeight, lineHeight, size)))).join('');
    body.push(`<text class="paragraph" font-size="${size}" font-weight="${paragraph.isHeading ? 'bold' : 'normal'}" fill="${TEXT_COLOR}">${tspans}</text>`);
    y += lines.length * lineHeight + PARAGRAPH_GAP;
  }

  for (const table of rows) {
    const columns = Math.max(1, table.colCount || table.rows.reduce((widest, row) => Math.max(widest, row.length), 0));
    const columnWidth = CONTENT_WIDTH / columns;
    const lineHeight = TABLE_SIZE * LINE_FACTOR;
    const rowMarkup: string[] = [];
    table.rows.forEach((row, rowIndex) => {
      const cells = Array.from({ length: columns }, (_, c) => wrappedLines(row[c] ?? '', meter, columnWidth - 2 * CELL_PADDING, TABLE_SIZE));
      const height = Math.max(...cells.map((lines) => lines.length)) * lineHeight + 2 * CELL_PADDING;
      const parts: string[] = [];
      cells.forEach((lines, c) => {
        const x = PAGE_MARGIN + c * columnWidth;
        parts.push(`<rect x="${round(x)}" y="${round(y)}" width="${round(columnWidth)}" height="${round(height)}" fill="none" stroke="${GRID_COLOR}" stroke-width="${TABLE_BORDER_WIDTH}"/>`);
        if (lines.every((line) => line === '')) return;
        const tspans = lines
          .map((line, i) => (line === '' ? '' : lineMarkup(meter.place(line, x + CELL_PADDING, TABLE_SIZE), x + CELL_PADDING, baseline(y + CELL_PADDING + i * lineHeight, lineHeight, TABLE_SIZE))))
          .join('');
        parts.push(`<text class="cell" font-size="${TABLE_SIZE}" font-weight="${rowIndex === 0 ? 'bold' : 'normal'}" fill="${TEXT_COLOR}">${tspans}</text>`);
      });
      rowMarkup.push(`<g class="row">${parts.join('')}</g>`);
      y += height;
    });
    body.push(`<g class="table">${rowMarkup.join('')}</g>`);
    y += TABLE_GAP;
  }

  const height = Math.ceil(y + PAGE_MARGIN);
  if (HWP_RENDER_WIDTH * height > MAX_RENDER_PIXELS) {
    throw new PayloadLimitError(
      `The HWP page would be ${HWP_RENDER_WIDTH} x ${height} pixels, over the limit of ${MAX_RENDER_PIXELS} pixels for a rendered page.`
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${HWP_RENDER_WIDTH}" height="${height}" viewBox="0 0 ${HWP_RENDER_WIDTH} ${height}">
<rect width="${HWP_RENDER_WIDTH}" height="${height}" fill="#ffffff"/>
${body.join('\n')}
</svg>`;
}
