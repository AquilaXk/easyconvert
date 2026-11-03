import { describe, expect, it } from 'vitest';
import node_fs from 'node:fs';
import node_path from 'node:path';
import node_crypto from 'node:crypto';
import { parseCmapTable, parseFontToSfnt } from '../src/lib/conversions/font';

/**
 * OFL-1.1 clause 2 requires every copy of a font to carry the copyright notice and the licence text. The web image copies
 * `public/` (Dockerfile.web) and the server serves it, so the two texts live in `public/fonts/licenses/`: a client reads
 * them at `/fonts/licenses/` and an operator finds them in the image.
 */

const REPO_ROOT = process.cwd();
const LICENSE_DIR = node_path.join(REPO_ROOT, 'public', 'fonts', 'licenses');
const FONT_DIR = node_path.join(REPO_ROOT, 'src', 'app', 'fonts');
const LICENSE_HEADING = 'SIL OPEN FONT LICENSE Version 1.1';
const LICENSE_SECTIONS = ['PREAMBLE', 'DEFINITIONS', 'PERMISSION & CONDITIONS', 'TERMINATION', 'DISCLAIMER'];

const LICENCE = {
  file: 'Pretendard-OFL.txt',
  project: 'Pretendard',
  copyright: 'Copyright (c) 2021, Kil Hyung-jin (https://github.com/orioncactus/pretendard)',
};
/**
 * The two files the interface ships, cut from one source by scripts/subset-web-font.py. Each has a fixed budget: Latin is the
 * only file an English page loads (42,648 bytes on 2026-11-03), Hangul is loaded by a page that draws a syllable (73,120 on 2026-11-03).
 */
const FONT_FILES = {
  latin: { file: 'EasyConvertSans-latin.woff2', budgetBytes: 48 * 1024 },
  hangul: { file: 'EasyConvertSans-hangul.woff2', budgetBytes: 80 * 1024 },
} as const;
const CHECKSUMS_FILE = 'EasyConvertSans.sha256';
const FAMILY = 'EasyConvert Sans';

const fontBytes = (name: string) => node_fs.readFileSync(node_path.join(FONT_DIR, name));
const layoutSource = node_fs.readFileSync(node_path.join(REPO_ROOT, 'src', 'app', '[locale]', 'layout.tsx'), 'utf8');

/** The code points a served font file draws, read from the cmap inside its WOFF2 container. */
function drawnBy(name: string): Set<number> {
  const font = parseFontToSfnt(fontBytes(name), 'woff2', FAMILY);
  return new Set(parseCmapTable(font.tables.cmap.data).keys());
}

