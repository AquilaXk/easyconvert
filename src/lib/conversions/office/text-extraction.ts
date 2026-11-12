import { ConversionFailedError, ConversionOptions, PayloadLimitError } from '../../types';
import { documentToStructuredText } from '../document-model/markdown';
import { readPdfForOffice } from '../pdf-office';
import { readXpsText } from './xps-reader';
import { documentToText } from '../document-model/text';
import { parseHwpDocument } from '../hwp';
import { decodeHtmlInput } from '../html-encoding';
import { sourceBytesAsText } from './text-source';
import { readDocText } from './doc-reader';
import { readRtfText } from './rtf-reader';
import { EPUB_MAX_TEXT_CHARS, EPUB_TEXT_MEDIA_TYPES, openEpubPackage } from '../epub-reader';
import { EncryptedOfficeDocumentError } from './legacy-office-errors';
import { htmlToText } from './html-text';
import { decodeXmlBytes } from '../package-access';
import { extractTextFromOdt } from './odt-text';
import { PARAGRAPH_SEPARATOR } from './text-constants';

/**
 * Extracts clean text content from various source formats for Office generation
 */
export async function extractTextContentForOffice(
  inputBuffer: Buffer,
  src: string,
  options: ConversionOptions,
  baseName: string
): Promise<string> {
  if (src === 'pdf') {
    return documentToStructuredText(await readPdfForOffice(inputBuffer, options));
  }

  if (src === 'rtf') {
    return extractTextFromRtf(inputBuffer);
  }

  if (src === 'odt') {
    return extractTextFromOdt(inputBuffer);
  }

  if (src === 'doc') {
    return extractTextFromDoc(inputBuffer);
  }

  if (src === 'tex' || src === 'latex') {
    return extractTextFromTexString(inputBuffer.toString('utf-8'));
  }

  if (src === 'xps' || src === 'oxps') {
    return readXpsText(inputBuffer, options.signal);
  }

  if (src === 'hwp') {
    return documentToText(parseHwpDocument(inputBuffer).model);
  }

  if (src === 'html' || src === 'htm') {
    return decodeHtmlInput(inputBuffer);
  }

  const UNSUPPORTED_BINARY_OFFICE_FORMATS = new Set([
    'pages',
    'numbers',
    'key',
    'pub',
    'lwp',
    'epub',
    'et',
    'mobi',
    'azw',
    'azw3',
    'azw4',
    'cbz',
    'cbr',
    'cbc',
    'fb2',
    'ibooks',
    'lit',
    'prc',
    'snb',
    'tcr',
    'chm',
    'djvu',
    'xlsx',
    'xls',
    'docx',
    'docm',
    'pptx',
    'pptm',
    'potx',
    'potm',
    'ods',
    'odp',
    'odg',
    'odd',
  ]);

  if (UNSUPPORTED_BINARY_OFFICE_FORMATS.has(src)) {
    throw new ConversionFailedError(
      `Unsupported binary or compressed format '.${src}' for text extraction: fail-closed against mojibake corruption.`
    );
  }

  return sourceBytesAsText(inputBuffer, src);
}

/**
 * Text of a Word 97-2003 binary document, read through its CLX piece table ([MS-DOC]). Malformed input
 * throws a LegacyOfficeFormatError (400) and an encrypted document an EncryptedOfficeDocumentError (422).
 */
export function extractTextFromDoc(buffer: Buffer, canDraw?: (character: string) => boolean): string {
  return readDocText(buffer, canDraw);
}

function extractTextFromTexString(tex: string): string {
  return tex
    .replace(/\\(?:section|chapter|subsection)\*?\{([^}]+)\}/g, '$1\n\n')
    .replace(/\\[a-zA-Z]+(?:\[[^\]]*\])?(?:\{([^}]*)\})?/g, '$1 ')
    .replace(/[{}]/g, '')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

/**
 * Text of an RTF document: groups, \uN escapes with \ucN fallbacks, \'hh bytes in the document or font
 * code page, and non-text destinations are handled by the tokenizer. Malformed input throws a
 * LegacyOfficeFormatError (400).
 */
export function extractTextFromRtf(rtf: Buffer): string {
  return readRtfText(rtf);
}

/**
 * The text of an EPUB in reading order (EPUB Packages 3.3 and Open Packaging Format 2.0.1): META-INF/container.xml
 * names the package document, whose spine lists the content documents, and each XHTML document contributes its
 * body text. Navigation documents, scripts and styles are not text. A book with no text, a DRM-protected one or a
 * broken package is a typed error.
 */
export async function readEpubText(input: Buffer): Promise<string> {
  const book = await openEpubPackage(input);
  const chapters: string[] = [];
  let totalChars = 0;
  for (const item of book.spine) {
    if (!EPUB_TEXT_MEDIA_TYPES.has(item.mediaType) || item.properties.includes('nav')) continue;
    if (item.encrypted) {
      throw new EncryptedOfficeDocumentError('The EPUB content is protected by DRM, so its text cannot be read.');
    }
    const text = htmlToText(decodeXmlBytes(await book.read(item.path, 'EPUB spine'), `EPUB chapter ${item.path}`));
    if (text === '') continue;
    totalChars += text.length;
    if (totalChars > EPUB_MAX_TEXT_CHARS) throw new PayloadLimitError(`The EPUB text is longer than ${EPUB_MAX_TEXT_CHARS} characters.`);
    chapters.push(text);
  }
  if (chapters.length === 0) throw new ConversionFailedError('The EPUB holds no text.');
  return chapters.join(PARAGRAPH_SEPARATOR);
}
