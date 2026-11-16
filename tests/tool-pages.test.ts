// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toolAccepts } from '../src/hooks/useToolRun';
import { resultNameOf } from '../src/lib/tools/tool-client';
import { defaultToolOptions, TOOLS_WITH_OPTIONS, WEB_TOOLS } from '../src/lib/tools/tool-names';
import { parseConverterSlug } from '../src/lib/slug-parser';
import { drop, mountSlug, paste, stubBrowser, unmountPage } from './helpers/mount-converter-page';

vi.mock('../src/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement('a', { href, ...rest }, children),
}));
vi.mock('../src/components/Header', () => ({ default: () => null }));
vi.mock('../src/components/Footer', () => ({ default: () => null }));

const { default: ConverterPageView } = await import('../src/components/pages/ConverterPageView');

const MIB = 1024 * 1024;

interface ToolCall {
  url: string;
  body?: unknown;
  signal: AbortSignal | undefined;
  settle: (response: Response) => void;
}

let calls: ToolCall[] = [];
let multipartCalls: string[] = [];
let revoked: string[] = [];
let nextUrl = 0;

/** The page's fetch: the session answers 401, a blob URL answers its bytes, multipart chunking succeeds in parts, and a tool run waits until the test answers it. */
function stubServer(): void {
  calls = [];
  multipartCalls = [];
  revoked = [];
  nextUrl = 0;
  let uploadSeq = 0;
  const sessionAndBlobs = async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/storage/multipart')) {
      multipartCalls.push(url);
      if (url.includes('action=initiate')) {
        return new Response(JSON.stringify({ uploadId: `up-${++uploadSeq}`, partSize: 16 * MIB }), { status: 200 });
      }
      if (url.includes('action=chunk')) {
        return new Response(JSON.stringify({ etag: `etag-${multipartCalls.length}` }), { status: 200 });
      }
      if (url.includes('action=complete')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { uploadId?: string };
        return new Response(JSON.stringify({ key: `uploads/${body.uploadId ?? 'u'}` }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    return url.startsWith('blob:') ? new Response('bytes') : new Response(JSON.stringify({ success: false }), { status: 401 });
  };
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (!String(url).startsWith('/api/tools/')) return sessionAndBlobs(String(url), init);
    return new Promise<Response>((resolve) => calls.push({ url: String(url), body: init?.body, signal: init?.signal ?? undefined, settle: resolve }));
  }));
  URL.createObjectURL = vi.fn(() => `blob:test/${++nextUrl}`);
  URL.revokeObjectURL = vi.fn((url: string) => { revoked.push(url); });
}

beforeEach(() => {
  stubBrowser();
  stubServer();
});
afterEach(unmountPage);


describe('the files a tool page takes', () => {
  it.each([
    ['merge', 'a.PDF', true],
    ['merge', 'a.docx', false],
    ['split', 'book.pdf', true],
    ['rotate', 'photo.png', false],
    ['archive-extract', 'bundle.tar.gz', true],
    ['archive-extract', 'bundle.7z', true],
    ['archive-extract', 'notes.txt', false],
    ['archive-create', 'anything.xyz', true],
  ] as const)('%s takes %s: %s', (tool, name, accepted) => {
    expect(toolAccepts(tool, name)).toBe(accepted);
  });
});

