import { safeDecodeXmlEntities, safeExtractXmlElements } from '../safe-xml-scanner';
import { decodeXmlBytes, openPackage } from '../package-access';
import { InflateBudget } from '../bounded-inflate';
import { readZipEntryBytes, readZipEntryText } from '../zip-entry-reader';
import { ConversionFailedError, PayloadLimitError } from '../../types';
import { EncryptedOfficeDocumentError } from './legacy-office-errors';
import { assertWellFormedXml } from '../xml-wellformed';
import { MAX_MIMETYPE_ENTRY_BYTES, PARAGRAPH_SEPARATOR } from './text-constants';

export async function extractTextFromOdt(buffer: Buffer): Promise<string> {
  return readOdtText(buffer);
}

/** OpenDocument text: the most characters one document may hold, and the longest run one `text:s` element may stand for. */
const ODT_MAX_TEXT_CHARS = 128 * 1024 * 1024;

const ODT_MAX_SPACE_RUN = 1000;

const ODF_TEXT_MIMETYPE_PREFIX = 'application/vnd.oasis.opendocument.text';

const ODF_MANIFEST_PATH = 'META-INF/manifest.xml';

/** The text of one text:p or text:h element: spaces, tabs and line breaks (text:s, text:tab, text:line-break) are characters. */
function odfParagraphText(content: string): string {
  const withoutNotes = content.replace(/<text:note\b[^>]*>[\s\S]*?<\/text:note>/g, '');
  const spaced = withoutNotes
    .replace(/<text:line-break\s*\/>/g, '\n')
    .replace(/<text:tab\s*\/>/g, '\t')
    .replace(/<text:s(?:\s+text:c="(\d+)")?\s*\/>/g, (_, count?: string) => ' '.repeat(Math.min(count === undefined ? 1 : Number(count), ODT_MAX_SPACE_RUN)));
  return safeDecodeXmlEntities(spaced.replace(/<[^>]+>/g, ''));
}

/**
 * The paragraphs and headings of an OpenDocument text file in document order (ODF 1.3, text:p and text:h). A file
 * that is not an OpenDocument text package, an encrypted one, or one without text is a typed error.
 */
export async function readOdtText(input: Buffer): Promise<string> {
  const zip = await openPackage(input, 'ODT');
  const budget = new InflateBudget();
  const mimetypeEntry = zip.file('mimetype');
  const mimetype = mimetypeEntry ? await readZipEntryText(mimetypeEntry, { maxBytes: MAX_MIMETYPE_ENTRY_BYTES, budget }) : undefined;
  if (mimetype !== undefined && !mimetype.startsWith(ODF_TEXT_MIMETYPE_PREFIX)) {
    throw new ConversionFailedError('The ODT file is not an OpenDocument text document.');
  }
  const content = zip.file('content.xml');
  if (!content) throw new ConversionFailedError('The ODT file has no content.xml.');
  const manifest = zip.file(ODF_MANIFEST_PATH);
  if (manifest) {
    const entry = safeExtractXmlElements(await readZipEntryText(manifest, { budget }), 'manifest:file-entry').find((el) => el.attrs['manifest:full-path'] === 'content.xml');
    if (entry?.content.includes('encryption-data')) {
      throw new EncryptedOfficeDocumentError('The ODT file is password protected, so its text cannot be read.');
    }
  }
  const xml = decodeXmlBytes(await readZipEntryBytes(content, { budget }), 'ODT content.xml');
  assertWellFormedXml('content.xml', xml, 'ODT');
  const paragraphs: string[] = [];
  let totalChars = 0;
  for (const element of safeExtractXmlElements(xml, ['text:p', 'text:h'], { maxElements: ODT_MAX_TEXT_CHARS })) {
    const text = odfParagraphText(element.content).trim();
    if (text === '') continue;
    totalChars += text.length;
    if (totalChars > ODT_MAX_TEXT_CHARS) throw new PayloadLimitError(`The ODT text is longer than ${ODT_MAX_TEXT_CHARS} characters.`);
    paragraphs.push(text);
  }
  if (paragraphs.length === 0) throw new ConversionFailedError('The ODT file holds no text.');
  return paragraphs.join(PARAGRAPH_SEPARATOR);
}
