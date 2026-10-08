import fs from 'node:fs';
import path from 'node:path';
import { OcrLanguageUnavailableError } from '../types';
import { OCR_LANGUAGES, ocrLanguageCode, type OcrLanguage } from './ocr-languages';

/**
 * Where the OCR language data lives on this machine, and which of the languages in the table have it.
 *
 * The directories are `TESSDATA_PREFIX` (an optional mount that takes precedence) and the fixed system
 * locations; the working directory is never searched, so a traineddata file planted next to the process cannot
 * replace the installed copy. The installed set is read once and kept: the data a worker image ships does not
 * change while it runs.
 */

const TRAINEDDATA_SUFFIX = '.traineddata';
const GZIP_SUFFIX = '.gz';
/** HTTP status of a language whose data is not installed: the request is valid, the server lacks the data. */
export const OCR_LANGUAGE_NOT_INSTALLED_STATUS = 503;

const SYSTEM_TESSDATA_DIRS: readonly string[] = [
  '/usr/share/tesseract-ocr/5/tessdata',
  '/usr/share/tesseract-ocr/4.00/tessdata',
  '/usr/share/tessdata',
  '/opt/homebrew/share/tessdata',
  '/usr/local/share/tessdata',
];

/** The directories language data is read from, in precedence order. */
export function tessdataDirectories(): string[] {
  const mounted = process.env.TESSDATA_PREFIX;
  return mounted ? [mounted, ...SYSTEM_TESSDATA_DIRS] : [...SYSTEM_TESSDATA_DIRS];
}

export interface LanguageDataLocation {
  dir: string;
  gzip: boolean;
}

/** Locates the data of one traineddata name, for zero-network offline inference. */
export function locateLanguageData(traineddata: string): LanguageDataLocation | undefined {
  for (const dir of tessdataDirectories()) {
    if (fs.existsSync(path.join(dir, `${traineddata}${TRAINEDDATA_SUFFIX}${GZIP_SUFFIX}`))) return { dir, gzip: true };
    if (fs.existsSync(path.join(dir, `${traineddata}${TRAINEDDATA_SUFFIX}`))) return { dir, gzip: false };
  }
  return undefined;
}

function notInstalled(message: string): OcrLanguageUnavailableError {
  return new OcrLanguageUnavailableError(message, OCR_LANGUAGE_NOT_INSTALLED_STATUS);
}

/**
 * Locates the data of every traineddata name of a language request. The engine reads all of a request's
 * languages from one directory in one format, so names found in different places (or one gzipped and another
 * not) cannot be loaded together and are reported as not installed. A missing name is a 503 naming it.
 */
export function locateLanguagesData(request: string, traineddata: readonly string[]): LanguageDataLocation {
  const found = traineddata.map((name) => ({ name, location: locateLanguageData(name) }));
  const missing = found.filter((entry) => entry.location === undefined).map((entry) => `${entry.name}${TRAINEDDATA_SUFFIX}`);
  if (missing.length > 0) {
    throw notInstalled(`OCR language '${request}' (${missing.join(', ')}) is not available locally.`);
  }
  const first = found[0].location as LanguageDataLocation;
  for (const entry of found) {
    const location = entry.location as LanguageDataLocation;
    if (location.dir !== first.dir || location.gzip !== first.gzip) {
      throw notInstalled(
        `OCR languages '${request}' are installed in different places or formats and cannot be loaded together.`
      );
    }
  }
  return first;
}

let installedCache: ReadonlySet<string> | undefined;

function scanInstalled(): ReadonlySet<string> {
  const installed = new Set<string>();
  for (const dir of tessdataDirectories()) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = entry.endsWith(GZIP_SUFFIX) ? entry.slice(0, -GZIP_SUFFIX.length) : entry;
      if (name.endsWith(TRAINEDDATA_SUFFIX)) installed.add(name.slice(0, -TRAINEDDATA_SUFFIX.length));
    }
  }
  return installed;
}

/** Traineddata names found in the configured directories; read once, then kept. */
export function installedTraineddata(): ReadonlySet<string> {
  installedCache ??= scanInstalled();
  return installedCache;
}

/** Forgets the scan, so the next call reads the directories again (tests, and a mount attached after start). */
export function resetInstalledTraineddata(): void {
  installedCache = undefined;
}

export interface OcrLanguageListing {
  /** The short code to request the language by. */
  code: string;
  traineddata: string;
  name: string;
  /** ISO 15924 script code. */
  script: string;
  direction: OcrLanguage['direction'];
  /** Whether this machine has the data for the language. */
  installed: boolean;
}

/** Every language of the table with whether its data is installed here. */
export function listOcrLanguages(): OcrLanguageListing[] {
  const installed = installedTraineddata();
  return OCR_LANGUAGES.map((language) => ({
    code: ocrLanguageCode(language),
    traineddata: language.traineddata,
    name: language.name,
    script: language.script,
    direction: language.direction,
    installed: installed.has(language.traineddata),
  }));
}
