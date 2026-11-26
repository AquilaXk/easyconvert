import JSZip from 'jszip';
import { ConversionFailedError, ConversionOptions, ConversionResult, PayloadLimitError } from '../../types';
import { decodeXmlBytes } from '../package-access';
import { assertWellFormedXml } from '../xml-wellformed';
import { convertOdsSource, convertOdtSource } from './odf-convert';
import { convertOdpSource } from './odp-convert';
import { extractTextFromOdt } from './odt-text';
import { assertReadableAsText } from './text-source-guard';

/**
 * In-process Flat OpenDocument XML (FODT, FODS, FODP) converter.
 * Validates XML well-formedness and ODF root/body structure, packages into standard ODF ZIP
 * (`mimetype`, `META-INF/manifest.xml`, `content.xml`), and delegates to the ODT/ODS/ODP pipelines.
 */

const MAX_FLAT_ODF_BYTES = 64 * 1024 * 1024;

export type FlatOdfFormat = 'fodt' | 'fods' | 'fodp';

interface FlatOdfSpec {
  readonly mime: string;
  readonly bodyTag: string;
  readonly zipFormat: 'odt' | 'ods' | 'odp';
}

const FLAT_ODF_SPECS: Readonly<Record<FlatOdfFormat, FlatOdfSpec>> = {
  fodt: {
    mime: 'application/vnd.oasis.opendocument.text',
    bodyTag: 'text',
    zipFormat: 'odt',
  },
  fods: {
    mime: 'application/vnd.oasis.opendocument.spreadsheet',
    bodyTag: 'spreadsheet',
    zipFormat: 'ods',
  },
  fodp: {
    mime: 'application/vnd.oasis.opendocument.presentation',
    bodyTag: 'presentation',
    zipFormat: 'odp',
  },
};

export function isFlatOdfFormat(format: string): format is FlatOdfFormat {
  return format === 'fodt' || format === 'fods' || format === 'fodp';
}

