import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import QueueItemRow from '../src/components/workbench/QueueItemRow';
import { executeItemConversion } from '../src/lib/client-converter';
import type { ConversionQueueItem } from '../src/lib/types';
import { allElements, attrOf, renderDom, visibleText } from './helpers/rendered-dom';
import type { TestLocale } from './helpers/intl-messages';

/**
 * A file converted in one request to the server has no measure of how far it is: the request sends the file and waits for the
 * answer. Its row says it is converting, with a progress bar that has no value, as the reference shows a task that is
 * processing; it shows a share only when a stage measures one (an upload in parts, a job that reports its progress).
 */

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function item(overrides: Partial<ConversionQueueItem> = {}): ConversionQueueItem {
  const file = new File(['%PDF-1.4\n'], 'report.pdf', { type: 'application/pdf' });
  return { id: 'row-1', file, name: 'report.pdf', size: file.size, sourceFormat: 'pdf', targetFormat: 'docx', status: 'ready', options: {}, ...overrides };
}

function rowOf(overrides: Partial<ConversionQueueItem>, locale: TestLocale) {
  const noop = () => undefined;
  return renderDom(createElement(QueueItemRow, { item: item(overrides), onSelectTargetFormat: noop, onOpenOptions: noop, onRemove: noop }), locale);
}

const progressOf = (overrides: Partial<ConversionQueueItem>, locale: TestLocale) => {
  const row = rowOf(overrides, locale);
  const [bar] = allElements(row).filter((element) => element.tagName === 'progress');
  return { bar, text: visibleText(row) };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a conversion sent to the server in one request', () => {
  it('starts the converting stage and reports no share of progress while the request runs', async () => {
    let answer: (response: Response) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))));
    const onProgress = vi.fn();
    const onStage = vi.fn();
    const onSuccess = vi.fn();

    const running = executeItemConversion(item(), { onProgress, onStage, onSuccess, onError: vi.fn() });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    expect(onStage).toHaveBeenCalledWith('converting');
    expect(onProgress).not.toHaveBeenCalled();
    answer(new Response(new Uint8Array([0x50, 0x4b]), { status: 200, headers: { 'content-type': DOCX_MIME } }));
    await running;
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onProgress).not.toHaveBeenCalled();
  });
});

describe('the status of a running row', () => {
  it.each([
    ['en', 'Converting...'],
    ['ko', '변환 중...'],
  ] as const)('without a measured share is an indeterminate bar and the converting label in %s', (locale, label) => {
    const { bar, text } = progressOf({ status: 'converting' }, locale);

    expect(bar).toBeDefined();
    expect(attrOf(bar, 'value')).toBeNull();
    expect(text).toContain(label);
    expect(text).not.toMatch(/\d+%/);
  });

  it('with a measured share shows that share', () => {
    const { bar, text } = progressOf({ status: 'uploading', progress: 40 }, 'en');

    expect(attrOf(bar, 'value')).toBe('40');
    expect(text).toContain('40%');
  });
});
