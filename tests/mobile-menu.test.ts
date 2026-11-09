// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testMessages } from './helpers/intl-messages';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => Promise.resolve() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));

const { default: Header } = await import('../src/components/Header');

/** The mobile menu of the header, driven as a person does: opened from the menu button, then used with the keyboard. */

let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 401 })));
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function mountHeader(): Promise<HTMLButtonElement> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(NextIntlClientProvider, { locale: 'en', messages: testMessages('en'), timeZone: 'UTC', children: createElement(Header) }));
  });
  const button = document.querySelector<HTMLButtonElement>('button[aria-label="Open menu"]');
  if (!button) throw new Error('no menu button');
  return button;
}

async function openMenu(): Promise<{ button: HTMLButtonElement; sheet: HTMLDialogElement }> {
  const button = await mountHeader();
  button.focus();
  await act(async () => button.click());
  const sheet = document.querySelector('dialog');
  if (!sheet) throw new Error('the menu did not open');
  return { button, sheet };
}

const press = (target: Element, key: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });

const focusable = (sheet: HTMLElement) =>
  [...sheet.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), select, input')].filter((el) => !el.closest('[hidden]'));

describe('the mobile menu', () => {
  it('shows Log in and Sign up with the groups collapsed, not nine tools in a row', async () => {
    const { sheet } = await openMenu();
    const names = [...sheet.querySelectorAll('a')].map((link) => link.textContent);
    expect(names).toEqual(expect.arrayContaining(['Log in', 'Sign up', 'Pricing']));
    for (const group of sheet.querySelectorAll('button[aria-expanded]')) expect(group.getAttribute('aria-expanded')).toBe('false');
    expect(sheet.querySelector('#mobile-menu-tools')?.hasAttribute('hidden')).toBe(true);
    expect(focusable(sheet).filter((el) => el.getAttribute('href')?.endsWith('-converter'))).toEqual([]);
  });

  it('expands the Tools group on press', async () => {
    const { sheet } = await openMenu();
    const tools = [...sheet.querySelectorAll('button[aria-expanded]')].find((b) => b.textContent === 'Tools') as HTMLButtonElement;
    await act(async () => tools.click());
    expect(tools.getAttribute('aria-expanded')).toBe('true');
    expect(sheet.querySelector('#mobile-menu-tools')?.hasAttribute('hidden')).toBe(false);
    expect(sheet.querySelectorAll('#mobile-menu-tools a')).toHaveLength(16);
  });

  it('keeps Tab and Shift+Tab inside the sheet', async () => {
    const { sheet } = await openMenu();
    const items = focusable(sheet);
    const last = items[items.length - 1];
    last.focus();
    await press(last, 'Tab');
    expect(document.activeElement).toBe(items[0]);
    await press(items[0], 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('closes on Escape and returns focus to the menu button', async () => {
    const { button, sheet } = await openMenu();
    await press(sheet, 'Escape');
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('closes with the close button and returns focus to the menu button', async () => {
    const { button, sheet } = await openMenu();
    await act(async () => sheet.querySelector<HTMLButtonElement>('button[aria-label="Close menu"]')?.click());
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});

describe('the logo of the mobile menu', () => {
  it('links home, as the logo of the header does', async () => {
    const { sheet } = await openMenu();
    const home = sheet.querySelector<HTMLAnchorElement>('a[aria-label="EasyConvert Home"]');
    expect(home).not.toBeNull();
    expect(home!.getAttribute('href')).toBe(document.querySelector('header > div a[aria-label="EasyConvert Home"]')!.getAttribute('href'));
  });
});

describe('the Tools menu of the header', () => {
  const toolsButton = () => document.querySelector<HTMLButtonElement>('button[aria-haspopup=true]')!;
  const toolLinks = () => [...document.querySelectorAll<HTMLAnchorElement>('nav[aria-label] .grid a')];

  async function openTools() {
    await mountHeader();
    await act(async () => toolsButton().click());
    expect(toolLinks().length).toBeGreaterThan(0);
  }

  it('closes when Tab leaves its last item', async () => {
    await openTools();
    await act(async () => toolLinks().at(-1)!.focus());
    expect(toolsButton().getAttribute('aria-expanded')).toBe('true');
    // The next stop after the menu is the first link beside it.
    await act(async () => document.querySelector<HTMLAnchorElement>('nav[aria-label] > a')!.focus());
    expect(toolsButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('stays open while focus moves between its items', async () => {
    await openTools();
    await act(async () => toolLinks()[0].focus());
    await act(async () => toolLinks()[1].focus());
    expect(toolsButton().getAttribute('aria-expanded')).toBe('true');
  });

  it('gives focus back to its button when Escape closes it from an item', async () => {
    await openTools();
    await act(async () => toolLinks()[2].focus());
    await press(toolLinks()[2], 'Escape');
    expect(toolsButton().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toolsButton());
  });
});
