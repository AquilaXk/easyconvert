import { deflateSync } from 'node:zlib';

const BITS_PER_BYTE = 8;

/**
 * One-page PDF 1.4 (ISO 32000-1) that paints a 1-bit DeviceGray image XObject declared as `width` x `height`.
 * The image stream is Flate-compressed zeros, so a few hundred KiB inflate to `width * height / 8` bytes and
 * unpack to `width * height` pixels when a consumer decodes the picture. With `inline` the picture is an
 * inline image (BI/ID/EI) in the page content instead of an XObject.
 */
export function pdfWithFlateImage(width: number, height: number, inline = false): Buffer {
  const rowBytes = Math.ceil(width / BITS_PER_BYTE);
  const imageStream = deflateSync(Buffer.alloc(rowBytes * height), { level: 9 });
  const content = inline
    ? Buffer.concat([
        Buffer.from(`q 200 0 0 200 20 20 cm\nBI /W ${width} /H ${height} /BPC 1 /CS /G /F /Fl\nID `),
        imageStream,
        Buffer.from('\nEI Q'),
      ])
    : Buffer.from('q 200 0 0 200 20 20 cm /Im0 Do Q');
  const imageObject = Buffer.concat([
    Buffer.from(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode /Length ${imageStream.length} >>\nstream\n`
    ),
    imageStream,
    Buffer.from('\nendstream'),
  ]);
  const resources = inline ? '<< >>' : '<< /XObject << /Im0 5 0 R >> >>';
  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 240] /Resources ${resources} /Contents 4 0 R >>`),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]),
  ];
  if (!inline) objects.push(imageObject);
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
