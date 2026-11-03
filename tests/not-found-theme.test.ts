// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NotFoundPageView from '../src/components/pages/NotFoundPageView';
import { testMessages } from './helpers/intl-messages';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => '/nonexistent-page-xyz',
}));

/**
 * The document of a 404 is rendered by the framework's error shell, where the theme script of the layout has not run, so the
 * page itself applies the theme the visitor chose (the toggle of the other pages stores it).
 */

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
  document.documentElement.classList.remove('dark');
  localStorage.clear();
});

async function mount(): Promise<void> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(NextIntlClientProvider, { locale: 'en', messages: testMessages('en'), timeZone: 'UTC', children: createElement(NotFoundPageView) }));
  });
}

describe('the 404 page follows the theme the visitor chose', () => {
  it('is dark for a visitor whose stored theme is dark', async () => {
    localStorage.setItem('theme', 'dark');
    await mount();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('is light for a visitor whose stored theme is light', async () => {
    localStorage.setItem('theme', 'light');
    await mount();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
