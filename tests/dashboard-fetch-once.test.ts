// @vitest-environment jsdom
import { createElement, useState } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider, useTimeZone } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDashboardController } from '../src/components/dashboard/useDashboardController';
import { useFilesAndDlqController } from '../src/components/dashboard/useDashboardResources';
import {
  useAuthErrorWording,
  useConversionFailureWording,
  useProblemWording,
  useUrlImportErrorWording,
  useZipFailureWording,
} from '../src/components/i18n/error-wording';
import { useFileLimitCopy, useFileTooLargeMessage, useFormatBytes, useTierLabel } from '../src/components/i18n/format';
import ViewerTimeZone, { browserTimeZone } from '../src/i18n/ViewerTimeZone';
import { testMessages } from './helpers/intl-messages';

/**
 * The signed-in dashboard, rendered on the "server" and hydrated in a DOM with React's own renderer under the providers
 * of a page: the page's message provider in the server's time zone, and ViewerTimeZone, which moves the dates to the
 * browser's zone right after hydration. Each resource is read once per visit, and the wording and formatting hooks keep
 * their identity across renders while the language and the zone stay, so an effect that depends on them runs once.
 *
 * The mount runs without StrictMode, as a production build does. `reactStrictMode` is on in next.config.mjs, and in
 * development StrictMode mounts every effect twice on purpose, so a development server reads each resource twice.
 */

const ROUTER = { push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() };
vi.mock('../src/i18n/navigation', () => ({ useRouter: () => ROUTER }));

const SETTLE_MS = 400;
/** A zone other than the browser's, so hydration is followed by the switch to the browser's zone. */
const SERVER_ZONE = browserTimeZone() === 'UTC' ? 'Asia/Seoul' : 'UTC';
const BROWSER_ZONE = browserTimeZone();

const ANSWERS: Record<string, unknown> = {
  '/api/auth/me': { success: true, user: { id: 'user-1', email: 'reader@dashboard.test', name: 'Reader', tier: 'free' } },
  '/api/keys': { success: true, keys: [] },
  '/api/keys/usage': { success: true, usage: { used: 0, limit: 50 } },
  '/api/account/files': { files: [] },
  '/api/webhooks/dlq': { entries: [] },
};

let requests: string[] = [];
let zones: Array<string | undefined> = [];
let root: Root | undefined;

beforeEach(() => {
  requests = [];
  zones = [];
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requests.push(url);
    return new Response(JSON.stringify(ANSWERS[url] ?? {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});

afterEach(() => {
  root?.unmount();
  root = undefined;
  vi.unstubAllGlobals();
});

function ZoneProbe() {
  zones.push(useTimeZone());
  return null;
}

function page(component: () => null) {
  return createElement(NextIntlClientProvider, {
    locale: 'en',
    messages: testMessages('en'),
    timeZone: SERVER_ZONE,
    children: createElement(ViewerTimeZone, null, createElement(ZoneProbe), createElement(component)),
  });
}

/** Renders `component` to markup as the server does, then hydrates that markup in the DOM. */
function mount(component: () => null): void {
  const container = document.createElement('div');
  container.innerHTML = renderToString(page(component));
  document.body.append(container);
  root = hydrateRoot(container, page(component));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

/** Waits until the dates moved to the browser's zone and `counts` were read, then for any read that follows. */
async function expectReadOnce(counts: Record<string, number>): Promise<void> {
  await vi.waitFor(() => {
    expect(zones).toContain(BROWSER_ZONE);
    expect(requestCounts()).toEqual(counts);
  });
  await settle();
  expect(requestCounts()).toEqual(counts);
}

function requestCounts(): Record<string, number> {
  return requests.reduce<Record<string, number>>((counts, url) => ({ ...counts, [url]: (counts[url] ?? 0) + 1 }), {});
}

describe('the dashboard reads each resource once per visit', () => {
  it('reads the files and the failed deliveries once', async () => {
    let renders = 0;
    const onReportError = () => undefined;
    mount(function FilesAndDlq() {
      renders++;
      useFilesAndDlqController(true, onReportError);
      return null;
    });
    await expectReadOnce({ '/api/account/files': 1, '/api/webhooks/dlq': 1 });
    expect(renders).toBeLessThan(10);
  });

  it('reads the session, the keys, the usage, the files and the failed deliveries once', async () => {
    mount(function Dashboard() {
      useDashboardController();
      return null;
    });
    await expectReadOnce({
      '/api/auth/me': 1,
      '/api/keys': 1,
      '/api/keys/usage': 1,
      '/api/account/files': 1,
      '/api/webhooks/dlq': 1,
    });
  });
});

describe('the wording and formatting hooks keep their identity across renders', () => {
  it('returns the same function from each hook while the language and the zone stay', async () => {
    const seen = new Map<string, Set<unknown>>();
    let rerender: (() => void) | undefined;
    mount(function Hooks() {
      const [, setTick] = useState(0);
      const zone = useTimeZone();
      rerender = () => setTick((tick) => tick + 1);
      const hooks: Record<string, unknown> = {
        useProblemWording: useProblemWording(),
        useUrlImportErrorWording: useUrlImportErrorWording(),
        useAuthErrorWording: useAuthErrorWording(),
        useConversionFailureWording: useConversionFailureWording(),
        useZipFailureWording: useZipFailureWording(),
        useFormatBytes: useFormatBytes(),
        useFileLimitCopy: useFileLimitCopy(),
        useFileTooLargeMessage: useFileTooLargeMessage(),
        useTierLabel: useTierLabel(),
      };
      if (zone !== BROWSER_ZONE) return null;
      for (const [name, value] of Object.entries(hooks)) seen.set(name, (seen.get(name) ?? new Set()).add(value));
      return null;
    });
    await vi.waitFor(() => expect(zones).toContain(BROWSER_ZONE));
    for (let i = 0; i < 3; i++) {
      rerender?.();
      await settle();
    }
    expect(Object.fromEntries([...seen].map(([name, values]) => [name, values.size]))).toEqual({
      useProblemWording: 1,
      useUrlImportErrorWording: 1,
      useAuthErrorWording: 1,
      useConversionFailureWording: 1,
      useZipFailureWording: 1,
      useFormatBytes: 1,
      useFileLimitCopy: 1,
      useFileTooLargeMessage: 1,
      useTierLabel: 1,
    });
  });
});
