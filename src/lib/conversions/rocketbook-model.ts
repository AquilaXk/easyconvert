import { ConversionFailedError, PayloadLimitError } from '../types';
import { DocumentContext, assembleDocument } from './document-model/build';
import type { Block, DocumentModel } from './document-model/model';
import { HTML_MODEL_MAX_IMAGES, HTML_MODEL_MAX_IMAGE_BYTES, htmlToDocumentModel } from './html-model';
import { readRocketBook } from './office/rocketbook-reader';
import { mapBookLink } from './source-model';

/**
 * Reads a RocketBook into the document model: the HTML pages in table order as one flow of blocks, the PNG pictures the
 * pages name, and the title and authors of the info page. A book whose pages hold no text is refused with a typed error;
 * the container's own refusals (a damaged file, a limit) come from the container reader.
 */
export async function readRocketBookModel(file: Buffer, fallbackTitle: string): Promise<DocumentModel> {
  const book = readRocketBook(file);
  const context = new DocumentContext();
  const blocks: Block[] = [];
  let language: string | undefined;
  for (const page of book.pages) {
    const chapter = await htmlToDocumentModel(page.html, { resolveImage: (src) => book.image(src), mapLink: mapBookLink, context });
    if (context.images.length > HTML_MODEL_MAX_IMAGES) throw new PayloadLimitError(`The RocketBook embeds more than ${HTML_MODEL_MAX_IMAGES} images.`);
    if (context.images.reduce((sum, image) => sum + image.data.length, 0) > HTML_MODEL_MAX_IMAGE_BYTES) {
      throw new PayloadLimitError(`The RocketBook embeds more than ${HTML_MODEL_MAX_IMAGE_BYTES} bytes of images.`);
    }
    language ??= chapter.language;
    blocks.push(...chapter.sections.flatMap((section) => section.blocks));
  }
  if (blocks.length === 0) throw new ConversionFailedError('The RocketBook holds no text.');
  return assembleDocument({
    sections: [{ columns: 1, blocks }],
    context,
    title: book.title ?? fallbackTitle,
    author: book.authors.length > 0 ? book.authors.join(', ') : undefined,
    language,
  });
}
