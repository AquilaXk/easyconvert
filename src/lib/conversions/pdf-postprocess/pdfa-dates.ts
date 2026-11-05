import crypto from 'node:crypto';
import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFString,
  decodePDFRawStream,
} from 'pdf-lib';

const MAX_DATE_STRING_LENGTH = 64;
const PDF_DATE_HEAD_PATTERN = /^D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(.*)$/;
const PDF_TZ_OFFSET_PATTERN = /^([+-])(\d{2})'(\d{2})'?$/;
const XMP_DATE_HEAD_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(.*)$/;
const XMP_TZ_OFFSET_PATTERN = /^([+-])(\d{2}):(\d{2})$/;

export type PdfOffsetSign = 'Z' | '+' | '-';

export interface PdfDateInstant {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  offsetSign: PdfOffsetSign;
  offsetHours: number;
  offsetMinutes: number;
  epochMs: number;
}

interface TimezoneOffset {
  offsetSign: PdfOffsetSign;
  offsetHours: number;
  offsetMinutes: number;
}

interface RawDateFields extends TimezoneOffset {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

function normalizeOffsetSign(sign: PdfOffsetSign, hours: number, minutes: number): PdfOffsetSign {
  if (sign === '-' && hours === 0 && minutes === 0) {
    return 'Z';
  }
  return sign;
}

function signedOffsetInMinutes(sign: PdfOffsetSign, hours: number, minutes: number): number {
  if (sign === 'Z') return 0;
  const total = hours * 60 + minutes;
  return sign === '+' ? total : -total;
}

function isValidDateRange(fields: RawDateFields): boolean {
  if (fields.year < 1 || fields.year > 9999) return false;
  if (fields.month < 1 || fields.month > 12) return false;
  if (fields.day < 1 || fields.day > daysInMonth(fields.year, fields.month)) return false;
  if (fields.hour < 0 || fields.hour > 23) return false;
  if (fields.minute < 0 || fields.minute > 59) return false;
  if (fields.second < 0 || fields.second > 59) return false;
  return fields.offsetHours >= 0 && fields.offsetHours <= 23 && fields.offsetMinutes >= 0 && fields.offsetMinutes <= 59;
}

function buildInstant(fields: RawDateFields): PdfDateInstant | null {
  if (!isValidDateRange(fields)) return null;
  const { year, month, day, hour, minute, second, offsetSign, offsetHours, offsetMinutes } = fields;
  const normalizedSign = normalizeOffsetSign(offsetSign, offsetHours, offsetMinutes);
  const signedOffsetMinutes = signedOffsetInMinutes(normalizedSign, offsetHours, offsetMinutes);
  const utcFieldsMs = Date.UTC(year, month - 1, day, hour, minute, second);

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    offsetSign: normalizedSign,
    offsetHours: normalizedSign === 'Z' ? 0 : offsetHours,
    offsetMinutes: normalizedSign === 'Z' ? 0 : offsetMinutes,
    epochMs: utcFieldsMs - signedOffsetMinutes * 60_000,
  };
}

function parsePdfTimezoneSuffix(suffix: string): { tz: TimezoneOffset; explicit: boolean } | null {
  if (suffix === '') {
    return { tz: { offsetSign: 'Z', offsetHours: 0, offsetMinutes: 0 }, explicit: false };
  }
  if (suffix === 'Z' || suffix === "Z'" || suffix === "Z00'00'" || suffix === "Z00'00") {
    return { tz: { offsetSign: 'Z', offsetHours: 0, offsetMinutes: 0 }, explicit: true };
  }
  const match = PDF_TZ_OFFSET_PATTERN.exec(suffix);
  if (!match) return null;
  return {
    tz: {
      offsetSign: match[1] as '+' | '-',
      offsetHours: Number(match[2]),
      offsetMinutes: Number(match[3]),
    },
    explicit: true,
  };
}

function parseXmpTimezoneSuffix(suffix: string): TimezoneOffset | null {
  if (suffix === 'Z') {
    return { offsetSign: 'Z', offsetHours: 0, offsetMinutes: 0 };
  }
  const match = XMP_TZ_OFFSET_PATTERN.exec(suffix);
  if (!match) return null;
  const offsetHours = Number(match[2]);
  const offsetMinutes = Number(match[3]);
  if (offsetHours > 23 || offsetMinutes > 59) return null;
  const offsetSign = normalizeOffsetSign(match[1] as '+' | '-', offsetHours, offsetMinutes);
  return {
    offsetSign,
    offsetHours: offsetSign === 'Z' ? 0 : offsetHours,
    offsetMinutes: offsetSign === 'Z' ? 0 : offsetMinutes,
  };
}

