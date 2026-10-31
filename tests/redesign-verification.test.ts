import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createElement, type ComponentType } from 'react';
import { parseConverterSlug } from '../src/lib/slug-parser';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { REGISTRY_STATS } from '../src/lib/registry-stats';
import Header from '../src/components/Header';
import Footer from '../src/components/Footer';
import Hero from '../src/components/Hero';
import Features from '../src/components/Features';
import FormatSelector from '../src/components/FormatSelector';
import FaqSection from '../src/components/FaqSection';
import StatusDashboard from '../src/components/StatusDashboard';
import AdBanner from '../src/components/AdBanner';
import ConversionQueue from '../src/components/ConversionQueue';
import DynamicConverterPage from '../src/app/[slug]/page';
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
import { callArguments, firstStringArguments, initializersOf, parseSource } from './helpers/ts-source';

/**
 * The redesign checks read what a visitor receives: each component is rendered to markup (react-dom/server), the
 * markup is parsed by parse5, and the assertions are about visible text, headings, link targets, ARIA attributes
 * and class tokens. Where behaviour cannot be observed in a server-side render (a drop handler, a window event),
 * the TypeScript compiler's parser reads the module's structure instead of a text search.
 */

const rootDir = path.resolve(__dirname, '..');
const sourcePath = (...parts: string[]) => path.join(rootDir, ...parts);

/** A resolved promise React's `use()` reads synchronously, standing in for the route's `params`. */
function slugParams(slug: string): Promise<{ slug: string }> {
  const value = { slug };
  const settled = Promise.resolve(value) as Promise<{ slug: string }> & { status: string; value: { slug: string } };
  settled.status = 'fulfilled';
  settled.value = value;
  return settled;
}

const renderSlug = (slug: string) => renderDom(createElement(DynamicConverterPage, { params: slugParams(slug) }));
const render = <P extends object>(component: ComponentType<P>, props: P) => renderDom(createElement(component, props));
const noop = () => undefined;
const hrefsOf = (root: DomElement) => links(root).map((l) => l.href);
const classAttr = (element: DomElement | undefined) => (element ? attrOf(element, 'class') : null);

