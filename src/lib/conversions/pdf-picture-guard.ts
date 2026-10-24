import { InflateBudget, MAX_STREAM_INFLATE_BYTES } from './bounded-inflate';
import { type PdfDict, type PdfDocument, type PdfImageStream, type PdfValue, parseValue } from './pdf-document';
import { ccittPixels, jbig2Cost, jpxCodestream, jpxDecodedSamples, jpxDecoderBytes, pdfjsJpxProperties, pdfjsJpxReducePower } from './pdf-picture-headers';
import { forEachContentToken } from './pdf-stream-guard';
import { PDF_CONTENT_MAX_PICTURES, PDF_TEXT_MAX_IMAGE_PIXELS, PDF_WASM_DECODER_MAX_BYTES, pdfTextFailure } from './pdf-text-types';

/**
 * Which pictures pdf.js may hand to its WebAssembly decoders, decided from their headers before pdf.js reads the document.
 *
 * A JPEG 2000, JBIG2 or CCITT picture is left out when its decode would allocate more than PDF_PICTURE_DECODER_BUDGET_BYTES
 * (pdf-picture-headers.ts) or walk more than PDF_PICTURE_MAX_WALK_PIXELS: the image object is replaced by null in the copy pdf.js
 * reads, and pdf.js then skips the drawing as it skips any XObject that is not a stream. PDFium and pdf.js drop a picture whose
 * decoder fails in the same way, and the text and the other pictures convert. An inline picture cannot be replaced, so one past
 * a limit refuses the job (413). A document whose pages decode more of these pictures than a document may return
 * (PDF_CONTENT_MAX_PICTURES) is refused before any is decoded.
 *
 * The pdf.js picture of a JPEG 2000 stream is reduced by the size pdf.js reads from the first `FF 51` of the stream, which a
 * box ahead of the codestream can fake; the cost here is that of the codestream OpenJPEG decodes with that reduction. pdf.js
 * reads that size only when JPXDecode is the first filter; behind another filter the picture is decoded at full size.
 */

/** Three quarters of the decoder's memory maximum: the rest holds the module's own data, the coded bytes and its 5 % growth steps. */
const PDF_PICTURE_DECODER_BUDGET_BYTES = (PDF_WASM_DECODER_MAX_BYTES / 4) * 3;
/**
 * Pixels one picture may make its decoder walk: twice the pixel limit of a picture's dictionary (pdf.js skips a larger one,
 * `maxImageSize`). A real picture's decoder walks about its own pixels: CCITT rows of /Columns, JBIG2 regions that tile the
 * page (at most one page of region pixels per page in the 1,261 real-world PDFs). A walk of more is one of /Columns far past
 * the width, or of regions larger than the page.
 */
const PDF_PICTURE_MAX_WALK_PIXELS = 2 * PDF_TEXT_MAX_IMAGE_PIXELS;
/** Decoded bytes of the filters ahead of the picture codecs that one document may read (Flate or ASCII wrappers). */
const PICTURE_PREFIX_BUDGET_BYTES = MAX_STREAM_INFLATE_BYTES;

const JPX = 'JPXDecode';
const JBIG2 = 'JBIG2Decode';
const CCITT_NAMES = new Set(['CCITTFaxDecode', 'CCF']);
const INLINE_KEYS: Record<string, string> = { W: 'Width', H: 'Height', F: 'Filter', DP: 'DecodeParms' };
/** `ID` and the one white-space byte after it, before the data of an inline image; and the white space and `EI` after it. */
const INLINE_DATA_OFFSET = 3;
const INLINE_END = ' EI';

/** What decoding one picture costs: decoder memory, and the pixels or samples it walks. */
interface PictureCost {
  decoderBytes: number;
  pixels: number;
}

/** The cost of a picture whose coded data cannot be read here (an encrypted file, or an unreadable filter ahead of the codec). */
const UNREAD: PictureCost = { decoderBytes: 0, pixels: 0 };

function overLimits(cost: PictureCost): boolean {
  return cost.decoderBytes > PDF_PICTURE_DECODER_BUDGET_BYTES || cost.pixels > PDF_PICTURE_MAX_WALK_PIXELS;
}

/** A picture's dictionary and filters, from an image XObject or an inline image. */
interface CodedPicture {
  value(key: string): PdfValue;
  filters: Array<{ name: string; parms: PdfDict | null }>;
  /** The data the filter at `index` reads, or null when it cannot be read here. */
  dataBefore(index: number): Buffer | null;
}

