import { reportConversionWarning } from '../conversion-warnings';
import { decodeHtmlInput } from '../html-encoding';
import { readCfbContainer } from './cfb-streams';
import { htmlToText } from './html-text';
import { LegacyOfficeFormatError } from './legacy-office-errors';
import { decompressRtf } from './msg-rtf-compression';
import { readRtfText, RtfHoldsNoTextError } from './rtf-reader';

/**
 * The text of an Outlook message (.msg), read from its compound file as [MS-OXMSG] lays it out: property streams named
 * `__substg1.0_<tag><type>`, the property table `__properties_version1.0`, one `__recip_version1.0_#n` storage per recipient and one
 * `__attach_version1.0_#n` storage per attachment. The properties and the order of the fallbacks (plain body, HTML body,
 * compressed RTF body) follow Apache POI's HSMF `MAPIMessage` and Apache Tika's `OutlookExtractor`.
 */

const LABEL = 'Outlook message';
const PROPERTY_STREAM = '__properties_version1.0';
/** [MS-OXMSG] 2.4: the property stream of the message has a 32-byte header, that of a recipient or attachment 8 bytes. */
const MESSAGE_PROPERTY_HEADER_BYTES = 32;
const SUB_OBJECT_PROPERTY_HEADER_BYTES = 8;
const PROPERTY_ENTRY_BYTES = 16;
const PROPERTY_VALUE_OFFSET = 8;
const RECIPIENT_PREFIX = '__recip_version1.0_#';
const ATTACHMENT_PREFIX = '__attach_version1.0_#';
const STRING_UNICODE = '001F';
const STRING_ANSI = '001E';
const BINARY = '0102';
const INT32_TYPE = 0x0003;
const FILETIME_TYPE = 0x0040;
const FILETIME_UNIX_EPOCH_TICKS = 116_444_736_000_000_000n;
const TICKS_PER_MILLISECOND = 10_000n;
/** The most recipients and attachments listed; a compound file holds at most 65,536 directory entries. */
const MAX_LISTED = 10_000;
const DEFAULT_CODE_PAGE = 1252;

const PR = {
  subject: '0037',
  senderName: '0C1A',
  senderAddressType: '0C1E',
  senderAddress: '0C1F',
  senderSmtp: '5D01',
  sentRepresentingName: '0042',
  displayTo: '0E04',
  displayCc: '0E03',
  displayBcc: '0E02',
  body: '1000',
  html: '1013',
  rtfCompressed: '1009',
  displayName: '3001',
  addressType: '3002',
  emailAddress: '3003',
  smtpAddress: '39FE',
  attachLongName: '3707',
  attachShortName: '3704',
  attachData: '3701',
} as const;
const PR_CLIENT_SUBMIT_TIME = 0x0039;
const PR_MESSAGE_DELIVERY_TIME = 0x0e06;
const PR_RECIPIENT_TYPE = 0x0c15;
const PR_MESSAGE_CODEPAGE = 0x3ffd;
const PR_INTERNET_CPID = 0x3fde;
const UTF16LE_CODE_PAGE = 1200;
const RECIPIENT_TO = 1;
const RECIPIENT_CC = 2;
const RECIPIENT_BCC = 3;

export interface MsgAddress {
  name: string;
  address: string;
}

export interface MsgAttachment {
  name: string;
  bytes: number;
}

export interface OutlookMessage {
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  date: Date | undefined;
  body: string;
  attachments: MsgAttachment[];
}

type Streams = ReadonlyMap<string, Buffer>;

const CODE_PAGE_LABELS: ReadonlyMap<number, string> = new Map([
  [65001, 'utf-8'],
  [20127, 'windows-1252'],
  [932, 'shift_jis'],
  [936, 'gbk'],
  [949, 'euc-kr'],
  [950, 'big5'],
  [874, 'windows-874'],
  [10000, 'macintosh'],
  [20866, 'koi8-r'],
  [50220, 'iso-2022-jp'],
  [51932, 'euc-jp'],
  [20932, 'euc-jp'],
  [54936, 'gb18030'],
  [50221, 'iso-2022-jp'],
  [50222, 'iso-2022-jp'],
  [51949, 'euc-kr'],
  [38598, 'iso-8859-8-i'],
  [21866, 'koi8-u'],
  [20936, 'gbk'],
]);

