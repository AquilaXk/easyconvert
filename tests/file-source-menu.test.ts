// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FileSourceButton from '../src/components/workbench/FileSourceButton';
import { testMessages } from './helpers/intl-messages';

/**
 * The "more sources" menu of the file button, driven as the menu button pattern of the WAI-ARIA Authoring Practices
 * describes it: opening moves focus into the menu, the arrows, Home and End move within it, Escape and a choice return focus
 * to the button, and Tab or a pointer press outside closes it. A mouse press inside never closes it, in an engine that
 * blurs the focused item on that press as well.
 */

let root: Root | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.innerHTML = '';
});

async function mount(onPickDevice = vi.fn()) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
  const host = document.createElement('div');
  const after = document.createElement('button');
  after.textContent = 'after';
  document.body.append(host, after);
  root = createRoot(host);
  root.render(
    createElement(NextIntlClientProvider, {
      locale: 'en',
      messages: testMessages('en'),
      timeZone: 'UTC',
      children: createElement(FileSourceButton, { label: 'Select File', variant: 'primary', onPickDevice, onImportFile: vi.fn() }),
    })
  );
  await vi.waitFor(() => expect(host.querySelector('[aria-haspopup]')).not.toBeNull());
  const toggle = host.querySelector<HTMLButtonElement>('[aria-haspopup]')!;
  return { host, toggle, after, onPickDevice };
}

const items = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[role=menuitem]')];
const press = (key: string) =>
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

async function open(host: HTMLElement, toggle: HTMLButtonElement) {
  toggle.click();
  await vi.waitFor(() => expect(document.activeElement).toBe(items(host)[0]));
}

describe('the menu of more file sources', () => {
  it('moves focus to its first item when it opens, and the arrows, Home and End move within it', async () => {
    const { host, toggle } = await mount();
    await open(host, toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const [device, link] = items(host);
    expect(items(host).map((item) => item.tabIndex)).toEqual([-1, -1]);

    press('ArrowDown');
    await vi.waitFor(() => expect(document.activeElement).toBe(link));
    press('ArrowDown');
    await vi.waitFor(() => expect(document.activeElement).toBe(device));
    press('ArrowUp');
    await vi.waitFor(() => expect(document.activeElement).toBe(link));
    press('Home');
    await vi.waitFor(() => expect(document.activeElement).toBe(device));
    press('End');
    await vi.waitFor(() => expect(document.activeElement).toBe(link));
  });

  it('closes on Escape and returns focus to the button', async () => {
    const { host, toggle } = await mount();
    await open(host, toggle);
    press('Escape');
    await vi.waitFor(() => expect(items(host)).toEqual([]));
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes when a choice is made and returns focus to the button before the device picker opens', async () => {
    const { host, toggle, onPickDevice } = await mount();
    await open(host, toggle);
    items(host)[0].click();
    await vi.waitFor(() => expect(items(host)).toEqual([]));
    expect(document.activeElement).toBe(toggle);
    expect(onPickDevice).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Tab', 'leaves the browser to move focus on from the button', false],
    ['Shift+Tab', 'keeps focus on the button, the element before the menu', true],
  ] as const)('closes on %s with focus on the button first, and %s', async (_keys, _outcome, shiftKey) => {
    const { host, toggle } = await mount();
    await open(host, toggle);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(tab);
    expect(document.activeElement).toBe(toggle);
    await vi.waitFor(() => expect(items(host)).toEqual([]));
    expect(document.activeElement).toBe(toggle);
    expect(tab.defaultPrevented).toBe(shiftKey);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('stays open when a mouse press blurs its item without moving focus anywhere, as WebKit does, so the link item opens its dialog', async () => {
    const { host, toggle } = await mount();
    await open(host, toggle);
    items(host)[0].dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(items(host)).toHaveLength(2);
    items(host)[1].click();
    await vi.waitFor(() => expect(document.querySelector('dialog[aria-labelledby=url-import-heading]')).not.toBeNull());
  });

  it('keeps focus where it is when pressed with a mouse, so a press inside it never blurs its item', async () => {
    const { host, toggle } = await mount();
    await open(host, toggle);
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    items(host)[1].dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);
  });

  it('closes on a pointer press outside it', async () => {
    const { host, toggle, after } = await mount();
    await open(host, toggle);
    after.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await vi.waitFor(() => expect(items(host)).toEqual([]));
  });

  it('closes on Escape from the button, and Down on the button of an open menu moves focus into it', async () => {
    const { host, toggle } = await mount();
    await open(host, toggle);
    toggle.focus();
    press('ArrowDown');
    await vi.waitFor(() => expect(document.activeElement).toBe(items(host)[0]));
    toggle.focus();
    press('Escape');
    await vi.waitFor(() => expect(items(host)).toEqual([]));
    expect(document.activeElement).toBe(toggle);
  });
});
