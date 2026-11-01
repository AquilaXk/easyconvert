import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as convertRoute } from '../src/app/api/convert/route';
import QueueItemRow from '../src/components/workbench/QueueItemRow';
import { executeItemConversion } from '../src/lib/client-converter';
import type { ConversionFailure } from '../src/lib/conversion-failure';
import { CONVERSION_REFUSAL_CODES } from '../src/lib/refusal-codes';
import type { ConversionQueueItem } from '../src/lib/types';
import type { TestLocale } from './helpers/intl';
import { WebhooksPanel } from '../src/components/dashboard/WebhooksPanel';
import { allElements, attrOf, renderComponent, renderDom, select, visibleText, type DomElement } from './helpers/rendered-dom';

/**
 * A conversion that fails in the queue is worded in the page's language, and the server's English text stays one click
 * away under "technical details". The refusals come from the real `/api/convert` route and the real conversion path.
 */

/** Two Latin words in a row: an English sentence or phrase, unlike a format name (`HWP`) or a number. */
const ENGLISH_PHRASE = /[A-Za-z]{2,}[\s,.]+[A-Za-z]{2,}/;
const HANGUL = /[가-힣]/;

const noop = () => undefined;

function queueItem(name: string, bytes: Uint8Array, sourceFormat: string, targetFormat: string, options: ConversionQueueItem['options'] = {}): ConversionQueueItem {
  const file = new File([bytes], name);
  return { id: 'row-1', file, name, size: file.size, sourceFormat, targetFormat, status: 'ready', progress: 0, options };
}

const hwpItem = (options: ConversionQueueItem['options'] = {}) =>
  queueItem('report.hwp', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), 'hwp', 'pdf', options);

async function failureOf(item: ConversionQueueItem): Promise<ConversionFailure> {
  const onError = vi.fn<(failure: ConversionFailure) => void>();
  await executeItemConversion(item, { onProgress: noop, onSuccess: noop, onError });
  expect(onError).toHaveBeenCalledTimes(1);
  return onError.mock.calls[0][0];
}

/** The browser's requests to `/api/convert` answered by the real route handler. */
function serveConvertRoute(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => convertRoute(new NextRequest(new URL(url, 'http://localhost:3000'), init as never))));
}

function answer(body: unknown, status: number): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/problem+json' } })));
}

interface RenderedFailure {
  alert: string;
  details: string | null;
}

function renderedFailure(failure: ConversionFailure, locale: TestLocale): RenderedFailure {
  const item: ConversionQueueItem = { ...hwpItem(), status: 'error', error: failure };
  const dom = renderDom(
    createElement(QueueItemRow, {
      item, isFormatSelectorOpen: false, onToggleFormatSelector: noop, onCloseFormatSelector: noop,
      onSelectTargetFormat: noop, onOpenOptions: noop, onRetry: noop, onRemove: noop,
    }),
    locale
  );
  const [alert] = select(dom, 'p', 'role', 'alert');
  const [details] = select(dom, 'details');
  return { alert: visibleText(alert), details: details ? visibleText(details) : null };
}

