import { createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { expect, vi } from 'vitest';
import { testMessages, type TestLocale } from './intl-messages';
import { ANONYMOUS_DAILY_CONVERSIONS } from '../../src/lib/plan-limits';
import { parsedSlug } from './intl';

/**
 * A converter page driven in jsdom as a person drives it: mounted under the message provider, files dropped or pasted on it,
 * the format picker used by keyboard. A test file mocks `../src/i18n/navigation`, `Header` and `Footer` itself (vi.mock is
 * hoisted per file) and imports `ConverterPageView` after that.
 */

export interface MountedPage {
  host: HTMLElement;
  unmount: () => void;
}

let root: Root | undefined;

/** The browser parts jsdom lacks: layout, a resize observer and the session answer of an anonymous visitor. */
export function stubBrowser(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 112, 120));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 401 })));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
}

export function unmountPage(): void {
  root?.unmount();
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}

export async function mountElement(element: ReactNode, ready: string, locale: TestLocale = 'en'): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(NextIntlClientProvider, { locale, messages: testMessages(locale), timeZone: 'UTC' }, element));
  await vi.waitFor(() => expect(host.querySelector(ready)).not.toBeNull());
  return host;
}

export async function mountSlug(
  PageView: (props: { parsed: ReturnType<typeof parsedSlug>; dailyLimit: number }) => ReactNode,
  slug: string,
  locale: TestLocale = 'en'
): Promise<HTMLElement> {
  return mountElement(createElement(PageView as never, { parsed: parsedSlug(slug), dailyLimit: ANONYMOUS_DAILY_CONVERSIONS }), 'main h2, main h1', locale);
}

export function filesOf(files: File[]): FileList {
  return Object.assign([...files], { item: (index: number) => files[index] ?? null }) as unknown as FileList;
}

export function drop(host: HTMLElement, files: File[]): void {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: filesOf(files) } });
  host.querySelector('main h2')!.parentElement!.dispatchEvent(event);
}

export function paste(files: File[]): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files: filesOf(files) } });
  document.body.dispatchEvent(event);
}

/** Types into a text field the way a person does, so React sees the change. */
export function typeInto(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Opens the picker behind `button`, types `format` into its search and takes the first match with Enter. */
export async function choose(button: HTMLElement, format: string): Promise<void> {
  button.click();
  const search = await vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>('dialog input[type=text]');
    expect(input).not.toBeNull();
    return input!;
  });
  typeInto(search, format);
  await vi.waitFor(() => expect(search.value).toBe(format));
  search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(document.querySelector('dialog input[type=text]')).toBeNull());
}
