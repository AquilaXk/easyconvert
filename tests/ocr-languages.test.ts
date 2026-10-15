import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { performOcr } from '../src/lib/conversions/ocr';
import {
  installedTraineddata,
  listOcrLanguages,
  locateLanguageData,
  resetInstalledTraineddata,
  tessdataDirectories,
} from '../src/lib/conversions/ocr-language-data';
import {
  OCR_LANGUAGES,
  OCR_MAX_LANGUAGES_PER_REQUEST,
  findOcrLanguage,
  resolveOcrLanguages,
} from '../src/lib/conversions/ocr-languages';
import { OcrLanguageUnavailableError } from '../src/lib/types';
import { MAGICK_BINARY, requireMagick } from './helpers/imagemagick';
import { OracleToolMissingError } from './helpers/differential-oracle';
import { characterErrorRatePercent } from './helpers/ocr-cer';
import { fixtureImage, fixturePath, groundTruth, requireTessdata, requireTesseract } from './helpers/ocr-fixtures';
import { oracleTest } from './helpers/oracle-test';

/**
 * The OCR language table and the data behind it. The expected values are written by hand from the ISO 639
 * registry and the file names of the published tessdata set; the installed set is read from the tesseract
 * command line, never from the table under test.
 */

const PAGE_TIMEOUT_MS = 180_000;
const REFERENCE_TIMEOUT_MS = 30_000;
const MAX_MIXED_SCRIPT_CER_PERCENT = 5;
const MAX_HARD_MIXED_SCRIPT_CER_PERCENT = 8;
const HTTP_BAD_REQUEST = 400;
const HTTP_SERVICE_UNAVAILABLE = 503;

/** Every file of the published tessdata set (tessdata_best and tessdata_fast list the same names), less `osd`. */
const PUBLISHED_TESSDATA: readonly string[] = [
  'afr', 'amh', 'ara', 'asm', 'aze', 'aze_cyrl', 'bel', 'ben', 'bod', 'bos', 'bre', 'bul', 'cat', 'ceb', 'ces',
  'chi_sim', 'chi_sim_vert', 'chi_tra', 'chi_tra_vert', 'chr', 'cos', 'cym', 'dan', 'deu', 'div', 'dzo', 'ell', 'eng',
  'enm', 'epo', 'equ', 'est', 'eus', 'fao', 'fas', 'fil', 'fin', 'fra', 'frk', 'frm', 'fry', 'gla', 'gle', 'glg',
  'grc', 'guj', 'hat', 'heb', 'hin', 'hrv', 'hun', 'hye', 'iku', 'ind', 'isl', 'ita', 'ita_old', 'jav', 'jpn',
  'jpn_vert', 'kan', 'kat', 'kat_old', 'kaz', 'khm', 'kir', 'kmr', 'kor', 'kor_vert', 'lao', 'lat', 'lav', 'lit',
  'ltz', 'mal', 'mar', 'mkd', 'mlt', 'mon', 'mri', 'msa', 'mya', 'nep', 'nld', 'nor', 'oci', 'ori', 'pan', 'pol',
  'por', 'pus', 'que', 'ron', 'rus', 'san', 'sin', 'slk', 'slv', 'snd', 'spa', 'spa_old', 'sqi', 'srp', 'srp_latn',
  'sun', 'swa', 'swe', 'syr', 'tam', 'tat', 'tel', 'tgk', 'tha', 'tir', 'ton', 'tur', 'uig', 'ukr', 'urd', 'uzb',
  'uzb_cyrl', 'vie', 'yid', 'yor',
];

