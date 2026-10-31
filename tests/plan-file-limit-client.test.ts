import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plan } from '../src/lib/plan-limits';
import { fileTooLargeMessage, PLAN_MAX_FILE_BYTES } from '../src/lib/plan-limits';
import {
  getViewerMaxFileBytes,
  getViewerPlan,
  refreshViewerPlan,
  setViewerPlan,
  subscribeViewerPlan,
} from '../src/lib/viewer-plan';
import type { ConversionQueueItem } from '../src/lib/types';
import { attrOf, renderDom, select, visibleText } from './helpers/rendered-dom';

const shownPlan = vi.hoisted(() => ({ current: 'anonymous' as Plan }));

vi.mock('../src/hooks/useViewerPlan', () => ({ useViewerPlan: () => shownPlan.current }));

import HeroDropzoneCard from '../src/components/workbench/HeroDropzoneCard';
import QueueItemRow from '../src/components/workbench/QueueItemRow';
import { buildQueuedFileItem } from '../src/hooks/useClientQueue';

const GIB = 1024 * 1024 * 1024;

function claimedFile(name: string, size: number): File {
  const file = new File([], name);
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

function sessionAnswer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  shownPlan.current = 'anonymous';
  setViewerPlan('anonymous');
});

afterEach(() => {
  vi.unstubAllGlobals();
  setViewerPlan('anonymous');
});

describe('the plan of the viewer', () => {
  it('starts anonymous, so the smallest limit applies before the session answers', () => {
    expect(getViewerPlan()).toBe('anonymous');
    expect(getViewerMaxFileBytes()).toBe(PLAN_MAX_FILE_BYTES.anonymous);
  });

  it.each([
    ['free', PLAN_MAX_FILE_BYTES.free],
    ['pro', PLAN_MAX_FILE_BYTES.pro],
    ['enterprise', PLAN_MAX_FILE_BYTES.enterprise],
  ] as const)('becomes the %s plan when the session says so', async (tier, bytes) => {
    vi.stubGlobal('fetch', vi.fn(async () => sessionAnswer(200, { success: true, user: { id: 'u1', tier } })));
    await refreshViewerPlan();
    expect(getViewerPlan()).toBe(tier);
    expect(getViewerMaxFileBytes()).toBe(bytes);
  });

  it('returns to anonymous when the session endpoint answers 401 after a sign-out', async () => {
    setViewerPlan('pro');
    vi.stubGlobal('fetch', vi.fn(async () => sessionAnswer(401, { success: false })));
    await refreshViewerPlan();
    expect(getViewerPlan()).toBe('anonymous');
  });

  it('keeps the plan it had when the network fails', async () => {
    setViewerPlan('pro');
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    await refreshViewerPlan();
    expect(getViewerPlan()).toBe('pro');
  });

  it('asks the session endpoint once for callers that overlap', async () => {
    const fetchMock = vi.fn(async () => sessionAnswer(200, { success: true, user: { id: 'u1', tier: 'pro' } }));
    vi.stubGlobal('fetch', fetchMock);
    await Promise.all([refreshViewerPlan(), refreshViewerPlan(), refreshViewerPlan()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await refreshViewerPlan();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('tells subscribers once per change and stops after unsubscribing', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeViewerPlan(listener);
    setViewerPlan('pro');
    setViewerPlan('pro');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setViewerPlan('free');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('the drop zone states the limit of the plan', () => {
  const noop = () => undefined;
  const dropzoneText = () =>
    visibleText(
      renderDom(
        createElement(HeroDropzoneCard, {
          isDragOver: false,
          onDragOver: noop,
          onDragLeave: noop,
          onDrop: noop,
          onOpenFileDialog: noop,
          onOpenUrlModal: noop,
        })
      )
    );

  it.each([
    ['anonymous', 'Up to 1 GB per file'],
    ['free', 'Up to 1 GB per file'],
    ['pro', 'Up to 5 GB per file'],
    ['enterprise', 'Up to 10 GB per file'],
  ] as const)('shows "%s" viewers %s', (plan, copy) => {
    shownPlan.current = plan;
    const text = dropzoneText();
    expect(text).toContain(copy);
    expect(text).not.toMatch(/2 GB|100 MB|OPFS/);
  });
});

describe('a file over the limit', () => {
  it.each([
    ['anonymous', GIB + 1, 'File size 1,073,741,825 bytes exceeds the 1 GB limit for anonymous use. Pro allows files up to 5 GB.'],
    ['free', 3 * GIB, 'File size 3 GB exceeds the 1 GB limit for the free plan. Pro allows files up to 5 GB.'],
    ['pro', 6 * GIB, 'File size 6 GB exceeds the 5 GB limit for the Pro plan. Enterprise allows files up to 10 GB.'],
    ['enterprise', 11 * GIB, 'File size 11 GB exceeds the 10 GB limit for the Enterprise plan.'],
  ] as const)('is queued as an error naming the limit and the next plan for %s', (plan, size, message) => {
    const item = buildQueuedFileItem(claimedFile('big.mp4', size), plan);
    expect(item.status).toBe('error');
    expect(item.error).toBe(message);
  });

  it('is queued ready at the limit itself and as an error one byte past it', () => {
    expect(buildQueuedFileItem(claimedFile('a.mp4', PLAN_MAX_FILE_BYTES.pro), 'pro').status).toBe('ready');
    expect(buildQueuedFileItem(claimedFile('a.mp4', PLAN_MAX_FILE_BYTES.pro + 1), 'pro').status).toBe('error');
    expect(buildQueuedFileItem(claimedFile('a.mp4', PLAN_MAX_FILE_BYTES.free + 1), 'free').status).toBe('error');
  });

  function rowFor(size: number, error?: string) {
    const item: ConversionQueueItem = {
      id: 'row-1',
      file: claimedFile('clip.mp4', size),
      name: 'clip.mp4',
      size,
      sourceFormat: 'mp4',
      targetFormat: 'webm',
      status: error ? 'error' : 'ready',
      error,
      progress: 0,
      options: {},
    };
    const noop = () => undefined;
    return renderDom(
      createElement(QueueItemRow, {
        item,
        isFormatSelectorOpen: false,
        onToggleFormatSelector: noop,
        onCloseFormatSelector: noop,
        onSelectTargetFormat: noop,
        onOpenOptions: noop,
        onRetry: noop,
        onRemove: noop,
      })
    );
  }

  it('shows the message on the row and disables the controls for an anonymous viewer', () => {
    const size = 2 * GIB;
    const dom = rowFor(size, fileTooLargeMessage('anonymous', size));
    expect(visibleText(dom)).toContain('File size 2 GB exceeds the 1 GB limit for anonymous use. Pro allows files up to 5 GB.');
    expect(attrOf(select(dom, 'button', 'data-testid', 'queue-target-format-btn')[0], 'disabled')).toBe('');
    expect(attrOf(select(dom, 'button').find((b) => visibleText(b) === 'Retry')!, 'disabled')).toBe('');
  });

  it('leaves the same file convertible for a viewer on the Pro plan', () => {
    shownPlan.current = 'pro';
    const dom = rowFor(2 * GIB);
    expect(attrOf(select(dom, 'button', 'data-testid', 'queue-target-format-btn')[0], 'disabled')).toBeNull();
  });
});
