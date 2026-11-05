import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { testMessages, type TestLocale } from './helpers/intl-messages';

/**
 * The interface copy states only what the service does (entry 139, UI copy): most conversions run on the server and a
 * result is kept until the retention rule deletes it (entry 125), so no string may promise no storage, browser-only
 * processing or a quality nobody measured. The messages are checked as a page reads them, with the copy English takes
 * from the registry.
 */

const BANNED_CLAIMS: Readonly<Record<TestLocale, readonly RegExp[]>> = {
  en: [
    /directly in your browser/i,
    /client-side/i,
    /zero[ -]?(?:server|data|cloud|permanent)?[ -]?(?:storage|retention|uploads?)/i,
    /volatile memory|volatile buffer|transient in-memory|ephemeral (?:memory|processing)/i,
    /100% in-browser/i,
    /high[ -]precision|high[ -]fidelity|lossless rasteri[sz]ation|lossless visual quality|optimum visual fidelity/i,
    /instant calculation precision/i,
    /technical specifications covering|step-by-step guide/i,
    /x-zero-data-retention/i,
    /\bin[- ](?:browser )?memory\b|browser memory/i,
  ],
  ko: [
    /(?:보관|저장)하지 않아요/,
    /클라우드에는 (?:올리지|저장하지)/,
    /손실 없이 래스터화|화질 손실 없이/,
    /고음질로|정밀하게/,
    /휘발성/,
    /모든 처리를 브라우저에서/,
    /브라우저 메모리|메모리에서 (?:바로 )?처리/,
  ],
};

/**
 * Words that claim speed, accuracy, preservation, losslessness or sharpness for a conversion nobody measured. The messages
 * in `FORMAT_FACTS` state a property of a format or codec, not of the service ("FLAC (Lossless)", "preserves POSIX
 * permissions"), and are checked only against the claims above.
 */
const UNMEASURED_CLAIMS: Readonly<Record<TestLocale, readonly RegExp[]>> = {
  en: [
    /\baccurate(?:ly)?\b/i, /(?<![-\w])fast(?:er|est)?\b(?!-)/i, /\bprecise(?:ly)?\b/i, /\bpreserves\b|\bpreservation\b/i,
    /\blossless\b/i, /\bcrisp(?:ly)?\b/i,
  ],
  ko: [/정확하게|정확히/, /빠르게|빠르고/, /보존/, /무손실/, /선명/],
};

/** Each message that states a true property of a format or codec in one of the words above, by key. */
const FORMAT_FACTS: ReadonlySet<string> = new Set([
  'features.pairs.flac-mp3', 'options.audio.codecs.flac', 'status.components.pipeline-audio.description',
  'formatSpecs.flac.desc', 'formatSpecs.gif.desc', 'formatSpecs.m4a.desc', 'formatSpecs.png.desc', 'formatSpecs.svg.desc',
  'formatSpecs.webp.desc',
  'formatDescriptions.alac', 'formatDescriptions.ape', 'formatDescriptions.arc', 'formatDescriptions.flac', 'formatDescriptions.pdfa',
  'formatDescriptions.png', 'formatDescriptions.webp', 'formatDescriptions.zip', 'formatDescriptions.zstd',
]);

const HEADER_NAMES = /x-zero-(?:data-)?retention|x-storage-footprint/i;

function strings(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]];
  if (node && typeof node === 'object') return Object.entries(node).flatMap(([key, value]) => strings(value, prefix ? `${prefix}.${key}` : key));
  return [];
}

const claimsIn = (locale: TestLocale, key: string, text: string) =>
  BANNED_CLAIMS[locale].some((claim) => claim.test(text)) ||
  (!FORMAT_FACTS.has(key) && UNMEASURED_CLAIMS[locale].some((claim) => claim.test(text)));

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('the interface copy', () => {
  it.each(['en', 'ko'] as const)('in %s makes none of the retired claims about storage, browser-only processing, speed or quality', (locale) => {
    const hits = strings(testMessages(locale)).filter(([key, text]) => claimsIn(locale, key, text));
    expect(hits).toEqual([]);
  });

  it('lists only format facts that a message still states', () => {
    for (const locale of ['en', 'ko'] as const) {
      const keys = new Set(strings(testMessages(locale)).map(([key]) => key));
      expect([...FORMAT_FACTS].filter((key) => !keys.has(key)), locale).toEqual([]);
    }
  });

  it('is not sent as a retention or storage header by any code, since results are kept until the retention rule deletes them', () => {
    const src = path.resolve(__dirname, '..', 'src');
    const naming = sourceFiles(src).filter((file) => HEADER_NAMES.test(fs.readFileSync(file, 'utf8')));
    expect(naming.map((file) => path.relative(src, file))).toEqual([]);
  });

  it('catches each kind of retired claim it guards against, and not a format fact or a question', () => {
    expect(claimsIn('en', 'formatSpecs.csv.desc', 'Lossless conversion of every table')).toBe(true);
    const claims = {
      en: ['Converted directly in your browser.', 'Zero data retention guaranteed.', 'High-fidelity media transcoding.', '100% In-Browser Execution', 'X-Zero-Data-Retention: true', 'Fast, accurate file conversions.', 'Accurate image structure translation', 'Preserves container layout', 'Vector artwork preservation in PDF', 'Converts precisely.', 'Supported pairs run locally in browser memory.', 'Files are processed in-memory.', 'Standard lossless conversion parameters apply.', 'Crisp rasterized PNG graphic'],
      ko: ['파일은 보관하지 않아요.', '고음질로 인코딩해요.', '휘발성 메모리', '모든 처리를 브라우저에서 실행', '빠르고 정확하게 변환해요.', '구조를 정확하게 변환', '벡터 아트워크를 PDF로 보존', '빠르게 해결할게요.', '브라우저 메모리에서 바로 처리해요.', '기본 무손실 변환 설정이 적용돼요.', '선명한 PNG 이미지로 래스터화'],
    } as const;
    for (const locale of ['en', 'ko'] as const) {
      for (const sample of claims[locale]) expect(claimsIn(locale, 'converterPage.sample', sample), sample).toBe(true);
    }
    const notClaims = {
      en: [['converterPage.sample', 'Does converting PNG to JPG preserve layout and quality?'], ['features.sample', 'Breakfast menus and steadfast rules'], ['formatSpecs.mp4.desc', 'Supports fast-start web playback'], ['options.audio.codecs.flac', 'FLAC (Lossless)'], ['status.diagnostics.probes.memory-sandbox.name', 'Memory buffer check']],
      ko: [['unitConverter.referenceHeading', 'kg → lb 빠른 환산표'], ['formatDescriptions.pdfa', '장기 보존용으로 특화된 ISO 표준 PDF예요.'], ['status.diagnostics.probes.opfs.unsupported', 'Blob 메모리 스트리밍으로 처리']],
    } as const;
    for (const locale of ['en', 'ko'] as const) {
      for (const [key, sample] of notClaims[locale]) expect(claimsIn(locale, key, sample), sample).toBe(false);
    }
  });
});