export function parsePdfDate(raw: string): PdfDateInstant | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_DATE_STRING_LENGTH) {
    return null;
  }
  const match = PDF_DATE_HEAD_PATTERN.exec(raw);
  if (!match) return null;
  const parsedTz = parsePdfTimezoneSuffix(match[7]);
  if (!parsedTz) return null;

  return buildInstant({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
    ...parsedTz.tz,
  });
}

function hasPdfDateExplicitTimezone(raw: string | undefined): boolean {
  if (!raw || raw.length > MAX_DATE_STRING_LENGTH) return false;
  const match = PDF_DATE_HEAD_PATTERN.exec(raw);
  if (!match) return false;
  return parsePdfTimezoneSuffix(match[7])?.explicit ?? false;
}

export function parseXmpDate(raw: string): PdfDateInstant | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_DATE_STRING_LENGTH) {
    return null;
  }
  const match = XMP_DATE_HEAD_PATTERN.exec(raw.trim());
  if (!match) return null;
  const parsedTz = parseXmpTimezoneSuffix(match[7]);
  if (!parsedTz) return null;

  return buildInstant({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
    ...parsedTz,
  });
}

export function fromUtcDate(date: Date): PdfDateInstant {
  const safe = Number.isFinite(date.getTime()) ? date : new Date(0);
  const year = Math.min(9999, Math.max(1, safe.getUTCFullYear()));
  const month = safe.getUTCMonth() + 1;
  const day = safe.getUTCDate();
  const hour = safe.getUTCHours();
  const minute = safe.getUTCMinutes();
  const second = safe.getUTCSeconds();
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    offsetSign: 'Z',
    offsetHours: 0,
    offsetMinutes: 0,
    epochMs: Date.UTC(year, month - 1, day, hour, minute, second),
  };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function pad4(value: number): string {
  return String(value).padStart(4, '0');
}

export function formatPdfDate(instant: PdfDateInstant): string {
  const base = `D:${pad4(instant.year)}${pad2(instant.month)}${pad2(instant.day)}${pad2(instant.hour)}${pad2(instant.minute)}${pad2(instant.second)}`;
  if (instant.offsetSign === 'Z') {
    return `${base}Z`;
  }
  return `${base}${instant.offsetSign}${pad2(instant.offsetHours)}'${pad2(instant.offsetMinutes)}'`;
}

export function formatXmpDate(instant: PdfDateInstant): string {
  const base = `${pad4(instant.year)}-${pad2(instant.month)}-${pad2(instant.day)}T${pad2(instant.hour)}:${pad2(instant.minute)}:${pad2(instant.second)}`;
  if (instant.offsetSign === 'Z') {
    return `${base}Z`;
  }
  return `${base}${instant.offsetSign}${pad2(instant.offsetHours)}:${pad2(instant.offsetMinutes)}`;
}

function readInfoString(info: PDFDict | undefined, key: string): string | undefined {
  if (!info) return undefined;
  const value = info.lookup(PDFName.of(key));
  if (value instanceof PDFString || value instanceof PDFHexString) {
    return value.decodeText();
  }
  return undefined;
}

function extractXmpDateString(xmp: string | null, localName: string): string | undefined {
  if (!xmp) return undefined;
  const elementMatch = new RegExp(String.raw`<(?:xmp|xap):${localName}>([^<]*)<\/(?:xmp|xap):${localName}>`).exec(xmp);
  if (elementMatch) return elementMatch[1].trim();
  const attrMatch = new RegExp(String.raw`\b(?:xmp|xap):${localName}\s*=\s*["']([^"']*)["']`).exec(xmp);
  if (attrMatch) return attrMatch[1].trim();
  return undefined;
}

function extractXmpTimezoneOffset(
  rawXmpDate: string | undefined,
  parsedXmp: PdfDateInstant | null
): TimezoneOffset | null {
  if (parsedXmp) {
    return {
      offsetSign: parsedXmp.offsetSign,
      offsetHours: parsedXmp.offsetHours,
      offsetMinutes: parsedXmp.offsetMinutes,
    };
  }
  if (!rawXmpDate || rawXmpDate.length > MAX_DATE_STRING_LENGTH) return null;
  const match = XMP_DATE_HEAD_PATTERN.exec(rawXmpDate.trim());
  return match ? parseXmpTimezoneSuffix(match[7]) : null;
}

