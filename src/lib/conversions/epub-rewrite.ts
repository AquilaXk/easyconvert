import { documentToEpub } from './document-model/epub';
import { readEpubModel } from './source-model';

/**
 * Writes an EPUB again from the structure of its own reader: the chapters in spine order with their headings, lists, tables and
 * pictures, and the title, language and cover the package states. Only what the model carries is in the new package: its links are
 * web, mail and bookmark links, and its pictures are the files the package packaged, so nothing of the uploaded package (a manifest
 * or spine entry that names a path outside it, a script, a style sheet) reaches a program that reads the result.
 */
export async function rewriteEpubFromModel(input: Buffer, title: string, language?: string): Promise<Buffer> {
  return documentToEpub(await readEpubModel(input), { title, language });
}
