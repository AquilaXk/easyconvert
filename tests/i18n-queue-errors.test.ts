import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import QueueItemRow from '../src/components/workbench/QueueItemRow';
import { executeItemConversion } from '../src/lib/client-converter';
import type { ConversionFailure } from '../src/lib/conversion-failure';
import type { ConversionQueueItem } from '../src/lib/types';
import type { TestLocale } from './helpers/intl';
import { renderDom, select, visibleText } from './helpers/rendered-dom';

/**
 * A conversion that fails in the queue is worded in the page's language: the failures the client decides (client-only
 * mode, a network failure, an answer with no sentence) and the server's typed refusals. The failures come from the real
 * conversion path, with the network answered by the test.
 */

/** Two Latin words in a row: an English sentence or phrase, unlike a format name (`HWP`) or a number. */
const ENGLISH_PHRASE = /[A-Za-z]{2,}[\s,.]+[A-Za-z]{2,}/;

const noop = () => undefined;

function hwpItem(options: ConversionQueueItem['options'] = {}): ConversionQueueItem {
  const file = new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])], 'report.hwp', { type: 'application/x-hwp' });
  return { id: 'row-1', file, name: 'report.hwp', size: file.size, sourceFormat: 'hwp', targetFormat: 'pdf', status: 'ready', progress: 0, options };
}

async function failureOf(item: ConversionQueueItem): Promise<ConversionFailure> {
  const onError = vi.fn<(failure: ConversionFailure) => void>();
  await executeItemConversion(item, { onProgress: noop, onSuccess: noop, onError });
  expect(onError).toHaveBeenCalledTimes(1);
  return onError.mock.calls[0][0];
}

function answer(body: unknown, status: number): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/problem+json' } })));
}

function rowAlert(failure: ConversionFailure, locale: TestLocale): string {
  const item: ConversionQueueItem = { ...hwpItem(), status: 'error', error: failure };
  const dom = renderDom(
    createElement(QueueItemRow, {
      item, isFormatSelectorOpen: false, onToggleFormatSelector: noop, onCloseFormatSelector: noop,
      onSelectTargetFormat: noop, onOpenOptions: noop, onRetry: noop, onRemove: noop,
    }),
    locale
  );
  const [alert] = select(dom, 'p', 'role', 'alert');
  return visibleText(alert);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a failed conversion in the queue reads in the page language', () => {
  it('words the failures of the conversion path in Korean, with no English sentence', async () => {
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
      const korean = rowAlert(failure, 'ko');
      expect(korean, JSON.stringify(failure)).toMatch(/[가-힣]/);
      expect(korean, JSON.stringify(failure)).not.toMatch(ENGLISH_PHRASE);
      expect(rowAlert(failure, 'en'), JSON.stringify(failure)).toMatch(ENGLISH_PHRASE);
    }
    expect(rowAlert(failures[0], 'ko')).toContain('HWP → PDF');
  });

  it('shows an untyped server sentence as the server wrote it', async () => {
    answer({ error: 'Unsupported target format "xyz".' }, 400);
    expect(rowAlert(await failureOf(hwpItem()), 'ko')).toBe('Unsupported target format "xyz".');
  });
});
