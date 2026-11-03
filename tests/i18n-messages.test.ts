import { describe, expect, it } from 'vitest';
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { testMessages, type TestLocale } from './helpers/intl';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { FORMAT_SPECIFICATIONS } from '../src/components/converter/format-specs';
import { DIRECTORY_CATEGORIES, PRIMARY_LINKS, SECONDARY_LINKS, TOOL_ROUTES, type SiteLink } from '../src/components/site-links';
import { formatMessageKey } from '../src/i18n/message-keys';
import { routing } from '../src/i18n/routing';
import { completeMessages } from '../src/i18n/messages';
import en from '../messages/en.json';

/**
 * Every offered language carries every message, with the same arguments, and the Korean copy keeps one register (해요체)
 * and one set of terms. The messages are read as the server assembles them (`src/i18n/messages.ts`). English keeps its
 * format descriptions, format categories and unit names in the registry and the unit catalog, where the API reads them
 * too, so `en.json` has no `formatDescriptions`, `formatCategories`, `unitCategories` or `unitNames`; `ko.json` keeps its
 * translation of each. The key parity below therefore compares the assembled English with the Korean file.
 */

function leaves(tree: unknown, prefix = ''): Map<string, string> {
  const found = new Map<string, string>();
  if (typeof tree === 'string') {
    found.set(prefix, tree);
    return found;
  }
  for (const [key, value] of Object.entries(tree as Record<string, unknown>)) {
    for (const [path, text] of leaves(value, prefix ? `${prefix}.${key}` : key)) found.set(path, text);
  }
  return found;
}

const LOCALES = routing.locales as readonly TestLocale[];
const MESSAGES = new Map(LOCALES.map((locale) => [locale, leaves(testMessages(locale))]));
const english = MESSAGES.get('en')!;
const korean = MESSAGES.get('ko')!;

/** The argument names a message uses, with the parser next-intl's runtime formats it with. */
function argumentsOf(message: string): string[] {
  const names = new Set<string>();
  const visit = (elements: MessageFormatElement[]) => {
    for (const element of elements) {
      if ('value' in element && element.type !== TYPE.literal) names.add(String(element.value));
      if (element.type === TYPE.tag) visit(element.children);
      if (element.type === TYPE.select || element.type === TYPE.plural) {
        for (const option of Object.values(element.options)) visit(option.value);
      }
    }
  };
  visit(parse(message));
  return [...names].sort();
}

describe('the assembled messages', () => {
  it('are assembled once per messages file, not on every request', () => {
    expect(completeMessages('en', en)).toBe(completeMessages('en', en));
  });
});

describe('every language carries every message', () => {
  it('has the same keys in each locale', () => {
    for (const locale of LOCALES) {
      const keys = MESSAGES.get(locale)!;
      expect([...english.keys()].filter((key) => !keys.has(key)), `missing in ${locale}`).toEqual([]);
      expect([...keys.keys()].filter((key) => !english.has(key)), `only in ${locale}`).toEqual([]);
    }
  });

  it('has no empty message', () => {
    for (const [locale, keys] of MESSAGES) {
      expect([...keys].filter(([, text]) => text.trim() === '').map(([key]) => key), locale).toEqual([]);
    }
  });

  it('gives each message the same arguments in every locale, in valid ICU syntax', () => {
    const mismatched = [...english].flatMap(([key, text]) => {
      const expected = argumentsOf(text);
      return LOCALES.filter((locale) => {
        const translated = MESSAGES.get(locale)!.get(key);
        return translated !== undefined && argumentsOf(translated).join() !== expected.join();
      }).map((locale) => `${locale}:${key}`);
    });
    expect(mismatched).toEqual([]);
  });

  it('describes every registry format in Korean, and words every written dossier in both languages', () => {
    const ids = Object.keys(FORMAT_REGISTRY).map(formatMessageKey);
    expect(ids.filter((id) => !korean.has(`formatDescriptions.${id}`))).toEqual([]);
    for (const locale of LOCALES) {
      const specs = [...MESSAGES.get(locale)!.keys()].filter((key) => key.startsWith('formatSpecs.'));
      expect(new Set(specs.map((key) => key.split('.')[1]))).toEqual(new Set(Object.keys(FORMAT_SPECIFICATIONS)));
    }
  });

  it('labels every link of the site chrome', () => {
    const directoryLinks = DIRECTORY_CATEGORIES.flatMap((category): readonly SiteLink[] => category.links);
    const linkKeys = [...TOOL_ROUTES, ...PRIMARY_LINKS, ...SECONDARY_LINKS, ...directoryLinks].map(
      (link) => `siteLinks.${link.key}`
    );
    const categoryKeys = DIRECTORY_CATEGORIES.map((category) => `footer.categories.${category.key}`);
    for (const locale of LOCALES) {
      expect([...linkKeys, ...categoryKeys].filter((key) => !MESSAGES.get(locale)!.has(key)), locale).toEqual([]);
    }
  });
});

