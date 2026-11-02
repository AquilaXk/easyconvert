// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAvailableTargetFormats } from '../src/lib/registry';
import { testMessages, type TestLocale } from './helpers/intl-messages';

vi.mock('../src/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement('a', { href, ...rest }, children),
}));

const { default: SourceChipPicker } = await import('../src/components/workbench/SourceChipPicker');

/**
 * The format chips of the home page's upload card, driven the way a person drives them: a click on a source swaps the
 * card to that source's targets, each a link to its pair page, and keyboard focus follows the swap both ways.
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
  await vi.waitFor(() => expect(host.querySelector('[data-testid=source-chip]')).not.toBeNull());
  return host;
}

const buttonNamed = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);

describe('the source chips of the upload card', () => {
  it('offer each source as a toggle that is not pressed, under the question they answer', async () => {
    const host = await mount('ko');
    const group = host.querySelector('[role=group]')!;
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent).toBe('어떤 형식을 변환할까요?');
    const chips = [...group.querySelectorAll('button')];
    expect(chips.map((c) => c.textContent)).toContain('PNG');
    expect(new Set(chips.map((c) => c.getAttribute('aria-pressed')))).toEqual(new Set(['false']));
  });

  it('swap to the targets of the chosen source, link each to its pair page and move focus to "back"', async () => {
    const host = await mount('ko');
    buttonNamed(host, 'PNG')!.click();

    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('← 뒤로'));
    expect(buttonNamed(host, 'PNG')!.getAttribute('aria-pressed')).toBe('true');
    const group = host.querySelector('[role=group]')!;
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent).toBe('PNG 파일을 다음 형식으로 변환:');

    const expected = getAvailableTargetFormats('png').map((f) => f.id).filter((id) => id !== 'png');
    const hrefs = [...group.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(expected.map((id) => `/png-to-${id}`));
    expect(hrefs).toContain('/png-to-jpg');
    expect(host.querySelector('[data-testid=source-chip]')).toBeNull();
  });

  it('return focus to the chip it came from when "back" is pressed', async () => {
    const host = await mount('en');
    buttonNamed(host, 'MP4')!.click();
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('← Back'));
    expect(host.textContent).toContain('Convert MP4 to:');

    (document.activeElement as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-format')).toBe('mp4'));
    expect(document.activeElement?.getAttribute('aria-pressed')).toBe('false');
  });
});
