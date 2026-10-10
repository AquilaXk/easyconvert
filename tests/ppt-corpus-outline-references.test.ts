import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureCached } from '../bench/realworld/fetch';
import { readManifest } from '../bench/realworld/manifest';
import { readPptSlides } from '../src/lib/conversions/office/ppt-reader';
import { requireOracleTool } from './helpers/differential-oracle';
import { sofficeConvert } from './helpers/soffice-office';
import { isStrictMode, skipWithoutTools } from './helpers/strict-skip';

/**
 * Real presentations of the public-domain corpus (bench/realworld/manifest.json) that the reader used to refuse with
 * "a shape refers to outline text 1, but the slide has 1" (#632). Each one has a slide whose first text header holds only
 * a slide-number field, so the body the shapes refer to is block 1. The files are fetched, digest-checked and cached
 * like the nightly corpus run does; the oracle is the office suite: its PDF render, read by pdftotext, must contain
 * every word the reader returns, and the page count must equal the slide count.
 */

const CORPUS_FILES = ['govdocs1-000133.ppt', 'govdocs1-000167.ppt', 'govdocs1-000296.ppt', 'govdocs1-000715.ppt'];
const CACHE_DIR = path.join(os.homedir(), '.cache', 'easyconvert-realworld');
const MIN_WORD_LENGTH = 4;
/** Share of the reader's words the render may lack. */
const MAX_UNRENDERED_SHARE = 0.02;
const CONVERSION_TIMEOUT_MS = 300_000;

const toolsMissing = skipWithoutTools('soffice', 'pdftotext', 'pdfinfo');

/** Letters and digits only: line wraps, hyphens and bullets differ between the two writers. */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= MIN_WORD_LENGTH);
}

async function corpusFile(id: string): Promise<Buffer | null> {
  const entry = readManifest().files.find((file) => file.id === id);
  if (!entry) throw new Error(`${id} is not in the corpus manifest`);
  try {
    return fs.readFileSync(await ensureCached(entry, CACHE_DIR));
  } catch (error) {
    // Offline: CI (ORACLE_STRICT_MODE=1) must fail by name; a developer machine skips.
    if (isStrictMode()) throw error;
    return null;
  }
}

describe.skipIf(toolsMissing)('PowerPoint outline references in real corpus files', () => {
  for (const id of CORPUS_FILES) {
    it(
      `${id}: the reader accepts every reference and returns only text the office suite renders`,
      async (ctx) => {
        const ppt = await corpusFile(id);
        if (!ppt) {
          if (isStrictMode()) throw new Error(`${id} could not be fetched`);
          return ctx.skip();
        }
        const slides = readPptSlides(ppt);
        const pdf = sofficeConvert(ppt, 'ppt', 'pdf', 'pdf');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-corpus-'));
        try {
          const pdfPath = path.join(dir, 'render.pdf');
          fs.writeFileSync(pdfPath, pdf);
          const pages = Number(
            /^Pages:\s+(\d+)/m.exec(
              execFileSync(requireOracleTool('pdfinfo'), [pdfPath], {
                encoding: 'utf-8',
              }),
            )?.[1],
          );
          const renderedText = execFileSync(requireOracleTool('pdftotext'), [pdfPath, '-'], {
            encoding: 'utf-8',
            maxBuffer: 64 * 1024 * 1024,
          });
          const rendered = new Set(wordsOf(renderedText));
          // A renderer may hyphenate or split a word across lines; the letters still follow each other.
          const squashed = renderedText.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
          const ours = wordsOf(slides.flatMap((slide) => slide.texts).join(' '));
          expect(slides).toHaveLength(pages);
          expect(ours.length).toBeGreaterThan(20);
          const missing = ours.filter((word) => !rendered.has(word) && !squashed.includes(word));
          // Renderers lay out overflowing text differently (a Linux render of govdocs1-000296 drops two lines of slide 2); a block
          // that was read from the wrong place would leave far more words than this unexplained.
          expect({ missing: missing.slice(0, 10), withinLimit: missing.length <= ours.length * MAX_UNRENDERED_SHARE }).toEqual({
            missing: missing.slice(0, 10),
            withinLimit: true,
          });
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      CONVERSION_TIMEOUT_MS,
    );
  }
});
