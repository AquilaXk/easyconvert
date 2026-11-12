import path from 'node:path';
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { METADATA_WRITE_FORMATS } from '../graph-operations';
import { openPdfForEditing, PDF_LIB_OBJECTS_PER_TICK, type PdfAccess } from '../../conversions/pdf-access';
import { editExif, ExifFormatError, ExifValueError, WRITABLE_EXIF_FIELDS, type ExifEdits } from './exif';
import { ImageContainerError, readEmbeddedBlocks, withEmbeddedBlocks } from './image-blocks';
import { MetadataFieldError, MetadataWriteUnsupportedError } from './errors';
import { buildXmp, WRITABLE_XMP_FIELDS } from './xmp';

/**
 * Writes metadata into a file without changing anything else in it. Only the formats where that holds are written: a JPEG or a PNG,
 * whose EXIF block and XMP packet are cut out of the container and replaced (the picture is never decoded or encoded again), and a
 * PDF, whose information dictionary is rewritten with the pages kept. Any other format is refused, since writing it would encode the
 * picture or the document again. The field names are those of ExifTool; a name may carry its group (`EXIF:Artist`, `XMP:Title`,
 * `PDF:Title`).
 */

/** What an edit sets: a field name with the value it takes, or null to remove the field. A list field takes an array. */
export type MetadataEdits = Readonly<Record<string, string | number | string[] | null>>;

export const PDF_WRITABLE_FIELDS: readonly string[] = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreateDate', 'ModifyDate'];
const PDF_DATE_FIELDS: ReadonlySet<string> = new Set(['CreateDate', 'ModifyDate']);
const PDF_INFO_KEYS: Readonly<Record<string, string>> = { CreateDate: 'CreationDate', ModifyDate: 'ModDate' };
const MAX_FIELDS = 64;
const MAX_TEXT_CHARS = 8192;
const EXIF_DATE = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

export const WRITABLE_METADATA_FORMATS = METADATA_WRITE_FORMATS;

export interface MetadataWriteResult {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

const MIME_TYPES: Readonly<Record<string, string>> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };

/** The group a name carries and the name without it; a name without a group has none. */
function splitField(key: string): { group?: string; name: string } {
  const colon = key.indexOf(':');
  return colon < 0 ? { name: key } : { group: key.slice(0, colon), name: key.slice(colon + 1) };
}

function assertEditShape(edits: MetadataEdits): void {
  const entries = Object.entries(edits);
  if (entries.length === 0) throw new MetadataFieldError('The task sets no field: "options.metadata.set" is empty.');
  if (entries.length > MAX_FIELDS) throw new MetadataFieldError(`The task sets ${entries.length} fields; the most one task sets is ${MAX_FIELDS}.`);
  for (const [key, value] of entries) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (typeof item === 'string' && item.length > MAX_TEXT_CHARS) throw new MetadataFieldError(`"${key}" holds more than ${MAX_TEXT_CHARS} characters.`);
    }
  }
}

function exifDate(text: string, field: string): Date {
  const exif = EXIF_DATE.exec(text);
  let iso = '';
  if (exif) iso = `${exif[1]}-${exif[2]}-${exif[3]}T${exif[4]}:${exif[5]}:${exif[6]}${exif[7] ?? 'Z'}`;
  else if (ISO_DATE.test(text)) iso = text;
  const date = new Date(iso);
  if (iso === '' || Number.isNaN(date.getTime())) throw new MetadataFieldError(`"${field}" takes a date as "YYYY:MM:DD HH:MM:SS" or as ISO 8601.`);
  return date;
}

async function writePdf(buf: Buffer, edits: MetadataEdits, access: PdfAccess): Promise<Buffer> {
  const names = new Map<string, string | number | string[] | null>();
  for (const [key, value] of Object.entries(edits)) {
    const { group, name } = splitField(key);
    if ((group !== undefined && group !== 'PDF') || !PDF_WRITABLE_FIELDS.includes(name)) {
      throw new MetadataFieldError(`"${key}" is not a PDF field that can be written. A PDF takes: ${PDF_WRITABLE_FIELDS.join(', ')}.`);
    }
    names.set(name, value);
  }
  const plain = await openPdfForEditing(buf, 'metadata', access);
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(plain, { updateMetadata: false, parseSpeed: PDF_LIB_OBJECTS_PER_TICK });
  } catch (error) {
    throw new MetadataWriteUnsupportedError(`The PDF cannot be read, so its metadata is not changed (${error instanceof Error ? error.message.slice(0, 120) : 'unreadable'}).`);
  }
  let info = doc.context.lookupMaybe(doc.context.trailerInfo.Info, PDFDict);
  if (info === undefined) {
    info = doc.context.obj({});
    doc.context.trailerInfo.Info = doc.context.register(info);
  }
  for (const [name, value] of names) {
    const key = PDFName.of(PDF_INFO_KEYS[name] ?? name);
    if (value === null) {
      info.delete(key);
    } else if (PDF_DATE_FIELDS.has(name)) {
      info.set(key, PDFString.fromDate(exifDate(String(value), name)));
    } else {
      info.set(key, PDFHexString.fromText(Array.isArray(value) ? value.join(', ') : String(value)));
    }
  }
  return Buffer.from(await doc.save({ objectsPerTick: PDF_LIB_OBJECTS_PER_TICK }));
}