function applyTimezoneOffset(instant: PdfDateInstant, tz: TimezoneOffset | null): PdfDateInstant {
  if (!tz) return instant;
  return buildInstant({ ...instant, ...tz }) ?? instant;
}

function rewriteXmpTagOrAttr(xmp: string, localName: string, newValue: string): { text: string; replaced: boolean } {
  const elementRe = new RegExp(String.raw`(<(?:xmp|xap):${localName}>)([^<]*)(<\/(?:xmp|xap):${localName}>)`, 'g');
  let replaced = false;
  let next = xmp.replace(elementRe, (_, open: string, _old: string, close: string) => {
    replaced = true;
    return `${open}${newValue}${close}`;
  });
  const attrRe = new RegExp(String.raw`(\b(?:xmp|xap):${localName}\s*=\s*["'])([^"']*)(["'])`, 'g');
  next = next.replace(attrRe, (_, prefix: string, _old: string, suffix: string) => {
    replaced = true;
    return `${prefix}${newValue}${suffix}`;
  });
  return { text: next, replaced };
}

function insertMissingXmpCreateDate(xmp: string, xmpCreateDate: string): string {
  const xmpDescRe = /<rdf:Description\b[^>]*xmlns:(xmp|xap)="http:\/\/ns\.adobe\.com\/xap\/1\.0\/"[^>]*>/;
  const descMatch = xmpDescRe.exec(xmp);
  if (descMatch) {
    const fullTag = descMatch[0];
    const nsPrefix = descMatch[1];
    if (fullTag.endsWith('/>')) {
      const openTag = `${fullTag.slice(0, -2)}>`;
      return xmp.replace(
        fullTag,
        `${openTag}\n   <${nsPrefix}:CreateDate>${xmpCreateDate}</${nsPrefix}:CreateDate>\n  </rdf:Description>`
      );
    }
    return xmp.replace(
      fullTag,
      `${fullTag}\n   <${nsPrefix}:CreateDate>${xmpCreateDate}</${nsPrefix}:CreateDate>`
    );
  }
  if (xmp.includes('</rdf:RDF>')) {
    return xmp.replace(
      '</rdf:RDF>',
      `  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">\n   <xmp:CreateDate>${xmpCreateDate}</xmp:CreateDate>\n  </rdf:Description>\n </rdf:RDF>`
    );
  }
  return xmp;
}

function insertMissingXmpModifyDate(xmp: string, xmpModDate: string): string {
  const closeMatch = /<\/(xmp|xap):CreateDate>/.exec(xmp);
  if (closeMatch) {
    const nsPrefix = closeMatch[1];
    return xmp.replace(
      closeMatch[0],
      `${closeMatch[0]}\n   <${nsPrefix}:ModifyDate>${xmpModDate}</${nsPrefix}:ModifyDate>`
    );
  }
  const attrMatch = /\b(xmp|xap):CreateDate\s*=\s*["'][^"']*["']/.exec(xmp);
  if (attrMatch) {
    const nsPrefix = attrMatch[1];
    return xmp.replace(attrMatch[0], `${attrMatch[0]} ${nsPrefix}:ModifyDate="${xmpModDate}"`);
  }
  return xmp;
}

function rewriteXmpPacketDates(
  xmp: string,
  xmpCreateDate: string,
  xmpModDate: string,
  hasModDateInInfo: boolean
): string {
  const created = rewriteXmpTagOrAttr(xmp, 'CreateDate', xmpCreateDate);
  let updated = created.replaced ? created.text : insertMissingXmpCreateDate(created.text, xmpCreateDate);

  const modified = rewriteXmpTagOrAttr(updated, 'ModifyDate', xmpModDate);
  updated =
    !modified.replaced && hasModDateInInfo
      ? insertMissingXmpModifyDate(modified.text, xmpModDate)
      : modified.text;

  updated = rewriteXmpTagOrAttr(updated, 'MetadataDate', xmpModDate).text;

  return updated.replace(/<dc:date>([\s\S]*?)<\/dc:date>/g, (block) =>
    block.replace(/<rdf:li>[^<]*<\/rdf:li>/g, `<rdf:li>${xmpCreateDate}</rdf:li>`)
  );
}

