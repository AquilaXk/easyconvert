/**
 * The reference side of the watermark row: a one-page PDF that holds the text stamp, written here byte by byte from
 * the PDF file structure (ISO 32000-1 sections 7.5 and 8.4) so no PDF library of the project is involved. qpdf lays it
 * over the pages (`--overlay`), which is how a stamp is applied with the command-line tools.
 */

/** Advance widths of Helvetica-Bold in 1/1000 em, from the Adobe core-14 font metrics, for the characters the stamp text uses. */
const HELVETICA_BOLD_WIDTHS: Readonly<Record<string, number>> = {
  ' ': 278,
  A: 722,
  C: 722,
  D: 722,
  F: 611,
  O: 778,
  P: 667,
  R: 722,
  T: 611,
  Y: 667,
};
/** Cap height of Helvetica-Bold in 1/1000 em from the same metrics: the stamp text is capitals only, so its ink spans the baseline to this height. */
const HELVETICA_BOLD_CAP_HEIGHT = 718;
const EM_UNITS = 1000;
const DEGREES_PER_HALF_TURN = 180;
const NUMBER_DIGITS = 4;
const OFFSET_DIGITS = 10;
const GENERATION_DIGITS = 5;

export interface StampSpec {
  text: string;
  fontSize: number;
  /** Counter-clockwise degrees, as in the product's watermark option. */
  rotationDegrees: number;
  opacity: number;
  /** Fill grey level in 0..1. */
  grey: number;
  pageWidth: number;
  pageHeight: number;
}

function textWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const char of text) {
    const width = HELVETICA_BOLD_WIDTHS[char];
    if (width === undefined) throw new RangeError(`no Helvetica-Bold width for "${char}"; extend the table`);
    units += width;
  }
  return (units / EM_UNITS) * fontSize;
}

const number = (value: number): string => value.toFixed(NUMBER_DIGITS);

/** The content stream: the ink box of the text (its advance width, and the cap height above the baseline) centred on the page after the rotation. */
function stampContent(spec: StampSpec): string {
  const width = textWidth(spec.text, spec.fontSize);
  const height = (HELVETICA_BOLD_CAP_HEIGHT / EM_UNITS) * spec.fontSize;
  const angle = (spec.rotationDegrees * Math.PI) / DEGREES_PER_HALF_TURN;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const x = (spec.pageWidth - (width * cos - height * sin)) / 2;
  const y = (spec.pageHeight - (width * sin + height * cos)) / 2;
  return [
    '/GS0 gs',
    `${number(spec.grey)} ${number(spec.grey)} ${number(spec.grey)} rg`,
    'BT',
    `/F1 ${number(spec.fontSize)} Tf`,
    `${number(cos)} ${number(sin)} ${number(-sin)} ${number(cos)} ${number(x)} ${number(y)} Tm`,
    `(${spec.text.replace(/[\\()]/g, '\\$&')}) Tj`,
    'ET',
  ].join('\n');
}

/** A complete one-page PDF with a correct cross-reference table. */
export function buildStampPdf(spec: StampSpec): Buffer {
  const content = stampContent(spec);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${number(spec.pageWidth)} ${number(spec.pageHeight)}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /ExtGState << /GS0 << /ca ${number(spec.opacity)} /CA ${number(spec.opacity)} >> >> >> >>`,
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];
  let body = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(body, 'latin1');
  const entries = offsets.map((offset) => `${String(offset).padStart(OFFSET_DIGITS, '0')} ${'0'.padStart(GENERATION_DIGITS, '0')} n \n`).join('');
  body += `xref\n0 ${objects.length + 1}\n${'0'.padStart(OFFSET_DIGITS, '0')} 65535 f \n${entries}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
