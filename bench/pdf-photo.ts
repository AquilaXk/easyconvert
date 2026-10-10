/**
 * The input of the compress rows: a PDF with a photograph on every page, written here byte by byte from the PDF file
 * structure (ISO 32000-1 sections 7.5, 8.9 and 7.4.8) so no PDF library of the project is involved. The photograph is
 * a JPEG file embedded as it is (DCTDecode), placed small enough that its resolution on the page is well above what
 * a "web" optimisation keeps, so a downsampling optimiser has pixels to remove.
 */

const NUMBER_DIGITS = 4;
const OFFSET_DIGITS = 10;
const GENERATION_DIGITS = 5;
const POINTS_PER_INCH = 72;
const SOF_MARKERS: ReadonlySet<number> = new Set([0xc0, 0xc1, 0xc2]);
const JPEG_SOI = 0xffd8;
const MARKER_PREFIX = 0xff;
const SEGMENT_HEADER_BYTES = 2;
const SOF_HEIGHT_OFFSET = 5;
const SOF_WIDTH_OFFSET = 7;
const SOF_COMPONENTS_OFFSET = 9;

export interface PhotoPage {
  /** One line of text above the photograph, so the page also has a text layer to compare. */
  text: string;
  /** Width of the photograph on the page, in points; its height keeps the aspect ratio. */
  photoWidthPoints: number;
}

export interface PhotoPdfSpec {
  jpeg: Buffer;
  pages: readonly PhotoPage[];
  pageWidth: number;
  pageHeight: number;
}

export interface JpegInfo {
  width: number;
  height: number;
  components: number;
}

/** Size and component count of a baseline or progressive JPEG, from its start-of-frame segment. */
export function readJpegInfo(jpeg: Buffer): JpegInfo {
  if (jpeg.readUInt16BE(0) !== JPEG_SOI) throw new RangeError('not a JPEG file');
  let offset = SEGMENT_HEADER_BYTES;
  while (offset + SEGMENT_HEADER_BYTES < jpeg.length) {
    if (jpeg[offset] !== MARKER_PREFIX) throw new RangeError('JPEG marker expected');
    const marker = jpeg[offset + 1];
    if (SOF_MARKERS.has(marker)) {
      return {
        height: jpeg.readUInt16BE(offset + SOF_HEIGHT_OFFSET),
        width: jpeg.readUInt16BE(offset + SOF_WIDTH_OFFSET),
        components: jpeg[offset + SOF_COMPONENTS_OFFSET],
      };
    }
    offset += SEGMENT_HEADER_BYTES + jpeg.readUInt16BE(offset + SEGMENT_HEADER_BYTES);
  }
  throw new RangeError('JPEG has no start-of-frame segment');
}

const number = (value: number): string => value.toFixed(NUMBER_DIGITS);
const escapeText = (text: string): string => text.replace(/[\\()]/g, String.raw`\$&`);

/** Pixels per inch of the photograph at the size it is placed. */
export function photoResolution(info: JpegInfo, photoWidthPoints: number): number {
  return (info.width / photoWidthPoints) * POINTS_PER_INCH;
}

/** A complete PDF with a correct cross-reference table: one image object shared by every page. */
export function buildPhotoPdf(spec: PhotoPdfSpec): Buffer {
  const info = readJpegInfo(spec.jpeg);
  if (info.components !== 3) throw new RangeError('the photograph must be a colour JPEG');
  const aspect = info.height / info.width;
  const pageCount = spec.pages.length;
  // Objects: 1 catalog, 2 page tree, 3 image, 4 font, then a page and a content stream per page.
  const firstPageObject = 5;
  const pageObject = (index: number): number => firstPageObject + index * 2;
  const pageRefs = spec.pages.map((_, index) => `${pageObject(index)} 0 R`);
  const bodies: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from(`<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pageCount} >>`, 'latin1'),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${spec.jpeg.length} >>\nstream\n`,
        'latin1'
      ),
      spec.jpeg,
      Buffer.from('\nendstream', 'latin1'),
    ]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', 'latin1'),
  ];
  for (const [index, page] of spec.pages.entries()) {
    const width = page.photoWidthPoints;
    const height = width * aspect;
    const x = (spec.pageWidth - width) / 2;
    const y = spec.pageHeight - 90 - height;
    const content = [
      'BT',
      '/F1 16 Tf',
      `${number(x)} ${number(spec.pageHeight - 60)} Td`,
      `(${escapeText(page.text)}) Tj`,
      'ET',
      'q',
      `${number(width)} 0 0 ${number(height)} ${number(x)} ${number(y)} cm`,
      '/Im0 Do',
      'Q',
    ].join('\n');
    bodies.push(
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${number(spec.pageWidth)} ${number(spec.pageHeight)}] /Contents ${pageObject(index) + 1} 0 R /Resources << /Font << /F1 4 0 R >> /XObject << /Im0 3 0 R >> >> >>`,
        'latin1'
      ),
      Buffer.from(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`, 'latin1')
    );
  }

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let position = chunks[0].length;
  for (const [index, body] of bodies.entries()) {
    offsets.push(position);
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    chunks.push(object);
    position += object.length;
  }
  const entries = offsets.map((offset) => `${String(offset).padStart(OFFSET_DIGITS, '0')} ${'0'.repeat(GENERATION_DIGITS)} n \n`);
  chunks.push(
    Buffer.from(
      `xref\n0 ${bodies.length + 1}\n${'0'.repeat(OFFSET_DIGITS)} 65535 f \n${entries.join('')}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`,
      'latin1'
    )
  );
  return Buffer.concat(chunks);
}
