// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobsHistoryPanel } from '../src/components/dashboard/JobsHistoryPanel';
import { useFilesAndDlqController } from '../src/components/dashboard/useDashboardResources';
import { useApiKeysController } from '../src/components/dashboard/useDashboardController';
import type { FileWithRemaining } from '../src/components/dashboard/dashboard-types';
import { AccountQuotaPanel } from '../src/components/dashboard/AccountQuotaPanel';
import { ApiKeysPanel } from '../src/components/dashboard/ApiKeysPanel';
import type { QuotaUsage } from '../src/lib/api-keys/types';
import type { User } from '../src/lib/auth/types';
import { FREE_DAILY_CONVERSIONS, TIER_LIMITS } from '../src/lib/plan-limits';
import { attrOf, renderDom, select, visibleText } from './helpers/rendered-dom';
import { testMessages, type TestLocale } from './helpers/intl-messages';

/**
 * What the dashboard tells a person about a file and about a refused action: the time a file has left in the largest
 * sensible unit, and a sentence of the page's language for a refusal, never the server's own text.
 */

const noop = () => undefined;

const keysPanelState = {
  apiKeys: [], quota: null, newKeyName: '', generatedSecret: null, isGeneratingKey: false, showGenerateForm: false,
  copiedKey: false, revokingKeyId: null, selectedScopes: ['convert:write' as const], keyExpiry: '30d' as const,
};
const keysPanelActions = {
  onOpenGenerateForm: noop, onCloseGenerateForm: noop, onDismissGeneratedSecret: noop, onNameChange: noop, onToggleScope: noop,
  onExpiryChange: noop, onGenerateKey: noop, onRequestRevoke: noop, onConfirmRevoke: noop, onCopy: noop,
};

function fileWithSecondsLeft(remainingSeconds: number): FileWithRemaining {
  return {
    id: 'f-1', fileName: 'report.pdf', fromFormat: 'pdf', toFormat: 'docx', size: 2_418_112,
    downloadUrl: '/download', createdAt: 0, expiresAt: 0, remainingSeconds,
  } as FileWithRemaining;
}

