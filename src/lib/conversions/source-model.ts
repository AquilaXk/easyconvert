import { ConversionFailedError, EncryptedOfficeDocumentError, PayloadLimitError } from '../types';
import { collectImages, emptyDocModel, safeHref, type DocInline, type DocModel } from './document-model';
import { EPUB_MAX_TEXT_CHARS, EPUB_TEXT_MEDIA_TYPES, openEpubPackage } from './epub-reader';
import { HTML_MODEL_MAX_IMAGES, HTML_MODEL_MAX_IMAGE_BYTES, htmlToDocModel } from './html-model';
import { renderMarkdownFragment } from './markdown';
import { decodeXmlBytes, resolvePackagePath } from './package-access';

/**
 * Readers that turn sources other than DOCX into the block model: Markdown and HTML (through the HTML reader), plain
 * text (one paragraph per blank-line-separated chunk, single line breaks kept) and EPUB packages (every content
 * document of the spine, with the pictures it references).
 */

const PARAGRAPH_SEPARATOR = /\r?\n[ \t]*\r?\n/;
const IMAGE_SOURCE = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const MAX_IMAGE_REFERENCES_PER_DOCUMENT = 20_000;
const EXTERNAL_LINK = /^(?:https?|mailto|ftp):/i;

export async function markdownToDocModel(markdown: string): Promise<DocModel> {
  return htmlToDocModel(renderMarkdownFragment(markdown));
}

export async function htmlSourceToDocModel(html: string): Promise<DocModel> {
  return htmlToDocModel(html);
}

/** Plain text as paragraphs: chunks separated by blank lines, lines inside a chunk joined by line breaks. */
export function plainTextToDocModel(text: string): DocModel {
  const model = emptyDocModel();
  for (const chunk of text.split(PARAGRAPH_SEPARATOR)) {
    const lines = chunk.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
    if (lines.length === 0) continue;
    const inlines: DocInline[] = [];
    lines.forEach((line, index) => {
      if (index > 0) inlines.push({ kind: 'break' });
      inlines.push({ kind: 'text', text: line });
    });
    model.blocks.push({ kind: 'paragraph', inlines });
  }
  return model;
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash + 1);
}

/** The links of a content document that stay meaningful in one flat document: web and mail links, and bookmarks. */
function mapEpubLink(href: string): string | undefined {
  if (EXTERNAL_LINK.test(href)) return safeHref(href);
  const hash = href.indexOf('#');
  return hash >= 0 && hash < href.length - 1 ? `#${href.slice(hash + 1)}` : undefined;
}

/**
 * Reads an EPUB into the model, chapters in spine order. A DRM-protected book, a package that is not well formed
 * and a book without text are refused with typed errors; pictures a content document names are carried.
 */
export async function readEpubModel(input: Buffer): Promise<DocModel> {
  const book = await openEpubPackage(input);
  const model = emptyDocModel();
  model.title = book.title;
  if (book.creators.length > 0) model.author = book.creators.join(', ');
  model.language = book.language;
  let totalChars = 0;
  let imageCount = 0;
  let imageBytes = 0;
  for (const item of book.spine) {
    if (!EPUB_TEXT_MEDIA_TYPES.has(item.mediaType) || item.properties.includes('nav')) continue;
    if (item.encrypted) throw new EncryptedOfficeDocumentError('The EPUB content is protected by DRM, so its text cannot be read.');
    const html = decodeXmlBytes(await book.read(item.path, 'EPUB spine'), `EPUB chapter ${item.path}`);

    // Pictures the document references, read before the synchronous reader needs them.
    const pictures = new Map<string, Buffer>();
    let references = 0;
    for (const match of html.matchAll(IMAGE_SOURCE)) {
      references += 1;
      if (references > MAX_IMAGE_REFERENCES_PER_DOCUMENT) throw new PayloadLimitError(`${item.path} references more than ${MAX_IMAGE_REFERENCES_PER_DOCUMENT} images.`);
      const source = (match[1] ?? match[2] ?? '').trim();
      if (source === '' || source.startsWith('data:') || pictures.has(source)) continue;
      let path: string;
      try {
        path = resolvePackagePath(directoryOf(item.path), source);
      } catch {
        continue;
      }
      const entry = book.items.get(path);
      if (entry && entry.mediaType.startsWith('image/')) pictures.set(source, await book.read(path, 'EPUB image'));
    }

    const chapter = await htmlToDocModel(html, { resolveImage: (src) => pictures.get(src), mapLink: mapEpubLink });
    for (const image of collectImages(chapter)) {
      imageCount += 1;
      imageBytes += image.data.length;
    }
    if (imageCount > HTML_MODEL_MAX_IMAGES) throw new PayloadLimitError(`The EPUB embeds more than ${HTML_MODEL_MAX_IMAGES} images.`);
    if (imageBytes > HTML_MODEL_MAX_IMAGE_BYTES) throw new PayloadLimitError(`The EPUB embeds more than ${HTML_MODEL_MAX_IMAGE_BYTES} bytes of images.`);
    totalChars += html.length;
    if (totalChars > EPUB_MAX_TEXT_CHARS) throw new PayloadLimitError(`The EPUB text is longer than ${EPUB_MAX_TEXT_CHARS} characters.`);
    if (model.language === undefined && chapter.language !== undefined) model.language = chapter.language;
    model.blocks.push(...chapter.blocks);
    model.warnings.push(...chapter.warnings);
  }
  if (model.blocks.length === 0) throw new ConversionFailedError('The EPUB holds no text.');
  return model;
}
