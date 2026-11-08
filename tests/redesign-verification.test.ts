import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createElement, type ComponentType } from 'react';
import { CATEGORY_WORDS, type CategoryWord } from '../src/lib/category-words';
import { parseConverterSlug } from '../src/lib/slug-parser';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import Header from '../src/components/Header';
import Footer from '../src/components/Footer';
import { HomeHero } from '../src/components/Hero';
import Features, { POPULAR_PAIRS_BY_CATEGORY } from '../src/components/Features';
import FormatSelector from '../src/components/FormatSelector';
import ConversionQueue from '../src/components/ConversionQueue';
import ConverterPageView from '../src/components/pages/ConverterPageView';
import HomePageView from '../src/components/pages/HomePageView';
import { FORMAT_NAME_ALIASES, isSameFormat } from '../src/lib/format-aliases';
import type { ConversionQueueItem } from '../src/lib/types';
import {
  allElements,
  attrOf,
  classTokens,
  headings,
  links,
  missingFrom,
  phrasesMissing,
  phrasesPresent,
  presentIn,
  renderDom,
  select,
  visibleText,
  type DomElement,
} from './helpers/rendered-dom';
import { parsedSlug, slugPageCopy, type TestLocale } from './helpers/intl';
import { testMessages } from './helpers/intl-messages';
import { ANONYMOUS_DAILY_CONVERSIONS } from '../src/lib/plan-limits';

/**
 * The redesign checks read what a visitor receives: each component is rendered to markup (react-dom/server), the
 * markup is parsed by parse5, and the assertions are about visible text, headings, link targets, ARIA attributes
 * and class tokens. Where behaviour cannot be observed in a server-side render (a drop handler, a window event),
 * the TypeScript compiler's parser reads the module's structure instead of a text search.
 */

const rootDir = path.resolve(__dirname, '..');
const sourcePath = (...parts: string[]) => path.join(rootDir, ...parts);

// The pages get the allowance from the constant, and the copy checks below write the 10 of entry 15 out by hand, as a visitor
// reads it: an oracle independent of src/lib/plan-limits.ts.
const renderSlug = (slug: string, locale: TestLocale = 'en') =>
  renderDom(createElement(ConverterPageView, { parsed: parsedSlug(slug), dailyLimit: ANONYMOUS_DAILY_CONVERSIONS }), locale);
const render = <P extends object>(component: ComponentType<P>, props: P) => renderDom(createElement(component, props));
const noop = () => undefined;
const hrefsOf = (root: DomElement) => links(root).map((l) => l.href);
const classAttr = (element: DomElement | undefined) => (element ? attrOf(element, 'class') : null);

const FOOTER_SECTION_HEADINGS = ['Company', 'Resources', 'Legal', 'Contact'];

