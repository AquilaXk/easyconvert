import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { ConversionFailedError, type ConversionResult, type ConversionOptions } from '../types';
import { extract7zArchive, extractRarArchive } from './archive';
import { InflateBudget } from './bounded-inflate';
import { blankDocument, imagePixelSize } from './document-model/build';
import { documentToEpub } from './document-model/epub';
import type { DocumentImage, ImageBlock } from './document-model/model';
import { decodeBmp } from './image';
import { openInputImage, openLimitedSharp, rethrowInputPixelLimit } from './image-input-limits';
import { openPackage, readPackageEntry } from './package-access';
import { readZipEntryBytes, readZipEntryText } from './zip-entry-reader';

/**
 * Comic book archives (CBZ, CBR, and the volumes of a CBC) read as page images, in natural name order, and the
 * pages bound into a PDF. A comic has no text layer: the pages are the content.
 */

/** Most pages one comic archive may hold. */
export const CBZ_MAX_PAGES = 5000;
/** Largest decoded page image, in bytes, the converter reads out of a comic archive. */
export const CBZ_MAX_PAGE_BYTES = 256 * 1024 * 1024;
const CBZ_IMAGE_PATTERN = /\.(png|jpe?g|webp|bmp|gif)$/i;
/** Archive members that are not pages: macOS resource forks and hidden files. */
const CBZ_JUNK_MEMBER_PATTERN = /(^|\/)(__MACOSX\/|\.[^/]*$)/;
const DIGIT_RUN_PATTERN = /(\d+)/;
const PDF_PAGE_MARGIN = 40;
const BMP_SIGNATURE = 'BM';
/** Formats pdfkit embeds as they are; every other page format is decoded and embedded as PNG. */
const PDF_EMBEDDABLE_FORMATS: ReadonlySet<string> = new Set(['png', 'jpeg']);

/**
 * Orders names the way people number comic pages: digit runs compare by value ("page2" before "page10"),
 * the rest compares case-insensitively, and equal keys fall back to the raw names so the order is total.
 */
export function compareNaturally(a: string, b: string): number {
  const left = a.toLowerCase().split(DIGIT_RUN_PATTERN);
  const right = b.toLowerCase().split(DIGIT_RUN_PATTERN);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] === right[i]) continue;
    const isDigitRun = i % 2 === 1;
    if (isDigitRun) {
      const l = left[i].replace(/^0+(?=\d)/, '');
      const r = right[i].replace(/^0+(?=\d)/, '');
      if (l.length !== r.length) return l.length - r.length;
      if (l !== r) return l < r ? -1 : 1;
    } else {
      return left[i] < right[i] ? -1 : 1;
    }
  }
  if (left.length !== right.length) return left.length - right.length;
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** One page of a comic: its name in the archive and a reader that loads and size-checks its bytes. */
export interface ComicPage {
  name: string;
  read: () => Promise<Buffer>;
}

