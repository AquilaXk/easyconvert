// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FileSourceButton from '../src/components/workbench/FileSourceButton';
import { testMessages } from './helpers/intl-messages';

/**
 * The "more sources" menu of the file button, driven by keyboard as the menu button pattern of the WAI-ARIA Authoring
 * Practices describes it: opening moves focus into the menu, the arrows, Home and End move within it, and every way out
 * returns focus to the button or hands it to what the item opens.
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

  it('closes when focus leaves it, as Tab moves it on', async () => {
    const { host, toggle, after } = await mount();
    await open(host, toggle);
    after.focus();
    await vi.waitFor(() => expect(items(host)).toEqual([]));
    expect(document.activeElement).toBe(after);
  });
});
