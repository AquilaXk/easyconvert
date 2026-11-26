import iconv from 'iconv-lite';
import { ConversionFailedError } from '../../types';
import { escapeMarkupAttribute } from '../../text/escape';
import { decodeHtmlInput } from '../html-encoding';
import { assertReadableAsText } from './text-source-guard';
import { htmlToText } from './html-text';

/**
 * Bounded RFC 5322 / MIME (RFC 2045-2047) email (.eml) reader.
 * Decodes folded headers, RFC 2047 encoded words, multipart trees, quoted-printable and base64 bodies,
 * and attachment listings without spawning external mail tools.
 */

const MAX_MIME_DEPTH = 16;
const MAX_MIME_PARTS = 256;
const MAX_HEADER_BYTES = 256 * 1024;
const MAX_DECODED_BYTES = 32 * 1024 * 1024;

export interface EmlAttachment {
  name: string;
  contentType: string;
  bytes: number;
}

export interface EmlMessage {
  subject: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  date: string;
  textBody: string;
  htmlBody: string;
  attachments: EmlAttachment[];
}

interface MimeWalkState {
  partCount: number;
  decodedBytes: number;
  textParts: string[];
  htmlParts: string[];
  attachments: EmlAttachment[];
}

function findHeaderBodySplit(raw: string): { head: string; body: string } {
  const crlf = raw.indexOf('\r\n\r\n');
  const lf = raw.indexOf('\n\n');
  if (crlf === -1 && lf === -1) return { head: raw, body: '' };
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { head: raw.slice(0, crlf), body: raw.slice(crlf + 4) };
  }
  return { head: raw.slice(0, lf), body: raw.slice(lf + 2) };
}

function parseHeaders(headerSection: string): Map<string, string> {
  if (Buffer.byteLength(headerSection, 'utf-8') > MAX_HEADER_BYTES) {
    throw new ConversionFailedError(`Invalid EML message: header block exceeds ${MAX_HEADER_BYTES} bytes.`);
  }
  const unfolded = headerSection.replace(/\r?\n[ \t]+/g, ' ');
  const headers = new Map<string, string>();
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).trim();
    const existing = headers.get(name);
    headers.set(name, existing ? `${existing}, ${val}` : val);
  }
  return headers;
}

function decodeCharset(bytes: Buffer, charset: string | undefined): string {
  const normalized = (charset || 'utf-8').trim().toLowerCase();
  if (normalized === 'utf-8' || normalized === 'utf8' || normalized === 'us-ascii' || normalized === 'ascii') {
    return bytes.toString('utf-8');
  }
  if (iconv.encodingExists(normalized)) {
    return iconv.decode(bytes, normalized);
  }
  return bytes.toString('utf-8');
}

function decodeQuotedPrintableBytes(raw: string): Buffer {
  const cleaned = raw.replace(/=\r?\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned.charCodeAt(i);
    if (ch === 0x3d /* '=' */ && i + 2 < cleaned.length) {
      const hex = cleaned.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    if (ch <= 0xff) out.push(ch);
    else {
      for (const b of Buffer.from(cleaned[i], 'utf-8')) out.push(b);
    }
  }
  return Buffer.from(out);
}

function decodeEncodedWords(value: string): string {
  // Collapse linear whitespace strictly between consecutive RFC 2047 encoded words per RFC 2047 §6.2.
  const adjacentJoined = value.replace(/(\?=)[ \t]+(=\?)/g, '$1$2');
  return adjacentJoined.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_full, charset: string, enc: string, payload: string) => {
    try {
      if (enc.toUpperCase() === 'B') {
        const bytes = Buffer.from(payload, 'base64');
        return decodeCharset(bytes, charset);
      }
      const qBytes = decodeQuotedPrintableBytes(payload.replace(/_/g, ' '));
      return decodeCharset(qBytes, charset);
    } catch {
      return _full;
    }
  });
}

