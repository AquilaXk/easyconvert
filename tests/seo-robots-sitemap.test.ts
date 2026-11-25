import { afterEach, describe, expect, it, vi } from 'vitest';
import robots from '../src/app/robots';
import sitemap from '../src/app/sitemap';

describe('Open Beta crawlability: robots.txt and localized sitemap.xml', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('allows public crawling, disallows API/account/dashboard/auth paths, and points to the public sitemap URL', () => {
    vi.stubEnv('APP_ORIGIN', 'https://convert.aquilaxk.site');
    const config = robots();
    expect(config.sitemap).toBe('https://convert.aquilaxk.site/sitemap.xml');

    const rules = Array.isArray(config.rules) ? config.rules : [config.rules];
    expect(rules).toHaveLength(1);
    expect(rules[0].userAgent).toBe('*');
    expect(rules[0].allow).toEqual(['/', '/api/og']);
    expect(rules[0].disallow).toEqual(
      expect.arrayContaining(['/api/', '/dashboard/', '/account/', '/auth/', '/ko/dashboard/', '/ko/account/', '/ko/auth/'])
    );
  });

  it('lists every canonical public EN and KO page with bidirectional hreflang alternates and excludes private or disabled routes', () => {
    vi.stubEnv('APP_ORIGIN', 'https://convert.aquilaxk.site');
    vi.stubEnv('CAPTURE_WEBSITE_ENABLED', undefined as unknown as string);
    const entries = sitemap();

    expect(entries.length).toBeGreaterThan(6000);
    expect(entries.length).toBeLessThan(50000);

    const urls = new Set(entries.map((e) => e.url));
    expect(urls.has('https://convert.aquilaxk.site/')).toBe(true);
    expect(urls.has('https://convert.aquilaxk.site/ko')).toBe(true);
    expect(urls.has('https://convert.aquilaxk.site/pdf-to-jpg')).toBe(true);
    expect(urls.has('https://convert.aquilaxk.site/ko/pdf-to-jpg')).toBe(true);
    expect(urls.has('https://convert.aquilaxk.site/pricing')).toBe(true);
    expect(urls.has('https://convert.aquilaxk.site/ko/pricing')).toBe(true);
    expect(urls.has('https://convert.aquilaxk.site/api-docs')).toBe(true);
    expect(urls.has('https://convert.aquilaxk.site/terms')).toBe(true);
    for (const captureSlug of ['save-website-as-pdf', 'website-png-screenshot', 'website-jpg-screenshot']) {
      expect(urls.has(`https://convert.aquilaxk.site/${captureSlug}`), captureSlug).toBe(true);
      expect(urls.has(`https://convert.aquilaxk.site/ko/${captureSlug}`), captureSlug).toBe(true);
    }
    for (const topic of ['quickstart', 'convert', 'jobs', 'uploads', 'downloads', 'formats', 'ocr-languages', 'archives', 'usage', 'errors']) {
      expect(urls.has(`https://convert.aquilaxk.site/api-docs/${topic}`), topic).toBe(true);
      expect(urls.has(`https://convert.aquilaxk.site/ko/api-docs/${topic}`), topic).toBe(true);
    }
    expect(urls.has('https://convert.aquilaxk.site/privacy')).toBe(true);

    // Non-canonical alias slugs (e.g. same-format pairjpeg-to-jpg -> jpeg-converter) and private routes never appear.
    for (const forbidden of [
      'https://convert.aquilaxk.site/jpeg-to-jpg',
      'https://convert.aquilaxk.site/dashboard',
      'https://convert.aquilaxk.site/dashboard/api-keys',
      'https://convert.aquilaxk.site/account',
      'https://convert.aquilaxk.site/auth',
    ]) {
      expect(urls.has(forbidden), forbidden).toBe(false);
    }

    const pdfToJpg = entries.find((e) => e.url === 'https://convert.aquilaxk.site/pdf-to-jpg');
    expect(pdfToJpg?.alternates?.languages).toEqual({
      en: 'https://convert.aquilaxk.site/pdf-to-jpg',
      ko: 'https://convert.aquilaxk.site/ko/pdf-to-jpg',
      'x-default': 'https://convert.aquilaxk.site/pdf-to-jpg',
    });

    const saveWebPdf = entries.find((e) => e.url === 'https://convert.aquilaxk.site/save-website-as-pdf');
    expect(saveWebPdf?.alternates?.languages).toEqual({
      en: 'https://convert.aquilaxk.site/save-website-as-pdf',
      ko: 'https://convert.aquilaxk.site/ko/save-website-as-pdf',
      'x-default': 'https://convert.aquilaxk.site/save-website-as-pdf',
    });
  });

  it('omits website capture routes in both locales when CAPTURE_WEBSITE_ENABLED is false or unrecognized, while keeping them when blank', () => {
    vi.stubEnv('APP_ORIGIN', 'https://convert.aquilaxk.site');
    const captureUrls = [
      'https://convert.aquilaxk.site/save-website-as-pdf',
      'https://convert.aquilaxk.site/ko/save-website-as-pdf',
      'https://convert.aquilaxk.site/website-png-screenshot',
      'https://convert.aquilaxk.site/ko/website-png-screenshot',
      'https://convert.aquilaxk.site/website-jpg-screenshot',
      'https://convert.aquilaxk.site/ko/website-jpg-screenshot',
    ];

    vi.stubEnv('CAPTURE_WEBSITE_ENABLED', '   ');
    const blankUrls = new Set(sitemap().map((e) => e.url));
    for (const url of captureUrls) expect(blankUrls.has(url), `blank ${url}`).toBe(true);

    for (const disabledValue of ['false', '0', 'on']) {
      vi.stubEnv('CAPTURE_WEBSITE_ENABLED', disabledValue);
      const disabledUrls = new Set(sitemap().map((e) => e.url));
      expect(disabledUrls.has('https://convert.aquilaxk.site/pdf-to-jpg')).toBe(true);
      for (const url of captureUrls) {
        expect(disabledUrls.has(url), `${disabledValue} ${url}`).toBe(false);
      }
    }
  });
});
