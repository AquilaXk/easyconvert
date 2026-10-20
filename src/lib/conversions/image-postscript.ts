import { promisify } from 'node:util';
import { deflate } from 'node:zlib';
import { ConversionFailedError } from '../types';
import { DEFAULT_PRINT_DENSITY, pageSizePoints, type PrintDensity } from './image-print-density';

/**
 * PostScript (and EPS) writer for a raster picture. A page is one picture at its stored print size, as the PDF writer sizes its
 * pages (pixels x 72 / dpi points on each axis, one pixel to the point when the picture states no resolution; see
 * image-print-density.ts). The samples go in as a FlateDecode stream in ASCII85 (PostScript Language Reference, LanguageLevel 3: the filters
 * of a data source, Adobe Technical Note 5603 for the structuring comments): a hexadecimal copy of the raw samples was 6
 * bytes to the pixel, so a scan of 3,307 x 4,677 pixels weighed 94 MB.
 *
 * A PostScript document sets the size of every page with `setpagedevice` (an interpreter that is not told draws on its default
 * page and cuts off what lies outside it); an EPS has no page device, its bounding box is its size. A document of several
 * pages is made of single-page documents: `joinPostscriptPages` takes the page of each and numbers them again.
 */

const deflateAsync = promisify(deflate);

const RGB_CHANNELS = 3;
const BYTE_VALUES = 256;
const ASCII85_GROUP_BYTES = 4;
const ASCII85_GROUP_CHARS = 5;
const ASCII85_FIRST_CHAR = 33;
const ASCII85_BASE = 85;
/** Groups on a line: 75 characters, well under the 255 characters a PostScript line may hold. */
const ASCII85_GROUPS_PER_LINE = 15;
const ASCII85_END = '~>';
const LINE_FEED = 10;
const HEADER_PROBE_BYTES = 512;

const PAGE_OPEN = '%%Page: 1 1\n';
const PAGE_CLOSE = '%%Trailer\n';
const BOUNDING_BOX = /^%%BoundingBox: 0 0 (\d+) (\d+)$/m;

/** The value of the group of up to four bytes at `start`, a short group padded with zero bytes. */
function ascii85Value(data: Buffer, start: number): number {
  let value = 0;
  for (let byte = 0; byte < ASCII85_GROUP_BYTES; byte += 1) value = value * BYTE_VALUES + (start + byte < data.length ? data[start + byte] : 0);
  return value;
}

/** The bytes as ASCII85 text in lines, ended by `~>`; an all-zero group is written as five characters, not as `z`. */
export function encodeAscii85(data: Buffer): Buffer {
  const groups = Math.ceil(data.length / ASCII85_GROUP_BYTES);
  const out = Buffer.allocUnsafe(groups * ASCII85_GROUP_CHARS + Math.ceil(groups / ASCII85_GROUPS_PER_LINE) + ASCII85_END.length);
  let written = 0;
  for (let group = 0; group < groups; group += 1) {
    const start = group * ASCII85_GROUP_BYTES;
    // The five digits are written most significant first; a short last group keeps one character more than the bytes it holds,
    // and the digits past those are overwritten by what follows.
    let rest = ascii85Value(data, start);
    for (let place = ASCII85_GROUP_CHARS - 1; place >= 0; place -= 1) {
      const quotient = Math.floor(rest / ASCII85_BASE);
      out[written + place] = rest - quotient * ASCII85_BASE + ASCII85_FIRST_CHAR;
      rest = quotient;
    }
    written += Math.min(ASCII85_GROUP_CHARS, data.length - start + 1);
    if ((group + 1) % ASCII85_GROUPS_PER_LINE === 0) out[written++] = LINE_FEED;
  }
  written += out.write(ASCII85_END, written, 'latin1');
  return out.subarray(0, written);
}