/** The document a plan reads, the budget of the filters ahead of the codecs, and the JBIG2Globals streams read so far. */
interface ScanContext {
  document: PdfDocument;
  prefixBudget: InflateBudget;
  globals: Map<number, Buffer | null>;
}

type PdfObjectValue = Exclude<PdfValue, number | boolean | null>;

function objectOf(value: PdfValue | undefined): PdfObjectValue | null {
  return typeof value === 'object' && value !== null ? value : null;
}

function numberOf(value: PdfValue): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function codecIndex(picture: CodedPicture): number {
  return picture.filters.findIndex(({ name }) => name === JPX || name === JBIG2 || CCITT_NAMES.has(name));
}

/** The decoded JBIG2Globals stream `value` names, read once per object however many pictures share it. */
function globalsOf({ document, prefixBudget, globals }: ScanContext, value: PdfValue | undefined): Buffer | null {
  const ref = objectOf(value);
  if (ref?.kind !== 'ref') return null;
  if (!globals.has(ref.num)) globals.set(ref.num, document.streamData(ref, prefixBudget));
  return globals.get(ref.num) ?? null;
}

/** The cost of decoding `picture`, or null when none of its filters is a WebAssembly codec. */
function pictureCost(context: ScanContext, picture: CodedPicture): PictureCost | null {
  const index = codecIndex(picture);
  if (index < 0) return null;
  const { name, parms } = picture.filters[index];
  const width = numberOf(picture.value('Width')) ?? 0;
  const height = numberOf(picture.value('Height')) ?? 0;
  const parm = (key: string): number | null => numberOf(context.document.resolved(parms?.entries.get(key)));
  if (CCITT_NAMES.has(name)) return { decoderBytes: 0, pixels: ccittPixels(parm('Columns'), parm('Rows'), height) };
  const data = picture.dataBefore(index);
  if (data === null) return UNREAD;
  if (name === JBIG2) return jbig2Cost(data, globalsOf(context, parms?.entries.get('JBIG2Globals')), width, height);
  const codestream = jpxCodestream(data);
  if (codestream === null) return UNREAD;
  const pdfjsSize = index === 0 ? pdfjsJpxProperties(data) : null;
  const reducePower = pdfjsSize === null ? 0 : pdfjsJpxReducePower(pdfjsSize);
  return { decoderBytes: jpxDecoderBytes(codestream, reducePower) + data.length, pixels: jpxDecodedSamples(codestream, reducePower) / codestream.components.length };
}

function xobjectPicture({ document, prefixBudget }: ScanContext, image: PdfImageStream): CodedPicture {
  return { value: (key) => document.resolved(image.dict.entries.get(key)), filters: image.filters, dataBefore: (index) => image.dataBefore(index, prefixBudget) };
}

/** The masks pdf.js decodes with an image (/SMask, and /Mask when it is a stream; ISO 32000-1 sections 8.9.6 and 11.6.5.3). */
function masksOf(document: PdfDocument, image: PdfImageStream): PdfImageStream[] {
  return ['SMask', 'Mask'].map((key) => document.imageStream(image.dict.entries.get(key))).filter((mask): mask is PdfImageStream => mask !== null);
}

/** The inline images of one content stream with a WebAssembly codec, read from `BI` to `EI` (ISO 32000-1 section 8.9.7). */
function inlinePictures(content: string): CodedPicture[] {
  const pictures: CodedPicture[] = [];
  let dictionaryStart = -1;
  forEachContentToken(content, (token, start, end) => {
    if (token === 'BI') dictionaryStart = end;
    if (token !== 'ID' || dictionaryStart < 0) return;
    const entries = new Map<string, PdfValue>();
    let at = dictionaryStart;
    while (at < start) {
      const key = parseValue(content, at, 0);
      if (key.end >= start || typeof key.value !== 'object' || key.value?.kind !== 'name') break;
      const value = parseValue(content, key.end, 0);
      entries.set(INLINE_KEYS[key.value.value] ?? key.value.value, value.value);
      at = value.end;
    }
    dictionaryStart = -1;
    const filterValue = objectOf(entries.get('Filter'));
    const names = (filterValue?.kind === 'array' ? filterValue.items : [filterValue]).map((item) => {
      const name = objectOf(item);
      return name?.kind === 'name' ? name.value : '';
    });
    const parmsValue = objectOf(entries.get('DecodeParms'));
    const parmsOf = (index: number): PdfDict | null => {
      if (parmsValue?.kind !== 'array') return index === 0 && parmsValue?.kind === 'dict' ? parmsValue : null;
      const item = objectOf(parmsValue.items[index]);
      return item?.kind === 'dict' ? item : null;
    };
    const dataEnd = content.startsWith('EI', end - INLINE_END.length + 1) ? end - INLINE_END.length : end;
    const data = Buffer.from(content.slice(Math.min(dataEnd, start + INLINE_DATA_OFFSET), dataEnd), 'latin1');
    const picture: CodedPicture = { value: (key) => entries.get(key) ?? null, filters: names.map((name, index) => ({ name, parms: parmsOf(index) })), dataBefore: (index) => (index === 0 ? data : null) };
    if (codecIndex(picture) >= 0) pictures.push(picture);
  });
  return pictures;
}

