// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobsHistoryPanel } from '../src/components/dashboard/JobsHistoryPanel';
import { useFilesAndDlqController } from '../src/components/dashboard/useDashboardResources';
import { useApiKeysController } from '../src/components/dashboard/useDashboardController';
import type { FileWithRemaining } from '../src/components/dashboard/dashboard-types';
import { attrOf, renderDom, select, visibleText } from './helpers/rendered-dom';
import { testMessages, type TestLocale } from './helpers/intl-messages';

/**
 * What the dashboard tells a person about a file and about a refused action: the time a file has left in the largest
 * sensible unit, and a sentence of the page's language for a refusal, never the server's own text.
 */

const noop = () => undefined;

function fileWithSecondsLeft(remainingSeconds: number): FileWithRemaining {
  return {
    id: 'f-1', fileName: 'report.pdf', fromFormat: 'pdf', toFormat: 'docx', size: 2_418_112,
    downloadUrl: '/download', createdAt: 0, expiresAt: 0, remainingSeconds,
  } as FileWithRemaining;
}

function retentionCell(remainingSeconds: number, locale: TestLocale): string {
  const dom = renderDom(createElement(JobsHistoryPanel, { files: [fileWithSecondsLeft(remainingSeconds)], loading: false, onRefresh: noop, onDeleteFile: noop }), locale);
  const cells = select(dom, 'td');
  return visibleText(cells[3]);
}

describe('the time a file has left', () => {
  it.each([
    [0, '곧 삭제', 'Deleted soon'],
    [59, '곧 삭제', 'Deleted soon'],
    [60, '1분 후 삭제', 'Deleted in 1 minute'],
    [120, '2분 후 삭제', 'Deleted in 2 minutes'],
    [3_599, '59분 후 삭제', 'Deleted in 59 minutes'],
    [3_600, '1시간 후 삭제', 'Deleted in 1 hour'],
    [5_400, '1시간 후 삭제', 'Deleted in 1 hour'],
    [82_800, '23시간 후 삭제', 'Deleted in 23 hours'],
    [86_399, '23시간 후 삭제', 'Deleted in 23 hours'],
    [86_400, '1일 후 삭제', 'Deleted in 1 day'],
    [172_800, '2일 후 삭제', 'Deleted in 2 days'],
    [604_799, '6일 후 삭제', 'Deleted in 6 days'],
  ])('reads %i seconds in the largest unit it fills, never rounded up to the next', (seconds, korean, english) => {
    expect(retentionCell(seconds, 'ko')).toBe(korean);
    expect(retentionCell(seconds, 'en')).toBe(english);
  });
});

const routeBody = (error: string) => ({ success: false, error });