function unreadableCodePage(codePage: number): LegacyOfficeFormatError {
  return new LegacyOfficeFormatError(`${LABEL}: the message code page ${codePage} is not one this service reads.`);
}

function decoderLabel(codePage: number): string {
  const known = CODE_PAGE_LABELS.get(codePage);
  if (known !== undefined) return known;
  if (codePage >= 1250 && codePage <= 1258) return `windows-${codePage}`;
  if (codePage >= 28591 && codePage <= 28605) return `iso-8859-${codePage - 28590}`;
  throw unreadableCodePage(codePage);
}

/** The label of a range above can name an encoding the runtime lacks (28602 is "iso-8859-12", which the standard does not define). */
function decoderFor(codePage: number): TextDecoder {
  try {
    return new TextDecoder(decoderLabel(codePage));
  } catch (error) {
    throw error instanceof LegacyOfficeFormatError ? error : unreadableCodePage(codePage);
  }
}

function decodeAnsi(bytes: Buffer, codePage: number): string {
  return decoderFor(codePage).decode(bytes);
}

function cutAtNul(text: string): string {
  const end = text.indexOf('\u0000');
  return end < 0 ? text : text.slice(0, end);
}

/** The fixed-size properties of a property stream by tag: `id` and `type` from the tag, the 8 value bytes after the flags. */
function fixedProperties(stream: Buffer | undefined, headerBytes: number): Map<number, { type: number; value: Buffer }> {
  const properties = new Map<number, { type: number; value: Buffer }>();
  if (stream === undefined) return properties;
  for (let at = headerBytes; at + PROPERTY_ENTRY_BYTES <= stream.length; at += PROPERTY_ENTRY_BYTES) {
    const type = stream.readUInt16LE(at);
    const id = stream.readUInt16LE(at + 2);
    properties.set(id, { type, value: stream.subarray(at + PROPERTY_VALUE_OFFSET, at + PROPERTY_ENTRY_BYTES) });
  }
  return properties;
}

function int32Property(properties: ReadonlyMap<number, { type: number; value: Buffer }>, id: number): number | undefined {
  const property = properties.get(id);
  return property?.type === INT32_TYPE ? property.value.readInt32LE(0) : undefined;
}

/**
 * A code page property; 0 and below name no code page, and 1200 (UTF-16LE) names the Unicode strings, which carry no code
 * page, not the 8-bit ones this decodes, so the next property or the default stands.
 */
function codePageProperty(properties: ReadonlyMap<number, { type: number; value: Buffer }>, id: number): number | undefined {
  const codePage = int32Property(properties, id);
  return codePage !== undefined && codePage > 0 && codePage !== UTF16LE_CODE_PAGE ? codePage : undefined;
}

