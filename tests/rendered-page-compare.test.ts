import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';
import { authorWithReferenceSuite, identifyImage, SLIDES } from './helpers/office-pair-fixtures';
import {
  expectPagesMatchReference,
  expectWordsOnReferencePages,
  MIN_PAGE_SSIM,
  pageSsim,
  renderReferencePages,
  wordRecall,
} from './helpers/rendered-page-compare';

/**
 * The page comparison used by the Office image tests must reject the faults those tests exist for: a blank page, pages
 * in the wrong order, a render at another resolution and a missing page, while two separate runs of the reference
 * pipeline stay above the threshold.
 */

const TOOLS = ['soffice', 'identify', 'pdftoppm', 'pdftotext', 'magick'] as const;
const TEST_TIMEOUT_MS = 180_000;

/** A white PNG of the size of `page`, drawn by ImageMagick at exactly that pixel size (ffmpeg's yuv420 source rounds an odd height down). */
function blankPageLike(page: Buffer): Buffer {
  const { width, height } = identifyImage(page, 'png');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blank-page-'));
  try {
    const file = path.join(dir, 'blank.png');
    execFileSync(requireOracleTool('magick'), ['-size', `${width}x${height}`, 'xc:white', file], { stdio: 'ignore' });
    return fs.readFileSync(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('rendered page comparison', () => {
  oracleTest(
    'two separate runs of the reference pipeline score identical pages and the authored words are on their slides',
    [...TOOLS],
    async () => {
      const first = renderReferencePages(authorWithReferenceSuite('ppt'), 'ppt', 'png');
      const second = renderReferencePages(authorWithReferenceSuite('ppt'), 'ppt', 'png');
      expect(first.pages).toHaveLength(SLIDES.length);
      first.pages.forEach((page, index) => expect(pageSsim(page, second.pages[index], 'png')).toBeGreaterThanOrEqual(MIN_PAGE_SSIM));
      expectPagesMatchReference('reference twice', first.pages, second.pages, 'png');
      expectWordsOnReferencePages('reference PDF', first.pageTexts, SLIDES);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a blank page, shuffled pages, another resolution and a missing page are all rejected',
    [...TOOLS],
    async () => {
      const input = authorWithReferenceSuite('ppt');
      const reference = renderReferencePages(input, 'ppt', 'png');
      const [first, second] = reference.pages;

      expect(() => expectPagesMatchReference('blank', [blankPageLike(first), second], reference.pages, 'png')).toThrow(/page 1 SSIM/);
      expect(() => expectPagesMatchReference('shuffled', [second, first], reference.pages, 'png')).toThrow(/SSIM|must resemble/);
      const lowResolution = renderReferencePages(input, 'ppt', 'png', 100);
      expect(() => expectPagesMatchReference('100 dpi', lowResolution.pages, reference.pages, 'png')).toThrow(/pixel size/);
      expect(() => expectPagesMatchReference('missing page', [first], reference.pages, 'png')).toThrow(/page count/);
      expect(() => expectWordsOnReferencePages('swapped text', [...reference.pageTexts].reverse(), SLIDES)).toThrow(/must carry/);
    },
    TEST_TIMEOUT_MS
  );

  it('word recall counts the authored words found in a text, ignoring case', () => {
    expect(wordRecall('Slide ONE title aloha beta', ['slide', 'one', 'title', 'alpha', 'beta'])).toBe(0.8);
    expect(wordRecall('', ['alpha'])).toBe(0);
  });
});
