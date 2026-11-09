// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { choose, mountElement, mountSlug, stubBrowser, unmountPage } from './helpers/mount-converter-page';

const pushed = vi.hoisted(() => [] as string[]);

vi.mock('../src/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement('a', { href, ...rest }, children),
  useRouter: () => ({ push: (path: string) => pushed.push(path) }),
}));
vi.mock('../src/components/Header', () => ({ default: () => null }));
vi.mock('../src/components/Footer', () => ({ default: () => null }));

const { default: ConverterPageView } = await import('../src/components/pages/ConverterPageView');
const { default: HomeFormatPicker } = await import('../src/components/workbench/HomeFormatPicker');

beforeEach(() => {
  pushed.length = 0;
  stubBrowser();
});
afterEach(unmountPage);

const tileLabel = (host: HTMLElement, side: 'source' | 'target') =>
  host.querySelector(`[data-testid=hero-${side}-format-btn]`)?.getAttribute('aria-label');

describe('the format tiles when the source becomes the format of the target', () => {
  it('read any format on a converter page, not PDF to PDF', async () => {
    const host = await mountSlug(ConverterPageView, 'docx-to-pdf');
    await choose(host.querySelector('[data-testid=hero-source-format-btn]')!, 'pdf');
    await vi.waitFor(() => expect(tileLabel(host, 'source')).toBe('Source format PDF'));
    expect(tileLabel(host, 'target')).toBe('Target format ANY');
  });

  it('keep the target on a page whose pair is its own format, when the source is picked again', async () => {
    const host = await mountSlug(ConverterPageView, 'compress-pdf');
    await choose(host.querySelector('[data-testid=hero-source-format-btn]')!, 'pdf');
    expect(tileLabel(host, 'target')).toBe('Target format PDF');
  });
});

describe('the home page pair', () => {
  it('stays on any format, and opens no page, when the source is changed to the target format', async () => {
    const host = await mountElement(createElement(HomeFormatPicker), '[data-testid=hero-source-format-btn]');
    await choose(host.querySelector('[data-testid=hero-source-format-btn]')!, 'pdf');
    await vi.waitFor(() => expect(tileLabel(host, 'source')).toBe('Source format PDF'));
    expect(tileLabel(host, 'target')).toBe('Target format ANY');
    expect(pushed).toEqual([]);
  });

  it('does not offer the source format as its own target, so PDF to PDF is never opened', async () => {
    const host = await mountElement(createElement(HomeFormatPicker), '[data-testid=hero-source-format-btn]');
    await choose(host.querySelector('[data-testid=hero-source-format-btn]')!, 'pdf');
    await vi.waitFor(() => expect(tileLabel(host, 'source')).toBe('Source format PDF'));
    host.querySelector<HTMLElement>('[data-testid=hero-target-format-btn]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-format=docx]')).not.toBeNull());
    expect(document.querySelector('[data-format=pdf]')).toBeNull();
  });

  it('still opens the page of a pair', async () => {
    const host = await mountElement(createElement(HomeFormatPicker), '[data-testid=hero-source-format-btn]');
    await choose(host.querySelector('[data-testid=hero-target-format-btn]')!, 'html');
    expect(pushed).toEqual(['/docx-to-html']);
  });
});
