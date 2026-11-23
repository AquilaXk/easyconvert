import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureCached } from '../bench/realworld/fetch';
import { readManifest } from '../bench/realworld/manifest';
import { extractPdfDocument } from '../src/lib/conversions/pdf-text-document';
import { extractTextWithExternalPdftotext } from './helpers/differential-oracle';
import { isStrictMode, skipWithoutTools } from './helpers/strict-skip';

/**
 * Glyphs that pdf.js gives no Unicode value for, read from the real files of the public-domain corpus
 * (bench/realworld/manifest.json), fetched and digest-checked as the nightly corpus run does. The expected stretches are
 * what the pages show (the files were read in a viewer): the "SECTION 2" heading and the first sentence of
 * govdocs1-001389.pdf, whose CG Times glyph numbers pdf.js reads as `5'%6+10` and `6JG VCDNGU`; the units and relations
 * of the two papers whose MathematicalPi glyphs have catalogue names (`H9262` is the mu of "10.8 um"); the punctuation of a
 * dvips bitmap font whose glyphs are named `/.`, `/,` and `/(`.
 */

const CACHE_DIR = path.join(os.homedir(), '.cache', 'easyconvert-realworld');
const TIMEOUT_MS = 300_000;
/** Share of the digits and marks Poppler reads that the reader's text must hold (it holds 0.95 to 1.01 of each of them). */
const MIN_SHARE = 0.9;

const toolsMissing = skipWithoutTools('pdftotext');

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

/**
 * How often each of the digits and marks that this font's glyphs name occurs in `text` (leaving out `[`, which Poppler's
 * reader drops while EasyConvert now keeps it alongside `]`, `,`, `1`, and `4`).
 */
function countOf(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const character of text.match(/[0-9.,()\]]/g) ?? []) counts.set(character, (counts.get(character) ?? 0) + 1);
  return counts;
}

const DOCUMENTS: ReadonlyArray<{ id: string; expected: readonly RegExp[]; unmappedAtMost: number }> = [
  {
    id: 'govdocs1-001389.pdf',
    expected: [/^SECTION 2$/m, /The tables in this section summarize fiscal information of the federal government/, /AGENCY OBLIGATIONS FOR METEOROLOGICAL OPERATIONS/],
    unmappedAtMost: 0,
  },
  { id: 'govdocs1-000839.pdf', expected: [/time-domain \(FDTD\) program/, /0\.55 and 10\.8 μm/], unmappedAtMost: 20 },
  { id: 'govdocs1-004161.pdf', expected: [/0\.10 ± 0\.04 m Pa−1 with/, /highly correlated, ρ = 0\.7 in the observations/], unmappedAtMost: 2 },
  {
    id: 'govdocs1-004647.pdf',
    expected: [
      /Y\. Papaphilipp ?ou, C\. Gardner, R\. Lambiase, Y\.Y\. Lee, I\. Marneris and J\. Wei/,
      /March 21, 2001/,
      /Preliminary Change Request for the Low-field/,
      /and finally 1\.3GeV compatible/,
      /248m ring \[3 ?\], complementary studies/,
    ],
    unmappedAtMost: 25,
  },
];

describe('glyphs without a Unicode value in real corpus files', () => {
  for (const { id, expected, unmappedAtMost } of DOCUMENTS) {
    it(
      `${id}: reads the text the page shows and leaves out few glyphs`,
      async (ctx) => {
        const pdf = await corpusFile(id);
        // skip-ok: corpusFile returns null only outside ORACLE_STRICT_MODE; under strict mode it throws.
        if (!pdf) return ctx.skip();
        const document = await extractPdfDocument(pdf);
        for (const stretch of expected) expect(document.text).toMatch(stretch);
        const unmapped = document.pages.reduce((total, page) => total + page.unmappedGlyphs, 0);
        expect(unmapped).toBeLessThanOrEqual(unmappedAtMost);
      },
      TIMEOUT_MS
    );
  }

  it.skipIf(toolsMissing)(
    'govdocs1-004647.pdf: holds the digits and punctuation Poppler reads',
    async (ctx) => {
      const pdf = await corpusFile('govdocs1-004647.pdf');
      // skip-ok: corpusFile returns null only outside ORACLE_STRICT_MODE; under strict mode it throws.
      if (!pdf) return ctx.skip();
      const ours = countOf((await extractPdfDocument(pdf)).text);
      const reference = countOf(extractTextWithExternalPdftotext(pdf) ?? '');
      // The words themselves are not compared: the bitmap font's spacing splits some of them ("p owering") in both readers.
      for (const [character, count] of reference) expect({ character, ours: ours.get(character) ?? 0 }).toEqual({ character, ours: expect.toSatisfy((n: number) => n >= count * MIN_SHARE) });
    },
    TIMEOUT_MS
  );
});