function trimPaddingSpacesBeforeEnd(beforeEnd: string, neededRemoval: number): string | null {
  let removed = 0;
  const chars = Array.from(beforeEnd);
  for (let i = chars.length - 1; i >= 0 && removed < neededRemoval; i--) {
    if (chars[i] === ' ') {
      chars[i] = '';
      removed++;
    } else if (chars[i] !== '\n' && chars[i] !== '\r') {
      break;
    }
  }
  return removed === neededRemoval ? chars.join('') : null;
}

function adjustXmpPaddingToLength(xmp: string, targetByteLength: number): Buffer | null {
  const currentBytes = Buffer.from(xmp, 'utf-8');
  const delta = targetByteLength - currentBytes.length;
  if (delta === 0) return currentBytes;

  const endMarkerIndex = xmp.lastIndexOf('<?xpacket end=');
  if (endMarkerIndex < 0) return null;

  if (delta > 0) {
    const padded = `${xmp.slice(0, endMarkerIndex)}${' '.repeat(delta)}${xmp.slice(endMarkerIndex)}`;
    const paddedBytes = Buffer.from(padded, 'utf-8');
    return paddedBytes.length === targetByteLength ? paddedBytes : null;
  }

  const trimmedPrefix = trimPaddingSpacesBeforeEnd(xmp.slice(0, endMarkerIndex), -delta);
  if (trimmedPrefix === null) return null;
  const trimmedBytes = Buffer.from(`${trimmedPrefix}${xmp.slice(endMarkerIndex)}`, 'utf-8');
  return trimmedBytes.length === targetByteLength ? trimmedBytes : null;
}

function defaultPdfAXmpPacket(xmpCreateDate: string, xmpModDate: string): string {
  return (
    '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n' +
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
    '  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">\n' +
    '   <pdfaid:part>1</pdfaid:part>\n' +
    '   <pdfaid:conformance>B</pdfaid:conformance>\n' +
    '  </rdf:Description>\n' +
    '  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">\n' +
    `   <xmp:CreateDate>${xmpCreateDate}</xmp:CreateDate>\n` +
    `   <xmp:ModifyDate>${xmpModDate}</xmp:ModifyDate>\n` +
    `   <xmp:MetadataDate>${xmpModDate}</xmp:MetadataDate>\n` +
    '  </rdf:Description>\n' +
    ' </rdf:RDF>\n' +
    '</x:xmpmeta>\n' +
    '<?xpacket end="w"?>'
  );
}

interface CatalogXmpState {
  hasUncompressedRawMetadata: boolean;
  oldXmpBytes: Buffer | null;
  oldXmpText: string | null;
}

function decodeCatalogXmp(doc: PDFDocument): CatalogXmpState {
  const metadataObj = doc.catalog.lookup(PDFName.of('Metadata'));
  const hasUncompressedRawMetadata =
    metadataObj instanceof PDFRawStream && !metadataObj.dict.lookup(PDFName.of('Filter'));

  if (!(metadataObj instanceof PDFRawStream)) {
    return { hasUncompressedRawMetadata, oldXmpBytes: null, oldXmpText: null };
  }
  try {
    const oldXmpBytes = Buffer.from(decodePDFRawStream(metadataObj).decode());
    return {
      hasUncompressedRawMetadata,
      oldXmpBytes,
      oldXmpText: oldXmpBytes.toString('utf-8'),
    };
  } catch {
    return { hasUncompressedRawMetadata, oldXmpBytes: null, oldXmpText: null };
  }
}

interface ResolvedPdfDates {
  rawCreationDate: string | undefined;
  rawModDate: string | undefined;
  canonicalPdfCreateDate: string;
  canonicalXmpCreateDate: string;
  canonicalPdfModDate: string;
  canonicalXmpModDate: string;
  hasModDateInInfo: boolean;
  needsInfoRewrite: boolean;
}

function selectCreationInstant(
  rawCreationDate: string | undefined,
  parsedCreation: PdfDateInstant | null,
  xmpCreateTz: TimezoneOffset | null,
  parsedXmpCreate: PdfDateInstant | null,
  now: Date
): PdfDateInstant {
  if (parsedCreation !== null) {
    return hasPdfDateExplicitTimezone(rawCreationDate)
      ? parsedCreation
      : applyTimezoneOffset(parsedCreation, xmpCreateTz);
  }
  if (rawCreationDate === undefined && parsedXmpCreate !== null) {
    return parsedXmpCreate;
  }
  return fromUtcDate(now);
}

