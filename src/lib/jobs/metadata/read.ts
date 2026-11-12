import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { inspectPdfEncryption } from '../../conversions/pdf-encryption';
import { PDF_LIB_OBJECTS_PER_TICK } from '../../conversions/pdf-access';
import { readZipDirectory, readZipFiles } from '../../conversions/archive-zip-reader';
import { childElements, firstChild, ownText, parseXmlTree, type XmlElement } from '../../conversions/xml-tree';
import { FFPROBE_TIMEOUT_MS, resolveFfprobeBinary } from '../../conversions/media-ffprobe';
import { openMediaInput, runFfprobeAsync } from '../../conversions/media-process';
import { getFormatByExtension } from '../../registry';
import { readExif, tiffBlockOf } from './exif';
import { readEmbeddedBlocks, type EmbeddedBlocks } from './image-blocks';
import { readXmp } from './xmp';

/**
 * What a `metadata` task returns: a JSON report in groups, with the names ExifTool prints for the same facts (behaviour only; no
 * code of it is used). A group holds only the facts the file states, so a field that is not there is absent, never null. Dates are
 * written as ExifTool writes them, `YYYY:MM:DD HH:MM:SS` with the zone when the file states one. Numbers are numbers: a
 * rational is its value, a GPS position is signed decimal degrees.
 *
 * Reading is best effort for what is inside a file: a part that cannot be read leaves its group out and says so in
 * `File.Warning`, it does not fail the task. The file itself is never changed.
 */
export const METADATA_SCHEMA_VERSION = 1;

export type MetadataValue = string | number | boolean | string[] | number[] | Array<Record<string, string | number | boolean>>;
export type MetadataGroup = Record<string, MetadataValue>;

export interface MetadataReport {
  schemaVersion: typeof METADATA_SCHEMA_VERSION;
  File: MetadataGroup;
  [group: string]: MetadataGroup | number;
}

const MIB = 1024 * 1024;
const OFFICE_PART_LIMIT_BYTES = MIB;
const OFFICE_MAX_ENTRIES = 100_000;
const OFFICE_LIMITS = { MAX_FILES: OFFICE_MAX_ENTRIES, MAX_UNCOMPRESSED_SIZE: 4 * OFFICE_PART_LIMIT_BYTES, MAX_RATIO: Number.POSITIVE_INFINITY };
const BITS_PER_DEPTH: Readonly<Record<string, number>> = { uchar: 8, char: 8, ushort: 16, short: 16, uint: 32, int: 32, float: 32, double: 64 };
const OOXML_FORMATS: ReadonlySet<string> = new Set(['docx', 'xlsx', 'pptx', 'docm', 'xlsm', 'pptm', 'dotx', 'xltx', 'potx']);
const ODF_FORMATS: ReadonlySet<string> = new Set(['odt', 'ods', 'odp', 'odg']);
const PDF_DATE = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(?:(\d{2})'?(\d{2})?'?)?/;

function put(group: MetadataGroup, name: string, value: MetadataValue | undefined | null): void {
  if (value === undefined || value === null || value === '' || (typeof value === 'number' && !Number.isFinite(value))) return;
  group[name] = value;
}

function nonEmpty(group: MetadataGroup): MetadataGroup | undefined {
  return Object.keys(group).length > 0 ? group : undefined;
}

function pdfZone(sign: string | undefined, hour: string | undefined, minute: string): string {
  if (sign === undefined) return '';
  return sign === 'Z' ? '+00:00' : `${sign}${hour ?? '00'}:${minute}`;
}

/** The zone of an ISO 8601 date: `Z`, `+0900` or `+09:00` as `+HH:MM`; none when the date states none. */
function isoZone(zone: string | undefined): string {
  if (zone === undefined) return '';
  if (zone === 'Z') return '+00:00';
  return zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
}

/** A PDF date (`D:20240102030405+09'00'`) as ExifTool prints it; a text that is not one is returned as it is. */
export function pdfDateToExif(raw: string): string {
  const match = PDF_DATE.exec(raw.trim());
  if (!match) return raw;
  const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00', sign, zoneHour, zoneMinute = '00'] = match;
  return `${year}:${month}:${day} ${hour}:${minute}:${second}${pdfZone(sign, zoneHour, zoneMinute)}`;
}

/** An ISO 8601 date (`2024-01-02T03:04:05Z`) as ExifTool prints it; a text that is not one is returned as it is. */
export function isoDateToExif(raw: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(raw.trim());
  if (!match) return raw;
  const [, year, month, day, hour = '00', minute = '00', second = '00', zone] = match;
  return `${year}:${month}:${day} ${hour}:${minute}:${second}${isoZone(zone)}`;
}