function skipXmlDoctype(xml: string, from: number): number {
  let i = from + 9; // past '<!DOCTYPE'
  let inSubset = false;
  let quote = '';
  while (i < xml.length) {
    const ch = xml[i];
    if (quote !== '') {
      if (ch === quote) quote = '';
      i += 1;
      continue;
    }
    if (inSubset && xml.startsWith('<!--', i)) {
      const commentEnd = xml.indexOf('-->', i + 4);
      if (commentEnd === -1) return xml.length;
      i = commentEnd + 3;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (!inSubset && ch === '[') inSubset = true;
    else if (inSubset && ch === ']') inSubset = false;
    else if (!inSubset && ch === '>') return i + 1;
    i += 1;
  }
  return xml.length;
}

function findXmlRootStart(xml: string): number {
  let at = xml.startsWith('\ufeff') ? 1 : 0;
  while (at < xml.length) {
    while (at < xml.length && /\s/.test(xml[at])) at += 1;
    if (xml.startsWith('<?', at)) {
      const end = xml.indexOf('?>', at + 2);
      if (end === -1) break;
      at = end + 2;
      continue;
    }
    if (xml.startsWith('<!--', at)) {
      const end = xml.indexOf('-->', at + 4);
      if (end === -1) break;
      at = end + 3;
      continue;
    }
    if (xml.slice(at, at + 9).toUpperCase() === '<!DOCTYPE') {
      at = skipXmlDoctype(xml, at);
      continue;
    }
    break;
  }
  return at;
}

function findXmlTagEnd(xml: string, from: number): number {
  let quote = '';
  for (let i = from; i < xml.length; i += 1) {
    const ch = xml[i];
    if (quote !== '') {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return xml.length - 1;
}

function findLastRealDocumentClose(
  xml: string,
  from: number
): { index: number; length: number; prefix: string } | null {
  const closePattern = /<\/([A-Za-z_][\w.-]*:)?document\s*>/y;
  let last: { index: number; length: number; prefix: string } | null = null;
  let pos = from;
  while (pos < xml.length) {
    const lt = xml.indexOf('<', pos);
    if (lt === -1) break;
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      pos = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      pos = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      pos = end === -1 ? xml.length : end + 2;
      continue;
    }
    if (xml.charCodeAt(lt + 1) === 0x2f /* '/' */) {
      closePattern.lastIndex = lt;
      const match = closePattern.exec(xml);
      if (match) {
        last = { index: lt, length: match[0].length, prefix: match[1] ?? '' };
        pos = lt + match[0].length;
        continue;
      }
    }
    pos = findXmlTagEnd(xml, lt + 1) + 1;
  }
  return last;
}

function normalizeFlatOdfContentXml(xml: string): string {
  const rootStart = findXmlRootStart(xml);
  const openPattern = /<([A-Za-z_][\w.-]*:)?document(?=\s|>|\/)/y;
  openPattern.lastIndex = rootStart;
  const openMatch = openPattern.exec(xml);
  if (!openMatch) return xml;
  const openPrefix = openMatch[1] ?? '';
  const openReplacement = `<${openPrefix}document-content`;
  const openReplaced =
    xml.slice(0, rootStart) + openReplacement + xml.slice(rootStart + openMatch[0].length);
  const afterOpenTag = findXmlTagEnd(openReplaced, rootStart + openReplacement.length) + 1;
  const closeMatch = findLastRealDocumentClose(openReplaced, afterOpenTag);
  if (!closeMatch) return openReplaced;
  return (
    openReplaced.slice(0, closeMatch.index) +
    `</${closeMatch.prefix}document-content>` +
    openReplaced.slice(closeMatch.index + closeMatch.length)
  );
}

function assertFlatOdfStructure(xml: string, format: FlatOdfFormat, spec: FlatOdfSpec): void {
  const rootStart = findXmlRootStart(xml);
  const rootPattern = /<([A-Za-z_][\w.-]*:)?document(?:\s|>)/y;
  rootPattern.lastIndex = rootStart;
  if (!rootPattern.test(xml)) {
    throw new ConversionFailedError(`Invalid ${format.toUpperCase()} document: missing <office:document> root element.`);
  }
  const rootEnd = findXmlTagEnd(xml, rootStart + 1);
  const rootOpenTag = xml.slice(rootStart, rootEnd + 1);
  const mimeMatch = /\boffice:mimetype\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(rootOpenTag);
  const declaredMime = mimeMatch?.[1] ?? mimeMatch?.[2];
  if (declaredMime !== undefined && declaredMime.trim() !== '' && declaredMime.trim().toLowerCase() !== spec.mime) {
    throw new ConversionFailedError(
      `Invalid ${format.toUpperCase()} document: unexpected mimetype '${declaredMime.trim()}'.`
    );
  }
  const bodyPattern = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${spec.bodyTag}(?:\\s|>)`);
  if (!bodyPattern.test(xml)) {
    throw new ConversionFailedError(`Invalid ${format.toUpperCase()} document: missing <office:${spec.bodyTag}> body.`);
  }
}

/** Validates and converts a Flat ODF buffer into an equivalent standard packaged ODF ZIP buffer. */
export async function flatOdfToZippedPackage(inputBuffer: Buffer, format: FlatOdfFormat): Promise<Buffer> {
  if (inputBuffer.length > MAX_FLAT_ODF_BYTES) {
    throw new PayloadLimitError(`Flat ODF document exceeds ${MAX_FLAT_ODF_BYTES} bytes.`);
  }
  assertReadableAsText(inputBuffer, format);
  const spec = FLAT_ODF_SPECS[format];
  const xml = decodeXmlBytes(inputBuffer, format.toUpperCase());
  assertWellFormedXml(`${format}.xml`, xml, format.toUpperCase());
  assertFlatOdfStructure(xml, format, spec);

  const zip = new JSZip();
  zip.file('mimetype', spec.mime, { compression: 'STORE' });
  zip.file(
    'META-INF/manifest.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="${spec.mime}"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`
  );
  zip.file('content.xml', normalizeFlatOdfContentXml(xml));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export async function extractTextFromFlatOdf(inputBuffer: Buffer, format: FlatOdfFormat): Promise<string> {
  const pkg = await flatOdfToZippedPackage(inputBuffer, format);
  if (format === 'fodt') return extractTextFromOdt(pkg);
  if (format === 'fodp') {
    const res = await convertOdpSource(pkg, 'txt', {}, 'presentation');
    return res.buffer.toString('utf-8');
  }
  const res = await convertOdsSource(pkg, 'csv', {}, 'spreadsheet');
  return res.buffer.toString('utf-8');
}

export async function convertFlatOdfSource(
  inputBuffer: Buffer,
  src: FlatOdfFormat,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const pkg = await flatOdfToZippedPackage(inputBuffer, src);
  const spec = FLAT_ODF_SPECS[src];
  if (tgt === spec.zipFormat) {
    return { buffer: pkg, mimeType: spec.mime, filename: `${baseName}.${spec.zipFormat}`, size: pkg.length };
  }
  if (src === 'fodt') return convertOdtSource(pkg, tgt, options, baseName);
  if (src === 'fods') return convertOdsSource(pkg, tgt, options, baseName);
  return convertOdpSource(pkg, tgt, options, baseName);
}
