import crypto from 'node:crypto';
import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
  decodePDFRawStream,
} from 'pdf-lib';

const MAX_DATE_STRING_LENGTH = 64;
const PDF_DATE_PATTERN =
  /^D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:(Z)|([+-])(\d{2})'(\d{2})'?)?$/;
const XMP_DATE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

export interface PdfDateInstant {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  offsetSign: 'Z' | '+' | '-';
  offsetHours: number;
  offsetMinutes: number;
  epochMs: number;
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

interface RawDateFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  offsetSign: 'Z' | '+' | '-';
  offsetHours: number;
  offsetMinutes: number;
}

function normalizeOffsetSign(sign: 'Z' | '+' | '-', hours: number, minutes: number): 'Z' | '+' | '-' {
  if (sign === '-' && hours === 0 && minutes === 0) {
    return 'Z';
  }
  return sign;
}

function signedOffsetInMinutes(sign: 'Z' | '+' | '-', hours: number, minutes: number): number {
  if (sign === 'Z') return 0;
  const total = hours * 60 + minutes;
  return sign === '+' ? total : -total;
}

function buildInstant(fields: RawDateFields): PdfDateInstant | null {
  const { year, month, day, hour, minute, second, offsetSign, offsetHours, offsetMinutes } = fields;
  if (year < 1 || year > 9999) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  if (second < 0 || second > 59) return null;
  if (offsetHours < 0 || offsetHours > 23) return null;
  if (offsetMinutes < 0 || offsetMinutes > 59) return null;

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

export function parsePdfDate(raw: string): PdfDateInstant | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_DATE_STRING_LENGTH) {
    return null;
  }
  const match = PDF_DATE_PATTERN.exec(raw);
  if (!match) return null;

  const sign = match[8] as '+' | '-' | undefined;
  return buildInstant({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
    offsetSign: sign ?? 'Z',
    offsetHours: match[9] !== undefined ? Number(match[9]) : 0,
    offsetMinutes: match[10] !== undefined ? Number(match[10]) : 0,
  });
}

