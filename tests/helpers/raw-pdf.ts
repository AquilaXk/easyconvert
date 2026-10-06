/**
 * Hand-written PDFs for text-geometry tests: uncompressed, Helvetica as /F1, exact cross-reference table.
 * Writing the content stream by hand lets a test place every text run, set word spacing or horizontal
 * scaling, or nest form XObjects, which pdf-lib's drawText cannot express.
 */

export interface RawPage {
  width: number;
  height: number;
  /** Content stream operators; /F1 is Helvetica. */
  content: string;
  /** Page /Rotate. */
  rotate?: number;
  /** Extra resource entries such as `/XObject << /X1 9 0 R >>`. */
  resources?: string;
  /** Extra entries of the font resource dictionary such as `/F2 6 0 R`. */
  fonts?: string;
}

/** Objects numbered from 1 are the catalog, the page tree, the font; page k uses objects 4+2k (page) and 5+2k (content). */
const FIRST_PAGE_OBJECT = 4;

function pageObjectNumber(index: number): number {
  return FIRST_PAGE_OBJECT + index * 2;
}

/**
 * Builds a PDF from pages and optional extra objects (their numbers start after the page objects, in
 * order; see `extraObjectNumber`).
 */
export function rawPdf(pages: RawPage[], extraObjects: string[] = []): Buffer {
  const objects: string[] = [];
  const kids = pages.map((_, index) => `${pageObjectNumber(index)} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  pages.forEach((page, index) => {
    const rotate = page.rotate === undefined ? '' : ` /Rotate ${page.rotate}`;
    const resources = `<< /Font << /F1 3 0 R ${page.fonts ?? ''} >> ${page.resources ?? ''} >>`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}]${rotate} /Resources ${resources} /Contents ${pageObjectNumber(index) + 1} 0 R >>`
    );
    objects.push(`<< /Length ${Buffer.byteLength(page.content, 'latin1')} >>\nstream\n${page.content}\nendstream`);
  });
  objects.push(...extraObjects);
  return assemble(objects);
}

/** Number of the first extra object for a document of `pageCount` pages. */
export function extraObjectNumber(pageCount: number): number {
  return pageObjectNumber(pageCount);
}

function assemble(objects: string[]): Buffer {
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** One text run: absolute position, size, optional extra text-state operators. */
export function run(text: string, x: number, y: number, size: number, state = ''): string {
  const escaped = text.replace(/[\\()]/g, (char) => `\\${char}`);
  return `BT /F1 ${size} Tf ${state} 1 0 0 1 ${x} ${y} Tm (${escaped}) Tj ET\n`;
}
