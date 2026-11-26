// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testMessages } from './helpers/intl-messages';
import { ANONYMOUS_DAILY_CREDITS } from '../src/lib/plan-limits';
import { parsedSlug } from './helpers/intl';
import { buildQueuedFileItem } from '../src/hooks/useClientQueue';
import { parseConverterSlug } from '../src/lib/slug-parser';

vi.mock('../src/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement('a', { href, ...rest }, children),
}));
vi.mock('../src/components/Header', () => ({ default: () => null }));
vi.mock('../src/components/Footer', () => ({ default: () => null }));

const { default: ConverterPageView } = await import('../src/components/pages/ConverterPageView');

/**
 * Converter pages no longer render HeroFormatTiles; files still inherit the page's fixed target (when any),
 * queue rows allow choosing per-file targets, and emptying the queue restores the page's default target for new drops.
 */

let root: Root | undefined;
let observed: Array<{ callback: ResizeObserverCallback; target?: Element }> = [];

beforeEach(() => {
  observed = [];
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 112, 120));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 401 })));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly entry: { callback: ResizeObserverCallback; target?: Element };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback };
        observed.push(this.entry);
      }
      observe(target: Element) {
        this.entry.target = target;
      }
      disconnect() {
        observed = observed.filter((entry) => entry !== this.entry);
      }
    }
  );
});

afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountPage(slug: string): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  root.render(
    createElement(NextIntlClientProvider, {
      locale: 'en',
      messages: testMessages('en'),
      timeZone: 'UTC',
      children: createElement(ConverterPageView, { parsed: parsedSlug(slug), dailyLimit: ANONYMOUS_DAILY_CREDITS }),
    })
  );
  await vi.waitFor(() => expect(host.querySelector('main h1')).not.toBeNull());
  return host;
}

function filesOf(files: File[]): FileList {
  return Object.assign([...files], { item: (index: number) => files[index] ?? null }) as unknown as FileList;
}

function drop(host: HTMLElement, files: File[]) {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: filesOf(files) } });
  host.querySelector('main h2')!.parentElement!.dispatchEvent(event);
}

function paste(files: File[]) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files: filesOf(files) } });
  document.body.dispatchEvent(event);
}

