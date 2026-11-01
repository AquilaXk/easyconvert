// @vitest-environment jsdom
import { createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
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
import { testMessages } from './helpers/intl-messages';

/**
 * The signed-in dashboard, mounted in a DOM with React's own renderer: each resource is read once per visit, and the
 * wording and formatting hooks keep their identity across renders, so an effect that depends on them runs once.
 */

const ROUTER = { push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() };
vi.mock('../src/i18n/navigation', () => ({ useRouter: () => ROUTER }));

const SETTLE_MS = 400;

const ANSWERS: Record<string, unknown> = {
  '/api/auth/me': { success: true, user: { id: 'user-1', email: 'reader@dashboard.test', name: 'Reader', tier: 'free' } },
  '/api/keys': { success: true, keys: [] },
  '/api/keys/usage': { success: true, usage: { used: 0, limit: 50 } },
  '/api/account/files': { files: [] },
  '/api/webhooks/dlq': { entries: [] },
};

let requests: string[] = [];
let root: Root | undefined;

beforeEach(() => {
  requests = [];
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

function mount(component: () => null): void {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(createElement(NextIntlClientProvider, { locale: 'en', messages: testMessages('en'), timeZone: 'UTC', children: createElement(component) }));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

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
    await settle();
    expect(requestCounts()).toEqual({ '/api/account/files': 1, '/api/webhooks/dlq': 1 });
    expect(renders).toBeLessThan(10);
  });

  it('reads the session, the keys, the usage, the files and the failed deliveries once', async () => {
    mount(function Dashboard() {
      useDashboardController();
      return null;
    });
    await settle();
    expect(requestCounts()).toEqual({
      '/api/auth/me': 1,
      '/api/keys': 1,
      '/api/keys/usage': 1,
      '/api/account/files': 1,
      '/api/webhooks/dlq': 1,
    });
  });
});

describe('the wording and formatting hooks keep their identity across renders', () => {
  it('returns the same function from each hook while the language stays', async () => {
    const seen = new Map<string, Set<unknown>>();
    let rerender: (() => void) | undefined;
    mount(function Hooks() {
      const [, setTick] = useState(0);
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
      for (const [name, value] of Object.entries(hooks)) seen.set(name, (seen.get(name) ?? new Set()).add(value));
      return null;
    });
    await settle();
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
