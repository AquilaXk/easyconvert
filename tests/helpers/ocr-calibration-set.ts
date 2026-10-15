import fs from 'node:fs';
import path from 'node:path';
import { addNoise, atDpi, blurred, fadedTo, type Degradation } from './ocr-degrade';

/**
 * The labelled pages the confidence calibration is fitted and scored on. Six paragraphs per
 * language were drawn once (tests/fixtures/ocr-calibration/generate_calibration.py); each is
 * degraded in several seeded ways. Pages `a`, `b` and `c` fit the tables and pages `d`, `e` and `f` are the
 * held-out half, so no word of the held-out half, and no text, has been seen by a fit.
 */

export const CALIBRATION_FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'ocr-calibration');

export type CalibrationLanguage = 'eng' | 'kor';

const PAGE_PREFIX: Record<CalibrationLanguage, string> = { eng: 'en', kor: 'ko' };

export const FIT_PAGE_LETTERS = ['a', 'b', 'c'] as const;
export const HELD_OUT_PAGE_LETTERS = ['d', 'e', 'f'] as const;
/** Noise seeds differ between the halves, so the held-out noise is not the fitted noise. */
export const FIT_SEED = 11;
export const HELD_OUT_SEED = 29;

const DPI_FOR_SCAN = 100;
const DPI_FOR_LOW_RESOLUTION = 60;
const BLUR_SIGMA = 3;
const NOISE_SIGMA = 30;
const HEAVY_NOISE_SIGMA = 40;
const FADED_CONTRAST = 0.45;
const FADED_NOISE_SIGMA = 20;

export const CALIBRATION_DEGRADATIONS: readonly Degradation[] = [
  { name: 'clean300', apply: async (png) => png },
  { name: 'dpi60', apply: (png) => atDpi(png, DPI_FOR_LOW_RESOLUTION) },
  { name: 'blur', apply: (png) => blurred(png, BLUR_SIGMA) },
  { name: 'noise-1', apply: (png, seed) => addNoise(png, NOISE_SIGMA, seed) },
  { name: 'noise-2', apply: (png, seed) => addNoise(png, NOISE_SIGMA, seed + 1) },
  { name: 'heavy-noise-1', apply: (png, seed) => addNoise(png, HEAVY_NOISE_SIGMA, seed) },
  { name: 'heavy-noise-2', apply: (png, seed) => addNoise(png, HEAVY_NOISE_SIGMA, seed + 1) },
  { name: 'faded', apply: async (png, seed) => addNoise(await fadedTo(png, FADED_CONTRAST), FADED_NOISE_SIGMA, seed) },
  { name: 'dpi100noise', apply: async (png, seed) => addNoise(await atDpi(png, DPI_FOR_SCAN), NOISE_SIGMA, seed) },
];

export function calibrationPageNames(language: CalibrationLanguage, letters: readonly string[]): string[] {
  return letters.map((letter) => `${PAGE_PREFIX[language]}_${letter}`);
}

export function calibrationPage(name: string): { png: Buffer; truth: string } {
  return {
    png: fs.readFileSync(path.join(CALIBRATION_FIXTURE_DIR, `${name}.png`)),
    truth: fs.readFileSync(path.join(CALIBRATION_FIXTURE_DIR, `${name}.gt.txt`), 'utf-8'),
  };
}