async function choose(button: HTMLElement, format: string) {
  button.click();
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

const rowTargets = (host: HTMLElement) =>
  [...host.querySelectorAll('[data-testid=queue-target-format-btn]')].map((button) => button.textContent);
const png = (name: string) => new File(['x'], name, { type: 'image/png' });

describe('converter and tool heroes without format tiles', () => {
  it.each(['png-to-jpg', 'pdf-converter', 'document-converter', 'compress-pdf', 'pdfa-converter', 'pdf-ocr'])(
    'omits hero format tiles completely on %s',
    async (slug) => {
      const host = await mountPage(slug);
      expect(host.querySelector('[data-testid=hero-source-format-btn]')).toBeNull();
      expect(host.querySelector('[data-testid=hero-target-format-btn]')).toBeNull();
    }
  );

  it('starts dropped files without target on format pages and with pair target on pair pages, then uses queue target for appended files', async () => {
    const formatHost = await mountPage('pdf-converter');
    drop(formatHost, [png('first.png')]);
    await vi.waitFor(() => expect(rowTargets(formatHost)).toEqual(['Select format']));

    root?.unmount();
    document.body.innerHTML = '';

    const pairHost = await mountPage('png-to-jpg');
    drop(pairHost, [png('first.png')]);
    await vi.waitFor(() => expect(rowTargets(pairHost)).toEqual(['JPG']));
    await choose(pairHost.querySelector<HTMLElement>('[data-testid=queue-target-format-btn]')!, 'webp');
    await vi.waitFor(() => expect(rowTargets(pairHost)).toEqual(['WEBP']));

    paste([png('second.png')]);
    await vi.waitFor(() => expect(rowTargets(pairHost)).toEqual(['WEBP', 'WEBP']));
  });

  it('restores the pair page target when the queue is emptied and another file is dropped', async () => {
    const host = await mountPage('png-to-jpg');
    drop(host, [png('first.png')]);
    await vi.waitFor(() => expect(rowTargets(host)).toEqual(['JPG']));
    await choose(host.querySelector<HTMLElement>('[data-testid=queue-target-format-btn]')!, 'gif');
    await vi.waitFor(() => expect(rowTargets(host)).toEqual(['GIF']));

    host.querySelector<HTMLElement>('[aria-label="Remove first.png"]')!.click();
    await vi.waitFor(() => expect(host.querySelector('[data-testid=queue-target-format-btn]')).toBeNull());

    drop(host, [png('second.png')]);
    await vi.waitFor(() => expect(rowTargets(host)).toEqual(['JPG']));
  });
});

describe('the pinned bar over the queue', () => {
  it('publishes its measured height for the scroll padding, follows a change of it and removes it with the queue', async () => {
    const host = await mountPage('png-to-jpg');
    drop(host, [png('first.png')]);
    const bar = await vi.waitFor(() => {
      const element = host.querySelector<HTMLElement>('[data-queue-bar]');
      expect(element).not.toBeNull();
      return element!;
    });
    const measure = (height: number) => {
      Object.defineProperty(bar, 'offsetHeight', { value: height, configurable: true });
      for (const { callback, target } of observed) if (target === bar) callback([], {} as ResizeObserver);
    };
    const published = () => document.documentElement.style.getPropertyValue('--queue-bar-height');

    measure(72);
    expect(published()).toBe('72px');
    measure(128);
    expect(published()).toBe('128px');

    host.querySelector<HTMLElement>('[aria-label="Remove first.png"]')!.click();
    await vi.waitFor(() => expect(host.querySelector('[data-queue-bar]')).toBeNull());
    expect(published()).toBe('');
  });
});

describe('the files of a page that does one operation with them', () => {
  const file = (name: string) => new File(['x'], name);

  it('start with text recognition on the OCR page, a scanned image and a PDF alike, so a PDF is not only compressed and an image not only wrapped', () => {
    expect(buildQueuedFileItem(file('scan.pdf'), 'pdf', 'ocr').options).toMatchObject({ ocrEnabled: true });
    expect(buildQueuedFileItem(file('photo.jpg'), 'pdf', 'ocr').options).toMatchObject({ ocrEnabled: true });
    expect(buildQueuedFileItem(file('photo.png'), 'pdf', 'ocr').options).toMatchObject({ ocrEnabled: true });
  });

  it('keep recognition off a target it cannot apply to, and off every other page', () => {
    expect(buildQueuedFileItem(file('letter.docx'), 'pdf', 'ocr').options.ocrEnabled).toBeUndefined();
    expect(buildQueuedFileItem(file('scan.pdf'), 'pdf').options.ocrEnabled).toBeUndefined();
    expect(buildQueuedFileItem(file('scan.pdf'), 'pdf', 'compress').options.ocrEnabled).toBeUndefined();
  });

  it('start with a PDF/A export on the PDF/A page, for a PDF and a document alike', () => {
    expect(buildQueuedFileItem(file('report.pdf'), 'pdf', 'pdfa').options).toMatchObject({ pdfa: {} });
    expect(buildQueuedFileItem(file('letter.docx'), 'pdf', 'pdfa').options).toMatchObject({ pdfa: {} });
    expect(buildQueuedFileItem(file('letter.docx'), 'pdf').options.pdfa).toBeUndefined();
  });

  it('open the options of an image dropped on the OCR page with text recognition already on', async () => {
    const host = await mountPage('pdf-ocr');
    drop(host, [file('scan.png')]);
    const options = await vi.waitFor(() => {
      const button = host.querySelector<HTMLElement>('[data-testid=queue-options-btn]');
      expect(button).not.toBeNull();
      return button!;
    });
    options.click();
    const checkbox = await vi.waitFor(() => {
      const element = document.querySelector<HTMLInputElement>('#opt-doc-ocr');
      expect(element).not.toBeNull();
      return element!;
    });
    expect(checkbox.checked).toBe(true);
  });
});

describe('the PDF/A page', () => {
  it('is a page that makes PDF/A files from PDFs, at the path the Tools menu links to, not the converter of a format no file has', () => {
    expect(parseConverterSlug('pdfa-converter')).toMatchObject({
      sourceFormat: 'pdf',
      targetFormat: 'pdf',
      copy: { kind: 'pdfa' },
      canonicalPath: '/pdfa-converter',
    });
  });

  it('drops files with target PDF and omits hero format tiles', async () => {
    const host = await mountPage('pdfa-converter');
    expect(host.querySelector('[data-testid=hero-source-format-btn]')).toBeNull();
    expect(host.querySelector('[data-testid=hero-target-format-btn]')).toBeNull();
    drop(host, [new File(['x'], 'report.pdf', { type: 'application/pdf' })]);
    await vi.waitFor(() => expect(rowTargets(host)).toEqual(['PDF']));
  });
});
