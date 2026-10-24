import type { PdfUpdateBase } from './pdf-document';

/** An object an incremental update defines: a new number, or an existing number and generation that it replaces. */
export interface PdfObjectDefinition {
  num: number;
  gen: number;
  /** The object's value as PDF text, a stream included. */
  body: string;
}

/**
 * `pdf` followed by an incremental update (ISO 32000-1 section 7.5.6) that defines `objects`: each object, a cross-reference
 * section for them, and a trailer whose /Prev is the file's last section. A reader then takes these definitions over the
 * file's own; the same bytes when there is nothing to define.
 */
export function withIncrementalUpdate(pdf: Buffer, base: PdfUpdateBase, objects: PdfObjectDefinition[]): Buffer {
  if (objects.length === 0) return pdf;
  let out = '\n';
  const defined: Array<{ num: number; gen: number; at: number }> = [];
  for (const { num, gen, body } of objects) {
    defined.push({ num, gen, at: pdf.length + out.length });
    out += `${num} ${gen} obj\n${body}\nendobj\n`;
  }
  const xrefAt = pdf.length + out.length;
  out += 'xref\n0 1\n0000000000 65535 f \n';
  for (const { num, gen, at } of defined.sort((a, b) => a.num - b.num)) out += `${num} 1\n${String(at).padStart(10, '0')} ${String(gen).padStart(5, '0')} n \n`;
  let size = base.nextObjectNumber;
  for (const { num } of objects) size = Math.max(size, num + 1);
  out += `trailer\n<< /Size ${size} /Root ${base.root.num} ${base.root.gen} R /Prev ${base.previousXref} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.concat([pdf, Buffer.from(out, 'latin1')]);
}