/** Request code -> traineddata name, from ISO 639-1, ISO 639-3 and BCP 47 (RFC 5646) by hand. */
const CODE_EXPECTATIONS: ReadonlyArray<readonly [string, string]> = [
  ['en', 'eng'], ['EN', 'eng'], ['eng', 'eng'], ['en-US', 'eng'], ['en_GB', 'eng'],
  ['ko', 'kor'], ['ko-KR', 'kor'], ['ja', 'jpn'], ['ja-vert', 'jpn_vert'], ['jpn_vert', 'jpn_vert'],
  ['zh', 'chi_sim'], ['zh-Hans', 'chi_sim'], ['zh-CN', 'chi_sim'], ['zh-Hant', 'chi_tra'], ['zh-TW', 'chi_tra'],
  ['zh_vert', 'chi_sim_vert'], ['zh_tra_vert', 'chi_tra_vert'],
  ['ar', 'ara'], ['ara', 'ara'], ['ru', 'rus'], ['hi', 'hin'], ['de', 'deu'], ['fr', 'fra'], ['es', 'spa'],
  ['pt-BR', 'por'], ['it', 'ita'], ['nl', 'nld'], ['pl', 'pol'], ['tr', 'tur'], ['uk', 'ukr'], ['vi', 'vie'],
  ['th', 'tha'], ['he', 'heb'], ['fa', 'fas'], ['el', 'ell'], ['sv', 'swe'], ['sr', 'srp'], ['sr-Latn', 'srp_latn'],
  ['uz-Cyrl', 'uzb_cyrl'], ['az-Cyrl', 'aze_cyrl'], ['bn', 'ben'], ['ta', 'tam'], ['id', 'ind'], ['ms', 'msa'],
];

let plantedDirectory: string | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  resetInstalledTraineddata();
  if (plantedDirectory) fs.rmSync(plantedDirectory, { recursive: true, force: true });
  plantedDirectory = undefined;
});

describe('the language table', () => {
  it('lists exactly the published tessdata files, each once', () => {
    const names = OCR_LANGUAGES.map((language) => language.traineddata);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...PUBLISHED_TESSDATA].sort());
    expect(names.length).toBeGreaterThanOrEqual(100);
  });

  it('is frozen, so no request can change what another is told', () => {
    expect(Object.isFrozen(OCR_LANGUAGES)).toBe(true);
    expect(Object.isFrozen(OCR_LANGUAGES[0])).toBe(true);
    expect(Object.isFrozen(OCR_LANGUAGES[0].aliases)).toBe(true);
  });

  it('gives every language an ISO 15924 script and a direction, and marks right-to-left and vertical data', () => {
    const byName = new Map(OCR_LANGUAGES.map((language) => [language.traineddata, language]));
    for (const language of OCR_LANGUAGES) {
      expect(language.script).toMatch(/^[A-Z][a-z]{3}$/);
      expect(['ltr', 'rtl', 'ttb']).toContain(language.direction);
    }
    for (const name of ['ara', 'heb', 'fas', 'urd', 'pus', 'yid', 'syr', 'div']) expect(byName.get(name)?.direction, name).toBe('rtl');
    for (const name of ['jpn_vert', 'chi_sim_vert', 'chi_tra_vert', 'kor_vert']) expect(byName.get(name)?.direction, name).toBe('ttb');
    expect(byName.get('eng')?.script).toBe('Latn');
    expect(byName.get('rus')?.script).toBe('Cyrl');
    expect(byName.get('ara')?.script).toBe('Arab');
    expect(byName.get('hin')?.script).toBe('Deva');
    expect(byName.get('kor')?.script).toBe('Hang');
    expect(byName.get('chi_sim')?.script).toBe('Hans');
    expect(byName.get('chi_tra')?.script).toBe('Hant');
  });

  it.each(CODE_EXPECTATIONS)('resolves %s to %s', (code, traineddata) => {
    expect(findOcrLanguage(code)?.traineddata).toBe(traineddata);
  });

  oracleTest(
    'covers every language the installed tesseract lists',
    ['tesseract'],
    () => {
      const listing = execFileSync(requireTesseract(), ['--list-langs'], { encoding: 'utf-8', timeout: REFERENCE_TIMEOUT_MS });
      const installed = listing
        .split('\n')
        .slice(1)
        .map((line) => line.trim())
        .filter((line) => line !== '' && line !== 'osd');
      expect(installed.length).toBeGreaterThan(0);
      const known = new Set(OCR_LANGUAGES.map((language) => language.traineddata));
      expect(installed.filter((name) => !known.has(name))).toEqual([]);
    }
  );
});

