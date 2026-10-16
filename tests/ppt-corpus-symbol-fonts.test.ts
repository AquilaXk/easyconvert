import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureCached } from '../bench/realworld/fetch';
import { readManifest } from '../bench/realworld/manifest';
import { convertFile } from '../src/lib/conversions';
import { extractTextWithExternalPdftotext } from './helpers/differential-oracle';
import { normalizeWhitespace } from './helpers/soffice-office';
import { isStrictMode, skipWithoutTools } from './helpers/strict-skip';

/**
 * A real presentation of the public corpus (bench/realworld/manifest.json) whose second slide draws two Wingdings long
 * right arrows (U+1F87A) in "Réforme de la politique agricole ===🡺 PASA 🡺 PISA" and, further on, a line that starts with
 * a Wingdings arrow (U+1F86A, the next arrow of the font). Few installed fonts cover those arrows. A PDF is drawn with
 * installed fonts, so on a machine without one the arrow becomes U+FFFD and the conversion reports it instead of failing
 * the file (#760, follow-up to #726); with a covering font the arrow is drawn. Either way the file converts, and the PDF
 * text, read by pdftotext, says which happened: the warnings must agree with it.
 */

const CORPUS_FILE = 'office-slideshow-41246-2.ppt';
const CACHE_DIR = path.join(os.homedir(), '.cache', 'easyconvert-realworld');
const CONVERSION_TIMEOUT_MS = 300_000;
const LONG_RIGHT_ARROW = '\u{1F87A}';
const WARNING_LINE = /^Replaced U\+F0E8 of the font "Wingdings" with U\+FFFD: its character U\+1F87A has no glyph in the installed fonts\.$/;

const toolsMissing = skipWithoutTools('pdftotext');

async function corpusFile(): Promise<Buffer | null> {
  const entry = readManifest().files.find((file) => file.id === CORPUS_FILE);
  if (!entry) throw new Error(`${CORPUS_FILE} is not in the corpus manifest`);
  try {
    return fs.readFileSync(await ensureCached(entry, CACHE_DIR));
  } catch (error) {
    // Offline: CI (ORACLE_STRICT_MODE=1) must fail by name; a developer machine skips.
    if (isStrictMode()) throw error;
    return null;
  }
}

describe.skipIf(toolsMissing)('PowerPoint symbol-font characters in a real corpus file', () => {
  it(
    `${CORPUS_FILE}: converts to PDF and shows each arrow as drawn or as U+FFFD with a matching warning`,
    async (ctx) => {
      const ppt = await corpusFile();
      // skip-ok: corpusFile returns null only outside ORACLE_STRICT_MODE; under strict mode it throws.
      if (!ppt) return ctx.skip();
      const pdf = await convertFile(ppt, 'ppt', 'pdf', {}, CORPUS_FILE);
      const rendered = normalizeWhitespace(extractTextWithExternalPdftotext(pdf.buffer) ?? '');
      const line = /Réforme de la politique agricole ===(\S+) PASA (\S+) PISA \(1995\)/u.exec(rendered);
      expect(line).not.toBeNull();
      const [, first, second] = line as RegExpExecArray;
      const warnings = (pdf.metadata?.warnings as string[] | undefined) ?? [];
      const aboutLongArrow = warnings.filter((warning) => warning.includes('U+F0E8'));
      expect(second).toBe(first);
      if (first === LONG_RIGHT_ARROW) {
        // A font covers the arrow: it is drawn, and nothing about the arrow is reported.
        expect(aboutLongArrow).toEqual([]);
      } else {
        // No font covers it: U+FFFD stands in for both arrows and one line reports the code.
        expect(first).toBe('\uFFFD');
        expect(aboutLongArrow).toHaveLength(1);
        expect(aboutLongArrow[0]).toMatch(WARNING_LINE);
      }
      // The arrow of the line further on is another code (Wingdings 0xE0): the same rule applies to it on its own.
      const heavy = /^\s*(\S+) institutionnel\s*$/mu.exec(extractTextWithExternalPdftotext(pdf.buffer) ?? '');
      expect(heavy).not.toBeNull();
      expect(['\u{1F86A}', '\uFFFD']).toContain((heavy as RegExpExecArray)[1]);
      expect(warnings.some((warning) => warning.includes('U+F0E0'))).toBe((heavy as RegExpExecArray)[1] === '\uFFFD');

      const txt = await convertFile(ppt, 'ppt', 'txt', {}, CORPUS_FILE);
      expect(txt.buffer.toString('utf-8')).toContain('Réforme de la politique agricole ===\u{1F87A} PASA \u{1F87A} PISA (1995)');
      expect(txt.metadata?.warnings).toBeUndefined();
    },
    CONVERSION_TIMEOUT_MS
  );
});