function selectModificationInstant(
  rawCreationDate: string | undefined,
  rawModDate: string | undefined,
  parsedMod: PdfDateInstant | null,
  xmpModTz: TimezoneOffset | null,
  parsedXmpMod: PdfDateInstant | null,
  creationInstant: PdfDateInstant
): PdfDateInstant {
  if (parsedMod !== null) {
    return hasPdfDateExplicitTimezone(rawModDate)
      ? parsedMod
      : applyTimezoneOffset(parsedMod, xmpModTz);
  }
  if (rawCreationDate === undefined && rawModDate === undefined && parsedXmpMod !== null) {
    return parsedXmpMod;
  }
  return creationInstant;
}

function resolveCanonicalDates(
  infoDict: PDFDict | undefined,
  oldXmpText: string | null,
  now: Date
): ResolvedPdfDates {
  const rawXmpCreate = extractXmpDateString(oldXmpText, 'CreateDate');
  const parsedXmpCreate = rawXmpCreate !== undefined ? parseXmpDate(rawXmpCreate) : null;
  const xmpCreateTz = extractXmpTimezoneOffset(rawXmpCreate, parsedXmpCreate);

  const rawXmpMod = extractXmpDateString(oldXmpText, 'ModifyDate');
  const parsedXmpMod = rawXmpMod !== undefined ? parseXmpDate(rawXmpMod) : null;
  const xmpModTz = extractXmpTimezoneOffset(rawXmpMod, parsedXmpMod) ?? xmpCreateTz;

  const rawCreationDate = readInfoString(infoDict, 'CreationDate');
  const parsedCreation = rawCreationDate !== undefined ? parsePdfDate(rawCreationDate) : null;
  const creationInstant = selectCreationInstant(rawCreationDate, parsedCreation, xmpCreateTz, parsedXmpCreate, now);
  const canonicalPdfCreateDate = formatPdfDate(creationInstant);
  const canonicalXmpCreateDate = formatXmpDate(creationInstant);

  const rawModDate = readInfoString(infoDict, 'ModDate');
  const hasModDateInInfo = rawModDate !== undefined;
  const parsedMod = rawModDate !== undefined ? parsePdfDate(rawModDate) : null;
  const modInstant = selectModificationInstant(
    rawCreationDate,
    rawModDate,
    parsedMod,
    xmpModTz,
    parsedXmpMod,
    creationInstant
  );
  const canonicalPdfModDate = formatPdfDate(modInstant);
  const canonicalXmpModDate = formatXmpDate(modInstant);

  const createInInfoCanonical = parsedCreation !== null && rawCreationDate === canonicalPdfCreateDate;
  const modInInfoCanonical = !hasModDateInInfo || (parsedMod !== null && rawModDate === canonicalPdfModDate);

  return {
    rawCreationDate,
    rawModDate,
    canonicalPdfCreateDate,
    canonicalXmpCreateDate,
    canonicalPdfModDate,
    canonicalXmpModDate,
    hasModDateInInfo,
    needsInfoRewrite: !infoDict || !createInInfoCanonical || !modInInfoCanonical,
  };
}

