import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureCached } from '../bench/realworld/fetch';
import { readManifest } from '../bench/realworld/manifest';
import { convertFile } from '../src/lib/conversions';
import { extractTextFromDoc } from '../src/lib/conversions/office';
import { extractTextWithExternalPdftotext } from './helpers/differential-oracle';
import { normalizeWhitespace, sofficeConvert } from './helpers/soffice-office';
import { isStrictMode, skipWithoutTools } from './helpers/strict-skip';

/**
 * Real Word documents of the public-domain corpus (bench/realworld/manifest.json) whose text holds symbol-font characters
 * (Symbol, Wingdings and the like at U+F020-U+F0FF). Until the reader knew the font of a run, #750 showed each of them as
 * U+FFFD with a warning. The files are fetched, digest-checked and cached like the nightly corpus run does. Each entry names
 * a stretch of text that reads naturally only with the right character (an age limit "at least 18", a temperature in
 * degrees, a bullet before a list item); the expected stretches were read off the documents' own wording. The second
 * oracle is the office suite: the words around the symbols must be the words its own text export holds.
 */

const CACHE_DIR = path.join(os.homedir(), '.cache', 'easyconvert-realworld');
const CONVERSION_TIMEOUT_MS = 300_000;
const MIN_WORD_LENGTH = 4;
/** Share of the reader's words the office suite's text export may lack (it lays tables and text boxes out differently). */
const MAX_MISSING_SHARE = 0.02;
const PRIVATE_USE = /[\uE000-\uF8FF]/u;

const SYMBOL_DOCUMENTS: ReadonlyArray<{ id: string; expected: RegExp }> = [
  { id: 'govdocs1-000677.doc', expected: /~700\u00B0C/u },
  { id: 'govdocs1-001265.doc', expected: /Range:\s+\u00B1\s+20 m\/s/u },
  { id: 'govdocs1-002680.doc', expected: /\u03C6ch\(m\/Pa\)/u },
  { id: 'govdocs1-003636.doc', expected: /SADT\u2122 \(Structured Analysis/u },
  { id: 'govdocs1-004043.doc', expected: /angle of 60\u00B0 horizontal and 15\u00B0 vertical/u },
  { id: 'govdocs1-004053.doc', expected: /a width of 22 \u00B1 4 /u },
  { id: 'govdocs1-004428.doc', expected: /\u2022\s+Complete IS-800: NRP/u },
  { id: 'govdocs1-004564.doc', expected: /runout \u226410% of channel/u },
  { id: 'govdocs1-006247.doc', expected: /Age \u2265 18 years of age/u },
];

const toolsMissing = skipWithoutTools('soffice', 'pdftotext');

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

describe.skipIf(toolsMissing)('Word symbol-font characters in real corpus files', () => {
  for (const { id, expected } of SYMBOL_DOCUMENTS) {
    it(
      `${id}: maps every symbol character, converts to PDF without warnings and keeps the words the office suite reads`,
      async (ctx) => {
        const doc = await corpusFile(id);
        if (!doc) return ctx.skip();
        const text = extractTextFromDoc(doc);
        expect(text).toMatch(expected);
        expect(text).not.toMatch(PRIVATE_USE);
        expect(text).not.toContain('\uFFFD');

        const pdf = await convertFile(doc, 'doc', 'pdf', {}, id);
        expect(pdf.metadata?.warnings).toBeUndefined();
        const rendered = normalizeWhitespace(extractTextWithExternalPdftotext(pdf.buffer) ?? '');
        expect(rendered).toMatch(new RegExp(expected.source.replace(/\\s\+/g, '\\s+'), 'u'));

        const reference = new Set(wordsOf(sofficeConvert(doc, 'doc', 'txt:Text (encoded):UTF8', 'txt').toString('utf-8')));
        const ours = wordsOf(text);
        const missing = ours.filter((word) => !reference.has(word));
        expect({ sample: missing.slice(0, 10), withinLimit: missing.length <= ours.length * MAX_MISSING_SHARE }).toEqual({
          sample: missing.slice(0, 10),
          withinLimit: true,
        });
      },
      CONVERSION_TIMEOUT_MS
    );
  }
});
