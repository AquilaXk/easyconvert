// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalFormat } from '../src/lib/format-aliases';
import { getAvailableTargetFormats } from '../src/lib/registry';
import { testMessages, type TestLocale } from './helpers/intl-messages';

vi.mock('../src/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement('a', { href, ...rest }, children),
}));

const { default: SourceChipPicker } = await import('../src/components/workbench/SourceChipPicker');

/**
 * The format chips of the home page's upload card, driven the way a person drives them: a click on a source swaps the
 * card to the common targets of that source, each a link to its pair page, then a link to every format of the source,
 * and keyboard focus follows the swap both ways.
 */

let root: Root | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.innerHTML = '';
});

async function mount(locale: TestLocale): Promise<HTMLElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(NextIntlClientProvider, { locale, messages: testMessages(locale), timeZone: 'UTC', children: createElement(SourceChipPicker) }));
  await vi.waitFor(() => expect(host.querySelector('[role=group] button')).not.toBeNull());
  return host;
}

const buttonNamed = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);

async function targetsOf(host: HTMLElement, source: string): Promise<HTMLAnchorElement[]> {
  buttonNamed(host, source.toUpperCase())!.click();
  await vi.waitFor(() => expect(host.querySelector('[role=group] a')).not.toBeNull());
  return [...host.querySelectorAll<HTMLAnchorElement>('[role=group] a')];
}

const INTERNAL_FORMATS = ['hocr', 'alto', 'odd', 'ps', 'eps', 'icns', 'xps'];

describe('the source chips of the upload card', () => {
  it('offer each source as a button named by what it does, under the question they answer', async () => {
    const host = await mount('ko');
    const group = host.querySelector('[role=group]')!;
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent).toBe('어떤 형식을 변환할까요?');
    const png = buttonNamed(host, 'PNG')!;
    expect(png.getAttribute('aria-label')).toBe('PNG, 변환할 형식 고르기');
    expect([...group.querySelectorAll('button')].filter((chip) => chip.hasAttribute('aria-pressed'))).toEqual([]);
  });

  it.each([
    ['png', ['jpg', 'webp', 'gif', 'bmp', 'tiff', 'avif', 'ico', 'pdf']],
    ['mp4', ['avi', 'mkv', 'mov', 'webm', 'wmv', 'flv', 'gif', 'mp3', 'wav']],
    ['pdf', ['docx', 'txt', 'html', 'jpg', 'png', 'rtf', 'epub', 'pptx', 'xlsx']],
  ])('swap %s to its common targets, each a link to its pair page, then a link to all its formats', async (source, common) => {
    const host = await mount('en');
    const links = await targetsOf(host, source);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      ...common.map((target) => `/${source}-to-${target}`),
      `/${source}-converter`,
    ]);
    expect(links.at(-1)!.textContent).toBe('See all formats');
  });

  it('show at most ten registered targets for every source, each format once by its own name and none internal', async () => {
    const host = await mount('en');
    const sources = [...host.querySelectorAll('[role=group] button')].map((chip) => chip.textContent!.toLowerCase());
    for (const source of sources) {
      const targets = (await targetsOf(host, source)).slice(0, -1).map((a) => a.getAttribute('href')!.replace(`/${source}-to-`, ''));
      const registered = getAvailableTargetFormats(source).map((format) => format.id);
      expect(targets.length, source).toBeLessThanOrEqual(10);
      expect(targets.filter((target) => !registered.includes(target)), source).toEqual([]);
      expect(targets.filter((target) => canonicalFormat(target) !== target), source).toEqual([]);
      expect(targets.filter((target) => INTERNAL_FORMATS.includes(target)), source).toEqual([]);
      buttonNamed(host, `← Back`)!.click();
      await vi.waitFor(() => expect(host.querySelector('[role=group] button')).not.toBeNull());
    }
    expect(sources).toHaveLength(20);
  });

  it('move focus to "back" on the swap, and back to the chip it came from', async () => {
    const host = await mount('en');
    await targetsOf(host, 'mp4');
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('← Back'));
    expect(host.textContent).toContain('Convert MP4 to:');
    expect(buttonNamed(host, 'MP4')!.getAttribute('aria-label')).toBe('MP4, change format');

    (document.activeElement as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('MP4'));
  });
});
