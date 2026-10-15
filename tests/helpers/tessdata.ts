import { existsSync } from 'node:fs';
import path from 'node:path';

/** Directories Tesseract reads language data from, in the order it looks (TESSDATA_PREFIX first). */
function tessdataDirectories(): string[] {
  return [
    ...(process.env.TESSDATA_PREFIX ? [process.env.TESSDATA_PREFIX] : []),
    process.cwd(),
    '/usr/share/tesseract-ocr/5/tessdata',
    '/usr/share/tesseract-ocr/4.00/tessdata',
    '/usr/share/tessdata',
  ];
}

/** Whether the traineddata file of `language` is installed. */
export function hasTesseractLanguage(language: string): boolean {
  return tessdataDirectories().some(
    (dir) => existsSync(path.join(dir, `${language}.traineddata`)) || existsSync(path.join(dir, `${language}.traineddata.gz`))
  );
}