describe('resolving a request', () => {
  it('turns auto, an empty request and no request into English', () => {
    for (const request of [undefined, '', '  ', 'auto', 'AUTO']) {
      expect(resolveOcrLanguages(request)).toEqual({ traineddata: ['eng'], joined: 'eng', auto: true });
    }
  });

  it('joins several languages with + in the order given, once each', () => {
    expect(resolveOcrLanguages('eng+kor')).toEqual({ traineddata: ['eng', 'kor'], joined: 'eng+kor', auto: false });
    expect(resolveOcrLanguages('ko+en')).toEqual({ traineddata: ['kor', 'eng'], joined: 'kor+eng', auto: false });
    expect(resolveOcrLanguages('eng+en+ENG').joined).toBe('eng');
    expect(resolveOcrLanguages('ara+rus+hin+jpn').joined).toBe('ara+rus+hin+jpn');
  });

  it(`refuses more than ${OCR_MAX_LANGUAGES_PER_REQUEST} languages in one request with a 400`, () => {
    const request = 'eng+kor+jpn+deu+fra';
    expect(() => resolveOcrLanguages(request)).toThrow(OcrLanguageUnavailableError);
    try {
      resolveOcrLanguages(request);
    } catch (err) {
      expect((err as OcrLanguageUnavailableError).status).toBe(HTTP_BAD_REQUEST);
      expect((err as Error).message).toContain(String(OCR_MAX_LANGUAGES_PER_REQUEST));
    }
  });

  it('refuses an unknown code, an empty part, auto in a list, and an oversized request, each with a 400', () => {
    for (const request of ['xx', 'eng+xx', 'eng+', '+eng', 'eng++kor', 'auto+kor', 'eng kor', 'a'.repeat(500), '../eng', 'eng\u0000']) {
      let thrown: unknown;
      try {
        resolveOcrLanguages(request);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, request).toBeInstanceOf(OcrLanguageUnavailableError);
      expect((thrown as OcrLanguageUnavailableError).status, request).toBe(HTTP_BAD_REQUEST);
    }
  });
});

describe('where language data is read from', () => {
  it('never includes the working directory, and puts a mounted TESSDATA_PREFIX first', () => {
    vi.stubEnv('TESSDATA_PREFIX', '/opt/tessdata');
    const directories = tessdataDirectories();
    expect(directories[0]).toBe('/opt/tessdata');
    expect(directories).not.toContain(process.cwd());
    expect(directories.every((directory) => path.isAbsolute(directory))).toBe(true);
    vi.unstubAllEnvs();
  });

  oracleTest(
    'uses the installed copy of a language when a file of that name sits in the working directory',
    ['tesseract'],
    async () => {
      const systemDirectory = requireTessdata('eng');
      plantedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-planted-'));
      fs.writeFileSync(path.join(plantedDirectory, 'eng.traineddata'), 'not a traineddata file');
      vi.spyOn(process, 'cwd').mockReturnValue(plantedDirectory);
      expect(locateLanguageData('eng')?.dir).not.toBe(plantedDirectory);
      const result = await performOcr(fixtureImage('en_a', 'clean300'), 'eng');
      expect(result.languageDataDirectory).toBe(locateLanguageData('eng')?.dir);
      expect(result.languageDataDirectory).not.toBe(plantedDirectory);
      expect(fs.existsSync(path.join(systemDirectory, 'eng.traineddata'))).toBe(true);
      expect(characterErrorRatePercent(groundTruth('en_a'), result.text)).toBeLessThanOrEqual(1);
    },
    PAGE_TIMEOUT_MS
  );
});

describe('which languages are installed', () => {
  oracleTest(
    'reports each language of the table installed exactly when the tesseract command line lists it',
    ['tesseract'],
    () => {
      const listing = execFileSync(requireTesseract(), ['--list-langs'], { encoding: 'utf-8', timeout: REFERENCE_TIMEOUT_MS });
      const listed = new Set(
        listing
          .split('\n')
          .slice(1)
          .map((line) => line.trim())
      );
      const reported = listOcrLanguages();
      expect(reported.length).toBe(OCR_LANGUAGES.length);
      for (const entry of reported) expect(entry.installed, entry.traineddata).toBe(listed.has(entry.traineddata));
      expect(new Set(reported.map((entry) => entry.code)).size).toBe(reported.length);
      const english = reported.find((entry) => entry.traineddata === 'eng');
      expect(english).toMatchObject({ code: 'en', script: 'Latn', direction: 'ltr' });
    }
  );

  it('reads the directories once and keeps the answer until it is reset', () => {
    const first = installedTraineddata();
    expect(installedTraineddata()).toBe(first);
    resetInstalledTraineddata();
    expect(installedTraineddata()).not.toBe(first);
  });
});