describe('Redesign & Free Static Architecture Verification', () => {
  it('verifies obsolete pricing page route has been completely eliminated', () => {
    const pricingPagePath = sourcePath('src', 'app', 'pricing', 'page.tsx');
    expect(fs.existsSync(pricingPagePath)).toBe(false);
  });

  it('verifies obsolete api/v2 documentation page route has been completely eliminated', () => {
    const apiV2PagePath = sourcePath('src', 'app', 'api', 'v2', 'page.tsx');
    expect(fs.existsSync(apiV2PagePath)).toBe(false);
  });

  it('verifies the retired login and register routes and the AuthModal have been completely eliminated', () => {
    const loginPath = sourcePath('src', 'app', 'login');
    const registerPath = sourcePath('src', 'app', 'register');
    const authModalPath = sourcePath('src', 'components', 'AuthModal.tsx');
    expect(fs.existsSync(loginPath)).toBe(false);
    expect(fs.existsSync(registerPath)).toBe(false);
    expect(fs.existsSync(authModalPath)).toBe(false);
  });

  it('verifies Header uses root-relative anchor links to prevent dead links on subpages', () => {
    const header = render(Header, {});
    const hrefs = hrefsOf(header);

    expect(missingFrom(hrefs, ['/#format-catalog', '/api-docs'])).toEqual([]);
    // The dashboard is for a signed-in person; a visitor's header does not list it.
    expect(presentIn(hrefs, ['/dashboard'])).toEqual([]);
    // Bare fragments only resolve on the home page.
    expect(presentIn(hrefs, ['#format-catalog'])).toEqual([]);
  });

  it('verifies Header offers sign-in through /auth only, with no link to the retired login and register routes', () => {
    const header = render(Header, {});

    expect(links(header)).toEqual([
      { text: 'EasyConvert', href: '/' },
      { text: 'Formats', href: '/#format-catalog' },
      { text: 'API Docs', href: '/api-docs' },
      { text: 'Pricing', href: '/pricing' },
      { text: 'English', href: '/' },
      { text: '한국어', href: '/ko' },
      { text: 'Log in', href: '/auth' },
      { text: 'Sign up', href: '/auth?tab=register' },
    ]);
    expect(presentIn(hrefsOf(header), ['/login', '/register'])).toEqual([]);

    // Key controls: the brand mark, the Tools dropdown trigger, the theme toggle and the mobile menu trigger, all
    // collapsed in the initial render.
    const toolsTrigger = select(header, 'button', 'aria-haspopup', 'true');
    expect(toolsTrigger.map((b) => [visibleText(b), attrOf(b, 'aria-expanded')])).toEqual([['Tools', 'false']]);
    expect(select(header, 'button', 'aria-label', 'Switch to dark mode')).toHaveLength(1);
    const mobileMenu = select(header, 'button', 'aria-label', 'Open menu');
    expect(mobileMenu.map((b) => attrOf(b, 'aria-expanded'))).toEqual(['false']);
    expect(select(header, 'a', 'aria-label', 'EasyConvert Home')).toHaveLength(1);
  });

  it('verifies the subpage capture script only visits live routes, none of the retired auth routes', () => {
    const captureScriptPath = sourcePath('scripts', 'capture-all-subpages.mjs');
    const script = fs.readFileSync(captureScriptPath, 'utf-8');
    const captured = [...script.matchAll(/path: '([^']+)'/g)].map((m) => m[1]);

    expect(captured).toEqual(['/pdf-converter']);
    expect(presentIn(captured, ['/login', '/register'])).toEqual([]);
  });

  it('verifies Footer uses root-relative anchor links to prevent dead links on subpages', () => {
    const footer = render(Footer, {});
    const hrefs = hrefsOf(footer);

    expect(missingFrom(hrefs, ['/#format-catalog'])).toEqual([]);
    expect(presentIn(hrefs, ['#format-catalog'])).toEqual([]);
    // The pricing page lists the free plan's limits; the retired api links should not exist
    expect(missingFrom(hrefs, ['/pricing'])).toEqual([]);
    expect(hrefs.filter((href) => href.includes('/api/v2'))).toEqual([]);

    // Four columns of links, and no directory of conversions
    expect(headings(footer)).toEqual(FOOTER_SECTION_HEADINGS);
    expect(hrefs.filter((href) => /-to-|-converter$/.test(href))).toEqual([]);
    expect(presentIn(hrefs, ['/status', '/unit-converter'])).toEqual([]);

    // The copyright is the only line besides the links; the claim of the upload card is not repeated
    const text = visibleText(footer);
    expect(text).toMatch(/© 2026 EasyConvert(?!\.com)/);
    expect(text).not.toMatch(/Encrypted transfer/);
    expect(missingFrom(hrefs, ['/accessibility', '/api-docs', '/privacy', '/terms', '/contact'])).toEqual([]);
  });

  it('verifies the frequent conversions of every category are supported pairs, and the home page has no popular-conversion cards', () => {
    for (const pair of Object.values(POPULAR_PAIRS_BY_CATEGORY).flat()) {
      const srcDef = FORMAT_REGISTRY[pair.from];
      expect(srcDef, `Source format ${pair.from} should exist`).toBeDefined();
      expect(srcDef.targetFormats.includes(pair.to), `Source ${pair.from} should support target ${pair.to}`).toBe(true);
    }
    expect(select(renderHome(), 'nav', 'aria-label', 'Popular conversions')).toHaveLength(0);
  });

  it('verifies parseConverterSlug properly routes dynamic converter and informational paths', () => {
    const pdfToWord = parsedSlug('pdf-to-docx');
    expect(pdfToWord.isInfoPage).toBe(false);
    expect(pdfToWord.sourceFormat).toBe('pdf');
    expect(pdfToWord.targetFormat).toBe('docx');

    // The status and unit converter pages are gone: their slugs are no page.
    expect(['status', 'unit-converter', 'lbs-to-kg', 'kg-to-lbs', 'feet-to-meters', 'meters-to-feet'].map((slug) => parseConverterSlug(slug))).toEqual([null, null, null, null, null, null]);
  });

  it('verifies pair and category slugs resolve to registered formats', () => {
    const testCases = [
      { slug: 'mp4-to-gif', expectedSrc: 'mp4', expectedTgt: 'gif', expectedTitle: 'MP4 to GIF Converter' },
      { slug: 'mp4-to-mp3', expectedSrc: 'mp4', expectedTgt: 'mp3', expectedTitle: 'MP4 to MP3 Converter' },
      { slug: 'jpg-to-pdf', expectedSrc: 'jpg', expectedTgt: 'pdf', expectedTitle: 'JPG to PDF Converter' },
      { slug: 'pdf-to-docx', expectedSrc: 'pdf', expectedTgt: 'docx', expectedTitle: 'PDF to DOCX Converter' },
      { slug: 'docx-to-pdf', expectedSrc: 'docx', expectedTgt: 'pdf', expectedTitle: 'DOCX to PDF Converter' },
      { slug: 'cad-converter', expectedSrc: 'dxf', expectedTgt: 'any', expectedTitle: 'CAD Converter' },
      { slug: 'font-converter', expectedSrc: 'ttf', expectedTgt: 'any', expectedTitle: 'Font Converter' },
      { slug: 'vector-converter', expectedSrc: 'svg', expectedTgt: 'any', expectedTitle: 'Vector Converter' },
      { slug: 'presentation-converter', expectedSrc: 'pptx', expectedTgt: 'any', expectedTitle: 'Presentation Converter' },
      { slug: 'spreadsheet-converter', expectedSrc: 'xlsx', expectedTgt: 'any', expectedTitle: 'Spreadsheet Converter' },
      { slug: 'data-converter', expectedSrc: 'csv', expectedTgt: 'any', expectedTitle: 'Data Converter' },
    ];

    for (const tc of testCases) {
      const parsed = parsedSlug(tc.slug);
      expect(parsed.isInfoPage).toBe(false);
      expect(parsed.sourceFormat).toBe(tc.expectedSrc);
      expect(parsed.targetFormat).toBe(tc.expectedTgt);
      expect(slugPageCopy(tc.slug).title).toBe(tc.expectedTitle);

      const srcDef = FORMAT_REGISTRY[parsed.sourceFormat];
      expect(srcDef, `Format registry must define ${parsed.sourceFormat}`).toBeDefined();
    }
  });

  it('verifies the footer sets its links in four columns, none of them out in bold', () => {
    const footer = render(Footer, {});

    const columns = allElements(footer).filter((e) => e.tagName === 'h2').map((h) => visibleText(h));
    expect(columns).toEqual(FOOTER_SECTION_HEADINGS);
    expect(allElements(footer).filter((e) => e.tagName === 'a' && classTokens(e).has('font-bold'))).toEqual([]);
  });

  it('verifies Hero implements workbench architecture with Select File CTA and interactive format tiles', () => {
    const hero = renderHome();
    const text = visibleText(hero);

    const selectFile = select(hero, 'button').filter((b) => visibleText(b) === 'Select File');
    expect(selectFile).toHaveLength(1);
    expect(classAttr(selectFile[0])).toMatch(/\bbtn-primary\b/);
    expect(select(hero, 'button', 'aria-haspopup', 'menu').map((b) => attrOf(b, 'aria-label'))).toEqual(['More file sources']);
    expect(phrasesMissing(text, ['Select your file to convert', 'or drop your files here'])).toEqual([]);

    // The home page holds no row of trust claims and no format chips in the upload card, and no tiles that name a pair.
    expect(phrasesPresent(text, ['Encrypted transfers', 'No sign-up needed', 'What do you want to convert?'])).toEqual([]);
    expect(select(hero, 'button').filter((b) => attrOf(b, 'aria-label')?.endsWith(', choose a target') ?? false)).toHaveLength(0);
    // The home page's tiles start on DOCX to PDF: changing one chooses the pair whose page opens.
    expect(select(hero, 'button', 'data-testid', 'hero-source-format-btn').map((b) => attrOf(b, 'aria-label'))).toEqual(['Source format DOCX']);
    expect(select(hero, 'button', 'data-testid', 'hero-target-format-btn').map((b) => attrOf(b, 'aria-label'))).toEqual(['Target format PDF']);

    const pairPage = renderSlug('png-to-jpg');
    expect(select(pairPage, 'button', 'data-testid', 'hero-source-format-btn').map((b) => attrOf(b, 'aria-label'))).toEqual(['Source format PNG']);
    expect(select(pairPage, 'button', 'data-testid', 'hero-target-format-btn').map((b) => attrOf(b, 'aria-label'))).toEqual(['Target format JPG']);

    expect(phrasesPresent(text, ['Conversion Console', '292 Formats Supported'])).toEqual([]);
    expect(presentIn(classTokens(hero), ['animate-card-flip', 'animate-orbit-slow', 'animate-orbit-fast'])).toEqual([]);
  });

  it('verifies semantic design token alignment across FormatSelector and Features', () => {
    // The selector floats as a solid surface with the menu elevation; the directory rests on hairline rules without a box.
    const selector = classTokens(render(FormatSelector, {} as never));
    expect(missingFrom(selector, ['bg-surface', 'border-rule', 'shadow-elev-1'])).toEqual([]);

    const features = classTokens(render(Features, {} as never));
    expect(missingFrom(features, ['border-rule'])).toEqual([]);
    expect(presentIn(features, ['bg-surface', 'shadow-elev-1', 'shadow-elev-2'])).toEqual([]);
  });

  it('verifies converter pages carry no breadcrumb', () => {
    for (const slug of ['pdf-to-docx', 'pdf-converter', 'document-converter']) {
      expect(select(renderSlug(slug), 'nav', 'aria-label', 'Breadcrumb'), slug).toHaveLength(0);
    }
  });

  it('verifies a pair page holds its title, upload prompt, two format cards and no list of related conversions, and nothing that explains how to convert', () => {
    const main = select(renderSlug('pdf-to-docx'), 'main')[0];

    expect(headings(main)).toEqual([
      'PDF to DOCX Converter',
      'Select your file to convert',
      'PDF Portable Document Format',
      'DOCX Office Open XML Document',
    ]);
    expect(links(main).filter((link) => / to /.test(link.text))).toEqual([]);
    expect(links(main).filter((link) => link.text.endsWith(' Converter'))).toEqual([
      { text: 'PDF Converter', href: '/pdf-converter' },
      { text: 'DOCX Converter', href: '/docx-converter' },
    ]);
    expect(phrasesPresent(visibleText(main), ['Three steps', 'How to Convert', 'Specification', 'MIME', 'Frequently Asked', 'Pick a target format', 'Pick a source format', 'Choose an output format'])).toEqual([]);
  });

  it('verifies the home page holds the title, the upload card, the format directory, the security card, the API card and the quality card, and no steps, questions or link to them', () => {
    const home = renderDom(createElement(HomePageView, { dailyLimit: ANONYMOUS_DAILY_CONVERSIONS, apiOrigin: 'https://convert.example.test' }));
    const main = select(home, 'main')[0];

    const sections = allElements(main).filter((element) => element.tagName === 'h1' || element.tagName === 'h2');
    expect(sections.map(visibleText)).toEqual([
      'File Converter',
      'Select your file to convert',
      'Supported Format Directory',
      'Security & Data Handling',
      'REST API & Batch Workflows',
      'High-Quality Conversions',
    ]);
    const text = visibleText(main);
    expect(phrasesPresent(text, ['How Conversion Works', 'Frequently Asked', 'Add source files', 'Select an extension'])).toEqual([]);
    // The limits line under the upload card is the one place the home page states the allowance.
    expect(text).toContain('10 conversions a day');
    expect(allElements(home).filter((element) => attrOf(element, 'id') === 'how-it-works')).toEqual([]);
    expect(presentIn(hrefsOf(home), ['/#how-it-works'])).toEqual([]);
  });

  it('verifies a format page describes its one format without a link to itself, and a category page describes none', () => {
    const format = select(renderSlug('pdf-converter'), 'main')[0];
    expect(headings(format)).toEqual(['PDF Converter', 'Select your file to convert', 'PDF Portable Document Format', 'Convert from PDF', 'Convert to PDF']);
    expect(links(format).filter((link) => link.text.endsWith(' Converter'))).toEqual([]);

    const category = select(renderSlug('document-converter'), 'main')[0];
    expect(headings(category)).toEqual(['Document Converter', 'Select your file to convert', 'Converters for Documents']);
    expect(links(category).map((link) => link.href)).toContain('/docx-converter');
  });

  // The section of the format cards is named for a screen reader; it is the one place the cards are told from the headings around them.
  const CARDS_LABEL = { en: 'Formats', ko: '형식' } as const;
  const formatCards = (slug: string, locale: TestLocale = 'en') => {
    const [section] = select(select(renderSlug(slug, locale), 'main')[0], 'section', 'aria-label', CARDS_LABEL[locale]);
    return {
      exists: section !== undefined,
      names: section ? headings(section) : [],
      hrefs: section ? links(section).map((link) => link.href.replace(/^\/ko(?=\/)/, '')) : [],
    };
  };

  // The name on a card is the id of the page in capitals and the full name of the format; the registry's extension would read JPG for ULTRAHDR.
  const CARD_NAME: Readonly<Record<string, string>> = {
    raw: 'RAW Digital Camera RAW',
    ultrahdr: 'ULTRAHDR Ultra HDR JPEG',
    pdf: 'PDF Portable Document Format',
    alto: 'ALTO ALTO XML Document',
    docx: 'DOCX Office Open XML Document',
    svgfont: 'SVGFONT SVG Font Glyphs',
    webpvideo: 'WEBPVIDEO Animated WebP',
    jpeg: 'JPEG JPEG Continuous-Tone Photographic Image',
    jpg: 'JPG JPEG Continuous-Tone Photographic Image',
    jfif: 'JFIF JPEG File Interchange Format',
  };

  it.each(['en', 'ko'] as const)(
    'verifies each card names and links its format by the id of the page, not by the extension of the registry entry (%s)',
    (locale) => {
      for (const [slug, ids] of [['raw-to-ultrahdr', ['raw', 'ultrahdr']], ['pdf-to-alto', ['pdf', 'alto']], ['pdf-to-docx', ['pdf', 'docx']]] as const) {
        const { names, hrefs } = formatCards(slug, locale);
        expect(names, slug).toEqual(ids.map((id) => CARD_NAME[id]));
        expect(hrefs, slug).toEqual(ids.map((id) => `/${id}-converter`));
      }
      for (const id of ['ultrahdr', 'alto', 'svgfont', 'webpvideo']) {
        const { names, hrefs } = formatCards(`${id}-converter`, locale);
        expect(names, id).toEqual([CARD_NAME[id]]);
        expect(hrefs, id).toEqual([]);
      }
    }
  );

  // The category words are the categories of the registry; a category page lists its formats, not the card of one of them.
  const CATEGORY_WORD_LIST = Object.keys(CATEGORY_WORDS) as CategoryWord[];

  it.each(['en', 'ko'] as const)('verifies a slug that names a category shows no format card (%s)', (locale) => {
    expect(CATEGORY_WORD_LIST.length).toBeGreaterThan(0);
    for (const word of CATEGORY_WORD_LIST) {
      const slug = `${word}-converter`;
      expect(formatCards(slug, locale).exists, slug).toBe(false);
    }
  });

  // A pair of two names of one format converts nothing, so every part of the page (title, meta, tiles, card and
  // both lists) describes the one format the slug starts from, as the page of that format does.
  const ALIAS_PAIR_HEADINGS = {
    en: (name: string) => [`${name} Converter`, 'Select your file to convert', `Convert from ${name}`, `Convert to ${name}`],
    ko: (name: string) => [`${name} 변환기`, '변환할 파일을 선택해 주세요', `${name} 파일 변환`, `${name} 형식으로 변환`],
  } as const;
  const aliasPairSlugs = Object.entries(FORMAT_REGISTRY).flatMap(([source, { targetFormats }]) =>
    targetFormats.filter((target) => target !== source && isSameFormat(source, target)).map((target) => `${source}-to-${target}`)
  );

  it('verifies the slug parser reads a pair of two names of one format that the registry lists, or of a format and itself, as the page of its source', () => {
    for (const [slug, source] of [['jpeg-to-jpg', 'jpeg'], ['jfif-to-jpg', 'jfif'], ['tgz-to-tar.gz', 'tgz'], ['pdf-to-pdf', 'pdf']] as const) {
      expect(parseConverterSlug(slug), slug).toMatchObject({ sourceFormat: source, targetFormat: 'any', copy: { kind: 'format', name: { id: source } } });
    }
    expect(parseConverterSlug('jpeg-to-png')).toMatchObject({ sourceFormat: 'jpeg', targetFormat: 'png', copy: { kind: 'pair', src: 'jpeg', tgt: 'png' } });
  });

  it.each(['en', 'ko'] as const)('verifies the h1 and both list headings of jpeg-to-jpg and jfif-to-jpg name their one format (%s)', (locale) => {
    // No registry format converts to JFIF, so its page has no second list.
    for (const [slug, name, hasToList] of [['jpeg-to-jpg', 'JPEG', true], ['jfif-to-jpg', 'JFIF', false]] as const) {
      const [h1, prompt, from, to] = ALIAS_PAIR_HEADINGS[locale](name);
      const all = headings(select(renderSlug(slug, locale), 'main')[0]);
      expect(all, slug).toEqual([h1, prompt, CARD_NAME[name.toLowerCase()], from, ...(hasToList ? [to] : [])]);
    }
  });

  it.each(['en', 'ko'] as const)(
    'verifies each of the 14 pairs of two names of one format reads as the page of its source in the title, meta, cards and lists (%s)',
    (locale) => {
      expect(aliasPairSlugs).toHaveLength(14);
      for (const slug of aliasPairSlugs) {
        const formatSlug = `${slug.split('-to-')[0]}-converter`;
        const [alias, format] = [slug, formatSlug].map((name) => renderSlug(name, locale));
        expect(visibleText(alias), slug).toBe(visibleText(format));
        expect(hrefsOf(alias), slug).toEqual(hrefsOf(format));
        expect(headings(select(alias, 'main')[0]), slug).toEqual(headings(select(format, 'main')[0]));
        expect(formatCards(slug, locale), slug).toEqual(formatCards(formatSlug, locale));
        expect(formatCards(slug, locale).hrefs, slug).toEqual([]);
        expect(slugPageCopy(slug, locale), slug).toEqual(slugPageCopy(formatSlug, locale));
      }
    }
  );

  it('verifies a format is listed once among the related conversions', () => {
    const texts = links(select(renderSlug('png-converter'), 'main')[0]).map((link) => link.text);
    expect(texts.filter((text) => text === 'JPG to PNG')).toHaveLength(1);
    expect(texts.filter((text) => text === 'JPEG to PNG' || text === 'JFIF to PNG')).toEqual([]);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('verifies the related-conversion lists of a format page offer no conversion of a format to itself or to its other name', () => {
    const selfPairs = (slug: string, format: string, aliases: readonly string[]) => {
      const names = [format, ...aliases].map((name) => name.toUpperCase());
      return links(select(renderSlug(slug), 'main')[0])
        .filter((link) => names.some((from) => names.some((to) => link.text === `${from} to ${to}`)))
        .map((link) => link.text);
    };
    expect(selfPairs('pdf-converter', 'pdf', [])).toEqual([]);
    expect(selfPairs('mp3-converter', 'mp3', [])).toEqual([]);
    expect(selfPairs('jpg-converter', 'jpg', ['jpeg', 'jfif'])).toEqual([]);
    expect(selfPairs('jpeg-converter', 'jpeg', ['jpg'])).toEqual([]);
  });

  it('verifies a page with no ad network configured shows no ad frame and reserves no space for one', () => {
    for (const page of [renderSlug('pdf-to-docx'), renderSlug('about'), renderQueue('completed')]) {
      expect(select(page, 'aside', 'aria-label', 'Advertisement')).toHaveLength(0);
      expect(visibleText(page)).not.toMatch(/Advertisement|728 × 90|Leaderboard|Placement/);
      expect(allElements(page).filter((e) => /min-h-\[50px\]/.test(attrOf(e, 'class') ?? ''))).toEqual([]);
    }
  });

  it('verifies fake rating pills are purged and the real limits are stated once', () => {
    const page = renderSlug('pdf-to-docx');
    const text = visibleText(page);

    // Fake social proof and manufactured ratings must be purged completely
    expect(phrasesPresent(text, ['4.8 / 5.0', '14,200+ user ratings'])).toEqual([]);
    expect([...classTokens(page)].filter((token) => token.startsWith('rating-star-'))).toEqual([]);

    // The real limits are stated once, under the upload card, and no separate coloured strip repeats them
    expect(phrasesMissing(text, ['Up to 1 GB per file', '10 conversions a day', 'Files deleted automatically'])).toEqual([]);
    expect(phrasesPresent(text, ['Free, 10 server conversions a day', 'Encrypted Ephemeral Processing', 'Browser Edge & Isolated Worker Pipeline'])).toEqual([]);
  });

  it('verifies informational pages eliminate forgot-password and fake alert forms', () => {
    // No forgot-password page exists: the slug is no page, so no credential-reset controls are rendered.
    expect(parseConverterSlug('forgot-password')).toBeNull();

    // The contact page is a plain support contact: a mailto link, no form that would pretend to send a message
    const contact = renderSlug('contact');
    expect(links(contact).filter((l) => l.href.startsWith('mailto:')).map((l) => l.href)).toEqual([
      'mailto:support@aquilaxk.site',
      'mailto:support@aquilaxk.site?subject=Bug%20Report',
    ]);
  });

  it('names each other name of a format (JPEG for JPG, TIF for TIFF) after another format the registry has', () => {
    const pairs = Object.entries(FORMAT_NAME_ALIASES);
    expect(pairs.flat().filter((id) => !Object.hasOwn(FORMAT_REGISTRY, id))).toEqual([]);
    expect(pairs.filter(([alias, format]) => alias === format || Object.hasOwn(FORMAT_NAME_ALIASES, format))).toEqual([]);
  });

  it('verifies Dynamic Converter Page maintains clean dual-theme scaffold regardless of queue state', () => {
    for (const slug of ['pdf-to-docx', 'contact', 'about']) {
      const page = renderSlug(slug);
      const root = select(page, 'body')[0].childNodes.find((n): n is DomElement => 'tagName' in n);
      // The body paints the canvas colour of both themes, so the page root carries layout only and never covers it.
      expect(classAttr(root), slug).toBe('flex flex-col min-h-screen');
    }
  });

  it('verifies Dynamic Converter Page renders a full page for a category slug and for a pair', () => {
    for (const slug of ['video-converter', 'cad-converter', 'mp4-to-gif']) {
      const page = renderSlug(slug);
      expect(headings(page).filter((h) => h.length > 0).length, slug).toBeGreaterThan(5);
      expect(select(page, 'input').map((i) => attrOf(i, 'type')), slug).toEqual(['file']);
    }
    expect(headings(renderSlug('video-converter'))[0]).toBe('Video Converter');
    expect(headings(renderSlug('mp4-to-gif'))[0]).toBe('MP4 to GIF Converter');
  });

  it('verifies ConversionQueue eliminates duplicate fixed bottom bar and fake cloud storage options', () => {
    const queue = renderQueue();
    const text = visibleText(queue);

    // Must NOT have redundant fixed bottom bar causing duplicate CTA dock
    const fixedBottom = allElements(queue).filter((e) => {
      const tokens = (attrOf(e, 'class') ?? '').split(/\s+/);
      return tokens.includes('fixed') && tokens.includes('bottom-0');
    });
    expect(fixedBottom).toEqual([]);
    expect(phrasesMissing(text, ['1 file ready to convert'])).toEqual([]);

    // Must NOT have fake/dummy cloud storage options
    expect(phrasesPresent(text, ['From Google Drive', 'From Dropbox', 'From OneDrive'])).toEqual([]);

    // Must have the one attached conversion dock with Add more files and Convert CTA
    expect(select(queue, 'button').map((b) => visibleText(b)).filter((label) => /Add more files|^Convert$/.test(label))).toEqual([
      'Add more files',
      'Convert',
    ]);
  });

  it('verifies Hero and dynamic slug pages do not contain fake cloud storage options or claims', () => {
    const hero = visibleText(renderHome());
    expect(phrasesPresent(hero, ['From Google Drive', 'From Dropbox', 'From OneDrive'])).toEqual([]);

    const slugPage = visibleText(renderSlug('pdf-to-docx'));
    expect(phrasesPresent(slugPage, ['import from URLs or cloud storage', 'From Google Drive', 'From Dropbox'])).toEqual([]);
  });

  it('verifies ConversionQueue bottom dock has harmonious surface styling without stark dark navy light-mode block', () => {
    const queue = renderQueue();
    const tokens = classTokens(queue);

    // Must NOT have jarring dark navy background in light mode
    expect(presentIn(tokens, ['bg-[#1F2340]'])).toEqual([]);

    // The bar: a surface pinned to the bottom of the viewport while the queue scrolls, divided from the rows by a top rule
    const dock = allElements(queue).find((e) => attrOf(e, 'data-queue-bar') !== null);
    expect(missingFrom((classAttr(dock) ?? '').split(/\s+/), ['sticky', 'bottom-0', 'bg-surface', 'border-t', 'border-rule'])).toEqual([]);

    // "Add more files" is a secondary control on the canvas with a hairline border; the status uses the tertiary ink
    const addMore = select(queue, 'button').find((b) => visibleText(b) === 'Add more files');
    expect(missingFrom((classAttr(addMore) ?? '').split(/\s+/), ['border-rule', 'bg-canvas'])).toEqual([]);
    expect(missingFrom(tokens, ['text-ink-3'])).toEqual([]);

    // The primary Convert CTA; the bar stacks its parts on a phone and lays them in one line from a tablet up
    const convert = select(queue, 'button').find((b) => visibleText(b) === 'Convert');
    expect(missingFrom((classAttr(convert) ?? '').split(/\s+/), ['btn-primary'])).toEqual([]);
    expect(missingFrom(tokens, ['flex-col', 'md:flex-row'])).toEqual([]);
  });
});

/** One PDF, ready to be converted to DOCX, or already converted. */
function renderQueue(status: 'ready' | 'completed' = 'ready'): DomElement {
  const item: ConversionQueueItem = {
    id: 'item-1',
    file: new File(['%PDF-1.4'], 'report.pdf', { type: 'application/pdf' }),
    name: 'report.pdf',
    size: 2048,
    sourceFormat: 'pdf',
    targetFormat: 'docx',
    status,
    progress: 0,
    options: {},
  };
  return render(ConversionQueue, {
    items: [item],
    onRemoveItem: noop,
    onClearAll: noop,
    onUpdateTargetFormat: noop,
    onUpdateOptions: noop,
    onConvertAll: noop,
    onAddMoreFiles: noop,
    onImportFile: noop,
    onDownloadAllZip: noop,
    isConverting: false,
  });
}

/** The home page's hero with no files queued. */
function renderHome(): DomElement {
  return render(HomeHero, { onFilesSelected: noop, dailyLimit: ANONYMOUS_DAILY_CONVERSIONS });
}
