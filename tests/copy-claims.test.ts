import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import ko from '../messages/ko.json';

/**
 * The interface copy states only what the service does (entry 139, UI copy): most conversions run on the server and a
 * result is kept until the retention rule deletes it (entry 125), so no string may promise no storage, browser-only
 * processing or a quality nobody measured.
 */

const BANNED_CLAIMS: Readonly<Record<'en' | 'ko', readonly RegExp[]>> = {
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
  ],
  ko: [
    /(?:보관|저장)하지 않아요/,
    /클라우드에는 (?:올리지|저장하지)/,
    /손실 없이 래스터화|화질 손실 없이/,
    /고음질로|정밀하게/,
    /휘발성/,
    /모든 처리를 브라우저에서/,
  ],
};

function strings(node: unknown, path = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[path, node]];
  if (node && typeof node === 'object') return Object.entries(node).flatMap(([key, value]) => strings(value, path ? `${path}.${key}` : key));
  return [];
}

describe('the interface copy', () => {
  it.each([
    ['en', en],
    ['ko', ko],
  ] as const)('in %s makes none of the retired claims about storage, browser-only processing or quality', (locale, messages) => {
    const hits = strings(messages).filter(([, text]) => BANNED_CLAIMS[locale].some((claim) => claim.test(text)));
    expect(hits).toEqual([]);
  });

  it('is not sent as a zero-retention header by any route, since results are kept until the retention rule deletes them', () => {
    const routeFiles = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? routeFiles(full) : /\.tsx?$/.test(entry.name) ? [full] : [];
      });
    const app = path.resolve(__dirname, '..', 'src', 'app');
    const sending = routeFiles(app).filter((file) => /x-zero-data-retention/i.test(fs.readFileSync(file, 'utf8')));
    expect(sending.map((file) => path.relative(app, file))).toEqual([]);
  });

  it('catches each kind of retired claim it guards against', () => {
    const samples = {
      en: ['Converted directly in your browser.', 'Zero data retention guaranteed.', 'High-fidelity media transcoding.', '100% In-Browser Execution', 'X-Zero-Data-Retention: true'],
      ko: ['파일은 보관하지 않아요.', '고음질로 인코딩해요.', '휘발성 메모리', '모든 처리를 브라우저에서 실행'],
    } as const;
    for (const locale of ['en', 'ko'] as const) {
      for (const sample of samples[locale]) expect(BANNED_CLAIMS[locale].some((claim) => claim.test(sample)), sample).toBe(true);
    }
  });
});