export function parseXmpDate(raw: string): PdfDateInstant | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_DATE_STRING_LENGTH) {
    return null;
  }
  const match = XMP_DATE_PATTERN.exec(raw.trim());
  if (!match) return null;

  const sign = match[8] as '+' | '-' | undefined;
  return buildInstant({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
    offsetSign: sign ?? 'Z',
    offsetHours: match[9] !== undefined ? Number(match[9]) : 0,
    offsetMinutes: match[10] !== undefined ? Number(match[10]) : 0,
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

function rewriteXmpTagOrAttr(xmp: string, localName: string, newValue: string): { text: string; replaced: boolean } {
  const elementRe = new RegExp(`(<xmp:${localName}>)([^<]*)(<\\/xmp:${localName}>)`, 'g');
  let replaced = false;
  let next = xmp.replace(elementRe, (_, open: string, _old: string, close: string) => {
    replaced = true;
    return `${open}${newValue}${close}`;
  });
  const attrRe = new RegExp(`(\\bxmp:${localName}\\s*=\\s*["'])([^"']*)(["'])`, 'g');
  next = next.replace(attrRe, (_, prefix: string, _old: string, suffix: string) => {
    replaced = true;
    return `${prefix}${newValue}${suffix}`;
  });
  return { text: next, replaced };
}

function rewriteXmpPacketDates(
  xmp: string,
  xmpCreateDate: string,
  xmpModDate: string,
  hasModDateInInfo: boolean
): string {
  let updated = xmp;

  const created = rewriteXmpTagOrAttr(updated, 'CreateDate', xmpCreateDate);
  updated = created.text;
  if (!created.replaced) {
    const xmpDescRe = /(<rdf:Description\b[^>]*xmlns:xmp="http:\/\/ns\.adobe\.com\/xap\/1\.0\/"[^>]*>)/;
    if (xmpDescRe.test(updated)) {
      updated = updated.replace(xmpDescRe, `$1\n   <xmp:CreateDate>${xmpCreateDate}</xmp:CreateDate>`);
    } else if (updated.includes('</rdf:RDF>')) {
      updated = updated.replace(
        '</rdf:RDF>',
        `  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">\n   <xmp:CreateDate>${xmpCreateDate}</xmp:CreateDate>\n  </rdf:Description>\n </rdf:RDF>`
      );
    }
  }

  const modified = rewriteXmpTagOrAttr(updated, 'ModifyDate', xmpModDate);
  updated = modified.text;
  if (!modified.replaced && hasModDateInInfo) {
    updated = updated.replace(
      `</xmp:CreateDate>`,
      `</xmp:CreateDate>\n   <xmp:ModifyDate>${xmpModDate}</xmp:ModifyDate>`
    );
  }

  updated = rewriteXmpTagOrAttr(updated, 'MetadataDate', xmpModDate).text;

  updated = updated.replace(/<dc:date>([\s\S]*?)<\/dc:date>/g, (block) =>
    block.replace(/<rdf:li>[^<]*<\/rdf:li>/g, `<rdf:li>${xmpCreateDate}</rdf:li>`)
  );

  return updated;
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

  const neededRemoval = -delta;
  const beforeEnd = xmp.slice(0, endMarkerIndex);
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
  if (removed !== neededRemoval) return null;
  const trimmed = `${chars.join('')}${xmp.slice(endMarkerIndex)}`;
  const trimmedBytes = Buffer.from(trimmed, 'utf-8');
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

export async function normalisePdfADates(pdf: Buffer, now: Date = new Date()): Promise<Buffer> {
  if (!Buffer.isBuffer(pdf) || pdf.length === 0) return pdf;

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdf, { updateMetadata: false });
  } catch {
    return pdf;
  }

  const infoRef = doc.context.trailerInfo.Info;
  const infoDict = infoRef ? doc.context.lookupMaybe(infoRef, PDFDict) : undefined;

  const rawCreationDate = readInfoString(infoDict, 'CreationDate');
  const parsedCreation = rawCreationDate !== undefined ? parsePdfDate(rawCreationDate) : null;
  const creationInstant = parsedCreation ?? fromUtcDate(now);
  const canonicalPdfCreateDate = formatPdfDate(creationInstant);
  const canonicalXmpCreateDate = formatXmpDate(creationInstant);

  const rawModDate = readInfoString(infoDict, 'ModDate');
  const hasModDateInInfo = rawModDate !== undefined;
  const parsedMod = rawModDate !== undefined ? parsePdfDate(rawModDate) : null;
  const modInstant = parsedMod ?? creationInstant;
  const canonicalPdfModDate = formatPdfDate(modInstant);
  const canonicalXmpModDate = formatXmpDate(modInstant);

  const needsInfoRewrite =
    !infoDict ||
    rawCreationDate !== canonicalPdfCreateDate ||
    (hasModDateInInfo && rawModDate !== canonicalPdfModDate);

  const metadataObj = doc.catalog.lookup(PDFName.of('Metadata'));
  const hasUncompressedRawMetadata =
    metadataObj instanceof PDFRawStream && !metadataObj.dict.lookup(PDFName.of('Filter'));

  let oldXmpBytes: Buffer | null = null;
  let oldXmpText: string | null = null;
  if (metadataObj instanceof PDFRawStream) {
    try {
      oldXmpBytes = Buffer.from(decodePDFRawStream(metadataObj).decode());
      oldXmpText = oldXmpBytes.toString('utf-8');
    } catch {
      oldXmpBytes = null;
      oldXmpText = null;
    }
  }

  const updatedXmpText =
    oldXmpText !== null
      ? rewriteXmpPacketDates(oldXmpText, canonicalXmpCreateDate, canonicalXmpModDate, hasModDateInInfo)
      : defaultPdfAXmpPacket(canonicalXmpCreateDate, canonicalXmpModDate);

  if (!needsInfoRewrite && hasUncompressedRawMetadata && oldXmpBytes !== null && oldXmpText !== null) {
    if (updatedXmpText === oldXmpText) {
      return pdf;
    }
    const sameLengthXmp = adjustXmpPaddingToLength(updatedXmpText, oldXmpBytes.length);
    if (sameLengthXmp) {
      const offset = pdf.indexOf(oldXmpBytes);
      if (offset >= 0 && pdf.indexOf(oldXmpBytes, offset + 1) === -1) {
        const copy = Buffer.from(pdf);
        sameLengthXmp.copy(copy, offset);
        return copy;
      }
    }
  }

  let targetInfoDict = infoDict;
  if (!targetInfoDict) {
    targetInfoDict = doc.context.obj({});
    doc.context.trailerInfo.Info = doc.context.register(targetInfoDict);
  }
  targetInfoDict.set(PDFName.of('CreationDate'), PDFString.of(canonicalPdfCreateDate));
  if (hasModDateInInfo) {
    targetInfoDict.set(PDFName.of('ModDate'), PDFString.of(canonicalPdfModDate));
  }

  const newXmpBytes = Buffer.from(updatedXmpText, 'utf-8');
  if (metadataObj instanceof PDFRawStream) {
    metadataObj.contents = newXmpBytes;
    metadataObj.dict.delete(PDFName.of('Filter'));
    metadataObj.dict.delete(PDFName.of('DecodeParms'));
    metadataObj.dict.set(PDFName.of('Type'), PDFName.of('Metadata'));
    metadataObj.dict.set(PDFName.of('Subtype'), PDFName.of('XML'));
    metadataObj.dict.set(PDFName.of('Length'), PDFNumber.of(newXmpBytes.length));
  } else {
    const stream = doc.context.stream(newXmpBytes, { Type: 'Metadata', Subtype: 'XML' });
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
  }

  if (!doc.context.trailerInfo.ID) {
    const digest = crypto.createHash('md5').update(pdf).digest('hex');
    doc.context.trailerInfo.ID = doc.context.obj([PDFHexString.of(digest), PDFHexString.of(digest)]);
  }

  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