function fileGroup(buf: Buffer, filename: string, ext: string): MetadataGroup {
  const definition = getFormatByExtension(ext);
  const group: MetadataGroup = {};
  put(group, 'FileName', path.basename(filename));
  put(group, 'FileSize', buf.length);
  put(group, 'FileType', ext.toUpperCase());
  put(group, 'FileTypeExtension', ext);
  put(group, 'MIMEType', definition?.mimeType ?? 'application/octet-stream');
  put(group, 'Category', definition?.category ?? 'unknown');
  return group;
}

async function readImage(buf: Buffer, ext: string, report: MetadataReport): Promise<void> {
  const meta = await sharp(buf, { failOn: 'none' }).metadata();
  const image: MetadataGroup = {};
  put(image, 'ImageWidth', meta.width);
  put(image, 'ImageHeight', meta.height);
  put(image, 'ColorSpace', meta.space);
  put(image, 'ColorComponents', meta.channels);
  put(image, 'BitsPerSample', meta.depth === undefined ? undefined : BITS_PER_DEPTH[meta.depth]);
  put(image, 'HasAlpha', meta.hasAlpha);
  put(image, 'FrameCount', meta.pages !== undefined && meta.pages > 1 ? meta.pages : undefined);
  put(image, 'Progressive', meta.isProgressive ? true : undefined);
  put(image, 'YCbCrSubSampling', meta.chromaSubsampling);
  put(image, 'ICCProfile', meta.icc === undefined ? undefined : true);
  report.Image = image;

  const blocks: EmbeddedBlocks = { exif: null, xmp: null };
  if (meta.exif !== undefined) blocks.exif = tiffBlockOf(meta.exif);
  blocks.xmp = meta.xmpAsString ?? readContainerXmp(buf, ext);
  if (blocks.exif !== null) {
    for (const [group, tags] of Object.entries(readExif(blocks.exif))) report[group] = tags as MetadataGroup;
  }
  if (blocks.xmp !== null) {
    const xmp = readXmp(blocks.xmp);
    if (Object.keys(xmp).length > 0) report.XMP = xmp as MetadataGroup;
  }
}

function jpegOrPng(ext: string): 'jpeg' | 'png' | undefined {
  if (ext === 'png') return 'png';
  return ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : undefined;
}

/** The XMP packet of a JPEG or PNG read from its container, for a library build that does not hand it over. */
function readContainerXmp(buf: Buffer, ext: string): string | null {
  const container = jpegOrPng(ext);
  if (container === undefined) return null;
  try {
    return readEmbeddedBlocks(buf, container).xmp;
  } catch {
    return null;
  }
}

function pdfString(info: PDFDict, key: string): string | undefined {
  const value = info.lookup(PDFName.of(key));
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText().trim() || undefined : undefined;
}

async function readPdf(buf: Buffer, report: MetadataReport): Promise<void> {
  const pdf: MetadataGroup = {};
  const header = /^%PDF-(\d\.\d)/.exec(buf.subarray(0, 1024).toString('latin1'));
  put(pdf, 'PDFVersion', header?.[1]);
  if (inspectPdfEncryption(buf).encrypted) {
    // Page count, title and author of an encrypted file sit behind its password: record that, read nothing.
    pdf.Encrypted = true;
    report.PDF = pdf;
    return;
  }
  // The library stamps its own producer and modification date on a document it loads, unless told not to: that would be reported as the file's.
  const doc = await PDFDocument.load(buf, { updateMetadata: false, parseSpeed: PDF_LIB_OBJECTS_PER_TICK });
  put(pdf, 'PageCount', doc.getPageCount());
  const size = doc.getPageCount() > 0 ? doc.getPage(0).getSize() : undefined;
  put(pdf, 'PageWidth', size ? Number(size.width.toFixed(2)) : undefined);
  put(pdf, 'PageHeight', size ? Number(size.height.toFixed(2)) : undefined);
  const info = doc.context.lookupMaybe(doc.context.trailerInfo.Info, PDFDict);
  if (info === undefined) {
    report.PDF = pdf;
    return;
  }
  for (const [name, key] of [['Title', 'Title'], ['Author', 'Author'], ['Subject', 'Subject'], ['Keywords', 'Keywords'], ['Creator', 'Creator'], ['Producer', 'Producer']] as const) {
    put(pdf, name, pdfString(info, key));
  }
  const created = pdfString(info, 'CreationDate');
  const modified = pdfString(info, 'ModDate');
  put(pdf, 'CreateDate', created === undefined ? undefined : pdfDateToExif(created));
  put(pdf, 'ModifyDate', modified === undefined ? undefined : pdfDateToExif(modified));
  report.PDF = pdf;
}

