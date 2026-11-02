// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFilesAndDlqController } from '../src/components/dashboard/useDashboardResources';
import { useApiKeysController } from '../src/components/dashboard/useDashboardController';
import { testMessages } from './helpers/intl-messages';

/**
 * A dashboard list read twice, where the first read answers last: the list shows the newer answer, as a newer request
 * supersedes an older one, so a row deleted between the two reads does not come back.
 */

let root: Root | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** A server whose first answer to `heldUrl` waits until `release` is called; every later read gets the list after the delete. */
function serverHoldingFirstRead(heldUrl: string, before: unknown, after: unknown, others: Record<string, unknown>) {
  let release: () => void = () => undefined;
  let held = false;
  const answer = async (url: string, method: string): Promise<Response> => {
    if (method === 'DELETE') return json({ success: true });
    if (url === heldUrl && !held) {
      held = true;
      await new Promise<void>((resolve) => { release = resolve; });
      return json(before);
    }
    return json(url === heldUrl ? after : others[url] ?? {});
  };
  return { answer, release: () => release() };
}

async function mount<Controller>(answer: (url: string, method: string) => Promise<Response>, useController: () => Controller) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => answer(url, init?.method ?? 'GET')));
  let controller: Controller | undefined;
  function Probe() {
    controller = useController();
    return null;
  }
  root = createRoot(document.createElement('div'));
  root.render(createElement(NextIntlClientProvider, { locale: 'en', messages: testMessages('en'), timeZone: 'UTC', children: createElement(Probe) }));
  await vi.waitFor(() => expect(controller).toBeDefined());
  return { get current() { return controller!; } };
}

const FILE = { id: 'f-1', fileName: 'report.pdf', fromFormat: 'pdf', toFormat: 'docx', size: 10, downloadUrl: '/d', createdAt: 0, expiresAt: 0, remainingSeconds: 3000 };

describe('a dashboard list whose older read answers last', () => {
  it('keeps a deleted file out of the list', async () => {
    const server = serverHoldingFirstRead('/api/account/files', { files: [FILE] }, { files: [] }, { '/api/webhooks/dlq': { entries: [] } });
    const dashboard = await mount(server.answer, () => useFilesAndDlqController(true, () => undefined));
    await dashboard.current.handleDeleteFile('f-1');
    server.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dashboard.current.userFiles).toEqual([]);
    expect(dashboard.current.filesLoading).toBe(false);
  });

  it('keeps a deleted failed webhook out of the list', async () => {
    const server = serverHoldingFirstRead('/api/webhooks/dlq', { entries: [{ id: 'd-1' }] }, { entries: [] }, { '/api/account/files': { files: [] } });
    const dashboard = await mount(server.answer, () => useFilesAndDlqController(true, () => undefined));
    await dashboard.current.handleDeleteDlq('d-1');
    server.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dashboard.current.dlqEntries).toEqual([]);
    expect(dashboard.current.dlqLoading).toBe(false);
  });

  it('shows a revoked key as revoked', async () => {
    const key = { id: 'k-1', name: 'CI', prefix: 'ec_live_', scopes: ['convert:write'], createdAt: 0 };
    const server = serverHoldingFirstRead(
      '/api/keys',
      { success: true, keys: [key] },
      { success: true, keys: [{ ...key, revokedAt: 1 }] },
      { '/api/keys/usage': { success: true, usage: { used: 0, limit: 50 } } }
    );
    const keys = await mount(server.answer, () => useApiKeysController(true, () => undefined));
    keys.current.actions.onConfirmRevoke('k-1');
    await vi.waitFor(() => expect(keys.current.state.apiKeys).toEqual([{ ...key, revokedAt: 1 }]));
    server.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(keys.current.state.apiKeys).toEqual([{ ...key, revokedAt: 1 }]);
  });
});
