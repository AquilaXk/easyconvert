// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testMessages } from './helpers/intl-messages';
import { getAvailableTargetFormats } from '../src/lib/registry';
import { parseConverterSlug } from '../src/lib/slug-parser';

const push = vi.fn();
vi.mock('../src/i18n/navigation', () => ({
  useRouter: () => ({ push }),
}));

const { default: HomeFormatPicker } = await import('../src/components/workbench/HomeFormatPicker');

/** The format tiles of the home page: choosing a source and a target opens the page of that pair. */

let root: Root | undefined;

beforeEach(() => {
  push.mockClear();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 112, 120));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
});

afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(NextIntlClientProvider, { locale: 'en', messages: testMessages('en'), timeZone: 'UTC', children: createElement(HomeFormatPicker) }));
  await vi.waitFor(() => expect(host.querySelector('[data-testid=hero-target-format-btn]')).not.toBeNull());
  return host;
}

async function choose(button: Element, format: string) {
  (button as HTMLElement).click();
  const search = await vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>('dialog input[type=text]');
    expect(input).not.toBeNull();
    return input!;
  });
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, format);
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => expect(search.value).toBe(format));
  search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(document.querySelector('dialog input[type=text]')).toBeNull());
}

describe('the home page format picker', () => {
  it('starts on DOCX to PDF instead of two empty tiles, and opens no page for it', async () => {
    const host = await mount();
    expect(host.querySelector('[data-testid=hero-source-format-btn]')?.getAttribute('aria-label')).toBe('Source format DOCX');
    expect(host.querySelector('[data-testid=hero-target-format-btn]')?.getAttribute('aria-label')).toBe('Target format PDF');
    expect(push).not.toHaveBeenCalled();
  });

  it('opens the page of the pair once a source and a target are chosen', async () => {
    const host = await mount();
    await choose(host.querySelector('[data-testid=hero-source-format-btn]')!, 'pdf');
    await vi.waitFor(() => expect(host.querySelector('[data-testid=hero-source-format-btn]')?.getAttribute('aria-label')).toBe('Source format PDF'));
    expect(push).not.toHaveBeenCalled();
    await choose(host.querySelector('[data-testid=hero-target-format-btn]')!, 'docx');
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/pdf-to-docx'));
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('offers only the targets the registry converts the source to, so every pair it opens is a page', () => {
    const targets = getAvailableTargetFormats('pdf').map((format) => format.id);
    expect(targets).toContain('docx');
    for (const target of targets) expect(parseConverterSlug(`pdf-to-${target}`), `pdf-to-${target}`).not.toBeNull();
  });
});
