import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { getOracleToolPath } from './differential-oracle';
import { palmDocText, wordsOfMarkup } from './palmdb-reader';

/**
 * Readers of the books that calibre's `ebook-convert` writes (MOBI, AZW3, PDB, LRF, OEB), run as the separate programs they
 * are, plus the setting that points the worker at the same `ebook-convert`. Importing the module makes a program found on
 * PATH the one the worker uses, as `EBOOK_CONVERT_PATH` would.
 */

export const calibreBinary: string | null = getOracleToolPath('ebook-convert');
if (calibreBinary !== null && !process.env.EBOOK_CONVERT_PATH) process.env.EBOOK_CONVERT_PATH = calibreBinary;

const READ_TIMEOUT_MS = 120_000;

/** What a reader must find: NFC, white space collapsed. */
export function normalized(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

function withCalibreDirectory<T>(prefix: string, extension: string, book: Buffer, run: (dir: string, bookPath: string, env: NodeJS.ProcessEnv) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    for (const name of ['config', 'cache', 'tmp']) fs.mkdirSync(path.join(dir, name));
    const bookPath = path.join(dir, `book.${extension}`);
    fs.writeFileSync(bookPath, book);
    const env = { ...process.env, QT_QPA_PLATFORM: 'offscreen', HOME: dir, CALIBRE_CONFIG_DIRECTORY: path.join(dir, 'config'), CALIBRE_CACHE_DIRECTORY: path.join(dir, 'cache'), CALIBRE_TEMP_DIR: path.join(dir, 'tmp') };
    return run(dir, bookPath, env);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A program of the calibre distribution, found beside `ebook-convert` (the CI install links only `ebook-convert` into PATH). */
function calibreTool(name: string): string {
  return path.join(path.dirname(fs.realpathSync(calibreBinary as string)), name);
}

/** The text of a book as calibre reads it: `ebook-convert book.<extension> book.txt`. */
export function calibreText(book: Buffer, extension: string): string {
  return withCalibreDirectory('calibre-readback-', extension, book, (dir, bookPath, env) => {
    execFileSync(calibreBinary as string, [bookPath, path.join(dir, 'book.txt')], { env, stdio: 'ignore', timeout: READ_TIMEOUT_MS });
    return fs.readFileSync(path.join(dir, 'book.txt'), 'utf-8');
  });
}

/** The metadata `ebook-meta` prints for a book. */
export function calibreMetadata(book: Buffer, extension: string): string {
  return withCalibreDirectory('calibre-meta-', extension, book, (_dir, bookPath, env) =>
    execFileSync(calibreTool('ebook-meta'), [bookPath], { env, encoding: 'utf-8', timeout: READ_TIMEOUT_MS })
  );
}

/**
 * The text of a Sony LRF book as `lrf2lrs` writes it (an XML description of the book: one `P` element per paragraph, `CR` between
 * them), which keeps the paragraphs that calibre's plain-text export of the same book runs together.
 */
export function lrfText(book: Buffer): string {
  return withCalibreDirectory('calibre-lrf-', 'lrf', book, (dir, bookPath, env) => {
    execFileSync(calibreTool('lrf2lrs'), [bookPath, '-o', path.join(dir, 'book.lrs')], { env, stdio: 'ignore', timeout: READ_TIMEOUT_MS });
    const blocks = [...fs.readFileSync(path.join(dir, 'book.lrs'), 'utf-8').matchAll(/<TextBlock\b[^>]*>([\s\S]*?)<\/TextBlock>/g)].map((match) => match[1]);
    return wordsOfMarkup(blocks.join(' '));
  });
}

/** The text of the XHTML documents of an OEB package delivered as a ZIP, in name order. */
export async function oebText(book: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(book);
  const pages = Object.keys(zip.files).filter((name) => /\.x?html$/i.test(name)).sort();
  return wordsOfMarkup((await Promise.all(pages.map((name) => (zip.file(name) as JSZip.JSZipObject).async('string')))).join(' '));
}

/** The words of a book of any of the five targets, NFC and with white space collapsed, from the reader that suits its format. */
export async function textOfCalibreTarget(book: Buffer, target: string): Promise<string> {
  if (target === 'oeb') return oebText(book);
  if (target === 'lrf') return lrfText(book);
  if (target === 'mobi') return wordsOfMarkup(palmDocText(book).toString('utf-8'));
  return normalized(calibreText(book, target));
}