describe('a language that is in the table but not installed', () => {
  oracleTest(
    'answers 503 and names the missing data, while an unknown code answers 400',
    ['tesseract'],
    async () => {
      const missing = OCR_LANGUAGES.find((language) => !installedTraineddata().has(language.traineddata));
      if (!missing) throw new OracleToolMissingError('tessdata', 'every language of the table is installed, so none can be missing');
      let thrown: unknown;
      try {
        await performOcr(fixtureImage('en_a', 'clean300'), missing.traineddata);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(OcrLanguageUnavailableError);
      expect((thrown as OcrLanguageUnavailableError).status).toBe(HTTP_SERVICE_UNAVAILABLE);
      expect((thrown as Error).message).toContain(`${missing.traineddata}.traineddata`);

      let unknown: unknown;
      try {
        await performOcr(fixtureImage('en_a', 'clean300'), 'klingon');
      } catch (err) {
        unknown = err;
      }
      expect((unknown as OcrLanguageUnavailableError).status).toBe(HTTP_BAD_REQUEST);
    },
    PAGE_TIMEOUT_MS
  );
});

describe('reading two languages in one request', () => {
  /** Letters of one script, in reading order. */
  const only = (text: string, script: 'Hangul' | 'Latin'): string => text.normalize('NFKC').replace(script === 'Hangul' ? /[^\p{Script=Hangul}]/gu : /[^\p{Script=Latin}0-9]/gu, '');

  /** Error of each script of `text` against the text drawn on the stacked pages (the Korean page also has digits). */
  const scriptErrors = (drawn: string, text: string): { english: number; korean: number } => ({
    english: characterErrorRatePercent(only(drawn, 'Latin'), only(text, 'Latin')),
    korean: characterErrorRatePercent(only(drawn, 'Hangul'), only(text, 'Hangul')),
  });

  const STACKS: ReadonlyArray<{ name: string; pages: readonly string[]; maxPercent: number }> = [
    { name: 'a Korean page over an English one', pages: ['ko_a', 'en_b'], maxPercent: MAX_MIXED_SCRIPT_CER_PERCENT },
    // The engine itself reads the Korean of this stack at 7.7%; the pipeline must do no worse than it.
    { name: 'an English page over a Korean one', pages: ['en_a', 'ko_a'], maxPercent: MAX_HARD_MIXED_SCRIPT_CER_PERCENT },
  ];

  for (const { name, pages, maxPercent } of STACKS) {
    oracleTest(
      `eng+kor reads ${name}: each script within ${maxPercent}% error and no worse than the command line`,
      ['tesseract'],
      async () => {
        const tessdataDir = requireTessdata('eng');
        requireTessdata('kor');
        if (!MAGICK_BINARY) throw new OracleToolMissingError('magick', 'ImageMagick is not installed');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-mixed-'));
        try {
          const mixed = path.join(dir, 'mixed.png');
          execFileSync(requireMagick(), [...pages.map((page) => fixturePath(page, 'clean300')), '-background', 'white', '-gravity', 'center', '-append', mixed], {
            timeout: REFERENCE_TIMEOUT_MS,
          });
          const drawn = pages.map((page) => groundTruth(page)).join('\n');
          const result = await performOcr(fs.readFileSync(mixed), 'eng+kor');
          expect(result.language).toBe('eng+kor');
          const ours = scriptErrors(drawn, result.text);
          const reference = scriptErrors(
            drawn,
            execFileSync(requireTesseract(), [mixed, 'stdout', '-l', 'eng+kor', '--tessdata-dir', tessdataDir, '--psm', '3', '--oem', '1'], {
              encoding: 'utf-8',
              timeout: REFERENCE_TIMEOUT_MS,
              env: { ...process.env, OMP_THREAD_LIMIT: '1' },
              stdio: ['ignore', 'pipe', 'ignore'],
            })
          );
          expect(ours.english, 'English share').toBeLessThanOrEqual(maxPercent);
          expect(ours.korean, 'Korean share').toBeLessThanOrEqual(maxPercent);
          expect(ours.english, 'English share against the command line').toBeLessThanOrEqual(reference.english);
          expect(ours.korean, 'Korean share against the command line').toBeLessThanOrEqual(reference.korean);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      PAGE_TIMEOUT_MS
    );
  }
});
