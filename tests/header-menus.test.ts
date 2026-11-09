// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountElement, stubBrowser, unmountPage } from './helpers/mount-converter-page';

vi.mock('../src/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string | { pathname: string }; children: ReactNode }) =>
    createElement('a', { href: typeof href === 'string' ? href : href.pathname, ...rest }, children),
  usePathname: () => '/',
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  getPathname: () => '/',
}));

const { default: Header } = await import('../src/components/Header');

beforeEach(stubBrowser);
afterEach(unmountPage);

const toolsButton = () => document.querySelector<HTMLButtonElement>('button[aria-haspopup=true]')!;
const toolLinks = () => [...document.querySelectorAll<HTMLAnchorElement>('nav[aria-label] .grid a')];

async function openTools() {
  const host = await mountElement(createElement(Header), 'header');
  toolsButton().click();
  await vi.waitFor(() => expect(toolLinks().length).toBeGreaterThan(0));
  return host;
}

describe('the Tools menu of the header', () => {
  it('closes when Tab leaves its last item', async () => {
    const host = await openTools();
    const last = toolLinks().at(-1)!;
    last.focus();
    expect(toolsButton().getAttribute('aria-expanded')).toBe('true');
    // The next stop after the menu is the first link beside it.
    host.querySelector<HTMLAnchorElement>('nav[aria-label] > a')!.focus();
    await vi.waitFor(() => expect(toolsButton().getAttribute('aria-expanded')).toBe('false'));
  });

  it('stays open while focus moves between its items', async () => {
    await openTools();
    toolLinks()[0].focus();
    toolLinks()[1].focus();
    expect(toolsButton().getAttribute('aria-expanded')).toBe('true');
  });

  it('gives focus back to its button when Escape closes it from an item', async () => {
    await openTools();
    toolLinks()[2].focus();
    toolLinks()[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => expect(toolsButton().getAttribute('aria-expanded')).toBe('false'));
    expect(document.activeElement).toBe(toolsButton());
  });
});

describe('the mobile menu', () => {
  it('has its logo link home, as the header has', async () => {
    await mountElement(createElement(Header), 'header');
    document.querySelector<HTMLButtonElement>('button[aria-label="Open menu"]')!.click();
    const dialog = await vi.waitFor(() => {
      const element = document.querySelector('dialog');
      expect(element).not.toBeNull();
      return element!;
    });
    const home = dialog.querySelector<HTMLAnchorElement>('a[href="/"]');
    expect(home).not.toBeNull();
    expect(home!.getAttribute('aria-label')).toBe(document.querySelector('header > div a[href="/"]')!.getAttribute('aria-label'));
  });
});