/** The code point ranges of the `unicode-range` descriptor the layout gives the Hangul face. */
function declaredHangulRanges(): Array<[number, number]> {
  const value = /unicode-range',\s*value:\s*'([^']+)'/.exec(layoutSource)?.[1] ?? '';
  return value.split(',').map((range) => {
    const [low, high = low] = range.trim().slice(2).split('-');
    return [parseInt(low, 16), parseInt(high, 16)];
  });
}

/** The texts the pages draw: the messages and the legal pages rendered from docs/legal. */
const LEGAL_DIR = node_path.join(REPO_ROOT, 'docs', 'legal');
const drawnTexts = [
  ...['ko', 'en'].map((locale) => node_path.join(REPO_ROOT, 'messages', `${locale}.json`)),
  ...node_fs.readdirSync(LEGAL_DIR).filter((name) => /\.(en|ko)\.md$/.test(name)).map((name) => node_path.join(LEGAL_DIR, name)),
];
const messageCodePoints = new Set(
  drawnTexts.flatMap((file) =>
    [...node_fs.readFileSync(file, 'utf8')].map((character) => character.codePointAt(0)!).filter((codePoint) => codePoint > 0x20 && codePoint !== 0x7f),
  ),
);
const inHangulRange = (codePoint: number) => declaredHangulRanges().some(([low, high]) => codePoint >= low && codePoint <= high);

describe('Served web fonts carry their OFL text', () => {
  it(`ships the ${LICENCE.project} licence beside the served fonts`, () => {
    for (const { file } of Object.values(FONT_FILES)) expect(node_fs.existsSync(node_path.join(FONT_DIR, file)), file).toBe(true);
    const licencePath = node_path.join(LICENSE_DIR, LICENCE.file);
    expect(node_fs.existsSync(licencePath), licencePath).toBe(true);
    const text = node_fs.readFileSync(licencePath, 'utf8');
    expect(text.startsWith(LICENCE.copyright)).toBe(true);
    expect(text).toContain(LICENSE_HEADING);
    for (const section of LICENSE_SECTIONS) expect(text, section).toContain(section);
  });

  it('is copied into the web image with the rest of public/', () => {
    const dockerfile = node_fs.readFileSync(node_path.join(REPO_ROOT, 'Dockerfile.web'), 'utf8');
    expect(dockerfile).toMatch(/COPY --from=webbuilder [^\n]*\/app\/public \.\/public/);
  });
});

describe('The two font files draw every character of the messages', () => {
  it('has Hangul in the Hangul file and every other character in the Latin file, so no heading mixes two faces', () => {
    const latin = drawnBy(FONT_FILES.latin.file);
    const hangul = drawnBy(FONT_FILES.hangul.file);
    const missing = [...messageCodePoints].filter((codePoint) => !(inHangulRange(codePoint) ? hangul : latin).has(codePoint));
    expect(missing.map((codePoint) => String.fromCodePoint(codePoint)), 'rerun scripts/subset-web-font.py').toEqual([]);
  });

  it('draws the language names of the switcher from the Latin file, so an English page never asks for the Hangul file', () => {
    const switcher = node_fs.readFileSync(node_path.join(REPO_ROOT, 'src', 'components', 'LanguageSwitcher.tsx'), 'utf8');
    const names = [...new Set((switcher.match(/[\u3131-\u318e\uac00-\ud7a3]/g) ?? []).map((character) => character.codePointAt(0)!))];
    expect(names.length).toBeGreaterThan(0);
    const latin = drawnBy(FONT_FILES.latin.file);
    expect(names.filter((codePoint) => !latin.has(codePoint)).map((codePoint) => String.fromCodePoint(codePoint))).toEqual([]);
  });

  it('keeps the Hangul file inside the unicode-range the layout declares, so the browser asks for it only to draw Hangul', () => {
    expect(declaredHangulRanges().length).toBeGreaterThan(0);
    const outside = [...drawnBy(FONT_FILES.hangul.file)].filter((codePoint) => !inHangulRange(codePoint));
    expect(outside).toEqual([]);
  });

  it('gives both files the family name EasyConvert Sans and a weight axis from 400 to 700', () => {
    for (const { file } of Object.values(FONT_FILES)) {
      const font = parseFontToSfnt(fontBytes(file), 'woff2', 'unnamed');
      expect(font.fontFamily, file).toBe(FAMILY);
      const fvar = font.tables.fvar.data;
      const [axisTag, min, , max] = [fvar.toString('latin1', 16, 20), fvar.readInt32BE(20) / 65536, fvar.readInt32BE(24) / 65536, fvar.readInt32BE(28) / 65536];
      expect([file, axisTag, min, max]).toEqual([file, 'wght', 400, 700]);
    }
  });

  it('preloads the Latin file only: the Hangul face is fetched on demand', () => {
    const calls = layoutSource.split('localFont(').slice(1);
    expect(calls).toHaveLength(2);
    const [latinCall, hangulCall] = calls;
    expect(latinCall).toContain(FONT_FILES.latin.file);
    expect(latinCall).not.toContain('preload: false');
    expect(hangulCall).toContain(FONT_FILES.hangul.file);
    expect(hangulCall).toContain('preload: false');
  });
});

describe('The font files stay within their budgets and match their recorded hashes', () => {
  it('ships exactly the two WOFF2 files, each within its size budget', () => {
    const files = node_fs.readdirSync(FONT_DIR).filter((name) => name.endsWith('.woff2')).sort();
    expect(files).toEqual(Object.values(FONT_FILES).map(({ file }) => file).sort());
    for (const { file, budgetBytes } of Object.values(FONT_FILES)) {
      const font = fontBytes(file);
      expect(font.length, file).toBeLessThanOrEqual(budgetBytes);
      expect(font.subarray(0, 4).toString('latin1'), file).toBe('wOF2');
    }
  });

  it('matches the sha256 the script recorded for each file, so a file is never replaced without its record', () => {
    const recorded = Object.fromEntries(
      node_fs.readFileSync(node_path.join(FONT_DIR, CHECKSUMS_FILE), 'utf8').trim().split('\n').map((line) => line.split(/\s+/).reverse() as [string, string]),
    );
    const actual = Object.fromEntries(Object.values(FONT_FILES).map(({ file }) => [file, node_crypto.createHash('sha256').update(fontBytes(file)).digest('hex')]));
    expect(actual).toEqual(recorded);
  });
});
