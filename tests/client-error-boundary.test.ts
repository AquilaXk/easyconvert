// @vitest-environment jsdom
import { createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testMessages } from './helpers/intl-messages';

/** The error boundaries of the pages report the error they caught, once, and show the page they showed before. */

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => '/ko/pdf-to-jpg',
}));

let root: Root | undefined;
let fetchStub: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
  fetchStub = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchStub);
  // A page boundary renders <html> inside a test container, which React reports as a nesting warning.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  root?.unmount();
  root = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function provided(element: ReactElement): ReactElement {
  return createElement(NextIntlClientProvider, { locale: 'en', messages: testMessages('en'), timeZone: 'UTC', children: element });
}

function mount(element: ReactElement): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(provided(element));
  return container;
}

const bodies = () => fetchStub.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>);

describe('useReportBoundaryError', () => {
  it('reports the error once as a boundary report, however often the component renders', async () => {
    const { useReportBoundaryError } = await import('../src/lib/client-errors/use-report-boundary-error');
    const error = Object.assign(new Error('render failed'), { digest: 'abc123' });
    function Probe({ tick }: Readonly<{ tick: number }>) {
      useReportBoundaryError(error);
      return createElement('p', null, tick);
    }
    mount(createElement(Probe, { tick: 1 }));
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1));
    root!.render(provided(createElement(Probe, { tick: 2 })));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bodies()).toEqual([expect.objectContaining({ kind: 'boundary', name: 'Error', message: 'render failed', digest: 'abc123' })]);
  });

  it('reports a new error that the boundary catches after a retry', async () => {
    const { useReportBoundaryError } = await import('../src/lib/client-errors/use-report-boundary-error');
    function Probe({ error }: Readonly<{ error: Error }>) {
      useReportBoundaryError(error);
      return null;
    }
    const wrap = (error: Error) => provided(createElement(Probe, { error }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(wrap(new Error('first')));
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1));
    root.render(wrap(new Error('second')));
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(2));
    expect(bodies().map((body) => body.message)).toEqual(['first', 'second']);
  });
});

describe('the boundaries of the app', () => {
  it('reports the error of a page under a locale and keeps its page', async () => {
    const { default: LocaleError } = await import('../src/app/[locale]/error');
    const container = mount(createElement(LocaleError, { error: new Error('page crashed'), reset: () => undefined }));
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1));
    expect(bodies()[0]).toMatchObject({ kind: 'boundary', message: 'page crashed' });
    expect(container.querySelector('main')).not.toBeNull();
  });

  it('reports the error of the root layout and keeps its page', async () => {
    const { default: GlobalError } = await import('../src/app/global-error');
    const container = mount(createElement(GlobalError, { error: new Error('layout crashed'), reset: () => undefined }));
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1));
    expect(bodies()[0]).toMatchObject({ kind: 'boundary', message: 'layout crashed' });
    expect(container.querySelector('main')).not.toBeNull();
  });
});