/** The page images of a ZIP comic archive in natural name order; each is read, size-checked and decoded only when bound. */
export function zipComicPages(zip: JSZip, label: string, budget = new InflateBudget()): ComicPage[] {
  return Object.keys(zip.files)
    .filter((name) => !zip.files[name].dir && CBZ_IMAGE_PATTERN.test(name) && !CBZ_JUNK_MEMBER_PATTERN.test(name))
    .sort(compareNaturally)
    .map((name) => ({
      name: label === '' ? name : `${label}/${name}`,
      read: async () => {
        const declared = (zip.files[name] as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
        if (declared !== undefined && declared > CBZ_MAX_PAGE_BYTES) {
          throw new ConversionFailedError(`CBZ page "${name}" declares ${declared} bytes, more than the ${CBZ_MAX_PAGE_BYTES} byte limit.`);
        }
        return readZipEntryBytes(zip.files[name], { maxBytes: CBZ_MAX_PAGE_BYTES, budget });
      },
    }));
}

/** A comic with no page, or with more than the page limit, is a typed 400 error. */
function assertPageCount(pages: readonly ComicPage[], format: string): void {
  if (pages.length === 0) {
    throw new ConversionFailedError(`The ${format} archive holds no page images.`);
  }
  if (pages.length > CBZ_MAX_PAGES) {
    throw new ConversionFailedError(`The ${format} archive holds ${pages.length} pages, more than the ${CBZ_MAX_PAGES} page limit.`);
  }
}

/**
 * Binds comic pages into a PDF, one image per A4 page in the order given. A page that cannot be decoded, or no
 * pages at all, fails with a typed 400 error; no page is replaced by text.
 */
export async function bindComicPagesToPdf(pages: ComicPage[], format: string, baseName: string): Promise<ConversionResult> {
  assertPageCount(pages, format);

  const doc = new PDFDocument({ autoFirstPage: false });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err) => reject(err));
  });

  for (const comicPage of pages) {
    // Pages are processed one at a time on purpose: each is decoded into memory.
    const page = await decodeComicPage(await comicPage.read(), comicPage.name, format); // NOSONAR S9382: sequential to bound memory
    doc.addPage({ size: 'A4' });
    try {
      doc.image(page, PDF_PAGE_MARGIN, PDF_PAGE_MARGIN, {
        fit: [doc.page.width - 2 * PDF_PAGE_MARGIN, doc.page.height - 2 * PDF_PAGE_MARGIN],
        align: 'center',
        valign: 'center',
      });
    } catch (err) {
      throw new ConversionFailedError(`${format} page "${comicPage.name}" cannot be embedded: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  doc.end();
  const buffer = await done;
  return { buffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: buffer.length };
}

/** Comic Book Collection (CBC): the most volumes one collection may list, and the largest volume archive read. */
const CBC_MAX_VOLUMES = 1000;
const CBC_MAX_VOLUME_BYTES = 1024 * 1024 * 1024;
const CBC_LISTING_NAME = 'comics.txt';
const CBC_VOLUME_PATTERN = /\.(cbz|cbr|cb7)$/i;
/** A listing line names a volume and its title: `volume.cbz:Title`. */
const CBC_LISTING_LINE = /^(.+?\.(?:cbz|cbr|cb7))\s*:/i;

/** The pages of an archive that was unpacked into memory: the images in natural name order, each checked for size when it is read. */
function unpackedComicPages(label: string, members: { filename: string; buffer: Buffer }[], format: string): ComicPage[] {
  return members
    .filter((m) => CBZ_IMAGE_PATTERN.test(m.filename) && !CBZ_JUNK_MEMBER_PATTERN.test(m.filename))
    .sort((a, b) => compareNaturally(a.filename, b.filename))
    .map((m) => {
      const name = label === '' ? m.filename : `${label}/${m.filename}`;
      return {
        name,
        read: async () => {
          if (m.buffer.length > CBZ_MAX_PAGE_BYTES) {
            throw new ConversionFailedError(`${format} page "${name}" is ${m.buffer.length} bytes, more than the ${CBZ_MAX_PAGE_BYTES} byte limit.`);
          }
          return m.buffer;
        },
      };
    });
}

/** The page images of one volume of a collection: a CBZ is read lazily, a CBR or CB7 is unpacked by the archive readers. */
async function cbcVolumePages(name: string, bytes: Buffer, budget: InflateBudget): Promise<ComicPage[]> {
  const lower = name.toLowerCase();
  if (lower.endsWith('.cbz')) {
    return zipComicPages(await openPackage(bytes, `CBC volume ${name}`), name, budget);
  }
  let members: { filename: string; buffer: Buffer }[];
  try {
    members = lower.endsWith('.cbr') ? extractRarArchive(bytes) : extract7zArchive(bytes);
  } catch (err) {
    throw new ConversionFailedError(`The CBC volume "${name}" cannot be unpacked: ${err instanceof Error ? err.message : String(err)}`);
  }
  return unpackedComicPages(name, members, 'CBC');
}

/** The pages of a comic archive that is one book: a CBZ (a ZIP read lazily) or a CBR (a RAR unpacked by the archive reader). */
export async function readComicPages(input: Buffer, src: 'cbz' | 'cbr'): Promise<ComicPage[]> {
  if (src === 'cbz') return zipComicPages(await openPackage(input, 'CBZ', 'ZIP archive'), '', new InflateBudget());
  let members: { filename: string; buffer: Buffer }[];
  try {
    members = extractRarArchive(input);
  } catch (err) {
    if (err instanceof ConversionFailedError) throw err;
    throw new ConversionFailedError(`The CBR archive cannot be unpacked: ${err instanceof Error ? err.message : String(err)}`);
  }
  return unpackedComicPages('', members, 'CBR');
}

/**
 * The pages of a Comic Book Collection: a ZIP of CBZ, CBR and CB7 volumes with an optional `comics.txt` that lists
 * them (`volume.cbz:Title`, one per line). Volumes the listing names come first in its order, then any other
 * volume in natural name order; a listed volume that is not in the archive is a typed 400 error.
 */
export async function readCbcPages(input: Buffer): Promise<ComicPage[]> {
  const zip = await openPackage(input, 'CBC');
  const outerBudget = new InflateBudget(CBC_MAX_VOLUME_BYTES);
  const pageBudget = new InflateBudget();
  const present = Object.keys(zip.files).filter((n) => !zip.files[n].dir && CBC_VOLUME_PATTERN.test(n) && !CBZ_JUNK_MEMBER_PATTERN.test(n));
  if (present.length === 0) throw new ConversionFailedError('The CBC archive holds no comic volumes (.cbz, .cbr or .cb7).');
  if (present.length > CBC_MAX_VOLUMES) throw new ConversionFailedError(`The CBC archive holds ${present.length} volumes, more than the ${CBC_MAX_VOLUMES} volume limit.`);

  const listed: string[] = [];
  const listing = zip.file(CBC_LISTING_NAME);
  if (listing) {
    for (const line of (await readZipEntryText(listing, { budget: outerBudget })).split(/\r?\n/)) {
      const volume = CBC_LISTING_LINE.exec(line.trim())?.[1];
      if (volume === undefined || listed.includes(volume)) continue;
      if (!present.includes(volume)) throw new ConversionFailedError(`The CBC listing names "${volume}", which is not in the archive.`);
      listed.push(volume);
    }
  }
  const ordered = [...listed, ...present.filter((n) => !listed.includes(n)).sort(compareNaturally)];

  const pages: ComicPage[] = [];
  for (const volume of ordered) {
    const bytes = await readPackageEntry(zip, volume, CBC_MAX_VOLUME_BYTES, 'CBC listing', outerBudget); // NOSONAR S9382: one volume in memory at a time
    pages.push(...(await cbcVolumePages(volume, bytes, pageBudget))); // NOSONAR S9382: sequential to bound memory
    if (pages.length > CBZ_MAX_PAGES) throw new ConversionFailedError(`The CBC collection holds more than the ${CBZ_MAX_PAGES} page limit.`);
  }
  return pages;
}

/** Proves that a page decodes and returns bytes pdfkit can embed (PNG and JPEG as stored). */
async function decodeComicPage(bytes: Buffer, name: string, format: string): Promise<Buffer> {
  if (bytes.length > CBZ_MAX_PAGE_BYTES) {
    throw new ConversionFailedError(`${format} page "${name}" is ${bytes.length} bytes, more than the ${CBZ_MAX_PAGE_BYTES} byte limit.`);
  }
  try {
    if (bytes.length >= BMP_SIGNATURE.length && bytes.toString('latin1', 0, BMP_SIGNATURE.length) === BMP_SIGNATURE) {
      // libvips has no BMP loader: the in-process decoder reads the pixels, checking the declared size first.
      const bmp = decodeBmp(bytes);
      return await sharp(bmp.raw, { raw: { width: bmp.width, height: bmp.height, channels: bmp.channels } }).png().toBuffer();
    }
    const image = await openInputImage(bytes);
    const format = (await image.metadata()).format ?? '';
    if (PDF_EMBEDDABLE_FORMATS.has(format)) {
      await openLimitedSharp(bytes).stats();
      return bytes;
    }
    return await image.png().toBuffer();
  } catch (err) {
    rethrowInputPixelLimit(err);
    throw new ConversionFailedError(`${format} page "${name}" cannot be decoded: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const PNG_FIRST_BYTE = 0x89;
/** Points per pixel at 96 dpi, the size a page picture is given in the book. */
const POINTS_PER_PIXEL = 0.75;

/**
 * Writes the pages as an image book: an EPUB whose content is one picture per page, in page order, with the first page as
 * the cover. A page that cannot be decoded, or no pages at all, is a typed 400 error; no page is replaced by text.
 */
export async function comicPagesToEpub(pages: ComicPage[], format: string, baseName: string, options: ConversionOptions): Promise<ConversionResult> {
  assertPageCount(pages, format);
  const images: DocumentImage[] = [];
  const blocks: ImageBlock[] = [];
  for (const comicPage of pages) {
    // Pages are processed one at a time on purpose: each is decoded into memory.
    const data = await decodeComicPage(await comicPage.read(), comicPage.name, format); // NOSONAR S9382: sequential to bound memory
    const imageFormat = data[0] === PNG_FIRST_BYTE ? 'png' : 'jpeg';
    const size = imagePixelSize(data, imageFormat);
    if (size === undefined) throw new ConversionFailedError(`${format} page "${comicPage.name}" has no readable picture size.`);
    images.push({ id: images.length, format: imageFormat, data, pixelWidth: size.width, pixelHeight: size.height });
    blocks.push({ type: 'image', imageId: images.length - 1, widthPt: size.width * POINTS_PER_PIXEL, heightPt: size.height * POINTS_PER_PIXEL, alt: `Page ${images.length}` });
  }
  const model = { ...blankDocument([{ columns: 1, blocks }]), images, title: baseName, coverImageId: 0 };
  const buffer = await documentToEpub(model, { title: baseName, language: options.language });
  return { buffer, mimeType: 'application/epub+zip', filename: `${baseName}.epub`, size: buffer.length };
}
