import { documentToEpub } from './document-model/epub';
import { readEpubModel } from './source-model';
import { openEpubPackage } from './epub-reader';
import type { DocumentModel } from './document-model/model';
import { ConversionFailedError } from '../types';

const SVG_MEDIA_TYPE = 'image/svg+xml';

/**
 * Writes an EPUB again from the structure of its own reader: the chapters in spine order with their headings, lists, tables and
 * pictures, and the title, language and cover the package states. Only what the model carries is in the new package: its links are
 * web, mail and bookmark links, and its pictures are the files the package packaged, so nothing of the uploaded package (a manifest
 * or spine entry that names a path outside it, a script, a style sheet) reaches a program that reads the result.
 */
export async function rewriteEpubFromModel(input: Buffer, title: string, language?: string): Promise<Buffer> {
  return documentToEpub(withoutVectorImages(await readEpubModel(input)), { title, language });
}

/**
 * The model without its SVG pictures. An SVG is a document of its own that names files and URLs (`xlink:href`, `@import`, external
 * entities) and is packaged as its original bytes, so a program that renders it would follow them; the picture's text alternative
 * stays where the picture was.
 */
export function withoutVectorImages(model: DocumentModel): DocumentModel {
  return { ...model, images: model.images.filter((image) => image.format !== 'svg') };
}

/** Refuses an EPUB that packages an SVG document: the last check on any book written for a program that renders its pictures. */
export async function assertNoVectorImages(epub: Buffer): Promise<void> {
  const pkg = await openEpubPackage(epub);
  for (const item of pkg.items.values()) {
    if (item.mediaType === SVG_MEDIA_TYPE || item.path.toLowerCase().endsWith('.svg')) {
      throw new ConversionFailedError('The book holds an SVG picture, which this conversion does not hand to the e-book writer.');
    }
  }
}
