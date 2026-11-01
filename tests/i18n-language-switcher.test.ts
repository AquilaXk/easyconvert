import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => '/png-to-jpg',
  useSearchParams: () => new URLSearchParams('tab=register&error=oauth_denied'),
}));

import LanguageSwitcher from '../src/components/LanguageSwitcher';
import { links, renderDom } from './helpers/rendered-dom';

/** The language selector opens the same page, query included, in each language. */
describe('the language selector', () => {
  it('links the current page in every language and keeps its query', () => {
    expect(links(renderDom(createElement(LanguageSwitcher), 'en'))).toEqual([
      { text: 'English', href: '/png-to-jpg?tab=register&error=oauth_denied' },
      { text: '한국어', href: '/ko/png-to-jpg?tab=register&error=oauth_denied' },
    ]);
  });
});
