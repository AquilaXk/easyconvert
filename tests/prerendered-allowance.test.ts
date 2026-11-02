import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl/server')>()),
  setRequestLocale: vi.fn(),
}));

import HomePage from '../src/app/[locale]/page';
import UnitConverterPage from '../src/app/[locale]/unit-converter/page';
import ConverterPage from '../src/app/[locale]/[slug]/page';

/**
 * The page modules read the anonymous allowance when they render, which for the prerendered home and unit converter pages
 * is `next build`; the image passes ANONYMOUS_DAILY_LIMIT to the build for that reason (Dockerfile.web).
 */

const english = (params: Record<string, string> = {}) => Promise.resolve({ locale: 'en', ...params });

const PAGES: Array<[string, () => Promise<ReactElement>]> = [
  ['the home page', () => HomePage({ params: english() })],
  ['the unit converter page', () => UnitConverterPage({ params: english() })],
  ['a converter page', () => ConverterPage({ params: english({ slug: 'pdf-to-docx' }) })],
];

/** The allowance a page hands its view: the `dailyLimit` of the view inside the page's message provider. */
function dailyLimitOf(page: ReactElement): unknown {
  return (page.props as { children: ReactElement<{ dailyLimit?: unknown }> }).children.props.dailyLimit;
}

describe('the allowance a page states', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(PAGES)('is the one the server enforces on %s: the configured limit, else 25', async (_name, render) => {
    vi.stubEnv('ANONYMOUS_DAILY_LIMIT', '30');
    expect(dailyLimitOf(await render())).toBe(30);

    vi.stubEnv('ANONYMOUS_DAILY_LIMIT', '');
    expect(dailyLimitOf(await render())).toBe(25);
  });
});