function expectKoreanWithDetails(failure: ConversionFailure, englishDetail: string): void {
  const korean = renderedFailure(failure, 'ko');
  expect(korean.alert, JSON.stringify(failure)).toMatch(HANGUL);
  expect(korean.alert, JSON.stringify(failure)).not.toMatch(ENGLISH_PHRASE);
  expect(korean.details, JSON.stringify(failure)).toBe(`기술 정보 ${englishDetail}`);
  expect(renderedFailure(failure, 'en').details).toBe(`Technical details ${englishDetail}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a refusal of /api/convert reads in the page language, with the English text under technical details', () => {
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const cases: Array<[string, ConversionQueueItem, string]> = [
    ['a file whose content is not the format its name says', queueItem('photo.png', new TextEncoder().encode('this is plain text, not a picture'), 'png', 'jpg'), 'spoofed_file'],
    ['a pair the registry cannot convert', queueItem('photo.png', new Uint8Array(PNG_SIGNATURE), 'png', 'docx'), 'unsupported_pair'],
    ['an archive that is damaged', queueItem('broken.zip', new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(60).fill(0x41)]), 'zip', 'tar'), 'malformed_input'],
  ];

  it.each(cases)('words %s by its code', async (_, item, code) => {
    serveConvertRoute();
    const failure = await failureOf(item);
    expect(failure.code).toBe('server');
    const problem = (failure as Extract<ConversionFailure, { code: 'server' }>).problem;
    expect(problem.code).toBe(code);
    expect(typeof problem.error).toBe('string');
    expectKoreanWithDetails(failure, problem.error as string);
    expect(renderedFailure(failure, 'en').alert).not.toContain(problem.error as string);
  });

  it('words every conversion refusal code in Korean', () => {
    for (const code of CONVERSION_REFUSAL_CODES) {
      expectKoreanWithDetails({ code: 'server', problem: { code, error: 'English text.', status: 400 } }, 'English text.');
    }
  });

  it('words an answer with no code it knows by its status class, keeping the English text of a refusal only', () => {
    expectKoreanWithDetails({ code: 'server', problem: { error: 'Unsupported target format "xyz".', status: 400 } }, 'Unsupported target format "xyz".');
    expect(renderedFailure({ code: 'server', problem: { error: 'Worker pool exploded.', status: 500 } }, 'ko')).toMatchObject({ details: null });
    expect(renderedFailure({ code: 'server', problem: { status: 400 } }, 'ko')).toMatchObject({ details: null });
  });
});

describe('the failures the client decides read in the page language', () => {
  it('words them in Korean, with no English sentence', async () => {
    vi.stubGlobal('window', {});
    const failures: ConversionFailure[] = [await failureOf(hwpItem({ clientEdgeMode: true }))];
    answer({ type: 'https://api.easyconvert.io/problems/service-unavailable', title: 'Service Unavailable', status: 503, detail: 'The conversion engine is busy right now.', error: 'The conversion engine is busy right now.' }, 503);
    failures.push(await failureOf(hwpItem()));
    answer({}, 500);
    failures.push(await failureOf(hwpItem()));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    failures.push(await failureOf(hwpItem()));
    failures.push({ code: 'jobTimedOut' }, { code: 'clientEdgeFailed' });

    expect(failures.map((failure) => failure.code)).toEqual(['clientOnlyBlocked', 'server', 'server', 'conversionFailed', 'jobTimedOut', 'clientEdgeFailed']);
    for (const failure of failures) {
      const korean = renderedFailure(failure, 'ko').alert;
      expect(korean, JSON.stringify(failure)).toMatch(HANGUL);
      expect(korean, JSON.stringify(failure)).not.toMatch(ENGLISH_PHRASE);
      expect(renderedFailure(failure, 'en').alert, JSON.stringify(failure)).toMatch(ENGLISH_PHRASE);
    }
    expect(renderedFailure(failures[0], 'ko').alert).toContain('HWP → PDF');
  });

  it('names the browser tier that failed before a client-only refusal, with its error under technical details', () => {
    const failure: ConversionFailure = { code: 'clientOnlyBlocked', source: 'MP4', target: 'FLV', edgeFailure: { tier: 'L1', reason: 'MP4: box overruns its parent' } };
    const korean = renderedFailure(failure, 'ko');
    expect(korean.alert).toMatch(/^MP4 → FLV .*L1/);
    expect(korean.alert).not.toMatch(ENGLISH_PHRASE);
    expect(korean.details).toBe('기술 정보 MP4: box overruns its parent');
  });

  it('keeps the browser error of a client-only conversion under technical details', () => {
    expectKoreanWithDetails({ code: 'clientEdgeFailed', reason: 'WASM module failed to load' }, 'WASM module failed to load');
  });
});

describe('a job that failed on the worker reads as one sentence, with the worker reason under technical details', () => {
  it('shows the generic job sentence and no HTTP status', () => {
    const failure: ConversionFailure = { code: 'jobFailed', reason: 'Worker process exited with code 137.' };
    expectKoreanWithDetails(failure, 'Worker process exited with code 137.');
    expect(renderedFailure(failure, 'ko').alert).not.toMatch(/\d{3}/);
  });

  it('words a job that hit its time limit by the code the worker recorded', () => {
    const korean = renderedFailure({ code: 'jobFailed', reason: 'The conversion exceeded its 600 s limit.', refusalCode: 'timeout' }, 'ko');
    expect(korean.alert).toBe(renderedFailure({ code: 'jobTimedOut' }, 'ko').alert);
  });
});

describe('technical details sit beside the message that is announced, never inside it', () => {
  const liveRegions = (dom: DomElement) => allElements(dom).filter((element) => attrOf(element, 'role') === 'alert' || attrOf(element, 'aria-live') !== null);

  function expectDisclosureOutsideLiveRegions(dom: DomElement): void {
    const [details] = select(dom, 'details');
    expect(details).toBeDefined();
    expect(liveRegions(dom).length).toBeGreaterThan(0);
    for (const region of liveRegions(dom)) expect(select(region, 'details')).toEqual([]);
    const [summary] = select(details, 'summary');
    expect(attrOf(summary, 'class')?.split(' ')).toContain('min-h-[44px]');
  }

  it('keeps the disclosure of a failed queue row out of its alert', () => {
    const item: ConversionQueueItem = { ...hwpItem(), status: 'error', error: { code: 'clientEdgeFailed', reason: 'WASM module failed to load' } };
    expectDisclosureOutsideLiveRegions(renderDom(createElement(QueueItemRow, {
      item, isFormatSelectorOpen: false, onToggleFormatSelector: noop, onCloseFormatSelector: noop,
      onSelectTargetFormat: noop, onOpenOptions: noop, onRetry: noop, onRemove: noop,
    })));
  });

  it('keeps the disclosure of a webhook replay out of its status message', () => {
    expectDisclosureOutsideLiveRegions(renderComponent(WebhooksPanel, {
      entries: [], loading: false, replayingId: null, inspectingEntry: null,
      feedback: { message: 'The replay failed.', technical: 'Endpoint answered HTTP 500.' },
      onRefresh: noop, onClearAll: noop, onDismissFeedback: noop, onInspect: noop, onReplay: noop, onDelete: noop,
    }));
  });
});
