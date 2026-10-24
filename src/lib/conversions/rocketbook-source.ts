import type { ConversionOptions, ConversionResult } from '../types';
import { documentToText } from './document-model/text';
import { MODEL_TARGETS, renderModelTarget } from './document-targets';
import { readRocketBookModel } from './rocketbook-model';

/** Writes a target from the text of a book, for the targets the document model does not write (the Palm family, the Sony and Open eBook formats, RTF, page images). */
export type WriteTargetFromText = (text: string, src: string, tgt: string, options: ConversionOptions, baseName: string) => Promise<ConversionResult>;

/**
 * Converts a RocketBook: the book is read into the document model once; the targets of the model (EPUB, PDF, TXT, HTML, Markdown,
 * DOCX, ODT) are written from its structure, every other target of the e-book sources from its text.
 */
export async function convertRocketBookSource(
  input: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string,
  writeFromText: WriteTargetFromText
): Promise<ConversionResult> {
  const model = await readRocketBookModel(input, baseName);
  if (MODEL_TARGETS.has(tgt)) return renderModelTarget(model, tgt, options, baseName);
  return writeFromText(documentToText(model), 'rb', tgt, options, baseName);
}
