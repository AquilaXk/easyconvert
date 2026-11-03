import type { FormatCategory } from './types';
import { FORMAT_REGISTRY } from './registry';

/** A word a slug names a category of the registry by (`/video-converter`): the id of the category. */
export type CategoryWord = FormatCategory;

/** The words a slug names a category by, the categories of the registry: the format its page converts and the word its title shows. */
export const CATEGORY_WORDS: Readonly<Record<CategoryWord, { format: string; display: string }>> = {
  video: { format: 'mp4', display: 'Video' },
  audio: { format: 'mp3', display: 'Audio' },
  image: { format: 'jpg', display: 'Image' },
  document: { format: 'docx', display: 'Document' },
  ebook: { format: 'epub', display: 'Ebook' },
  archive: { format: 'zip', display: 'Archive' },
  vector: { format: 'svg', display: 'Vector' },
  font: { format: 'ttf', display: 'Font' },
  cad: { format: 'dxf', display: 'CAD' },
  spreadsheet: { format: 'xlsx', display: 'Spreadsheet' },
  presentation: { format: 'pptx', display: 'Presentation' },
  data: { format: 'csv', display: 'Data' },
};

export const isCategoryWord = (word: string): word is CategoryWord => Object.hasOwn(CATEGORY_WORDS, word);

const isRegistered = (format: string): boolean => Object.hasOwn(FORMAT_REGISTRY, format);

/**
 * Whether two names are formats of the registry, not category words, and the registry lists the conversion between them: the
 * pair has a page. A category word stands for a format only as a representative, so `presentation`, a format of the registry
 * that is also the word of a category, has the converter page of the category and no pair page of its own.
 */
export function offersConversion(source: string, target: string): boolean {
  return (
    isRegistered(source) &&
    isRegistered(target) &&
    !isCategoryWord(source) &&
    !isCategoryWord(target) &&
    FORMAT_REGISTRY[source].targetFormats.includes(target)
  );
}
