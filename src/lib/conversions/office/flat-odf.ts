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

const MAX_FLAT_ODF_BYTES = 128 * 1024 * 1024;

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

function normalizeFlatOdfContentXml(xml: string): string {
  const openReplaced = xml.replace(/<([A-Za-z_][\w.-]*:)?document\b/, (_full, prefix = '') => `<${prefix}document-content`);
  return openReplaced.replace(/<\/([A-Za-z_][\w.-]*:)?document>\s*$/, (_full, prefix = '') => `</${prefix}document-content>`);
}

function assertFlatOdfStructure(xml: string, format: FlatOdfFormat, spec: FlatOdfSpec): void {
  if (!/<(?:[A-Za-z_][\w.-]*:)?document(?:\s|>)/.test(xml)) {
    throw new ConversionFailedError(`Invalid ${format.toUpperCase()} document: missing <office:document> root element.`);
  }
  const mimeMatch = /\boffice:mimetype\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(xml);
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
