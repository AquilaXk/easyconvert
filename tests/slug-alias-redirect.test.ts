import { describe, expect, it, vi } from 'vitest';
import { getRedirectStatusCodeFromError, getURLFromRedirectError } from 'next/dist/client/components/redirect';
import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { isHTTPAccessFallbackError } from 'next/dist/client/components/http-access-fallback/http-access-fallback';
import ConverterPage from '../src/app/[locale]/[slug]/page';
import { FORMAT_NAME_ALIASES } from '../src/lib/format-aliases';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { aliasRedirectSlug, parseConverterSlug } from '../src/lib/slug-parser';

vi.mock('next-intl/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl/server')>()),
  setRequestLocale: () => undefined,
}));

async function outcome(locale: string, slug: string): Promise<unknown> {
  try {
    await ConverterPage({ params: Promise.resolve({ locale, slug }) });
  } catch (error) {
    return error;
  }
  return null;
}

describe('another name of a format redirects to the page of its canonical name', () => {
  it.each([
    ['pdf-to-word', 'pdf-to-docx'],
    ['word-to-pdf', 'docx-to-pdf'],
    ['heic-to-jpeg', 'heic-to-jpg'],
    ['PDF-to-Word', 'pdf-to-docx'],
  ])('%s -> %s', (slug, target) => {
    expect(aliasRedirectSlug(slug)).toBe(target);
  });

  it('answers 308 under the locale of the request', async () => {
    const en = await outcome('en', 'pdf-to-word');
    expect(isRedirectError(en)).toBe(true);
    expect(getURLFromRedirectError(en as never)).toBe('/pdf-to-docx');
    expect(getRedirectStatusCodeFromError(en as never)).toBe(308);

    const ko = await outcome('ko', 'heic-to-jpeg');
    expect(getURLFromRedirectError(ko as never)).toBe('/ko/heic-to-jpg');
  });

  it('keeps answering 404 for names that stand for no page', async () => {
    for (const slug of ['foo-to-bar', 'pdf-to-nonsense', 'jpg-to-jpeg', 'word-to-word', 'word-converter', 'a-to-b-to-c']) {
      expect(aliasRedirectSlug(slug), slug).toBeNull();
      expect(isHTTPAccessFallbackError(await outcome('en', slug)), slug).toBe(true);
    }
  });

  it('never lets a slug that is no page redirect to a slug that redirects again', () => {
    const names = [...new Set([...Object.keys(FORMAT_NAME_ALIASES), 'word', ...Object.keys(FORMAT_REGISTRY).slice(0, 40)])];
    for (const source of names) {
      for (const target of names) {
        const slug = `${source}-to-${target}`;
        const redirected = aliasRedirectSlug(slug);
        if (redirected === null || parseConverterSlug(slug)) continue;
        expect(aliasRedirectSlug(redirected), slug).toBeNull();
        expect(parseConverterSlug(redirected)?.canonicalPath).toBe(`/${redirected}`);
      }
    }
  });
});
