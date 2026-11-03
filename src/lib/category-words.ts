import type { FormatCategory } from './types';

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
