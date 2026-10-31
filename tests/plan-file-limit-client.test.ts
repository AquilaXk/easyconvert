import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plan } from '../src/lib/plan-limits';
import { fileTooLargeMessage, PLAN_MAX_FILE_BYTES } from '../src/lib/plan-limits';
import {
  getViewerAccount,
  getViewerMaxFileBytes,
  getViewerPlan,
  refreshViewerPlan,
  setViewerPlan,
  subscribeViewerPlan,
} from '../src/lib/viewer-plan';
import type { ConversionQueueItem } from '../src/lib/types';
import { attrOf, renderDom, select, visibleText } from './helpers/rendered-dom';

const shownPlan = vi.hoisted(() => ({ current: 'anonymous' as Plan }));
const shownAccount = vi.hoisted(() => ({ current: null as { name: string; tier: string } | null }));

vi.mock('../src/hooks/useViewerPlan', () => ({
  useViewerPlan: () => shownPlan.current,
  useViewerAccount: () => shownAccount.current,
}));

import HeroDropzoneCard from '../src/components/workbench/HeroDropzoneCard';
import QueueItemRow from '../src/components/workbench/QueueItemRow';
import UserNav from '../src/components/UserNav';
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
  shownAccount.current = null;
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

describe('the signed-in person of the viewer', () => {
  it('is read from the same session answer as the plan, and cleared when the session ends', async () => {
    expect(getViewerAccount()).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => sessionAnswer(200, { success: true, user: { id: 'u1', name: 'Ada Lovelace', tier: 'pro' } })));
    await refreshViewerPlan();
    expect(getViewerAccount()).toEqual({ name: 'Ada Lovelace', tier: 'pro' });
    expect(getViewerPlan()).toBe('pro');

    vi.stubGlobal('fetch', vi.fn(async () => sessionAnswer(401, { success: false })));
    await refreshViewerPlan();
    expect(getViewerAccount()).toBeNull();
    expect(getViewerPlan()).toBe('anonymous');
  });

  it('keeps the person it had when the network fails and tells subscribers once for the same answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sessionAnswer(200, { success: true, user: { id: 'u1', name: 'Ada', tier: 'free' } })));
    await refreshViewerPlan();
    const listener = vi.fn();
    const unsubscribe = subscribeViewerPlan(listener);

    await refreshViewerPlan();
    expect(listener).not.toHaveBeenCalled();

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    await refreshViewerPlan();
    expect(getViewerAccount()).toEqual({ name: 'Ada', tier: 'free' });
    unsubscribe();
  });

  it('is named by the header from the store, without a request of its own', () => {
    const fetchMock = vi.fn(async () => sessionAnswer(401, { success: false }));
    vi.stubGlobal('fetch', fetchMock);
    shownAccount.current = { name: 'Ada Lovelace', tier: 'pro' };

    const signedIn = visibleText(renderDom(createElement(UserNav, {})));
    expect(signedIn).toContain('Ada');
    expect(signedIn).toContain('pro');
    expect(signedIn).not.toContain('Log In');

    shownAccount.current = null;
    const visitor = visibleText(renderDom(createElement(UserNav, { mobile: true })));
    expect(visitor).toContain('Log In');
    expect(visitor).toContain('Sign Up');
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('lets the viewer cancel a file on its way to the server and names the step', () => {
    const item: ConversionQueueItem = {
      id: 'row-2',
      file: claimedFile('clip.mp4', 200 * 1024 * 1024),
      name: 'clip.mp4',
      size: 200 * 1024 * 1024,
      sourceFormat: 'mp4',
      targetFormat: 'webm',
      status: 'uploading',
      progress: 22,
      options: {},
    };
    const removed = vi.fn();
    const noop = () => undefined;
    const props = {
      item,
      isFormatSelectorOpen: false,
      onToggleFormatSelector: noop,
      onCloseFormatSelector: noop,
      onSelectTargetFormat: noop,
      onOpenOptions: noop,
      onRetry: noop,
      onRemove: removed,
    };

    const uploading = renderDom(createElement(QueueItemRow, props));
    expect(select(uploading, 'progress', 'aria-label', 'Uploading clip.mp4')).toHaveLength(1);
    const cancel = select(uploading, 'button', 'aria-label', 'Cancel clip.mp4')[0];
    expect(attrOf(cancel, 'disabled')).toBeNull();

    const converting = renderDom(createElement(QueueItemRow, { ...props, item: { ...item, status: 'converting' } }));
    expect(select(converting, 'progress', 'aria-label', 'Converting clip.mp4')).toHaveLength(1);
    expect(select(converting, 'button', 'aria-label', 'Remove clip.mp4')).toHaveLength(0);
  });

  it('leaves the same file convertible for a viewer on the Pro plan', () => {
    shownPlan.current = 'pro';
    const dom = rowFor(2 * GIB);
    expect(attrOf(select(dom, 'button', 'data-testid', 'queue-target-format-btn')[0], 'disabled')).toBeNull();
  });
});