function dateProperty(properties: ReadonlyMap<number, { type: number; value: Buffer }>, id: number): Date | undefined {
  const property = properties.get(id);
  if (property?.type !== FILETIME_TYPE) return undefined;
  const milliseconds = (property.value.readBigUInt64LE(0) - FILETIME_UNIX_EPOCH_TICKS) / TICKS_PER_MILLISECOND;
  const date = new Date(Number(milliseconds));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** A string property of the storage at `prefix` ('' for the message): the Unicode stream when there is one, else the ANSI one. */
function stringProperty(streams: Streams, prefix: string, tag: string, codePage: number): string | undefined {
  const unicode = streams.get(`${prefix}__substg1.0_${tag}${STRING_UNICODE}`);
  if (unicode !== undefined) return cutAtNul(unicode.toString('utf16le'));
  const ansi = streams.get(`${prefix}__substg1.0_${tag}${STRING_ANSI}`);
  return ansi === undefined ? undefined : cutAtNul(decodeAnsi(ansi, codePage));
}

/** A header-like string property (a subject, a name, an address): its surrounding white space is not part of it. */
function fieldProperty(streams: Streams, prefix: string, tag: string, codePage: number): string | undefined {
  return stringProperty(streams, prefix, tag, codePage)?.trim();
}

function binaryProperty(streams: Streams, prefix: string, tag: string): Buffer | undefined {
  return streams.get(`${prefix}__substg1.0_${tag}${BINARY}`);
}

function addressText({ name, address }: MsgAddress): string {
  if (address === '' || address === name) return name;
  return name === '' ? address : `${name} <${address}>`;
}

interface MailboxProperties {
  name: string;
  smtp: string | undefined;
  addressType: string | undefined;
  address: string | undefined;
}

/** A sender or a recipient. An Exchange address ("/O=...") is not one a reader can use; the SMTP address stands in when the message has it. */
function mailboxText({ name, smtp, addressType, address }: MailboxProperties): string {
  return addressText({ name, address: smtp ?? (addressType?.toUpperCase() === 'EX' ? '' : (address ?? '')) });
}

function senderOf(streams: Streams, codePage: number): string {
  return mailboxText({
    name: fieldProperty(streams, '', PR.senderName, codePage) ?? fieldProperty(streams, '', PR.sentRepresentingName, codePage) ?? '',
    smtp: fieldProperty(streams, '', PR.senderSmtp, codePage),
    addressType: fieldProperty(streams, '', PR.senderAddressType, codePage),
    address: fieldProperty(streams, '', PR.senderAddress, codePage),
  });
}

function storageNames(streams: Streams, prefix: string): string[] {
  const names = new Set<string>();
  for (const key of streams.keys()) {
    if (!key.startsWith(prefix)) continue;
    const slash = key.indexOf('/');
    if (slash > 0) names.add(key.slice(0, slash));
  }
  return [...names].sort().slice(0, MAX_LISTED);
}

interface Recipients {
  to: string[];
  cc: string[];
  bcc: string[];
}

function recipientsOf(streams: Streams, codePage: number): Recipients {
  const recipients: Recipients = { to: [], cc: [], bcc: [] };
  for (const storage of storageNames(streams, RECIPIENT_PREFIX)) {
    const prefix = `${storage}/`;
    const kind = int32Property(fixedProperties(streams.get(`${prefix}${PROPERTY_STREAM}`), SUB_OBJECT_PROPERTY_HEADER_BYTES), PR_RECIPIENT_TYPE);
    const text = mailboxText({
      name: fieldProperty(streams, prefix, PR.displayName, codePage) ?? '',
      smtp: fieldProperty(streams, prefix, PR.smtpAddress, codePage),
      addressType: fieldProperty(streams, prefix, PR.addressType, codePage),
      address: fieldProperty(streams, prefix, PR.emailAddress, codePage),
    });
    if (text === '') continue;
    if (kind === RECIPIENT_CC) recipients.cc.push(text);
    else if (kind === RECIPIENT_BCC) recipients.bcc.push(text);
    else if (kind === RECIPIENT_TO || kind === undefined) recipients.to.push(text);
  }
  return recipients;
}

function displayList(streams: Streams, tag: string, codePage: number): string[] {
  const text = fieldProperty(streams, '', tag, codePage) ?? '';
  return text.split(';').map((part) => part.trim()).filter((part) => part !== '');
}

function attachmentsOf(streams: Streams, codePage: number): MsgAttachment[] {
  return storageNames(streams, ATTACHMENT_PREFIX).map((storage) => {
    const prefix = `${storage}/`;
    const name = fieldProperty(streams, prefix, PR.attachLongName, codePage) || fieldProperty(streams, prefix, PR.attachShortName, codePage) || fieldProperty(streams, prefix, PR.displayName, codePage) || 'attachment';
    return { name, bytes: binaryProperty(streams, prefix, PR.attachData)?.length ?? 0 };
  });
}

function htmlBody(streams: Streams, codePage: number): string | undefined {
  const bytes = binaryProperty(streams, '', PR.html);
  if (bytes !== undefined) return htmlToText(decodeHtmlInput(bytes));
  const text = stringProperty(streams, '', PR.html, codePage);
  return text === undefined ? undefined : htmlToText(text);
}

/** The RTF body, or undefined when it holds no text (the normal shape of a message that only carries attachments) or cannot be read; the latter is reported. */
function rtfBody(streams: Streams): string | undefined {
  const compressed = binaryProperty(streams, '', PR.rtfCompressed);
  if (compressed === undefined) return undefined;
  const rtf = decompressRtf(compressed);
  if (rtf === undefined) {
    reportConversionWarning(`${LABEL}: the RTF body is damaged (its checksum or size does not match), so the message body was left out.`);
    return undefined;
  }
  try {
    return readRtfText(rtf);
  } catch (error) {
    if (error instanceof RtfHoldsNoTextError) return undefined;
    if (!(error instanceof LegacyOfficeFormatError)) throw error;
    reportConversionWarning(`${LABEL}: the RTF body cannot be read (${error.message}), so the message body was left out.`);
    return undefined;
  }
}

function bodyOf(streams: Streams, codePage: number): string {
  const plain = stringProperty(streams, '', PR.body, codePage) ?? '';
  if (plain.trim() !== '') return plain.replace(/\r\n?/g, '\n');
  const html = htmlBody(streams, codePage) ?? '';
  if (html.trim() !== '') return html;
  return (rtfBody(streams) ?? '').replace(/\r\n?/g, '\n');
}

/** Reads the message. A file that is not a compound file, or holds no message property stream, is a typed `LegacyOfficeFormatError`. */
export function readOutlookMessage(buffer: Buffer): OutlookMessage {
  const container = readCfbContainer(buffer, LABEL);
  const streams: Streams = container.paths;
  const properties = fixedProperties(streams.get(PROPERTY_STREAM), MESSAGE_PROPERTY_HEADER_BYTES);
  if (!streams.has(PROPERTY_STREAM)) {
    throw new LegacyOfficeFormatError(`${LABEL}: the compound file has no message property stream, so it is not an Outlook message.`);
  }
  const codePage = codePageProperty(properties, PR_INTERNET_CPID) ?? codePageProperty(properties, PR_MESSAGE_CODEPAGE) ?? DEFAULT_CODE_PAGE;
  const listed = recipientsOf(streams, codePage);
  return {
    subject: fieldProperty(streams, '', PR.subject, codePage) ?? '',
    from: senderOf(streams, codePage),
    to: listed.to.length > 0 ? listed.to : displayList(streams, PR.displayTo, codePage),
    cc: listed.cc.length > 0 ? listed.cc : displayList(streams, PR.displayCc, codePage),
    bcc: listed.bcc.length > 0 ? listed.bcc : displayList(streams, PR.displayBcc, codePage),
    date: dateProperty(properties, PR_CLIENT_SUBMIT_TIME) ?? dateProperty(properties, PR_MESSAGE_DELIVERY_TIME),
    body: bodyOf(streams, codePage),
    attachments: attachmentsOf(streams, codePage),
  };
}

function headerLine(label: string, value: string): string[] {
  return value === '' ? [] : [`${label}: ${value}`];
}

/** The message as the text a reader sees: the header lines of a mail client, a blank line, the body, then the attachments. */
export function outlookMessageText(message: OutlookMessage): string {
  const lines = [
    ...headerLine('From', message.from),
    ...headerLine('To', message.to.join('; ')),
    ...headerLine('Cc', message.cc.join('; ')),
    ...headerLine('Bcc', message.bcc.join('; ')),
    ...headerLine('Date', message.date?.toISOString() ?? ''),
    ...headerLine('Subject', message.subject),
  ];
  const parts = [lines.join('\n'), message.body.trimEnd()].filter((part) => part !== '');
  if (message.attachments.length > 0) {
    parts.push(['Attachments:', ...message.attachments.map((attachment) => `- ${attachment.name} (${attachment.bytes} bytes)`)].join('\n'));
  }
  return parts.join('\n\n');
}
