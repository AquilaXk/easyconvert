/**
 * A one-page document that a replacement text thread reads before it takes user documents (see pdf-text-host.ts): it
 * loads pdfjs, the standard font data and the layout path, so the first user document is not the one that pays for the
 * cold start. It is fixed text written for this purpose, never user data.
 */

/** Page size in points (US Letter). */
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const LINES = [
  'Replacement threads read this page before the first document.',
  'Words, numbers 1234567890 and punctuation, (like this); are set in two fonts.',
  'A second paragraph keeps the reading order and the line joining busy.',
];
const LINE_HEIGHT = 16;
const FIRST_BASELINE = 720;
const LEFT_MARGIN = 72;
/** Objects: catalog, page tree, two fonts, page, content stream. */
const OBJECT_BODIES_BEFORE_CONTENT = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [5 0 R] /Count 1 >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>',
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents 6 0 R >>`,
];

function contentStream(): string {
  const shown = LINES.map((line, index) => {
    const font = index % 2 === 0 ? '/F1 12' : '/F2 12';
    const escaped = line.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
    return `${font} Tf ${LEFT_MARGIN} ${FIRST_BASELINE - index * LINE_HEIGHT} Td (${escaped}) Tj`;
  });
  return `BT\n${shown.join('\n1 0 0 1 0 0 Tm\n')}\nET`;
}

/** The document, with an exact cross-reference table. */
export function warmupPdf(): Uint8Array {
  const content = contentStream();
  const bodies = [...OBJECT_BODIES_BEFORE_CONTENT, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let out = '%PDF-1.4\n';
  const offsets = bodies.map((body, index) => {
    const offset = out.length;
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