describe('what a tool run is called and starts with', () => {
  it('names each download as the server names it', () => {
    expect(resultNameOf('merge', 'a.pdf', {})).toBe('merged.pdf');
    expect(resultNameOf('archive-create', 'a.txt', { format: '7z' })).toBe('archive.7z');
    expect(resultNameOf('archive-create', 'a.txt', {})).toBe('archive.zip');
    expect(resultNameOf('split', 'book.pdf', {})).toBe('book-split.zip');
    expect(resultNameOf('rotate', 'book.pdf', {})).toBe('book-rotated.pdf');
  });

  it('starts every tool with options its route accepts', () => {
    expect(defaultToolOptions('archive-create')).toEqual({ format: 'zip' });
    expect(defaultToolOptions('rotate')).toEqual({ rotate: { rotation: 90 } });
    expect(defaultToolOptions('split')).toEqual({});
    expect([...TOOLS_WITH_OPTIONS].sort()).toEqual([
      'archive-create',
      'archive-extract',
      'delete-pages',
      'extract-pages',
      'protect',
      'rotate',
      'split',
      'unlock',
      'watermark',
    ]);
  });

  it('has a page for each tool at its own path', () => {
    const paths = [
      'merge-pdf',
      'create-zip-archive',
      'extract-zip-archive',
      'split-pdf',
      'rotate-pdf',
      'protect-pdf',
      'unlock-pdf',
      'watermark-pdf',
      'extract-pdf-pages',
      'delete-pdf-pages',
    ].map((slug) => parseConverterSlug(slug)?.canonicalPath);
    expect(paths).toEqual([
      '/merge-pdf',
      '/create-zip-archive',
      '/extract-zip-archive',
      '/split-pdf',
      '/rotate-pdf',
      '/protect-pdf',
      '/unlock-pdf',
      '/watermark-pdf',
      '/extract-pdf-pages',
      '/delete-pdf-pages',
    ]);
    expect(WEB_TOOLS).toHaveLength(paths.length);
  });

  it('keeps non-reference archive-inspect, zip-repair, and reorder-pdf-pages out of web tool slugs', () => {
    expect(parseConverterSlug('inspect-archive')).toBeNull();
    expect(parseConverterSlug('repair-zip')).toBeNull();
    expect(parseConverterSlug('reorder-pdf-pages')).toBeNull();
  });
});

const pdf = (name: string, bytes = 4) => new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
/** A file that claims `size` bytes without holding them. */
function claimed(name: string, size: number): File {
  const file = pdf(name);
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

const bar = () => document.querySelector<HTMLElement>('[data-queue-bar]')!;
const summary = () => bar().querySelector('output')!.textContent;
const buttons = () => [...bar().querySelectorAll<HTMLButtonElement>('button')];
const buttonNamed = (name: string) => buttons().find((button) => button.textContent?.trim() === name);
const rows = (host: HTMLElement) => host.querySelectorAll('[aria-label^="Remove "]').length;

async function inQueue(host: HTMLElement, files: File[]) {
  drop(host, files);
  await vi.waitFor(() => expect(document.querySelector('[data-queue-bar]')).not.toBeNull());
}

const pdfAnswer = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'application/pdf' } });

