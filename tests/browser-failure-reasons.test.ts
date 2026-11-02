// @vitest-environment jsdom
import { createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ApiDocsPageView from '../src/components/pages/ApiDocsPageView';
import { useFilesAndDlqController } from '../src/components/dashboard/useDashboardResources';
import { useClientQueue } from '../src/hooks/useClientQueue';
import { executeItemConversion } from '../src/lib/client-converter';
import type { ConversionQueueItem } from '../src/lib/types';
import { testMessages, type TestLocale } from './helpers/intl-messages';

/**
 * A failure only the browser sees has no server log: the page words it in its language without the reason, and the English
 * reason goes to the console (entry 141).
 */

vi.mock('../src/components/Header', () => ({ default: () => null }));
vi.mock('../src/components/Footer', () => ({ default: () => null }));
vi.mock('../src/lib/edge/tier-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/edge/tier-router')>()),
  resolveConversionTier: () => {
    throw new Error('the router broke');
  },
}));

const REASON = 'socket hang up';
let root: Root | undefined;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  root?.unmount();
  root = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(element: ReactElement, locale: TestLocale): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(createElement(NextIntlClientProvider, { locale, messages: testMessages(locale), timeZone: 'UTC', children: element }));
  return container;
}

const warnings = () => warn.mock.calls.map((call: unknown[]) => String(call[0]));

describe('the dashboard', () => {
  it('words a webhook that could not be sent again without the reason, and logs the reason in English', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error(REASON);
      return new Response(JSON.stringify(url.includes('dlq') ? { entries: [] } : { files: [] }));
    }));
    let controller: ReturnType<typeof useFilesAndDlqController> | undefined;
    function Probe() {
      controller = useFilesAndDlqController(true, () => undefined);
      return null;
    }
    mount(createElement(Probe), 'ko');
    await vi.waitFor(() => expect(controller).toBeDefined());
    await controller!.handleReplayWebhook('dlq-1');
    await vi.waitFor(() => expect(controller!.dlqFeedback).toBe('다시 전송을 요청하지 못했어요. 연결을 확인해 주세요.'));
    expect(controller!.dlqFeedback).not.toContain(REASON);
    expect(warnings()).toEqual([`Sending a webhook again failed: ${REASON}`]);
  });
});

describe('the API documentation', () => {
  const spec = { openapi: '3.1.0', info: { title: 'API', version: '1' }, paths: {} };

  it('logs why the specification did not load and offers a retry that reads it again', async () => {
    const answers = [() => { throw new Error(REASON); }, () => new Response('{}', { status: 503 }), () => new Response(JSON.stringify(spec))];
    const fetchSpec = vi.fn(async () => answers[Math.min(fetchSpec.mock.calls.length - 1, answers.length - 1)]());
    vi.stubGlobal('fetch', fetchSpec);
    const page = mount(createElement(ApiDocsPageView), 'en');
    await vi.waitFor(() => expect(page.querySelector('[role="alert"]')).not.toBeNull());
    expect(warnings()).toEqual([`Loading the API specification failed: ${REASON}`]);
    const retry = () => page.querySelector<HTMLButtonElement>('[role="alert"] button');
    expect(retry()?.textContent).toBe('Try again');

    retry()!.click();
    await vi.waitFor(() => expect(warnings()).toHaveLength(2));
    expect(warnings()[1]).toBe('Loading the API specification failed: the server answered 503');
    await vi.waitFor(() => expect(retry()).not.toBeNull());

    retry()!.click();
    await vi.waitFor(() => expect(page.querySelector('[role="alert"]')).toBeNull());
    expect(fetchSpec).toHaveBeenCalledTimes(3);
    expect(warnings()).toHaveLength(2);
  });
});

describe('the API documentation retry', () => {
  it('keeps keyboard focus on the page while the specification loads again and on the button when it fails again', async () => {
    let finish: (res: Response) => void = () => undefined;
    const second = new Promise<Response>((resolve) => { finish = resolve; });
    const fetchSpec = vi.fn(async () => (fetchSpec.mock.calls.length === 1 ? new Response('{}', { status: 503 }) : second));
    vi.stubGlobal('fetch', fetchSpec);
    const page = mount(createElement(ApiDocsPageView), 'en');
    const retry = () => page.querySelector<HTMLButtonElement>('[role="alert"] button');
    await vi.waitFor(() => expect(retry()).not.toBeNull());
    retry()!.focus();
    retry()!.click();
    await vi.waitFor(() => expect(page.querySelector('output')).not.toBeNull());
    expect(document.activeElement).toBe(page.querySelector('output'));
    finish(new Response('{}', { status: 503 }));
    await vi.waitFor(() => expect(retry()).not.toBeNull());
    expect(document.activeElement).toBe(retry());
  });
});

describe('the ZIP of the converted files', () => {
  it('says in the page language that the ZIP failed, and logs the reason in English', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'blob:result') throw new Error(REASON);
      return new Response(JSON.stringify({ success: false }), { status: 401 });
    }));
    let queue: ReturnType<typeof useClientQueue> | undefined;
    function Probe() {
      queue = useClientQueue();
      return null;
    }
    mount(createElement(Probe), 'ko');
    await vi.waitFor(() => expect(queue).toBeDefined());
    const done = { id: 'a', name: 'a.png', targetFormat: 'jpg', status: 'completed', resultUrl: 'blob:result' } as ConversionQueueItem;
    queue!.setQueue([done]);
    await queue!.handleDownloadAllZip();
    await vi.waitFor(() => expect(queue!.zipError).toBe(true));
    expect(warnings()).toEqual([`Bundling the converted files into a ZIP failed: ${REASON}`]);
  });
});

describe('the conversion in the browser', () => {
  it('logs why the browser could not convert a file it was told to convert alone, and reports the failure to the queue', async () => {
    const onError = vi.fn();
    const item = {
      id: 'a', name: 'a.png', sourceFormat: 'png', targetFormat: 'jpg', status: 'queued', progress: 0,
      file: new File([new Uint8Array(16)], 'a.png', { type: 'image/png' }), options: { clientEdgeMode: true },
    } as unknown as ConversionQueueItem;
    await executeItemConversion(item, { onProgress: vi.fn(), onStage: vi.fn(), onSuccess: vi.fn(), onError });
    expect(onError).toHaveBeenCalledWith({ code: 'clientEdgeFailed' });
    expect(warnings()).toEqual(['Client edge conversion failed: the router broke']);
  });
});