function writeImage(buf: Buffer, container: 'jpeg' | 'png', edits: MetadataEdits): Buffer {
  const exifEdits: Record<string, string | number | null> = {};
  const xmpFields: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(edits)) {
    const { group, name } = splitField(key);
    if (group === 'XMP' || (group === undefined && WRITABLE_XMP_FIELDS.includes(name) && !WRITABLE_EXIF_FIELDS.includes(name))) {
      if (!WRITABLE_XMP_FIELDS.includes(name)) throw new MetadataFieldError(`"${key}" is not an XMP field that can be written. A picture takes: ${WRITABLE_XMP_FIELDS.join(', ')}.`);
      if (value === null || typeof value === 'number') throw new MetadataFieldError(`"${key}" takes text (or a list of text); an XMP field is set, not removed.`);
      xmpFields[name] = value;
    } else if ((group === undefined || group === 'EXIF' || group === 'GPS') && WRITABLE_EXIF_FIELDS.includes(name)) {
      if (Array.isArray(value)) throw new MetadataFieldError(`"${key}" takes one value, not a list.`);
      exifEdits[name] = value;
    } else {
      throw new MetadataFieldError(`"${key}" is not a field that can be written. A picture takes the EXIF fields ${WRITABLE_EXIF_FIELDS.join(', ')} and the XMP fields ${WRITABLE_XMP_FIELDS.map((field) => `XMP:${field}`).join(', ')}.`);
    }
  }

  try {
    const existing = readEmbeddedBlocks(buf, container);
    const blocks: Partial<{ exif: Buffer; xmp: Buffer }> = {};
    if (Object.keys(exifEdits).length > 0) blocks.exif = editExif(existing.exif, exifEdits as ExifEdits);
    if (Object.keys(xmpFields).length > 0) {
      if (existing.xmp !== null) {
        throw new MetadataWriteUnsupportedError('The picture already carries an XMP packet; writing XMP into it would drop properties the packet holds beyond the ones set. Write EXIF fields, or use a file without XMP.');
      }
      const packet = buildXmp(xmpFields);
      if (packet !== null) blocks.xmp = packet;
    }
    return withEmbeddedBlocks(buf, container, blocks);
  } catch (error) {
    if (error instanceof ExifValueError) throw new MetadataFieldError(error.message);
    if (error instanceof RangeError) throw new MetadataFieldError(error.message);
    if (error instanceof ExifFormatError || error instanceof ImageContainerError) {
      throw new MetadataWriteUnsupportedError(`${error.message} Its metadata is not changed.`);
    }
    throw error;
  }
}

/**
 * The file with `edits` written into its metadata, under the name it had. Throws MetadataWriteUnsupportedError for a format that
 * cannot be written without more change than the metadata, MetadataFieldError for a field the format cannot hold or a value
 * it cannot take, and the PDF errors of an encrypted file (`access` carries the password).
 */
export async function writeMetadata(buf: Buffer, filename: string, edits: MetadataEdits, access: PdfAccess = {}): Promise<MetadataWriteResult> {
  const ext = path.extname(filename).replace(/^\./, '').toLowerCase();
  if (!WRITABLE_METADATA_FORMATS.includes(ext)) {
    throw new MetadataWriteUnsupportedError(`A .${ext || '(none)'} file cannot get new metadata without more change than the metadata. Metadata is written into: ${WRITABLE_METADATA_FORMATS.join(', ')}.`);
  }
  assertEditShape(edits);
  const buffer = ext === 'pdf' ? await writePdf(buf, edits, access) : writeImage(buf, ext === 'png' ? 'png' : 'jpeg', edits);
  return { buffer, filename: path.basename(filename), mimeType: MIME_TYPES[ext] };
}