function extractParam(headerVal: string | undefined, paramName: string): string | undefined {
  if (!headerVal) return undefined;
  const escaped = paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|;)\\s*${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^;\\s]+))`, 'i').exec(headerVal);
  const raw = match?.[1] ?? match?.[2] ?? match?.[3];
  return raw ? decodeEncodedWords(raw.trim()) : undefined;
}

function mediaTypeOf(contentType: string | undefined): string {
  if (!contentType) return 'text/plain';
  return contentType.split(';', 1)[0].trim().toLowerCase() || 'text/plain';
}

function decodeBodyBytes(rawBody: string, encoding: string | undefined, state: MimeWalkState): Buffer {
  const cte = (encoding || '7bit').trim().toLowerCase();
  let decoded: Buffer;
  if (cte === 'base64') {
    decoded = Buffer.from(rawBody.replace(/[\r\n\s]+/g, ''), 'base64');
  } else if (cte === 'quoted-printable') {
    decoded = decodeQuotedPrintableBytes(rawBody);
  } else {
    decoded = Buffer.from(rawBody, 'latin1');
  }
  state.decodedBytes += decoded.length;
  if (state.decodedBytes > MAX_DECODED_BYTES) {
    throw new ConversionFailedError(`EML message exceeds ${MAX_DECODED_BYTES} decoded bytes.`);
  }
  return decoded;
}

function splitMultipartParts(body: string, boundary: string): string[] {
  const delim = `--${boundary}`;
  const closeDelim = `${delim}--`;
  const lines = body.split(/\r?\n/);
  const parts: string[] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.replace(/\s+$/, '');
    if (trimmed === closeDelim) {
      if (current !== null) parts.push(current.join('\r\n'));
      break;
    }
    if (trimmed === delim) {
      if (current !== null) parts.push(current.join('\r\n'));
      current = [];
      continue;
    }
    if (current !== null) current.push(line);
  }
  return parts;
}

function walkMimeEntity(rawEntity: string, depth: number, state: MimeWalkState, topHeadersOut?: Map<string, string>): void {
  if (depth > MAX_MIME_DEPTH) {
    throw new ConversionFailedError(`Invalid EML message: MIME nesting exceeds ${MAX_MIME_DEPTH} levels.`);
  }
  state.partCount += 1;
  if (state.partCount > MAX_MIME_PARTS) {
    throw new ConversionFailedError(`Invalid EML message: MIME part count exceeds ${MAX_MIME_PARTS}.`);
  }

  const { head, body } = findHeaderBodySplit(rawEntity);
  const headers = parseHeaders(head);
  if (topHeadersOut && depth === 0) {
    for (const [k, v] of headers) topHeadersOut.set(k, v);
  }

  const contentType = headers.get('content-type');
  const mime = mediaTypeOf(contentType);
  const disposition = (headers.get('content-disposition') || '').toLowerCase();
  const isAttachment = disposition.startsWith('attachment');

  if (mime.startsWith('multipart/')) {
    const boundary = extractParam(contentType, 'boundary');
    if (!boundary) {
      throw new ConversionFailedError(`Invalid EML message: ${mime} part is missing its boundary.`);
    }
    const children = splitMultipartParts(body, boundary);
    for (const child of children) {
      walkMimeEntity(child, depth + 1, state);
    }
    return;
  }

  const bytes = decodeBodyBytes(body, headers.get('content-transfer-encoding'), state);
  const fileName = extractParam(headers.get('content-disposition'), 'filename') ?? extractParam(contentType, 'name');

  if (isAttachment || (!mime.startsWith('text/') && fileName)) {
    state.attachments.push({
      name: fileName || `attachment-${state.attachments.length + 1}`,
      contentType: mime,
      bytes: bytes.length,
    });
    return;
  }

  const charset = extractParam(contentType, 'charset');
  if (mime === 'text/html') {
    const decoded = charset ? decodeCharset(bytes, charset) : decodeHtmlInput(bytes);
    if (decoded.trim() !== '') state.htmlParts.push(decoded);
    return;
  }

  if (mime.startsWith('text/')) {
    const decoded = decodeCharset(bytes, charset).replace(/\r\n?/g, '\n');
    if (decoded.trim() !== '') state.textParts.push(decoded);
  } else if (fileName || bytes.length > 0) {
    state.attachments.push({
      name: fileName || `part-${state.attachments.length + 1}`,
      contentType: mime,
      bytes: bytes.length,
    });
  }
}

export function readEmlMessage(input: Buffer): EmlMessage {
  assertReadableAsText(input, 'eml');
  const raw = input.toString('latin1');
  const topHeaders = new Map<string, string>();
  const state: MimeWalkState = {
    partCount: 0,
    decodedBytes: 0,
    textParts: [],
    htmlParts: [],
    attachments: [],
  };
  walkMimeEntity(raw, 0, state, topHeaders);

  const headerValue = (name: string): string => {
    const val = topHeaders.get(name);
    if (!val) return '';
    // Raw Latin-1 bytes of RFC 5322 headers -> reinterpret UTF-8 when unencoded raw UTF-8 headers occur, then decode RFC 2047
    const reinterpreted = Buffer.from(val, 'latin1').toString('utf-8');
    return decodeEncodedWords(reinterpreted);
  };

  return {
    subject: headerValue('subject'),
    from: headerValue('from'),
    to: headerValue('to'),
    cc: headerValue('cc'),
    bcc: headerValue('bcc'),
    date: headerValue('date'),
    textBody: state.textParts.join('\n\n').trim(),
    htmlBody: state.htmlParts.join('\n').trim(),
    attachments: state.attachments,
  };
}

function headerLine(label: string, value: string): string[] {
  return value ? [`${label}: ${value}`] : [];
}

/** Readable plain-text rendering of an EML message, matching `outlookMessageText`. */
export function emlMessageText(message: EmlMessage): string {
  const lines = [
    ...headerLine('From', message.from),
    ...headerLine('To', message.to),
    ...headerLine('Cc', message.cc),
    ...headerLine('Bcc', message.bcc),
    ...headerLine('Date', message.date),
    ...headerLine('Subject', message.subject),
  ];
  const bodyText = message.textBody || (message.htmlBody ? htmlToText(message.htmlBody) : '');
  const parts = [lines.join('\n'), bodyText].filter((p) => p !== '');
  if (message.attachments.length > 0) {
    parts.push(['Attachments:', ...message.attachments.map((a) => `- ${a.name} (${a.bytes} bytes)`)].join('\n'));
  }
  return parts.join('\n\n');
}

function sanitizeEmailHtmlFragment(html: string): string {
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  let inner = bodyMatch ? bodyMatch[1] : html;
  inner = inner.replace(/<(script|iframe|object|embed|form|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  inner = inner.replace(/<(script|iframe|object|embed)\b[^>]*\/?>/gi, '');
  inner = inner.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  inner = inner.replace(/(href|src)\s*=\s*(['"])\s*(?:javascript|vbscript|data:text\/html)[^'"]*\2/gi, '$1=$2#$2');
  return inner.trim();
}

/** Clean, script-safe standalone HTML rendering of an EML message. */
export function emlMessageHtml(message: EmlMessage, fallbackTitle = 'Email Message'): string {
  const title = message.subject || fallbackTitle;
  const metaRows = [
    ['From', message.from],
    ['To', message.to],
    ['Cc', message.cc],
    ['Date', message.date],
    ['Subject', message.subject],
  ]
    .filter(([, val]) => val !== '')
    .map(
      ([label, val]) =>
        `<tr><th style="text-align:left;padding:4px 12px 4px 0;color:#4D536B;font-weight:600;vertical-align:top;">${escapeMarkupAttribute(label)}</th><td style="padding:4px 0;color:#1F2340;">${escapeMarkupAttribute(val)}</td></tr>`
    )
    .join('');

  const metaHtml = metaRows
    ? `<table style="border-collapse:collapse;margin-bottom:1.5rem;border-bottom:1px solid #E1E4EE;padding-bottom:1rem;width:100%;font-size:0.9375rem;">${metaRows}</table>`
    : '';

  const bodyHtml = message.htmlBody
    ? sanitizeEmailHtmlFragment(message.htmlBody)
    : message.textBody
        .split(/\n{2,}/)
        .filter(Boolean)
        .map((p) => `<p style="margin:0 0 1rem;white-space:pre-wrap;">${escapeMarkupAttribute(p)}</p>`)
        .join('\n');

  const attachHtml =
    message.attachments.length > 0
      ? `<div style="margin-top:1.5rem;padding-top:1rem;border-top:1px solid #E1E4EE;font-size:0.875rem;color:#4D536B;"><strong>Attachments</strong><ul>${message.attachments
          .map((a) => `<li>${escapeMarkupAttribute(a.name)} (${a.bytes} bytes)</li>`)
          .join('')}</ul></div>`
      : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeMarkupAttribute(
    title
  )}</title><style>body{font-family:system-ui,-apple-system,sans-serif;line-height:1.6;padding:2rem;max-width:800px;margin:0 auto;color:#1F2340;}</style></head><body>${metaHtml}${bodyHtml}${attachHtml}</body></html>`;
}