/** The structuring comments that open a document of `pages` pages, the largest of which is `width` x `height` points. */
function documentHead(isEps: boolean, pages: number, width: number, height: number): string {
  return `%!PS-Adobe-3.0${isEps ? ' EPSF-3.0' : ''}
%%Creator: EasyConvert Image Engine
%%BoundingBox: 0 0 ${width} ${height}
%%LanguageLevel: 3
%%Pages: ${pages}
%%EndComments
`;
}

/** Decimals kept of a size in points: finer than any device resolves, and a whole size is written without any. */
const POINT_DECIMALS = 4;

/** A size in points as PostScript text: a whole number as it is, any other rounded to `POINT_DECIMALS`. */
const pointsText = (points: number): string => String(Number(points.toFixed(POINT_DECIMALS)));

/** The whole number of points a bounding box needs to hold `points` (a bounding box is integral, DSC 3.0). */
const boxPoints = (points: number): number => Math.ceil(Number(points.toFixed(POINT_DECIMALS)));

/**
 * One picture of RGB samples as a single-page PostScript document, or as an EPS. The page is the picture at `density`, in points; the
 * samples are the picture's own, drawn over the whole page.
 */
export async function encodePostscript(rgb: Buffer, width: number, height: number, isEps: boolean, density: PrintDensity = DEFAULT_PRINT_DENSITY): Promise<Buffer> {
  if (rgb.length !== width * height * RGB_CHANNELS) {
    throw new ConversionFailedError(`The picture holds ${rgb.length} sample bytes, not the ${width * height * RGB_CHANNELS} of ${width} x ${height} pixels`);
  }
  const samples = encodeAscii85(await deflateAsync(rgb));
  const page = pageSizePoints(width, height, density);
  const [pageWidth, pageHeight] = [pointsText(page.width), pointsText(page.height)];
  const [boxWidth, boxHeight] = [boxPoints(page.width), boxPoints(page.height)];
  const setup = isEps ? '' : `${PAGE_OPEN}%%PageBoundingBox: 0 0 ${boxWidth} ${boxHeight}\n<< /PageSize [${pageWidth} ${pageHeight}] >> setpagedevice\n`;
  const before = `${documentHead(isEps, 1, boxWidth, boxHeight)}${setup}gsave
0 0 translate
${pageWidth} ${pageHeight} scale
${width} ${height} 8 [${width} 0 0 -${height} 0 ${height}]
currentfile /ASCII85Decode filter /FlateDecode filter
false 3 colorimage
`;
  const after = `
grestore
showpage
${isEps ? '' : PAGE_CLOSE}%%EOF
`;
  return Buffer.concat([Buffer.from(before, 'latin1'), samples, Buffer.from(after, 'latin1')]);
}

interface PageOfDocument {
  /** The page from its page comment: the bounding box, the page device and the picture. */
  body: Buffer;
  width: number;
  height: number;
}

function pageOfDocument(document: Buffer): PageOfDocument {
  const box = BOUNDING_BOX.exec(document.subarray(0, HEADER_PROBE_BYTES).toString('latin1'));
  const open = document.indexOf(PAGE_OPEN, 0, 'latin1');
  const close = document.lastIndexOf(PAGE_CLOSE, document.length, 'latin1');
  if (box === null || open < 0 || close < open) {
    throw new ConversionFailedError('A page of the PostScript document is not one this converter wrote');
  }
  return { body: document.subarray(open + PAGE_OPEN.length, close), width: Number(box[1]), height: Number(box[2]) };
}

/** One PostScript document of the pages of single-page documents (`encodePostscript`, not EPS), in order. */
export function joinPostscriptPages(documents: readonly Buffer[]): Buffer {
  const pages = documents.map(pageOfDocument);
  const width = Math.max(...pages.map((page) => page.width));
  const height = Math.max(...pages.map((page) => page.height));
  const parts: Buffer[] = [Buffer.from(documentHead(false, pages.length, width, height), 'latin1')];
  pages.forEach((page, index) => {
    parts.push(Buffer.from(`%%Page: ${index + 1} ${pages.length}\n`, 'latin1'), page.body);
  });
  parts.push(Buffer.from(`${PAGE_CLOSE}%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}