function patchInfoDateTokenInPlace(
  pdf: Buffer,
  key: 'CreationDate' | 'ModDate',
  rawValue: string | undefined,
  canonicalValue: string
): Buffer | null {
  if (rawValue === canonicalValue) {
    return pdf;
  }
  if (!rawValue || rawValue.length < canonicalValue.length || !/^D:[0-9Z'+-]+$/.test(rawValue)) {
    return null;
  }
  for (const sep of ['', ' ']) {
    const needle = Buffer.from(`/${key}${sep}(${rawValue})`, 'latin1');
    const offset = pdf.indexOf(needle);
    if (offset >= 0 && !pdf.subarray(offset + 1).includes(needle)) {
      const copy = Buffer.from(pdf);
      const pad = ' '.repeat(rawValue.length - canonicalValue.length);
      Buffer.from(`/${key}${sep}(${canonicalValue})${pad}`, 'latin1').copy(copy, offset);
      return copy;
    }
  }
  return null;
}

function tryInPlaceXmpPatch(
  pdf: Buffer,
  hasInfoDict: boolean,
  dates: ResolvedPdfDates,
  xmpState: CatalogXmpState,
  updatedXmpText: string
): Buffer | null {
  if (!hasInfoDict || !xmpState.hasUncompressedRawMetadata || xmpState.oldXmpBytes === null || xmpState.oldXmpText === null) {
    return null;
  }
  let working = patchInfoDateTokenInPlace(pdf, 'CreationDate', dates.rawCreationDate, dates.canonicalPdfCreateDate);
  if (!working) return null;
  if (dates.hasModDateInInfo) {
    working = patchInfoDateTokenInPlace(working, 'ModDate', dates.rawModDate, dates.canonicalPdfModDate);
    if (!working) return null;
  }
  if (updatedXmpText === xmpState.oldXmpText) {
    return working;
  }
  const sameLengthXmp = adjustXmpPaddingToLength(updatedXmpText, xmpState.oldXmpBytes.length);
  if (!sameLengthXmp) return null;

  const offset = working.indexOf(xmpState.oldXmpBytes);
  if (offset < 0 || working.subarray(offset + 1).includes(xmpState.oldXmpBytes)) {
    return null;
  }
  const copy = Buffer.from(working);
  sameLengthXmp.copy(copy, offset);
  return copy;
}

function applyRebuiltPdfMetadata(
  doc: PDFDocument,
  pdf: Buffer,
  infoDict: PDFDict | undefined,
  dates: ResolvedPdfDates,
  updatedXmpText: string
): void {
  const targetInfoDict = infoDict ?? doc.context.obj({});
  if (!infoDict) {
    doc.context.trailerInfo.Info = doc.context.register(targetInfoDict);
  }
  targetInfoDict.set(PDFName.of('CreationDate'), PDFString.of(dates.canonicalPdfCreateDate));
  if (dates.hasModDateInInfo || /<(?:xmp|xap):ModifyDate|\b(?:xmp|xap):ModifyDate\s*=/.test(updatedXmpText)) {
    targetInfoDict.set(PDFName.of('ModDate'), PDFString.of(dates.canonicalPdfModDate));
  }

  const newXmpBytes = Buffer.from(updatedXmpText, 'utf-8');
  const stream = doc.context.stream(newXmpBytes, { Type: 'Metadata', Subtype: 'XML' });
  const metadataRef = doc.catalog.get(PDFName.of('Metadata'));
  if (metadataRef instanceof PDFRef) {
    doc.context.assign(metadataRef, stream);
  } else {
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
  }

  if (!doc.context.trailerInfo.ID) {
    const digest = crypto.createHash('sha256').update(pdf).digest('hex').slice(0, 32);
    doc.context.trailerInfo.ID = doc.context.obj([PDFHexString.of(digest), PDFHexString.of(digest)]);
  }
}

export async function normalisePdfADates(pdf: Buffer, now: Date = new Date()): Promise<Buffer> {
  if (!Buffer.isBuffer(pdf) || pdf.length === 0) return pdf;

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdf, { updateMetadata: false });
  } catch {
    return pdf;
  }

  const xmpState = decodeCatalogXmp(doc);
  const infoRef = doc.context.trailerInfo.Info;
  const infoDict = infoRef ? doc.context.lookupMaybe(infoRef, PDFDict) : undefined;
  const dates = resolveCanonicalDates(infoDict, xmpState.oldXmpText, now);

  const updatedXmpText =
    xmpState.oldXmpText !== null
      ? rewriteXmpPacketDates(
          xmpState.oldXmpText,
          dates.canonicalXmpCreateDate,
          dates.canonicalXmpModDate,
          dates.hasModDateInInfo
        )
      : defaultPdfAXmpPacket(dates.canonicalXmpCreateDate, dates.canonicalXmpModDate);

  const patchedInPlace = tryInPlaceXmpPatch(pdf, Boolean(infoDict), dates, xmpState, updatedXmpText);
  if (patchedInPlace) return patchedInPlace;

  applyRebuiltPdfMetadata(doc, pdf, infoDict, dates, updatedXmpText);

  const saved = Buffer.from(await doc.save({ useObjectStreams: false }));
  const inputHeader = /^%PDF-1\.[0-7]/.exec(pdf.subarray(0, 16).toString('latin1'));
  if (inputHeader && /^%PDF-1\.[0-7]/.test(saved.subarray(0, 16).toString('latin1'))) {
    saved.write(inputHeader[0], 0, 'latin1');
  }
  return saved;
}