const FOOTER_SECTION_HEADINGS = [
  'Video Converter',
  'Audio Converter',
  'Image Converter',
  'Document & Ebook',
  'Archive & Compression',
  'Data & Unit Tools',
  'Web Apps',
  'Client & Edge Tools',
];

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

    expect(missingFrom(hrefs, ['/#format-catalog', '/#how-it-works', '/api-docs', '/dashboard'])).toEqual([]);
    // Bare fragments only resolve on the home page.
    expect(presentIn(hrefs, ['#format-catalog', '#how-it-works'])).toEqual([]);
  });

  it('verifies Header offers sign-in through /auth only, with no link to the retired login and register routes', () => {
    const header = render(Header, {});

    expect(links(header)).toEqual([
      { text: 'EasyConvert', href: '/' },
      { text: 'Formats', href: '/#format-catalog' },
      { text: 'How It Works', href: '/#how-it-works' },
      { text: 'API Docs', href: '/api-docs' },
      { text: 'Dashboard', href: '/dashboard' },
      { text: 'Log In', href: '/auth' },
      { text: 'Sign Up', href: '/auth?tab=register' },
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

    expect(captured).toEqual(['/pdf-converter', '/unit-converter', '/status']);
    expect(presentIn(captured, ['/login', '/register'])).toEqual([]);
  });

  it('verifies Footer uses root-relative anchor links to prevent dead links on subpages', () => {
    const footer = render(Footer, {});
    const hrefs = hrefsOf(footer);

    expect(missingFrom(hrefs, ['/#format-catalog', '/#how-it-works'])).toEqual([]);
    expect(presentIn(hrefs, ['#format-catalog', '#how-it-works'])).toEqual([]);
    // Obsolete pricing and api links should not exist
    expect(hrefs.filter((href) => href.includes('/pricing') || href.includes('/api/v2'))).toEqual([]);

    // Categorized converter directory headings
    expect(headings(footer)).toEqual(FOOTER_SECTION_HEADINGS);

    // Key conversion routes
    expect(
      missingFrom(hrefs, ['/mp4-to-mp3', '/jpg-to-pdf', '/pdf-to-docx', '/video-to-gif', '/heic-to-jpg', '/rar-to-zip'])
    ).toEqual([]);

    // Privacy badge and copyright
    const text = visibleText(footer);
    expect(text).toMatch(/Encrypted Transfer & Ephemeral Processing/);
    expect(text).toMatch(/© 2026 EasyConvert\.com/);
    expect(missingFrom(hrefs, ['/accessibility', '/api-docs'])).toEqual([]);
  });

  it('verifies Terms of Service has no obsolete daily quotas or paid credits mentions', () => {
    const terms = renderSlug('terms');
    const text = visibleText(terms);

    expect(headings(terms).slice(0, 4)).toEqual([
      'Terms of Service',
      '1. Acceptance of Terms',
      '2. Acceptable Use',
      '3. Service Availability & Free Use',
    ]);
    expect(phrasesPresent(text, ['10 daily conversions', 'credits with prioritized throughput'])).toEqual([]);
    expect(phrasesMissing(text, ['100% free with unlimited conversions'])).toEqual([]);
  });

  it('verifies Hero synchronizes target format on paste, file selection, drop, and URL import', () => {
    const hero = parseSource(sourcePath('src', 'components', 'Hero.tsx'));
    const handlerCalls = callArguments(hero, 'onFilesSelected').filter((args) => args[1] === 'effectiveTarget');

    expect(handlerCalls).toEqual([
      ['files', 'effectiveTarget'],
      ['files', 'effectiveTarget'],
      ['files', 'effectiveTarget'],
      ['[file]', 'effectiveTarget'],
    ]);
    expect(initializersOf(hero, 'effectiveTarget')).toEqual([
      'getEffectiveTargetFormat(chosen, activeTargetFormat)',
      'getEffectiveTargetFormat(chosen, activeTargetFormat)',
      'getEffectiveTargetFormat(chosen, activeTargetFormat)',
      'getEffectiveTargetFormat(chosen, activeTargetFormat)',
    ]);
    expect(initializersOf(hero, 'chosen')).toEqual([
      'targetFormatRef.current',
      'targetFormatRef.current',
      'targetFormatRef.current',
      'targetFormatRef.current',
    ]);
    expect(initializersOf(hero, 'targetFormatRef')).toEqual(['useRef(targetFormat)']);
  });

  it('verifies all Hero popular presets specify supported formats in FORMAT_REGISTRY', () => {
    const popularPresets = [
      { label: 'PDF to Word', src: 'pdf', tgt: 'docx' },
      { label: 'Word to PDF', src: 'docx', tgt: 'pdf' },
      { label: 'Image to WebP', src: 'png', tgt: 'webp' },
      { label: 'Video to MP3', src: 'mp4', tgt: 'mp3' },
      { label: 'HEIC to JPG', src: 'heic', tgt: 'jpg' },
      { label: 'EPUB to PDF', src: 'epub', tgt: 'pdf' },
    ];

    for (const preset of popularPresets) {
      const srcDef = FORMAT_REGISTRY[preset.src];
      expect(srcDef, `Source format ${preset.src} should exist`).toBeDefined();
      expect(
        srcDef.targetFormats.includes(preset.tgt),
        `Source ${preset.src} should support target ${preset.tgt}`
      ).toBe(true);
    }

    const hero = render(Hero, { onFilesSelected: noop, hasActiveQueue: false });
    expect(visibleText(hero)).toMatch(/Popular PDF to Word Word to PDF Image to WebP Video to MP3 HEIC to JPG EPUB to PDF$/);
    expect(popularPresets.map((p) => p.label)).toEqual(['PDF to Word', 'Word to PDF', 'Image to WebP', 'Video to MP3', 'HEIC to JPG', 'EPUB to PDF']);
  });

  it('verifies parseConverterSlug properly routes dynamic converter and informational paths', () => {
    const pdfToWord = parseConverterSlug('pdf-to-docx');
    expect(pdfToWord.isInfoPage).toBe(false);
    expect(pdfToWord.sourceFormat).toBe('pdf');
    expect(pdfToWord.targetFormat).toBe('docx');

    const terms = parseConverterSlug('terms');
    expect(terms.isInfoPage).toBe(true);
    expect(terms.infoType).toBe('terms');

    const privacy = parseConverterSlug('privacy');
    expect(privacy.isInfoPage).toBe(true);
    expect(privacy.infoType).toBe('privacy');

    const status = parseConverterSlug('status');
    expect(status.isInfoPage).toBe(true);
    expect(status.infoType).toBe('status');
    expect(status.pageTitle).toBe('System Status');

    const unitConverter = parseConverterSlug('unit-converter');
    expect(unitConverter.isInfoPage).toBe(true);
    expect(unitConverter.infoType).toBe('unit');

    const lbsToKg = parseConverterSlug('lbs-to-kg');
    expect(lbsToKg.isInfoPage).toBe(true);
    expect(lbsToKg.infoType).toBe('unit');
    expect(lbsToKg.pageTitle).toMatch(/LBS to KG/);
  });

  it('verifies category and alias slugs resolve to registered canonical formats', () => {
    const testCases = [
      { slug: 'video-to-gif', expectedSrc: 'mp4', expectedTgt: 'gif', expectedTitle: 'Video to GIF Converter' },
      { slug: 'video-to-mp3', expectedSrc: 'mp4', expectedTgt: 'mp3', expectedTitle: 'Video to MP3 Converter' },
      { slug: 'image-to-pdf', expectedSrc: 'jpg', expectedTgt: 'pdf', expectedTitle: 'Image to PDF Converter' },
      { slug: 'pdf-to-word', expectedSrc: 'pdf', expectedTgt: 'docx', expectedTitle: 'PDF to Word Converter' },
      { slug: 'word-to-pdf', expectedSrc: 'docx', expectedTgt: 'pdf', expectedTitle: 'Word to PDF Converter' },
      { slug: 'cad-converter', expectedSrc: 'dxf', expectedTgt: 'any', expectedTitle: 'CAD Converter' },
      { slug: 'font-converter', expectedSrc: 'ttf', expectedTgt: 'any', expectedTitle: 'Font Converter' },
      { slug: 'vector-converter', expectedSrc: 'svg', expectedTgt: 'any', expectedTitle: 'Vector Converter' },
      { slug: 'presentation-converter', expectedSrc: 'pptx', expectedTgt: 'any', expectedTitle: 'Presentation Converter' },
      { slug: 'spreadsheet-converter', expectedSrc: 'xlsx', expectedTgt: 'any', expectedTitle: 'Spreadsheet Converter' },
      { slug: 'data-converter', expectedSrc: 'csv', expectedTgt: 'any', expectedTitle: 'Data Converter' },
    ];

    for (const tc of testCases) {
      const parsed = parseConverterSlug(tc.slug);
      expect(parsed.isInfoPage).toBe(false);
      expect(parsed.sourceFormat).toBe(tc.expectedSrc);
      expect(parsed.targetFormat).toBe(tc.expectedTgt);
      expect(parsed.pageTitle).toBe(tc.expectedTitle);

      const srcDef = FORMAT_REGISTRY[parsed.sourceFormat];
      expect(srcDef, `Format registry must define ${parsed.sourceFormat}`).toBeDefined();
    }
  });

  it('verifies footer directory grid uses balanced responsive layout with status link', () => {
    const footer = render(Footer, {});

    expect(links(footer).filter((l) => l.href === '/status')).toEqual([{ text: 'Status', href: '/status' }]);
    // Eight directory columns on a wide screen, halving down to two on a phone.
    const grids = allElements(footer).filter((e) => (attrOf(e, 'class') ?? '').split(/\s+/).includes('xl:grid-cols-8'));
    expect(grids.map((g) => classAttr(g))).toEqual([
      expect.stringContaining('grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-4 xl:grid-cols-8'),
    ]);
    expect(allElements(grids[0]).filter((e) => e.tagName === 'h2' || e.tagName === 'h3' || e.tagName === 'h4')).toHaveLength(FOOTER_SECTION_HEADINGS.length);

    const themeHookSource = parseSource(sourcePath('src', 'hooks', 'useThemeToggle.ts'));
    expect(firstStringArguments(themeHookSource, 'addEventListener')).toContain('easyconvert-theme-change');
    expect(firstStringArguments(themeHookSource, 'CustomEvent')).toEqual(['easyconvert-theme-change']);
  });

  it('verifies Hero implements workbench architecture with Select File CTA and interactive format tiles', () => {
    const hero = render(Hero, { onFilesSelected: noop, hasActiveQueue: false });
    const text = visibleText(hero);

    const selectFile = select(hero, 'button').filter((b) => visibleText(b) === 'Select File');
    expect(selectFile).toHaveLength(1);
    expect(classAttr(selectFile[0])).toMatch(/\bbg-brand-700\b/);
    expect(phrasesMissing(text, ['Select your file to convert', `${REGISTRY_STATS.formatCount} Formats Supported`, 'Popular'])).toEqual([]);
    expect(select(hero, 'button', 'data-testid', 'hero-source-format-btn')).toHaveLength(1);
    expect(select(hero, 'button', 'data-testid', 'hero-target-format-btn')).toHaveLength(1);

    expect(phrasesPresent(text, ['Conversion Console', '292 Formats Supported'])).toEqual([]);
    expect(presentIn(classTokens(hero), ['animate-card-flip', 'animate-orbit-slow', 'animate-orbit-fast', 'border-dashed'])).toEqual([]);
  });

  it('verifies semantic design token alignment across FormatSelector and Features', () => {
    const selector = classTokens(render(FormatSelector, {} as never));
    expect(missingFrom(selector, ['bg-white', 'dark:bg-dark-surface', 'border-neutral-border', 'dark:border-dark-border'])).toEqual([]);

    const features = classTokens(render(Features, {} as never));
    expect(missingFrom(features, ['bg-white', 'dark:bg-dark-surface', 'border-neutral-border', 'dark:border-dark-border'])).toEqual([]);
  });

  it('verifies Dynamic Converter Page implements dynamic breadcrumb navigation', () => {
    const page = renderSlug('pdf-to-docx');
    const breadcrumb = select(page, 'nav', 'aria-label', 'Breadcrumb');

    expect(breadcrumb).toHaveLength(1);
    // Home > category > source format > the pair; the last item is the current page.
    const items = allElements(breadcrumb[0]).filter((e) => e.tagName === 'li');
    expect(items.map((li) => [visibleText(li), attrOf(li, 'aria-current')])).toEqual([
      ['Home', null],
      ['Document', null],
      ['pdf Converter', null],
      ['pdf to docx', 'page'],
    ]);
    // A home icon, then a chevron between each pair of items.
    expect(select(breadcrumb[0], 'svg')).toHaveLength(4);
  });

  it('verifies Dynamic Converter Page implements 3-step visual conversion workflow', () => {
    const page = renderSlug('pdf-to-docx');
    const text = visibleText(page);

    expect(phrasesMissing(text, ['Step-by-Step Guide', 'How to Convert PDF to DOCX'])).toEqual([]);
    expect(headings(page).filter((h) => ['Upload PDF File(s)', 'Choose to DOCX', 'Download Your DOCX'].includes(h))).toEqual([
      'Upload PDF File(s)',
      'Choose to DOCX',
      'Download Your DOCX',
    ]);
    // The step numerals appear in order before their headings.
    expect(text.match(/\b0[123] (?:Upload PDF File\(s\)|Choose to DOCX|Download Your DOCX)/g)).toEqual([
      '01 Upload PDF File(s)',
      '02 Choose to DOCX',
      '03 Download Your DOCX',
    ]);
  });

  it('verifies Side-by-Side Format Specification Comparison Deck and technical dossier', () => {
    const page = renderSlug('pdf-to-docx');
    const text = visibleText(page);

    expect(phrasesMissing(text, ['Technical Specifications', 'PDF vs DOCX Specifications', 'SOURCE FORMAT'])).toEqual([]);
    expect(headings(page).filter((h) => /\((?:Portable Document Format|Microsoft Word Document)\)/.test(h))).toEqual([
      'PDF (Portable Document Format)',
      'DOCX (Microsoft Word Document)',
    ]);
    // Every dossier card lists the same fields for the source and the target.
    const fieldLabels = ['Full Name', 'Developer', 'MIME Type', 'Category'];
    for (const label of fieldLabels) {
      expect(text.split(label).length - 1).toBeGreaterThanOrEqual(2);
    }
    expect(phrasesMissing(text, ['Portable Document Format', 'application/pdf', 'Adobe Systems / ISO 32000'])).toEqual([]);
  });

  it('verifies top leaderboard ad unit has CLS protection container', () => {
    const page = renderSlug('pdf-to-docx');
    const leaderboard = select(page, 'aside', 'aria-label', 'Advertisement').find((aside) => /728 × 90 Leaderboard/.test(visibleText(aside)));
    expect(leaderboard).toBeDefined();

    // The reserved height lives on the wrapper element around the unit, so the layout does not shift when the ad loads.
    const wrapper = allElements(page).find(
      (e) => (attrOf(e, 'class') ?? '').includes('min-h-[50px] sm:min-h-[64px]') && allElements(e).includes(leaderboard as DomElement)
    );
    expect(wrapper).toBeDefined();
    expect(classAttr(wrapper)).toBe('w-full min-h-[50px] sm:min-h-[64px] flex items-center justify-center my-2');
  });

  it('verifies fake rating pills are purged and replaced with genuine client-side zero-retention guarantee', () => {
    const page = renderSlug('pdf-to-docx');
    const text = visibleText(page);

    // Fake social proof and manufactured ratings must be purged completely
    expect(phrasesPresent(text, ['4.8 / 5.0', '14,200+ user ratings'])).toEqual([]);
    expect([...classTokens(page)].filter((token) => token.startsWith('rating-star-'))).toEqual([]);

    // Genuine verifiable architecture guarantees must be present
    expect(phrasesMissing(text, ['100% Free & Unlimited', 'Encrypted Ephemeral Processing', 'Private & Secure', 'Browser Edge & Isolated Worker Pipeline'])).toEqual([]);
  });

  it('verifies AdBanner implements industry-standard publisher units and eliminates wireframe slop', () => {
    const slots = [
      ['top-leaderboard', '728 × 90 Leaderboard'],
      ['mid-content', '728 × 90 / 970 × 90 Responsive Banner'],
      ['in-feed', '728 × 90 In-Feed Placement'],
      ['post-conversion', '728 × 90 Display Placement'],
      ['sidebar', '300 × 250 Medium Rectangle'],
    ] as const;

    for (const [slot, dimensionLabel] of slots) {
      const banner = render(AdBanner, { slot });
      // Each unit is one labelled <aside> holding the standard "Advertisement" header and its IAB dimension label,
      // and nothing else: no fake feature or sponsor cards pretending to be ads.
      expect(select(banner, 'aside', 'aria-label', 'Advertisement')).toHaveLength(1);
      expect(visibleText(banner)).toBe(`Advertisement ${dimensionLabel}`);
      // Solid borders: no dashed wireframe box.
      expect(presentIn(classTokens(banner), ['border-dashed'])).toEqual([]);
      expect(select(banner, 'a')).toHaveLength(0);
    }
  });

  it('verifies StatusDashboard purges fake uptime stats, fake incident logs, and fake modals', () => {
    const dashboard = render(StatusDashboard, {} as never);
    const text = visibleText(dashboard);

    // Must NOT contain fake 99.99% claims, a made-up incident log or a subscription modal
    expect(phrasesPresent(text, ['99.99%', 'WebCodecs GPU Hardware Buffer Optimization', 'Subscribe to Status Updates'])).toEqual([]);
    expect(headings(dashboard).filter((h) => /incident/i.test(h))).toEqual([]);
    expect(select(dashboard, 'dialog')).toHaveLength(0);

    // Must contain genuine client edge telemetry and diagnostics
    expect(
      phrasesMissing(text, [
        'Run Edge Diagnostics',
        'SIMD WebAssembly Core Engine',
        'WebCodecs VPU Transcoding Accelerator',
        'Origin Private File System (OPFS)',
        'Zero Data Retention Ephemeral Memory Sandbox',
        '100% In-Browser Execution',
      ])
    ).toEqual([]);
  });

  it('verifies informational pages eliminate forgot-password and fake alert forms', () => {
    // No forgot-password page exists: the slug is an ordinary converter slug, so it renders the converter page and
    // none of the credential-reset controls.
    expect(parseConverterSlug('forgot-password').isInfoPage).toBe(false);
    const forgot = renderSlug('forgot-password');
    expect(select(forgot, 'form')).toHaveLength(0);
    expect(select(forgot, 'input').map((i) => attrOf(i, 'type'))).toEqual(['file']);

    // The contact page is a plain support contact: a mailto link, no form that would pretend to send a message
    const contact = renderSlug('contact');
    expect(links(contact).filter((l) => l.href.startsWith('mailto:')).map((l) => l.href)).toEqual([
      'mailto:support@easyconvert.com',
      'mailto:support@easyconvert.com?subject=Bug%20Report',
    ]);
    const alerts = callArguments(parseSource(sourcePath('src', 'app', '[slug]', 'page.tsx')), 'alert');
    expect(alerts).toEqual([]);
  });

  it('verifies category-aware dynamic descriptions in parseConverterSlug without AI slop', () => {
    // Video to Audio pair must not claim to preserve typography or document formatting
    expect(parseConverterSlug('mp4-to-mp3').pageDescription).toBe(
      'Convert MP4 to MP3 online and free. Extract clean, high-fidelity audio from video files directly in your browser with zero server storage.'
    );

    // Document pair preserves layout and typography
    expect(parseConverterSlug('pdf-to-docx').pageDescription).toBe(
      'Convert PDF to DOCX online and free. High-fidelity document conversion preserving layouts, formatting, and typography with zero server storage.'
    );

    // Format converters do not falsely claim to be document converters or mention external office software
    expect(parseConverterSlug('mp4-converter').pageDescription).toBe(
      'Convert MP4 video files online and free to MP4, WebM, AVI, and other media formats directly in your browser.'
    );
    expect(parseConverterSlug('svg-converter').pageDescription).toBe(
      'Convert SVG files online and free to PNG, JPG, WebP, SVG, and other graphic formats with lossless visual quality.'
    );
  });

  it('verifies FaqSection accordion conforms to WCAG accessibility standards', () => {
    const faq = render(FaqSection, {} as never);
    const triggers = select(faq, 'button').filter((b) => attrOf(b, 'aria-controls') !== null);

    // Five questions, each a button that controls its own answer region; only the open one is in the markup.
    expect(triggers.map((b) => attrOf(b, 'aria-controls'))).toEqual([0, 1, 2, 3, 4].map((i) => `faq-answer-${i}`));
    expect(triggers.map((b) => attrOf(b, 'aria-expanded'))).toEqual(['true', 'false', 'false', 'false', 'false']);
    const regions = select(faq, 'div', 'role', 'region');
    expect(regions.map((r) => attrOf(r, 'id'))).toEqual(['faq-answer-0']);
    expect(visibleText(regions[0])).toMatch(/^Yes, EasyConvert is completely free\./);
  });

  it('verifies Dynamic Converter Page maintains clean dual-theme scaffold regardless of queue state', () => {
    for (const slug of ['pdf-to-docx', 'terms', 'status', 'unit-converter']) {
      const page = renderSlug(slug);
      const root = select(page, 'body')[0].childNodes.find((n): n is DomElement => 'tagName' in n);
      expect(classAttr(root), slug).toBe('flex flex-col min-h-screen bg-neutral-scaffold dark:bg-dark-scaffold text-brand-950 dark:text-dark-text transition-colors');
    }
  });

  it('verifies Dynamic Converter Page handles category slugs and protects specification arrays', () => {
    // A category slug and a pair whose target has no specification entry both render a full page instead of failing
    // on a missing advantages array.
    for (const slug of ['video-converter', 'cad-converter', 'mp4-to-xyz']) {
      const page = renderSlug(slug);
      expect(headings(page).filter((h) => h.length > 0).length, slug).toBeGreaterThan(5);
      expect(select(page, 'input').map((i) => attrOf(i, 'type')), slug).toEqual(['file']);
    }
    expect(headings(renderSlug('video-converter'))[0]).toBe('Video Converter');
    expect(headings(renderSlug('mp4-to-xyz'))[0]).toBe('MP4 to XYZ Converter');
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
    expect(phrasesPresent(text, ['files ready'])).toEqual([]);

    // Must NOT have fake/dummy cloud storage options
    expect(phrasesPresent(text, ['From Google Drive', 'From Dropbox', 'From OneDrive'])).toEqual([]);

    // Must have the one attached conversion dock with Add more files and Convert CTA
    expect(select(queue, 'button').map((b) => visibleText(b)).filter((label) => /Add more files|^Convert$/.test(label))).toEqual([
      '+ Add more files',
      'Convert',
    ]);
  });

  it('verifies Hero and dynamic slug pages do not contain fake cloud storage options or claims', () => {
    const hero = visibleText(render(Hero, { onFilesSelected: noop, hasActiveQueue: false }));
    expect(phrasesPresent(hero, ['From Google Drive', 'From Dropbox', 'From OneDrive'])).toEqual([]);

    const slugPage = visibleText(renderSlug('pdf-to-docx'));
    expect(phrasesPresent(slugPage, ['import from URLs or cloud storage', 'From Google Drive', 'From Dropbox'])).toEqual([]);
  });

  it('verifies ConversionQueue bottom dock has harmonious surface styling without stark dark navy light-mode block', () => {
    const queue = renderQueue();
    const tokens = classTokens(queue);

    // Must NOT have jarring dark navy background in light mode
    expect(presentIn(tokens, ['bg-[#1F2340]'])).toEqual([]);

    // The dock: subtle light surface with its dark-mode surface, a rounded bottom edge and a top rule
    const dock = allElements(queue).find((e) => (attrOf(e, 'class') ?? '').split(/\s+/).includes('bg-neutral-subtle') && (attrOf(e, 'class') ?? '').includes('rounded-b-xl'));
    expect(classAttr(dock)).toMatch(/dark:bg-\[#121629\]/);

    // Tactile "Add more files" button and legible helper text tokens
    const addMore = select(queue, 'button').find((b) => visibleText(b) === '+ Add more files');
    expect(missingFrom((classAttr(addMore) ?? '').split(/\s+/), ['border-neutral-300', 'dark:border-[#2C3452]'])).toEqual([]);
    expect(missingFrom(tokens, ['text-ink-secondary', 'dark:text-neutral-300'])).toEqual([]);

    // Prominent brand.700 Convert CTA and responsive layout classes preventing mobile overflow
    const convert = select(queue, 'button').find((b) => visibleText(b) === 'Convert');
    expect(missingFrom((classAttr(convert) ?? '').split(/\s+/), ['bg-brand-700', 'hover:bg-brand-800', 'active:bg-brand-900'])).toEqual([]);
    expect(missingFrom(tokens, ['flex-wrap', 'sm:flex-nowrap'])).toEqual([]);
  });
});

/** One PDF, ready to be converted to DOCX. */
function renderQueue(): DomElement {
  const item: ConversionQueueItem = {
    id: 'item-1',
    file: new File(['%PDF-1.4'], 'report.pdf', { type: 'application/pdf' }),
    name: 'report.pdf',
    size: 2048,
    sourceFormat: 'pdf',
    targetFormat: 'docx',
    status: 'ready',
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
    onConvertSingle: noop,
    onAddMoreFiles: noop,
    onDownloadAllZip: noop,
    isConverting: false,
  });
}
