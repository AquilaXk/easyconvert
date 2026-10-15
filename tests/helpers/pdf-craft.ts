import zlib from 'node:zlib';

/**
 * Hand-authored PDF writer for tests (ISO 32000-1 sections 7.5.2 to 7.5.6): numbered objects, a
 * classic cross-reference table with exact byte offsets, a trailer and incremental updates.
 * It never touches the converter under test, so its output doubles as an independent fixture
 * that reference tools (pdftotext, qpdf) read as well.
 */

export interface CraftObject {
  /** Object number; generation is always 0. */
  id: number;
  /** Dictionary source without the enclosing `<<` `>>`, or the complete object body when `stream` is absent and `raw` is set. */
  dict?: string;
  /** Stream data written verbatim; `/Length` is added to `dict`. */
  stream?: Buffer;
  /** Complete object body for non-dictionary objects. */
  raw?: string;
}

function renderObject(obj: CraftObject): Buffer {
  const head = Buffer.from(`${obj.id} 0 obj\n`, 'latin1');
  const tail = Buffer.from('\nendobj\n', 'latin1');
  if (obj.stream) {
    const dict = `<< ${obj.dict ?? ''} /Length ${obj.stream.length} >>`;
    return Buffer.concat([
      head,
      Buffer.from(`${dict}\nstream\n`, 'latin1'),
      obj.stream,
      Buffer.from('\nendstream', 'latin1'),
      tail,
    ]);
  }
  const body = obj.raw ?? `<< ${obj.dict ?? ''} >>`;
  return Buffer.concat([head, Buffer.from(body, 'latin1'), tail]);
}

function renderXref(entries: { id: number; offset: number }[]): string {
  const sorted = [...entries].sort((a, b) => a.id - b.id);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].id === sorted[j].id + 1) j++;
    parts.push(`${sorted[i].id} ${j - i + 1}`);
    for (let k = i; k <= j; k++) {
      parts.push(`${String(sorted[k].offset).padStart(10, '0')} 00000 n `);
    }
    i = j + 1;
  }
  return parts.join('\n');
}

export interface CraftedPdf {
  buffer: Buffer;
  /** Byte offset of the last cross-reference section, for chaining an incremental update. */
  xrefOffset: number;
  /** One more than the highest object number written so far. */
  size: number;
}

export function buildPdf(objects: CraftObject[], rootId: number): CraftedPdf {
  const chunks: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = chunks[0].length;
  const entries: { id: number; offset: number }[] = [];
  for (const obj of objects) {
    const rendered = renderObject(obj);
    entries.push({ id: obj.id, offset });
    chunks.push(rendered);
    offset += rendered.length;
  }
  const size = Math.max(...objects.map((o) => o.id)) + 1;
  const xrefOffset = offset;
  const free = '0000000000 65535 f ';
  const xref = `xref\n0 1\n${free}\n${renderXref(entries)}\n`;
  const trailer = `trailer\n<< /Size ${size} /Root ${rootId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer, 'latin1'));
  return { buffer: Buffer.concat(chunks), xrefOffset, size };
}

/** Appends an incremental update (section 7.5.6) that redefines the given objects. */
export function appendRevision(base: CraftedPdf, objects: CraftObject[], rootId: number): CraftedPdf {
  const chunks: Buffer[] = [base.buffer];
  let offset = base.buffer.length;
  const entries: { id: number; offset: number }[] = [];
  for (const obj of objects) {
    const rendered = renderObject(obj);
    entries.push({ id: obj.id, offset });
    chunks.push(rendered);
    offset += rendered.length;
  }
  const size = Math.max(base.size, ...objects.map((o) => o.id + 1));
  const xrefOffset = offset;
  const xref = `xref\n${renderXref(entries)}\n`;
  const trailer = `trailer\n<< /Size ${size} /Root ${rootId} 0 R /Prev ${base.xrefOffset} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer, 'latin1'));
  return { buffer: Buffer.concat(chunks), xrefOffset, size };
}

export function flate(data: Buffer | string): Buffer {
  return zlib.deflateSync(typeof data === 'string' ? Buffer.from(data, 'latin1') : data);
}

/** A page content stream drawing `text` with the standard Helvetica font resource `/F1`. */
export function textContent(text: string, y = 700): string {
  return `BT\n/F1 12 Tf\n72 ${y} Td\n(${text}) Tj\nET\n`;
}

export const HELVETICA_FONT = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

/** Catalog (1), page tree (2), one page (3) with a single content stream (4) and the Helvetica font (5). */
export function singlePagePdf(
  content: Buffer,
  extra: CraftObject[] = [],
  options: { contentFilter?: boolean; pageExtra?: string; resources?: string } = {}
): CraftedPdf {
  const resources = options.resources ?? '<< /Font << /F1 5 0 R >> >>';
  const objects: CraftObject[] = [
    { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
    { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
    {
      id: 3,
      dict: `/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources ${resources} ${options.pageExtra ?? ''}`,
    },
    { id: 4, dict: options.contentFilter === false ? '' : '/Filter /FlateDecode', stream: content },
    { id: 5, raw: HELVETICA_FONT },
    ...extra,
  ];
  return buildPdf(objects, 1);
}
