/**
 * A PDF whose chosen objects are stored in one uncompressed object stream (ISO 32000-1 section 7.5.7) behind a
 * cross-reference stream (section 7.5.8), written by hand so that a test controls the bytes in front of each stored object:
 * the standard lets white space and comments stand there, and writers other than qpdf leave them.
 */

const XREF_FIELD_WIDTHS = [1, 4, 2];
const TYPE_FREE = 0;
const TYPE_PLAIN = 1;
const TYPE_PACKED = 2;

/** A cross-reference stream entry: type, then the offset (or holder number) and the generation (or index). */
function xrefEntry(type: number, second: number, third: number): Buffer {
  const entry = Buffer.alloc(XREF_FIELD_WIDTHS.reduce((sum, width) => sum + width, 0));
  entry.writeUInt8(type, 0);
  entry.writeUInt32BE(second, 1);
  entry.writeUInt16BE(third, 5);
  return entry;
}

/**
 * `objects` are the bodies of objects 1, 2, ... (stream objects included). Those named in `packed` go into the object
 * stream, each behind the text `packed` gives for its number and followed by one space (so that a comment with no line end
 * runs to the end of its object); the others are written as ordinary objects. `aliases` more entries of the header, numbered
 * after the file's objects, name the offset of the first stored object.
 */
export function objectStreamPdf(objects: string[], packed: ReadonlyMap<number, string>, aliases = 0): Buffer {
  const holder = objects.length + 1;
  const xrefStream = objects.length + 2;
  let out = '%PDF-1.5\n';
  const plainOffsets = new Map<number, number>();
  objects.forEach((body, index) => {
    const number = index + 1;
    if (packed.has(number)) return;
    plainOffsets.set(number, out.length);
    out += `${number} 0 obj\n${body}\nendobj\n`;
  });

  const members = [...packed].map(([number, before]) => ({ number, text: `${before}${objects[number - 1]}` }));
  let header = '';
  let packedBody = '';
  for (const { number, text } of members) {
    header += `${number} ${packedBody.length} `;
    packedBody += `${text} `;
  }
  for (let alias = 1; alias <= aliases; alias++) header += `${xrefStream + alias} 0 `;
  const data = header + packedBody;
  plainOffsets.set(holder, out.length);
  out += `${holder} 0 obj\n<< /Type /ObjStm /N ${members.length + aliases} /First ${header.length} /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\n`;

  const xrefAt = out.length;
  plainOffsets.set(xrefStream, xrefAt);
  const entries = [xrefEntry(TYPE_FREE, 0, 0xffff)];
  for (let number = 1; number <= xrefStream; number++) {
    const index = members.findIndex((member) => member.number === number);
    entries.push(index === -1 ? xrefEntry(TYPE_PLAIN, plainOffsets.get(number) as number, 0) : xrefEntry(TYPE_PACKED, holder, index));
  }
  const table = Buffer.concat(entries);
  const dictionary = `<< /Type /XRef /Size ${xrefStream + 1} /W [${XREF_FIELD_WIDTHS.join(' ')}] /Root 1 0 R /Length ${table.length} >>`;
  return Buffer.concat([
    Buffer.from(out, 'latin1'),
    Buffer.from(`${xrefStream} 0 obj\n${dictionary}\nstream\n`, 'latin1'),
    table,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`, 'latin1'),
  ]);
}
