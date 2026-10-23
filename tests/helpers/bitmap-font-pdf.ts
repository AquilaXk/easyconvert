/**
 * A one-page PDF set in a bitmap font, the way dvips writes one: a Type 3 font whose glyph is a 1-bit inline image mask.
 * Poppler draws such a character as a rectangle painted through a mask, so the text can only come from the PDF's text
 * layer (the font's ToUnicode map), which is what the DXF writer reads it from.
 */

/** The characters of the page, and the code each has in the font. */
export const BITMAP_FONT_TEXT = 'HH';
const GLYPH_CODE = 72;
const PAGE_WIDTH_PT = 612;
const PAGE_HEIGHT_PT = 792;
const GLYPH_SIZE_PX = 8;
const GLYPH_ROWS = '\xff\x81\x81\xff\xff\x81\x81\xff';
const TO_UNICODE =
  '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Bitmap def 1 begincodespacerange <00> <FF> endcodespacerange ' +
  '1 beginbfchar <48> <0048> endbfchar endcmap end end';

function stream(body: string): string {
  return `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
}

export function bitmapFontPdf(): Buffer {
  const glyphProc = `${GLYPH_SIZE_PX} 0 0 0 ${GLYPH_SIZE_PX} ${GLYPH_SIZE_PX} d1\nq ${GLYPH_SIZE_PX} 0 0 ${GLYPH_SIZE_PX} 0 0 cm BI /IM true /W ${GLYPH_SIZE_PX} /H ${GLYPH_SIZE_PX} /BPC 1 /D [1 0] ID ${GLYPH_ROWS}\nEI Q`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH_PT} ${PAGE_HEIGHT_PT}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    stream(`BT /F1 12 Tf 72 700 Td (${BITMAP_FONT_TEXT}) Tj ET`),
    `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 ${GLYPH_SIZE_PX} ${GLYPH_SIZE_PX}] /FontMatrix [0.1 0 0 0.1 0 0] /CharProcs << /H 6 0 R >> ` +
      `/Encoding << /Type /Encoding /Differences [${GLYPH_CODE} /H] >> /FirstChar ${GLYPH_CODE} /LastChar ${GLYPH_CODE} /Widths [${GLYPH_SIZE_PX}] /ToUnicode 7 0 R >>`,
    stream(glyphProc),
    stream(TO_UNICODE),
  ];
  let file = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = file.length;
    file += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const entries = offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${file.length}\n%%EOF\n`;
  return Buffer.from(file, 'latin1');
}
