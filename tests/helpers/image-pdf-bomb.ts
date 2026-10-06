import { deflateSync } from 'node:zlib';

const BITS_PER_BYTE = 8;
/** Object number of the image XObject; the objects that follow it are the caller's extra objects. */
const IMAGE_OBJECT_NUMBER = 5;

/** Assembles `objects` (object 1 is the catalog) into a PDF 1.4 file with a classic cross-reference table. */
function assemblePdf(objects: Buffer[]): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const offsets: number[] = [];
  let position = parts[0].length;
  objects.forEach((body, index) => {
    const head = Buffer.from(`${index + 1} 0 obj\n`);
    const tail = Buffer.from('\nendobj\n');
    offsets.push(position);
    parts.push(head, body, tail);
    position += head.length + body.length + tail.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`]
    .concat(offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`))
    .join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`));
  return Buffer.concat(parts);
}

function pageObjects(content: Buffer, resources: string): Buffer[] {
  return [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 240] /Resources ${resources} /Contents 4 0 R >>`),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]),
  ];
}

/** How a test writes the dictionary of the image object: its key text, given the stream length, and extra objects. */
export interface ImageDictionary {
  /** The dictionary between `<<` and `>>`; `{length}` is replaced by the stream length. */
  body: string;
  /** Bodies of the objects numbered 6, 7, ... that the dictionary may refer to. */
  extraObjects?: string[];
}

/**
 * One-page PDF 1.4 (ISO 32000-1) that paints a 1-bit DeviceGray image XObject declared as `width` x `height`.
 * The image stream is Flate-compressed zeros, so a few hundred KiB inflate to `width * height / 8` bytes and
 * unpack to `width * height` pixels when a consumer decodes the picture. With `inline` the picture is an
 * inline image (BI/ID/EI) in the page content instead of an XObject. `dictionary` replaces the image
 * dictionary text, to write the same image in a form a simple scan may misread.
 */
export function pdfWithFlateImage(width: number, height: number, inline = false, dictionary?: ImageDictionary): Buffer {
  const rowBytes = Math.ceil(width / BITS_PER_BYTE);
  const imageStream = deflateSync(Buffer.alloc(rowBytes * height), { level: 9 });
  const content = inline
    ? Buffer.concat([
        Buffer.from(`q 200 0 0 200 20 20 cm\nBI /W ${width} /H ${height} /BPC 1 /CS /G /F /Fl\nID `),
        imageStream,
        Buffer.from('\nEI Q'),
      ])
    : Buffer.from('q 200 0 0 200 20 20 cm /Im0 Do Q');
  const body =
    dictionary?.body ??
    `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode /Length {length}`;
  const imageObject = Buffer.concat([
    Buffer.from(`<< ${body.replace('{length}', String(imageStream.length))} >>\nstream\n`),
    imageStream,
    Buffer.from('\nendstream'),
  ]);
  const resources = inline ? '<< >>' : `<< /XObject << /Im0 ${IMAGE_OBJECT_NUMBER} 0 R >> >>`;
  const objects = pageObjects(content, resources);
  if (!inline) {
    objects.push(imageObject);
    for (const extra of dictionary?.extraObjects ?? []) objects.push(Buffer.from(extra));
  }
  return assemblePdf(objects);
}
