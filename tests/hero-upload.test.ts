// @vitest-environment jsdom
import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testMessages } from './helpers/intl-messages';
import { ANONYMOUS_DAILY_CONVERSIONS } from '../src/lib/plan-limits';

vi.mock('../src/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement('a', { href, ...rest }, children),
}));

const { HomeHero, PairHero, QueueHeader } = await import('../src/components/Hero');
const { usePairTiles } = await import('../src/components/hero/usePairTiles');

/**
 * The ways files reach the page from a hero, driven as a person does: picking them in the file input, dropping them
 * anywhere on the upload card, and pasting them outside a text field. Each hands the files on with the target the hero
 * names: none on the home page, the page's pair on a converter page, and the first file's target over the queue.
 */

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
});

/** Renders inside `act`, so the hero's paste listener, which an effect adds, is in place before a test pastes. */
async function mount(element: ReactElement): Promise<HTMLElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(NextIntlClientProvider, { locale: 'en', messages: testMessages('en'), timeZone: 'UTC', children: element }));
  });
  expect(host.querySelector('input[type=file]')).not.toBeNull();
  return host;
}

const file = () => new File(['x'], 'photo.png', { type: 'image/png' });

function filesOf(files: File[]): FileList {
  return Object.assign([...files], { item: (index: number) => files[index] ?? null }) as unknown as FileList;
}

function paste(target: EventTarget, files: File[]) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files: filesOf(files) } });
  target.dispatchEvent(event);
}

function drop(target: Element, files: File[]) {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: filesOf(files) } });
  target.dispatchEvent(event);
  return event;
}

function pick(host: HTMLElement, files: File[]) {
  const input = host.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', { value: filesOf(files), configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** The card of the drop zone: its padding around the heading and button is part of the target. */
const uploadCard = (host: HTMLElement) => host.querySelector('h2')!.parentElement!;

describe('the home hero', () => {
  it('hands on picked, dropped and pasted files with no target, and a drop on the card padding is not left to the browser', async () => {
    const onFilesSelected = vi.fn();
    const host = await mount(createElement(HomeHero, { onFilesSelected, dailyLimit: ANONYMOUS_DAILY_CONVERSIONS }));
    const picked = file();
    pick(host, [picked]);
    const dropped = file();
    const event = drop(uploadCard(host), [dropped]);
    const pasted = file();
    paste(document.body, [pasted]);
    expect(onFilesSelected.mock.calls).toEqual([[[picked], undefined], [[dropped], undefined], [[pasted], undefined]]);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves a paste into a text field to the field', async () => {
    const onFilesSelected = vi.fn();
    await mount(createElement('div', null, createElement('textarea'), createElement(HomeHero, { onFilesSelected, dailyLimit: ANONYMOUS_DAILY_CONVERSIONS })));
    paste(document.querySelector('textarea')!, [file()]);
    expect(onFilesSelected).not.toHaveBeenCalled();
  });
});

describe('a converter page hero', () => {
  it('hands on files with the target of its pair', async () => {
    const onFilesSelected = vi.fn();
    function PngToJpgPage() {
      const tiles = usePairTiles('png', 'jpg');
      return createElement(PairHero, { onFilesSelected, dailyLimit: ANONYMOUS_DAILY_CONVERSIONS, tiles, title: 'PNG to JPG Converter', description: 'Convert PNG files to JPG online.' });
    }
    const host = await mount(createElement(PngToJpgPage));
    const dropped = file();
    drop(uploadCard(host), [dropped]);
    expect(onFilesSelected).toHaveBeenCalledWith([dropped], 'jpg');
    expect(host.querySelector('h1')!.textContent).toBe('PNG to JPG Converter');
  });
});

describe('the header over the queue', () => {
  it('adds pasted files with the target of the first file', async () => {
    const onFilesSelected = vi.fn();
    const host = await mount(createElement(QueueHeader, { onFilesSelected, sourceFormat: 'png', targetFormat: 'webp' }));
    const pasted = file();
    paste(document.body, [pasted]);
    expect(onFilesSelected).toHaveBeenCalledWith([pasted], 'webp');
    expect(host.querySelector('h1')!.textContent).toBe('PNG to WEBP Converter');
    expect(host.querySelector<HTMLInputElement>('#main-file-input')).not.toBeNull();
  });

  it('keeps the intro of a converter page under its title, and says nothing under the title of the home page', async () => {
    const intro = 'Convert PNG files to JPG online.';
    const page = await mount(createElement(QueueHeader, { onFilesSelected: vi.fn(), sourceFormat: 'png', targetFormat: 'jpg', pageTitle: 'PNG to JPG Converter', pageDescription: intro }));
    expect(page.querySelector('p')!.textContent).toBe(intro);
    act(() => root?.unmount());
    const home = await mount(createElement(QueueHeader, { onFilesSelected: vi.fn(), sourceFormat: 'png', targetFormat: 'jpg' }));
    expect(home.querySelector('p')).toBeNull();
  });
});
