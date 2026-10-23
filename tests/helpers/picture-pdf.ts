import { deflateSync } from 'node:zlib';

/** What a PDF of pictures holds: `drawsPerPage` placements of a `dimension` x `dimension` gray picture on each page. */
export interface PicturePdfSpec {
  pages: number;
  drawsPerPage: number;
  dimension: number;
  /** One picture painted by every page, or a picture of its own on each page. */
  sharedPicture: boolean;
}

const MEDIA_BOX = '[0 0 600 800]';
const GRID_COLUMNS = 100;
const GRID_STEP = 5;
const PLACEMENT_SIZE = 2;

function assemble(objects: Buffer[]): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n')];
  const offsets: number[] = [];
  let position = parts[0].length;
  objects.forEach((body, index) => {
    const wrapped = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    offsets.push(position);
    parts.push(wrapped);
    position += wrapped.length;
  });
  const table = offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${table}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`));
  return Buffer.concat(parts);
}

function stream(dictionary: string, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`<< ${dictionary} /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')]);
}

function pictureObject(dimension: number, shade: number): Buffer {
  const dictionary = `/Type /XObject /Subtype /Image /Width ${dimension} /Height ${dimension} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`;
  return stream(dictionary, deflateSync(Buffer.alloc(dimension * dimension, shade)));
}

function placements(draws: number): Buffer {
  const operators = Array.from({ length: draws }, (_, draw) => {
    const x = (draw % GRID_COLUMNS) * GRID_STEP;
    const y = Math.floor(draw / GRID_COLUMNS) * GRID_STEP;
    return `q ${PLACEMENT_SIZE} 0 0 ${PLACEMENT_SIZE} ${x} ${y} cm /Im0 Do Q`;
  });
  return deflateSync(Buffer.from(operators.join('\n')));
}

/** A PDF whose pages place the same picture again and again; its size stays a few KiB however many placements it holds. */
export function picturePdf({ pages, drawsPerPage, dimension, sharedPicture }: PicturePdfSpec): Buffer {
  const kids = Array.from({ length: pages }, (_, page) => `${3 + (sharedPicture ? 1 : pages) + page * 2} 0 R`).join(' ');
  const objects: Buffer[] = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), Buffer.from(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`)];
  const content = placements(drawsPerPage);
  const pictures = sharedPicture ? [pictureObject(dimension, 90)] : Array.from({ length: pages }, (_, page) => pictureObject(dimension, (page % 250) + 1));
  objects.push(...pictures);
  for (let page = 0; page < pages; page++) {
    const picture = 3 + (sharedPicture ? 0 : page);
    const contentNumber = 3 + pictures.length + page * 2 + 1;
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox ${MEDIA_BOX} /Resources << /XObject << /Im0 ${picture} 0 R >> >> /Contents ${contentNumber} 0 R >>`));
    objects.push(stream('/Filter /FlateDecode', content));
  }
  return assemble(objects);
}