function textChild(root: XmlElement, local: string): string | undefined {
  const child = firstChild(root, local);
  const text = child ? ownText(child).trim() : '';
  return text === '' ? undefined : text;
}

function numberChild(root: XmlElement, local: string): number | undefined {
  const text = textChild(root, local);
  return text !== undefined && /^\d+$/.test(text) ? Number(text) : undefined;
}

async function zipParts(buf: Buffer, names: readonly string[]): Promise<Map<string, XmlElement>> {
  const directory = readZipDirectory(buf, OFFICE_LIMITS);
  const files = await readZipFiles(buf, directory, { limits: OFFICE_LIMITS, select: (name) => names.includes(name) });
  const parts = new Map<string, XmlElement>();
  for (const file of files) {
    if (file.buffer.length > OFFICE_PART_LIMIT_BYTES) continue;
    parts.set(file.filename, parseXmlTree(file.buffer.toString('utf8'), file.filename, 'document'));
  }
  return parts;
}

async function readOoxml(buf: Buffer): Promise<MetadataGroup | undefined> {
  const parts = await zipParts(buf, ['docProps/core.xml', 'docProps/app.xml']);
  const document: MetadataGroup = {};
  const core = parts.get('docProps/core.xml');
  if (core) {
    for (const [name, local] of [['Title', 'title'], ['Subject', 'subject'], ['Creator', 'creator'], ['Keywords', 'keywords'], ['Description', 'description'], ['LastModifiedBy', 'lastModifiedBy'], ['Language', 'language']] as const) {
      put(document, name, textChild(core, local));
    }
    const created = textChild(core, 'created');
    const modified = textChild(core, 'modified');
    put(document, 'CreateDate', created === undefined ? undefined : isoDateToExif(created));
    put(document, 'ModifyDate', modified === undefined ? undefined : isoDateToExif(modified));
    put(document, 'RevisionNumber', numberChild(core, 'revision'));
  }
  const app = parts.get('docProps/app.xml');
  if (app) {
    for (const [name, local] of [['Application', 'Application'], ['AppVersion', 'AppVersion'], ['Company', 'Company']] as const) put(document, name, textChild(app, local));
    for (const [name, local] of [['Pages', 'Pages'], ['Words', 'Words'], ['Characters', 'Characters'], ['Slides', 'Slides'], ['Paragraphs', 'Paragraphs']] as const) put(document, name, numberChild(app, local));
  }
  return nonEmpty(document);
}

async function readOdf(buf: Buffer): Promise<MetadataGroup | undefined> {
  const root = (await zipParts(buf, ['meta.xml'])).get('meta.xml');
  const meta = root ? firstChild(root, 'meta') : undefined;
  if (!meta) return undefined;
  const document: MetadataGroup = {};
  for (const [name, local] of [['Title', 'title'], ['Subject', 'subject'], ['Description', 'description'], ['Creator', 'initial-creator'], ['LastModifiedBy', 'creator'], ['Keywords', 'keyword'], ['Application', 'generator']] as const) {
    put(document, name, textChild(meta, local));
  }
  const created = textChild(meta, 'creation-date');
  const modified = textChild(meta, 'date');
  put(document, 'CreateDate', created === undefined ? undefined : isoDateToExif(created));
  put(document, 'ModifyDate', modified === undefined ? undefined : isoDateToExif(modified));
  const statistics = childElements(meta, 'document-statistic')[0];
  if (statistics) {
    for (const [name, attribute] of [['Pages', 'page-count'], ['Words', 'word-count'], ['Characters', 'character-count']] as const) {
      const value = statistics.attrs.get(attribute);
      put(document, name, value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined);
    }
  }
  return nonEmpty(document);
}

interface ProbedStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  bit_rate?: string;
  channels?: number;
  sample_rate?: string;
  tags?: Record<string, string>;
}

const FRAME_RATE = /^(\d+)\/(\d+)$/;
const MAX_STREAMS = 64;
const MAX_TAGS = 64;

function capitalised(name: string): string {
  return name
    .split(/[_\s-]+/)
    .filter((word) => word !== '')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join('');
}