function retentionCell(remainingSeconds: number, locale: TestLocale): string {
  const dom = renderDom(createElement(JobsHistoryPanel, { files: [fileWithSecondsLeft(remainingSeconds)], deletingFileIds: [], loading: false, onRefresh: noop, onDeleteFile: noop }), locale);
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

  /** The server of the dashboard: its lists hold one file and one failed webhook until a DELETE reaches it, and every DELETE answers `status`. */
  const answerWith = (status: number, error: string, other: (url: string, method: string) => Response | Promise<Response> = () => new Response('{}')) => {
    let deleted = false;
    return (url: string, method: string) => {
      if (method === 'GET' && url === '/api/account/files') return new Response(JSON.stringify({ files: deleted ? [] : [fileWithSecondsLeft(3_000)] }), { status: 200 });
      if (method === 'GET') return new Response(JSON.stringify({ entries: deleted ? [] : [{ id: 'd-1' }] }), { status: 200 });
      deleted = true;
      return status === 0 ? other(url, method) : new Response(JSON.stringify(routeBody(error)), { status, headers: { 'Content-Type': 'application/json' } });
    };
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

  it('words an untyped refusal of a read with the sentence of the read, since the page sent nothing to check', async () => {
    const refusingReads = (url: string, method: string) => {
      if (method === 'POST') return new Response(JSON.stringify(routeBody('Bad request')), { status: 400 });
      if (url === '/api/account/files') return new Response(JSON.stringify(routeBody('Bad request')), { status: 400 });
      return new Response(JSON.stringify({ entries: [{ id: 'd-1' }] }), { status: 200 });
    };
    const reported: string[] = [];
    const dashboard = await mountController('ko', refusingReads, (report) => useFilesAndDlqController(true, (error) => { if (error) reported.push(error); }), (c) => c.dlqEntries.length === 1);
    await vi.waitFor(() => expect(reported).toContain('변환한 파일을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.'));
    await dashboard.controller.handleReplayWebhook('d-1');
    await vi.waitFor(() => expect(dashboard.controller.dlqFeedback).toBe('웹훅을 다시 전송하지 못했어요.'));
    root?.unmount();

    const keysRefused = (url: string) =>
      url === '/api/keys' ? new Response(JSON.stringify(routeBody('Bad request')), { status: 400 }) : new Response(JSON.stringify({ success: true, usage: {} }));
    const keys = await mountController('en', keysRefused, (report) => useApiKeysController(true, report), () => true);
    await vi.waitFor(() => expect(keys.reported()).toBe('Could not load your API keys. Try again in a moment.'));
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
    const OTHER_KEY = { ...KEY, id: 'k-2', name: 'staging' };
    /** The key routes: the list holds two keys until a revocation reaches the server, which drops `k-1` from it. */
    const keysAnswer = (revoke: Response | Promise<Response>) => {
      let revoked = false;
      return (url: string, method: string) => {
        if (method === 'DELETE') {
          revoked = true;
          return revoke;
        }
        if (url === '/api/keys/usage') return new Response(JSON.stringify({ success: true, usage: {} }), { status: 200 });
        return new Response(JSON.stringify({ success: true, keys: revoked ? [OTHER_KEY] : [KEY, OTHER_KEY] }), { status: 200 });
      };
    };
    const mountKeys = (locale: TestLocale, revoke: Response | Promise<Response>) =>
      mountController(locale, keysAnswer(revoke), (report) => useApiKeysController(true, report), (c) => c.state.apiKeys.length === 2);
    const notFound = () => new Response(JSON.stringify(routeBody('API key not found.')), { status: 404 });

    it('that the server no longer knows is said not to exist, not to be revoked, and its row leaves the list', async () => {
      const ko = await mountKeys('ko', notFound());
      ko.controller.actions.onRequestRevoke('k-1');
      await vi.waitFor(() => expect(ko.controller.state.revokingKeyId).toBe('k-1'));
      ko.controller.actions.onConfirmRevoke('k-1');
      await vi.waitFor(() => expect(ko.controller.state.apiKeys.map((key) => key.id)).toEqual(['k-2']));
      expect(ko.reported()).toBe('이 API 키는 더 이상 없어요.');
      expect(ko.controller.state.revokingKeyId).toBeNull();
      root?.unmount();
      const en = await mountKeys('en', notFound());
      en.controller.actions.onConfirmRevoke('k-1');
      await vi.waitFor(() => expect(en.controller.state.apiKeys.map((key) => key.id)).toEqual(['k-2']));
      expect(en.reported()).toBe('That API key no longer exists.');
    });

    it('closes only its own confirmation when its revocation ends, not one opened for another key meanwhile', async () => {
      let finish: (res: Response) => void = () => undefined;
      const revoke = new Promise<Response>((resolve) => { finish = resolve; });
      const keys = await mountKeys('en', revoke);
      keys.controller.actions.onConfirmRevoke('k-1');
      keys.controller.actions.onRequestRevoke('k-2');
      await vi.waitFor(() => expect(keys.controller.state.revokingKeyId).toBe('k-2'));
      finish(new Response(JSON.stringify({ success: true }), { status: 200 }));
      await vi.waitFor(() => expect(keys.controller.state.apiKeys.map((key) => key.id)).toEqual(['k-2']));
      expect(keys.controller.state.revokingKeyId).toBe('k-2');
    });

    it('is revoked by one request however often its confirmation is pressed while the first is running', async () => {
      let finish: (res: Response) => void = () => undefined;
      const revoke = new Promise<Response>((resolve) => { finish = resolve; });
      const keys = await mountKeys('en', revoke);
      const fetchMock = vi.mocked(fetch);
      keys.controller.actions.onConfirmRevoke('k-1');
      keys.controller.actions.onConfirmRevoke('k-1');
      finish(new Response(JSON.stringify({ success: true }), { status: 200 }));
      await vi.waitFor(() => expect(keys.controller.state.apiKeys).toHaveLength(1));
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
    });

    it('whose revocation fails with a 500 stays listed with its confirmation open', async () => {
      const ko = await mountKeys('ko', new Response(JSON.stringify(routeBody('Failed to revoke.')), { status: 500 }));
      ko.controller.actions.onRequestRevoke('k-1');
      ko.controller.actions.onConfirmRevoke('k-1');
      await vi.waitFor(() => expect(ko.reported()).toBe('API 키를 폐기하지 못했어요. 잠시 후 다시 시도해 주세요.'));
      expect(ko.controller.state.apiKeys).toHaveLength(2);
      expect(ko.controller.state.revokingKeyId).toBe('k-1');
    });

    const answerKeyRoutes = (keysList: Response, create: Response) => (url: string, method: string) => {
      if (method === 'POST') return create;
      if (url === '/api/keys/usage') return new Response(JSON.stringify({ success: true, usage: {} }), { status: 200 });
      return keysList;
    };
    const untyped = (status: number, error: string) => new Response(JSON.stringify(routeBody(error)), { status });
    const coded = (status: number, code: string, error: string) => new Response(JSON.stringify({ ...routeBody(error), code }), { status });
    const listed = () => new Response(JSON.stringify({ success: true, keys: [KEY] }), { status: 200 });

    it.each([
      ['an untyped 401 (the proxy, an older server)', () => untyped(401, 'Unauthorized: Sign in or valid API key required.')],
      ['a 401 with a code outside the closed list', () => coded(401, 'sign_in_required', 'Unauthorized: Sign in or valid API key required.')],
    ])('says to sign in when the key list is answered with %s', async (_label, answer) => {
      let reported: string | null = null;
      const report = (error: string | null) => { reported = error; };
      await mountController('ko', answerKeyRoutes(answer(), listed()), () => useApiKeysController(true, report), () => true);
      await vi.waitFor(() => expect(reported).toBe('계속하려면 로그인해 주세요.'));
    });

    const submit = async (create: Response, locale: TestLocale = 'ko') => {
      const keys = await mountController(locale, answerKeyRoutes(listed(), create), (report) => useApiKeysController(true, report), (c) => c.state.apiKeys.length === 1);
      keys.controller.actions.onGenerateKey({ preventDefault: noop } as React.FormEvent);
      await vi.waitFor(() => expect(keys.controller.state.isGeneratingKey).toBe(false));
      await vi.waitFor(() => expect(keys.reported()).not.toBeNull());
      return keys.reported();
    };

    it.each([
      [429, '짧은 시간에 요청이 너무 많았어요. 잠시 후 다시 시도해 주세요.'],
      [503, '서비스를 잠시 사용할 수 없어요. 잠시 후 다시 시도해 주세요.'],
    ])('words a key creation answered with an untyped %i by the one cause it names', async (status, sentence) => {
      expect(await submit(untyped(status, 'Too many requests'))).toBe(sentence);
    });

    it('words a key creation the route refused for its settings by the code, and an untyped 400 as "check what you entered"', async () => {
      expect(await submit(coded(400, 'invalid_key_settings', "Invalid scope 'admin'."))).toBe('API 키 설정을 확인해 주세요. 이름, 권한 범위, 주소 목록, 만료일 중 맞지 않는 값이 있어요.');
      root?.unmount();
      expect(await submit(untyped(400, "Invalid scope 'admin'."))).toBe('요청을 처리하지 못했어요. 입력한 내용과 고른 설정을 확인해 주세요.');
      root?.unmount();
      expect(await submit(untyped(500, 'connect ECONNREFUSED'))).toBe('API 키를 만들지 못했어요. 잠시 후 다시 시도해 주세요.');
    });
  });

  it('marks a file as being deleted until its request ends, so a second click on its button sends no second DELETE', async () => {
    let finish: (res: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    const answer = answerWith(0, '', () => pending);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => answer(url, init?.method ?? 'GET'));
    vi.stubGlobal('fetch', fetchMock);
    function FilesTab() {
      const files = useFilesAndDlqController(true, noop);
      return createElement(JobsHistoryPanel, {
        files: files.userFiles, deletingFileIds: files.deletingFileIds, loading: files.filesLoading,
        onRefresh: noop, onDeleteFile: (id: string) => { void files.handleDeleteFile(id); },
      });
    }
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    root.render(createElement(NextIntlClientProvider, { locale: 'en', messages: testMessages('en'), timeZone: 'UTC', children: createElement(FilesTab) }));
    const button = () => host.querySelector<HTMLButtonElement>('button[aria-label^="Delete"]');
    await vi.waitFor(() => expect(button()).not.toBeNull());
    button()!.click();
    await vi.waitFor(() => expect(button()!.disabled).toBe(true));
    button()!.click();
    const deletes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE');
    expect(deletes()).toHaveLength(1);
    finish(new Response('{}', { status: 200 }));
    await vi.waitFor(() => expect(button()).toBeNull());
    expect(deletes()).toHaveLength(1);
    host.remove();
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

  it('words a refusal whose problem type this build does not know as "check what you entered", never with its detail', async () => {
    const typed = { type: 'https://api.easyconvert.io/problems/retired-problem', status: 400, detail: 'Index entry 7 is dangling.' };
    const files = answerWith(0, '');
    const dashboard = await mountDashboard('ko', (url, method) => (method === 'GET' ? files(url, method) : new Response(JSON.stringify(typed), { status: 400 })));
    await dashboard.controller.handleDeleteFile('f-1');
    expect(dashboard.reported()).toBe('요청을 처리하지 못했어요. 입력한 내용과 고른 설정을 확인해 주세요.');
  });
});

describe('the daily count on the dashboard', () => {
  const freeUser = { id: 'u-free', email: 'free@example.com', name: 'Free', tier: 'free' } as User;
  const proUser = { ...freeUser, id: 'u-pro', tier: 'pro' } as User;
  const overLimit = { tier: 'free' as const, dailyLimit: FREE_DAILY_CONVERSIONS, usedToday: FREE_DAILY_CONVERSIONS + 5, remaining: 0, resetAt: 0 };

  const usageCount = (user: User, quota: QuotaUsage | null) =>
    visibleText(select(renderDom(createElement(AccountQuotaPanel, { user, quota, apiKeys: [] })), 'div').find((div) => /^[\d,]+ \/ [\d,]+$/.test(visibleText(div)))!);

  it("states the allowance of the account's own plan while the usage has not loaded", () => {
    expect(usageCount(proUser, null)).toBe(`0 / ${TIER_LIMITS.pro}`);
    expect(usageCount(freeUser, null)).toBe(`0 / ${TIER_LIMITS.free}`);
  });

  it('never shows more conversions used than the day allows, for a count made under a larger allowance before a deploy', () => {
    expect(usageCount(freeUser, overLimit)).toBe(`${FREE_DAILY_CONVERSIONS} / ${FREE_DAILY_CONVERSIONS}`);
    const strip = renderDom(createElement(ApiKeysPanel, { state: { ...keysPanelState, quota: overLimit }, actions: keysPanelActions }));
    const used = select(strip, 'span').find((span) => /text-accent-ink/.test(attrOf(span, 'class') ?? ''));
    expect(visibleText(used!)).toBe(String(FREE_DAILY_CONVERSIONS));
  });
});
