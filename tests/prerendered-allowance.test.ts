import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANONYMOUS_DAILY_CREDITS } from '../src/lib/plan-limits';

vi.mock('next-intl/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl/server')>()),
  setRequestLocale: vi.fn(),
}));

import HomePage from '../src/app/[locale]/page';
import ConverterPage from '../src/app/[locale]/[slug]/page';

/**
 * The page modules read the anonymous allowance when they render. Every page renders per request (entry 370), so the server's
 * ANONYMOUS_DAILY_LIMIT is the number a page states and the image carries no copy of it.
 */

const english = <T extends Record<string, string> = Record<string, never>>(params = {} as T): Promise<{ locale: string } & T> =>
  Promise.resolve({ locale: 'en', ...params });

const PAGES: Array<[string, () => Promise<ReactElement>]> = [
  ['the home page', () => HomePage({ params: english() })],
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

  it.each(PAGES)('is the one the server enforces on %s: the configured limit, else the default', async (_name, render) => {
    vi.stubEnv('ANONYMOUS_DAILY_LIMIT', '30');
    expect(dailyLimitOf(await render())).toBe(30);

    vi.stubEnv('ANONYMOUS_DAILY_LIMIT', '');
    expect(dailyLimitOf(await render())).toBe(ANONYMOUS_DAILY_CREDITS);
  });
});