describe('a refused dashboard request', () => {
  let root: Root | undefined;
  afterEach(() => {
    root?.unmount();
    root = undefined;
    vi.unstubAllGlobals();
  });

  interface Mounted<Controller> {
    controller: Controller;
    reported: () => string | null;
  }

  async function mountController<Controller>(
    locale: TestLocale,
    answer: (url: string, method: string) => Response | Promise<Response>,
    useController: (onReportError: (error: string | null) => void) => Controller,
    ready: (controller: Controller) => boolean,
  ): Promise<Mounted<Controller>> {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => answer(url, init?.method ?? 'GET')));
    let reported: string | null = null;
    let controller: Controller | undefined;
    function Probe() {
      controller = useController((error) => { reported = error; });
      return null;
    }
    root = createRoot(document.createElement('div'));
    root.render(createElement(NextIntlClientProvider, { locale, messages: testMessages(locale), timeZone: 'UTC', children: createElement(Probe) }));
    await vi.waitFor(() => expect(controller !== undefined && ready(controller)).toBe(true));
    return { get controller() { return controller!; }, reported: () => reported };
  }

  type Dashboard = Mounted<ReturnType<typeof useFilesAndDlqController>>;
  const mountDashboard = (locale: TestLocale, answer: (url: string, method: string) => Response | Promise<Response>): Promise<Dashboard> =>
    mountController(locale, answer, (report) => useFilesAndDlqController(true, report), (c) => c.userFiles.length === 1 && c.dlqEntries.length === 1);

  const FILES_ANSWER = JSON.stringify({ files: [fileWithSecondsLeft(3_000)] });
  const answerWith = (status: number, error: string, other: (url: string, method: string) => Response | Promise<Response> = () => new Response('{}')) =>
    (url: string, method: string) => {
      if (method === 'GET' && url === '/api/account/files') return new Response(FILES_ANSWER, { status: 200 });
      if (method === 'GET') return new Response(JSON.stringify({ entries: [{ id: 'd-1' }] }), { status: 200 });
      return status === 0 ? other(url, method) : new Response(JSON.stringify(routeBody(error)), { status, headers: { 'Content-Type': 'application/json' } });
    };

  it.each([
    [401, 'Unauthorized: Authentication required.', '계속하려면 로그인해 주세요.', 'Sign in to continue.'],
    [403, 'Forbidden: API key lacks admin wildcard (*) scope to clear DLQ.', '이 계정으로는 할 수 없는 작업이에요.', 'This action is not allowed for your account.'],
    [429, 'Too many requests', '짧은 시간에 요청이 너무 많았어요. 잠시 후 다시 시도해 주세요.', 'Too many requests in a short time. Wait a moment and try again.'],
    [503, 'Storage unavailable.', '서비스를 잠시 사용할 수 없어요. 잠시 후 다시 시도해 주세요.', 'The service is temporarily unavailable. Try again shortly.'],
  ])('words a %i answer of a route (a body without a problem type) by its status, not as "try again"', async (status, error, korean, english) => {
    const ko = await mountDashboard('ko', answerWith(status, error));
    await ko.controller.handleClearDlq();
    expect(ko.reported()).toBe(korean);
    root?.unmount();
    const en = await mountDashboard('en', answerWith(status, error));
    await en.controller.handleClearDlq();
    expect(en.reported()).toBe(english);
  });

  it('says a file that is already gone is gone, and drops its row', async () => {
    const ko = await mountDashboard('ko', answerWith(404, 'File record not found or not owned by user.'));
    await ko.controller.handleDeleteFile('f-1');
    expect(ko.reported()).toBe('이미 삭제된 파일이에요.');
    await vi.waitFor(() => expect(ko.controller.userFiles).toHaveLength(0));
    root?.unmount();
    const en = await mountDashboard('en', answerWith(404, 'File record not found or not owned by user.'));
    await en.controller.handleDeleteFile('f-1');
    expect(en.reported()).toBe('The file was already deleted.');
    await vi.waitFor(() => expect(en.controller.userFiles).toHaveLength(0));
  });

  it('says a failed webhook that is already gone is gone, and drops its row', async () => {
    const ko = await mountDashboard('ko', answerWith(404, 'Entry not found.'));
    await ko.controller.handleDeleteDlq('d-1');
    expect(ko.reported()).toBe('이미 삭제된 웹훅이에요.');
    await vi.waitFor(() => expect(ko.controller.dlqEntries).toHaveLength(0));
    root?.unmount();
    const en = await mountDashboard('en', answerWith(404, 'Entry not found.'));
    await en.controller.handleDeleteDlq('d-1');
    expect(en.reported()).toBe('The webhook was already deleted.');
    await vi.waitFor(() => expect(en.controller.dlqEntries).toHaveLength(0));
  });

  describe('an API key', () => {
    const KEY = { id: 'k-1', userId: 'u-1', name: 'build server', prefix: 'ec_live_ab', status: 'active', createdAt: 0 };
    const keysAnswer = (revoke: Response | Promise<Response>) => (url: string, method: string) => {
      if (method === 'DELETE') return revoke;
      if (url === '/api/keys/usage') return new Response(JSON.stringify({ success: true, usage: {} }), { status: 200 });
      return new Response(JSON.stringify({ success: true, keys: [KEY] }), { status: 200 });
    };
    const mountKeys = (locale: TestLocale, revoke: Response | Promise<Response>) =>
      mountController(locale, keysAnswer(revoke), (report) => useApiKeysController(true, report), (c) => c.state.apiKeys.length === 1);
    const notFound = () => new Response(JSON.stringify(routeBody('API key not found.')), { status: 404 });

    it('that is already gone is said to be gone, its row leaves the list and its confirmation closes', async () => {
      const ko = await mountKeys('ko', notFound());
      ko.controller.actions.onRequestRevoke('k-1');
      await vi.waitFor(() => expect(ko.controller.state.revokingKeyId).toBe('k-1'));
      ko.controller.actions.onConfirmRevoke('k-1');
      await vi.waitFor(() => expect(ko.controller.state.apiKeys).toHaveLength(0));
      expect(ko.reported()).toBe('이미 폐기된 API 키예요.');
      expect(ko.controller.state.revokingKeyId).toBeNull();
      root?.unmount();
      const en = await mountKeys('en', notFound());
      en.controller.actions.onConfirmRevoke('k-1');
      await vi.waitFor(() => expect(en.controller.state.apiKeys).toHaveLength(0));
      expect(en.reported()).toBe('The API key was already revoked.');
    });

    it('whose revocation fails with a 500 stays listed with its confirmation open', async () => {
      const ko = await mountKeys('ko', new Response(JSON.stringify(routeBody('Failed to revoke.')), { status: 500 }));
      ko.controller.actions.onRequestRevoke('k-1');
      ko.controller.actions.onConfirmRevoke('k-1');
      await vi.waitFor(() => expect(ko.reported()).toBe('API 키를 폐기하지 못했어요. 잠시 후 다시 시도해 주세요.'));
      expect(ko.controller.state.apiKeys).toHaveLength(1);
      expect(ko.controller.state.revokingKeyId).toBe('k-1');
    });
  });

  it('marks a file as being deleted until its request ends, so its button cannot send a second DELETE', async () => {
    let finish: (res: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    const deletes = vi.fn();
    const dashboard = await mountDashboard('en', answerWith(0, '', (_url, method) => { deletes(method); return pending; }));
    const button = () => select(renderDom(createElement(JobsHistoryPanel, {
      files: dashboard.controller.userFiles, deletingFileIds: dashboard.controller.deletingFileIds, loading: false, onRefresh: noop, onDeleteFile: noop,
    })), 'button').find((b) => attrOf(b, 'aria-label')?.startsWith('Delete'));
    expect(button() && attrOf(button()!, 'disabled')).toBeNull();
    const deletion = dashboard.controller.handleDeleteFile('f-1');
    await vi.waitFor(() => expect(button() && attrOf(button()!, 'disabled')).not.toBeNull());
    expect(deletes).toHaveBeenCalledTimes(1);
    finish(new Response('{}', { status: 200 }));
    await deletion;
    await vi.waitFor(() => expect(dashboard.controller.userFiles).toHaveLength(0));
    expect(dashboard.controller.deletingFileIds).toEqual([]);
  });

  it('keeps the row and words the deletion that failed with a 500, not as a fault of the service in general', async () => {
    const ko = await mountDashboard('ko', answerWith(500, 'Failed to delete file.'));
    await ko.controller.handleDeleteFile('f-1');
    expect(ko.reported()).toBe('파일을 삭제하지 못했어요. 잠시 후 다시 시도해 주세요.');
    expect(ko.controller.userFiles).toHaveLength(1);
    root?.unmount();
    const en = await mountDashboard('en', answerWith(500, 'Failed to delete file.'));
    await en.controller.handleDeleteFile('f-1');
    expect(en.reported()).toBe('Could not delete the file. Try again in a moment.');
  });

  it('words an answer with a problem type of this API by that type, ahead of its status', async () => {
    const typed = { type: 'https://api.easyconvert.io/problems/retired-problem', status: 400, detail: 'Index entry 7 is dangling.' };
    const dashboard = await mountDashboard('ko', (url, method) => (method === 'GET' ? answerWith(0, '')(url, method) : new Response(JSON.stringify(typed), { status: 400 })));
    await dashboard.controller.handleDeleteFile('f-1');
    expect(dashboard.reported()).toBe('파일을 삭제하지 못했어요. 잠시 후 다시 시도해 주세요.');
  });
});