describe('a tool that takes one file', () => {
  it('opens a file dialog for one file, and counts the files it leaves out when several are dropped', async () => {
    const host = await mountSlug(ConverterPageView, 'rotate-pdf');
    expect(host.querySelector<HTMLInputElement>('input[type=file]')!.multiple).toBe(false);
    await inQueue(host, [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')]);
    expect(rows(host)).toBe(1);
    expect(summary()).toBe('2 more files were left out because this tool takes one file at a time');
  });

  it('opens a file dialog for several files on a tool that merges them', async () => {
    const host = await mountSlug(ConverterPageView, 'merge-pdf');
    expect(host.querySelector<HTMLInputElement>('input[type=file]')!.multiple).toBe(true);
  });
});

describe('the files a run would be turned away with', () => {
  it('are named before they are sent: more files than a run takes', async () => {
    const host = await mountSlug(ConverterPageView, 'merge-pdf');
    await inQueue(host, Array.from({ length: 51 }, (_, index) => pdf(`f${index}.pdf`)));
    expect(summary()).toBe('A run takes up to 50 files');
    expect(buttonNamed('Merge')!.disabled).toBe(true);
  });

  it('dispatches files together over 64 MiB as an async multipart tool job', async () => {
    const host = await mountSlug(ConverterPageView, 'merge-pdf');
    await inQueue(host, [claimed('a.pdf', 40 * MIB), claimed('b.pdf', 40 * MIB)]);
    expect(buttonNamed('Merge')!.disabled).toBe(false);
    buttonNamed('Merge')!.click();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(multipartCalls.filter((u) => u.includes('action=initiate'))).toHaveLength(2);
    expect(multipartCalls.filter((u) => u.includes('action=chunk'))).toHaveLength(6);
    expect(multipartCalls.filter((u) => u.includes('action=complete'))).toHaveLength(2);
    expect(calls[0].url).toBe('/api/tools/jobs');
    expect(JSON.parse(String(calls[0].body))).toMatchObject({
      tool: 'merge',
      files: [
        { key: 'uploads/up-1', name: 'a.pdf' },
        { key: 'uploads/up-2', name: 'b.pdf' },
      ],
    });
  });

  it('are named before they are sent: a file with nothing in it', async () => {
    const host = await mountSlug(ConverterPageView, 'merge-pdf');
    await inQueue(host, [pdf('a.pdf'), pdf('empty.pdf', 0)]);
    expect(summary()).toBe('Some files are empty');
    expect(buttonNamed('Merge')!.disabled).toBe(true);
    expect(calls).toEqual([]);
  });

  it('let a run through when the files are in order', async () => {
    const host = await mountSlug(ConverterPageView, 'merge-pdf');
    await inQueue(host, [pdf('a.pdf'), pdf('b.pdf')]);
    expect(buttonNamed('Merge')!.disabled).toBe(false);
  });
});

describe('a run in flight', () => {
  async function startMerge(host: HTMLElement) {
    await inQueue(host, [pdf('a.pdf'), pdf('b.pdf')]);
    buttonNamed('Merge')!.click();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
  }

  it('can be cancelled, and leaves the files ready to run again', async () => {
    const host = await mountSlug(ConverterPageView, 'merge-pdf');
    await startMerge(host);
    expect(summary()).toBe('Working on it');
    buttonNamed('Cancel')!.click();
    await vi.waitFor(() => expect(buttonNamed('Merge')).toBeDefined());
    expect(calls[0].signal?.aborted).toBe(true);
    expect(rows(host)).toBe(2);
    calls[0].settle(pdfAnswer());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(summary()).toBe('2 files are ready');
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('is stopped by a file pasted over it, and its answer no longer replaces the page', async () => {
    const host = await mountSlug(ConverterPageView, 'merge-pdf');
    await startMerge(host);
    paste([pdf('c.pdf')]);
    await vi.waitFor(() => expect(rows(host)).toBe(3));
    expect(calls[0].signal?.aborted).toBe(true);
    calls[0].settle(pdfAnswer());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(summary()).toBe('3 files are ready');
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revoked).toHaveLength(1);
  });

  it('keeps keyboard focus on the one button that runs, cancels and starts over', async () => {
    const host = await mountSlug(ConverterPageView, 'merge-pdf');
    await inQueue(host, [pdf('a.pdf'), pdf('b.pdf')]);
    const primary = buttonNamed('Merge')!;
    primary.focus();
    primary.click();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // A focused button that is disabled loses focus in the browsers that apply the focus fixup rule.
    expect(primary.disabled).toBe(false);
    expect(document.activeElement).toBe(primary);
    calls[0].settle(pdfAnswer());
    await vi.waitFor(() => expect(summary()).toBe('Done'));
    expect(document.activeElement).toBe(primary);
    expect(primary.textContent?.trim()).toBe('Start over');
  });
});

describe('a finished run', () => {
  it('can be run again with other options, without uploading the file again', async () => {
    const host = await mountSlug(ConverterPageView, 'rotate-pdf');
    await inQueue(host, [pdf('book.pdf')]);
    buttonNamed('Rotate')!.click();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0].settle(pdfAnswer());
    await vi.waitFor(() => expect(summary()).toBe('Done'));

    const optionsButton = buttons().find((button) => button.textContent?.trim() === 'Options')!;
    expect(optionsButton.disabled).toBe(false);
    optionsButton.click();
    const turn = await vi.waitFor(() => {
      const radio = document.querySelector<HTMLInputElement>('input[name=tool-rotation][type=radio]:not(:checked)');
      expect(radio).not.toBeNull();
      return radio!;
    });
    turn.click();
    [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find((button) => button.textContent?.trim() === 'Apply Options')!.click();

    await vi.waitFor(() => expect(buttonNamed('Rotate')?.disabled).toBe(false));
    expect(rows(host)).toBe(1);
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('keeps its result when the options are applied unchanged', async () => {
    const host = await mountSlug(ConverterPageView, 'rotate-pdf');
    await inQueue(host, [pdf('book.pdf')]);
    buttonNamed('Rotate')!.click();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0].settle(pdfAnswer());
    await vi.waitFor(() => expect(summary()).toBe('Done'));
    buttons().find((button) => button.textContent?.trim() === 'Options')!.click();
    await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
    [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find((button) => button.textContent?.trim() === 'Apply Options')!.click();
    await vi.waitFor(() => expect(document.querySelector('dialog[open]')).toBeNull());
    expect(summary()).toBe('Done');
    expect(document.querySelector('a[download]')).not.toBeNull();
  });
});

describe('a split by ranges with no range', () => {
  it('says what is missing instead of leaving a disabled button unexplained', async () => {
    const host = await mountSlug(ConverterPageView, 'split-pdf');
    await inQueue(host, [pdf('book.pdf')]);
    buttons().find((button) => button.textContent?.trim() === 'Options')!.click();
    const byRanges = await vi.waitFor(() => {
      const radio = document.querySelector<HTMLInputElement>('input[name=tool-split-mode]:not(:checked)');
      expect(radio).not.toBeNull();
      return radio!;
    });
    byRanges.click();
    await vi.waitFor(() => expect(document.querySelector('#tool-split-ranges')).not.toBeNull());
    [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find((button) => button.textContent?.trim() === 'Apply Options')!.click();
    await vi.waitFor(() => expect(summary()).toBe('Enter the page ranges to split by'));
    expect(buttonNamed('Split')!.disabled).toBe(true);
  });

  it.each([
    ['protect-pdf', 'Protect', 'Enter a password in Options'],
    ['unlock-pdf', 'Unlock', 'Enter the PDF password in Options'],
    ['watermark-pdf', 'Watermark', 'Enter watermark text in Options'],
    ['extract-pdf-pages', 'Extract pages', 'Enter the page range in Options'],
    ['delete-pdf-pages', 'Delete pages', 'Enter the page range in Options'],
  ] as const)('guides the visitor on %s until the required option is entered', async (slug, actionName, expectedStatus) => {
    const host = await mountSlug(ConverterPageView, slug);
    await inQueue(host, [pdf('book.pdf')]);
    await vi.waitFor(() => expect(summary()).toBe(expectedStatus));
    expect(buttonNamed(actionName)!.disabled).toBe(true);
  });
});

describe('the archive format', () => {
  it('offers every format the server creates, TAR among them', async () => {
    const host = await mountSlug(ConverterPageView, 'create-zip-archive');
    await inQueue(host, [new File(['x'], 'notes.txt')]);
    buttons().find((button) => button.textContent?.trim() === 'Options')!.click();
    const select = await vi.waitFor(() => {
      const element = document.querySelector<HTMLSelectElement>('#tool-archive-format');
      expect(element).not.toBeNull();
      return element!;
    });
    const { ARCHIVE_CREATE_FORMATS } = await import('../src/lib/jobs/graph-operations');
    expect([...select.options].map((option) => option.value).sort()).toEqual([...ARCHIVE_CREATE_FORMATS].sort());
  });
});

describe('download all of an unpacked archive', () => {
  const entries = {
    entries: [
      { name: 'a.txt', size: 1, mimeType: 'text/plain', data: btoa('a') },
      { name: 'b.txt', size: 1, mimeType: 'text/plain', data: btoa('b') },
    ],
  };

  async function unpacked() {
    const host = await mountSlug(ConverterPageView, 'extract-zip-archive');
    await inQueue(host, [new File(['x'], 'bundle.zip')]);
    buttonNamed('Extract')!.click();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0].settle(Response.json(entries));
    await vi.waitFor(() => expect(buttons().find((button) => button.textContent?.includes('Download all'))).toBeDefined());
    return buttons().find((button) => button.textContent?.includes('Download all'))!;
  }

  it('clicks a link attached to the page and keeps the URL until the browser has read it', async () => {
    const attached: boolean[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
      attached.push(this.isConnected && this.download === 'files.zip');
    });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const button = await unpacked();
    revoked.length = 0;
    button.click();
    await vi.waitFor(() => expect(attached).toEqual([true]));
    const bundle = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.results.at(-1)!.value as string;
    expect(revoked).not.toContain(bundle);
    vi.advanceTimersByTime(60_000);
    expect(revoked).toContain(bundle);
    vi.useRealTimers();
  });

  it('says so when the files cannot be bundled', async () => {
    const button = await unpacked();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    button.click();
    await vi.waitFor(() => expect(bar().querySelector('[role=alert]')?.textContent).toBe('Could not build the ZIP archive.'));
  });
});