/** What the reader asks of pdf.js for the pictures of a document. */
export interface PicturePlan {
  /** Image objects to replace by null in the copy pdf.js reads. */
  dropped: Array<{ num: number; gen: number }>;
}

/** Collects the inline pictures of the content streams `assertPdfStreamsWithinLimits` reads, per page. */
export class InlinePictureCollector {
  readonly byPage = new Map<number, CodedPicture[]>();

  readonly visit = (content: string, pageIndex: number | null): void => {
    if (pageIndex === null || !content.includes('BI')) return;
    const found = inlinePictures(content);
    if (found.length > 0) this.byPage.set(pageIndex, [...(this.byPage.get(pageIndex) ?? []), ...found]);
  };
}

/**
 * The plan for `document`'s pictures: every image object whose decode, or that of one of its masks, is past a limit is dropped.
 * The pages' pictures are then counted as pdf.js decodes them, again on each page that draws one.
 * @throws PayloadLimitError (413) for an inline picture past a limit, or when the pages decode more than PDF_CONTENT_MAX_PICTURES pictures.
 */
export function planPictureDecoding(document: PdfDocument, inline: InlinePictureCollector): PicturePlan {
  const context: ScanContext = { document, prefixBudget: new InflateBudget(PICTURE_PREFIX_BUDGET_BYTES), globals: new Map() };
  const costs = new Map<number, PictureCost | null>();
  const costOf = (image: PdfImageStream): PictureCost | null => {
    if (!costs.has(image.objectNumber)) costs.set(image.objectNumber, pictureCost(context, xobjectPicture(context, image)));
    return costs.get(image.objectNumber) ?? null;
  };
  const over = (image: PdfImageStream): boolean => {
    const cost = costOf(image);
    return cost !== null && overLimits(cost);
  };
  const dropped = new Map<number, { num: number; gen: number }>();
  for (const num of document.imageStreamNumbers()) {
    const image = document.imageStream({ kind: 'ref', num });
    if (image === null) continue;
    if (over(image) || masksOf(document, image).some(over)) dropped.set(num, { num, gen: image.generation });
  }
  let decoded = 0;
  document.paintedImageObjects().forEach((painted, pageIndex) => {
    for (const num of painted) {
      const image = dropped.has(num) ? null : document.imageStream({ kind: 'ref', num });
      if (image === null) continue;
      decoded += [image, ...masksOf(document, image)].filter((picture) => costOf(picture) !== null).length;
    }
    for (const picture of inline.byPage.get(pageIndex) ?? []) {
      const cost = pictureCost(context, picture) ?? UNREAD;
      if (overLimits(cost)) {
        throw pdfTextFailure('limit', `An inline picture on page ${pageIndex + 1} would take ${cost.decoderBytes} bytes or ${cost.pixels} pixels to decode, past the limit of ${PDF_PICTURE_DECODER_BUDGET_BYTES} bytes or ${PDF_PICTURE_MAX_WALK_PIXELS} pixels.`);
      }
      decoded++;
    }
  });
  if (decoded > PDF_CONTENT_MAX_PICTURES) {
    throw pdfTextFailure('limit', `PDF pages decode ${decoded} JPEG 2000, JBIG2 and CCITT pictures; a document may decode at most ${PDF_CONTENT_MAX_PICTURES}.`);
  }
  return { dropped: [...dropped.values()] };
}