function streamEntry(stream: ProbedStream): Record<string, string | number | boolean> {
  const entry: Record<string, string | number | boolean> = {};
  const put1 = (name: string, value: string | number | undefined): void => {
    if (value !== undefined && value !== '' && !(typeof value === 'number' && !Number.isFinite(value))) entry[name] = value;
  };
  put1('Index', stream.index);
  put1('Type', stream.codec_type);
  put1('Codec', stream.codec_name);
  put1('Profile', stream.profile);
  put1('Width', stream.width);
  put1('Height', stream.height);
  const rate = FRAME_RATE.exec(stream.r_frame_rate ?? '');
  put1('FrameRate', rate && Number(rate[2]) > 0 ? Number((Number(rate[1]) / Number(rate[2])).toFixed(3)) : undefined);
  put1('BitRate', stream.bit_rate === undefined ? undefined : Number(stream.bit_rate));
  put1('ChannelCount', stream.channels);
  put1('SampleRate', stream.sample_rate === undefined ? undefined : Number(stream.sample_rate));
  put1('Language', stream.tags?.language);
  put1('Title', stream.tags?.title);
  return entry;
}

async function readMedia(buf: Buffer, ext: string, report: MetadataReport, signal?: AbortSignal): Promise<void> {
  // ffprobe opens a file, so the bytes wait in a directory of this run alone for the length of the probe.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert_metadata_'));
  try {
    const file = path.join(dir, `input.${ext}`);
    fs.writeFileSync(file, buf);
    const run = await runFfprobeAsync(resolveFfprobeBinary(), ['-v', 'error', '-show_format', '-show_streams', '-of', 'json'], openMediaInput(file, ext), {
      timeoutMs: FFPROBE_TIMEOUT_MS,
      maxBuffer: 4 * MIB,
      signal,
    });
    if (!run.ok) throw new Error(run.failure);
    const parsed = JSON.parse(run.stdout) as { format?: Record<string, unknown> & { tags?: Record<string, string> }; streams?: ProbedStream[] };
    const media: MetadataGroup = {};
    const format = parsed.format ?? {};
    put(media, 'Format', typeof format.format_name === 'string' ? format.format_name : undefined);
    const duration = Number(format.duration);
    put(media, 'Duration', Number.isFinite(duration) ? Number(duration.toFixed(3)) : undefined);
    const bitRate = Number(format.bit_rate);
    put(media, 'BitRate', Number.isFinite(bitRate) ? bitRate : undefined);
    const streams = (parsed.streams ?? []).slice(0, MAX_STREAMS);
    put(media, 'StreamCount', streams.length);
    for (const [name, value] of Object.entries(format.tags ?? {}).slice(0, MAX_TAGS)) {
      if (typeof value === 'string') put(media, capitalised(name), name.endsWith('time') || name === 'date' ? isoDateToExif(value) : value);
    }
    report.Media = media;
    if (streams.length > 0) report.Streams = streams.map(streamEntry) as unknown as MetadataGroup;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function extensionOf(filename: string): string {
  return path.extname(filename).replace(/^\./, '').toLowerCase();
}

/** The metadata report of a file: its facts by group, for the format its name states. */
export async function readMetadata(buf: Buffer, filename: string, signal?: AbortSignal): Promise<MetadataReport> {
  const ext = extensionOf(filename);
  const category = getFormatByExtension(ext)?.category;
  const report: MetadataReport = { schemaVersion: METADATA_SCHEMA_VERSION, File: fileGroup(buf, filename, ext) };
  try {
    if (ext === 'pdf') await readPdf(buf, report);
    else if (OOXML_FORMATS.has(ext)) attach(report, 'Document', await readOoxml(buf));
    else if (ODF_FORMATS.has(ext)) attach(report, 'Document', await readOdf(buf));
    else if (category === 'image') await readImage(buf, ext, report);
    else if (category === 'audio' || category === 'video') await readMedia(buf, ext, report, signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (isMissingTool(error)) throw error;
    report.File.Warning = `The ${ext.toUpperCase()} content could not be read: ${error instanceof Error ? error.message.slice(0, 200) : 'unreadable'}`;
  }
  return report;
}

function attach(report: MetadataReport, name: string, group: MetadataGroup | undefined): void {
  if (group) report[name] = group;
}

function isMissingTool(error: unknown): boolean {
  return error instanceof Error && (error.name === 'EngineUnavailableError' || error.name === 'SandboxUnavailableError');
}