describe('the Korean copy keeps one register and one set of terms', () => {
  const koreanEntries = [...korean];

  it('uses 해요체, never 합니다체 or 하십시오체 endings', () => {
    const formal = /(?:니다|십시오|십시요|하소서)(?![가-힣])/;
    expect(koreanEntries.filter(([, text]) => formal.test(text)).map(([key]) => key)).toEqual([]);
  });

  it('carries no status code or protocol name in a sentence a person reads', () => {
    const protocolTerms = /HTTP\s*\d|\(HTTP|\bMIME\b|\bRBAC\b/;
    const developerPages = /^(?:apiDocs|dashboard\.keys|dashboard\.usage|dashboard\.guide|home\.api|formatSpecs|formatDescriptions)\./;
    expect(koreanEntries.filter(([key, text]) => !developerPages.test(key) && protocolTerms.test(text)).map(([key]) => key)).toEqual([]);
  });

  it('never leaves a particle hanging on an argument, whose last sound decides the particle', () => {
    const hangingParticle = /\}(?:은|는|이|가|을|를|과|와|으로|로)(?=[\s.,)]|$)/;
    expect(koreanEntries.filter(([, text]) => hangingParticle.test(text)).map(([key]) => key)).toEqual([]);
  });

  it('writes no alternating particle in parentheses, a machine translation tell', () => {
    expect(koreanEntries.filter(([, text]) => /\((?:이|가|을|를|은|는|과|와)\)/.test(text)).map(([key]) => key)).toEqual([]);
  });

  it('uses the glossary terms (형식, 변환기, 다운로드, 대기열, API 키, 동영상, 압축 파일)', () => {
    const offTerms = /포맷|컨버터|컨버트|다운받|다운 받|큐에|API키|에이피아이|비디오/;
    expect(koreanEntries.filter(([, text]) => offTerms.test(text)).map(([key]) => key)).toEqual([]);
  });

  it('calls an archive 압축 파일, keeping 아카이브 only in the name of a format that says so (tar, JAR, WAR, EAR)', () => {
    const namedArchive = /(?:tar|테이프|Java|웹 애플리케이션|엔터프라이즈) 아카이브/g;
    expect(koreanEntries.filter(([, text]) => text.replace(namedArchive, '').includes('아카이브')).map(([key]) => key)).toEqual([]);
  });

  it('points a conversion from one format to another with an arrow, so its direction reads (PNG → JPG 변환기)', () => {
    const pairWithoutArrow = /(?:[A-Z0-9][A-Za-z0-9.]*|\{\w+\}|이미지|동영상) (?:[A-Z0-9][A-Za-z0-9.]*|\{\w+\}) (?:단위 )?변환/;
    const pairs = koreanEntries.filter(([key]) => key !== 'slugPages.ocr.title');
    expect(pairs.filter(([, text]) => pairWithoutArrow.test(text)).map(([key]) => key)).toEqual([]);
    expect(korean.get('slugPages.pair.title')).toBe('{src} → {tgt} 변환기');
    expect(korean.get('hero.title.pair')).toBe('{src} → {tgt} 변환기');
  });
});
