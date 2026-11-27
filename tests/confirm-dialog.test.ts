// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKey, WebhookDlqEntry } from '../src/lib/api-keys/types';
import { DeleteApiKeyDialog } from '../src/components/dashboard/DeleteApiKeyDialog';
import { JobsHistoryPanel } from '../src/components/dashboard/JobsHistoryPanel';
import { WebhooksPanel } from '../src/components/dashboard/WebhooksPanel';
import { testMessages, type TestLocale } from './helpers/intl-messages';

vi.mock('../src/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/dashboard',
  getPathname: ({ href }: { href: string }) => href,
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => createElement('a', { href }, children),
}));

/**
 * The confirmation dialog of the dashboard: the key name typed to delete an API key, the plain confirmation of a file and of a
 * failed webhook, and what every such dialog does with the keyboard, the busy state and a failure.
 */

const KEY: ApiKey = { id: 'k-1', userId: 'u-1', name: 'build server', prefix: 'ec_live_ab12...', keyHash: 'h', createdAt: 0, status: 'active' };
const noop = () => undefined;

let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  vi.unstubAllGlobals();
});

function mount(element: React.ReactElement, locale: TestLocale = 'en'): void {
  act(() => {
    root = createRoot(host);
    // eslint-disable-next-line react/no-children-prop -- the provider's typing requires `children` as a prop
    root.render(createElement(NextIntlClientProvider, { locale, messages: testMessages(locale), timeZone: 'UTC', children: element }));
  });
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const dialog = () => host.querySelector('dialog');
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('dialog button')].find((candidate) => candidate.textContent?.trim() === label);
const field = () => host.querySelector<HTMLInputElement>('dialog input')!;
const submit = () => act(() => { host.querySelector('dialog form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });

function keyDialog(props: Partial<Parameters<typeof DeleteApiKeyDialog>[0]> = {}, locale: TestLocale = 'en') {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  mount(createElement(DeleteApiKeyDialog, { apiKey: KEY, pending: false, error: null, onConfirm, onClose, ...props }), locale);
  return { onConfirm, onClose };
}

describe('the dialog that deletes an API key', () => {
  it('draws nothing while no key is chosen', () => {
    keyDialog({ apiKey: undefined });
    expect(dialog()).toBeNull();
  });

  it('is a labelled modal that names the key and says what deleting costs, in English and in Korean', () => {
    keyDialog();
    const modal = dialog()!;
    expect(modal.getAttribute('aria-modal')).toBe('true');
    // The panels space their children (`space-y-6` puts a top margin on every child after the first): the dialog must keep its auto margins to stay centred.
    expect(modal.className.split(' ')).toContain('!m-auto');
    expect(document.getElementById(modal.getAttribute('aria-labelledby')!)?.textContent).toBe('Delete API key');
    expect(modal.textContent).toContain('build server');
    expect(modal.textContent).toContain('ec_live_ab12...');
    expect(modal.textContent).toContain('Requests sent with this key are refused at once. A deleted key cannot be restored.');
    expect(button('Delete key')).toBeDefined();
    expect(button('Cancel')).toBeDefined();

    act(() => root?.unmount());
    root = null;
    keyDialog({}, 'ko');
    const ko = dialog()!;
    expect(document.getElementById(ko.getAttribute('aria-labelledby')!)?.textContent).toBe('API 키 삭제');
    expect(ko.textContent).toContain('이 키로 보내는 요청은 즉시 거부됩니다. 삭제한 키는 되돌릴 수 없습니다.');
    expect(button('키 삭제')).toBeDefined();
    expect(button('취소')).toBeDefined();
  });

  it('puts the focus in the name field and keeps the cancel button before the red action', () => {
    keyDialog();
    expect(document.activeElement).toBe(field());
    const buttons = [...host.querySelectorAll('dialog form button')].map((candidate) => candidate.textContent?.trim());
    expect(buttons).toEqual(['Cancel', 'Delete key']);
  });

  it('keeps a tab order of close, name field, cancel and the red action, with the action last', () => {
    keyDialog();
    const order = [...host.querySelectorAll<HTMLElement>('dialog button, dialog input')].map((element) => element.getAttribute('aria-label') || element.textContent?.trim() || element.tagName);
    expect(order).toEqual(['Close delete API key dialog', 'INPUT', 'Cancel', 'Delete key']);
  });

  it('keeps the action off until the typed text, trimmed, is the name of the key, and sends no request for a wrong name', () => {
    const { onConfirm } = keyDialog();
    const action = button('Delete key')!;
    expect(action.disabled).toBe(true);

    typeInto(field(), 'build serve');
    expect(action.disabled).toBe(true);
    submit();
    expect(onConfirm).not.toHaveBeenCalled();

    typeInto(field(), 'Build Server');
    expect(action.disabled).toBe(true);

    typeInto(field(), '  build server  ');
    expect(action.disabled).toBe(false);
    submit();
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith('k-1');
  });

  it('closes by the cancel button, the close button and the close event of Escape', () => {
    const { onClose } = keyDialog();
    act(() => button('Cancel')!.click());
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Close delete API key dialog"]')!.click());
    act(() => dialog()!.dispatchEvent(new Event('close')));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('shows a failure inside the dialog, keeps it open and lets the person confirm again', () => {
    const { onConfirm } = keyDialog({ error: 'Could not delete the API key. Try again in a moment.' });
    expect(host.querySelector('dialog [role="alert"]')?.textContent).toBe('Could not delete the API key. Try again in a moment.');
    typeInto(field(), 'build server');
    submit();
    submit();
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it('is busy while the request runs: the action shows its pending label, nothing closes it, and Escape is not allowed to', () => {
    const { onConfirm, onClose } = keyDialog({ pending: true });
    const action = host.querySelector<HTMLButtonElement>('dialog button[type="submit"]')!;
    expect(action.textContent).toBe('Deleting');
    expect(action.getAttribute('aria-busy')).toBe('true');
    expect(action.disabled).toBe(true);
    expect(button('Cancel')!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Close delete API key dialog"]')!.disabled).toBe(true);
    expect(field().disabled).toBe(true);

    const escape = new Event('cancel', { cancelable: true });
    act(() => { dialog()!.dispatchEvent(escape); });
    expect(escape.defaultPrevented).toBe(true);
    act(() => dialog()!.dispatchEvent(new Event('close')));
    submit();
    expect(onClose).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('lets Escape through when nothing is running', () => {
    keyDialog();
    const escape = new Event('cancel', { cancelable: true });
    act(() => { dialog()!.dispatchEvent(escape); });
    expect(escape.defaultPrevented).toBe(false);
  });

  it('asks for the name again each time it opens', () => {
    keyDialog();
    typeInto(field(), 'build server');
    act(() => root?.unmount());
    root = null;
    keyDialog();
    expect(field().value).toBe('');
    expect(button('Delete key')!.disabled).toBe(true);
  });
});

describe('the plain confirmations of the dashboard', () => {
  const FILE = { id: 'f-1', userId: 'u-1', fileName: 'report.pdf', fromFormat: 'pdf', toFormat: 'docx', size: 10, downloadUrl: '/d', createdAt: 0, expiresAt: 0, remainingSeconds: 600, storageKey: 'k' };
  const ENTRY = { id: 'dlq-1', event: 'job.completed', targetUrl: 'https://example.com/hook', status: 'failed', failedAt: 0, retryCount: 3 } as unknown as WebhookDlqEntry;

  it('asks before a converted file is deleted, names it, and sends nothing until the red button is pressed', () => {
    const onDeleteFile = vi.fn();
    mount(createElement(JobsHistoryPanel, { files: [FILE], deletingFileIds: [], loading: false, onRefresh: noop, onDeleteFile }));
    expect(dialog()).toBeNull();

    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Delete report.pdf"]')!.click());
    expect(dialog()!.textContent).toContain('report.pdf');
    expect(host.querySelector('dialog input')).toBeNull();
    expect(document.activeElement).toBe(button('Cancel'));
    expect(onDeleteFile).not.toHaveBeenCalled();

    act(() => button('Cancel')!.click());
    expect(dialog()).toBeNull();
    expect(onDeleteFile).not.toHaveBeenCalled();

    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Delete report.pdf"]')!.click());
    act(() => button('Delete file')!.click());
    expect(onDeleteFile).toHaveBeenCalledExactlyOnceWith('f-1');
    expect(dialog()).toBeNull();
  });

  const webhooks = (handlers: { onDelete?: () => void; onClearAll?: () => void }) =>
    createElement(WebhooksPanel, {
      entries: [ENTRY], loading: false, replayingId: null, feedback: null, inspectingEntry: null, onRefresh: noop, onClearAll: handlers.onClearAll ?? noop,
      onDismissFeedback: noop, onInspect: noop, onReplay: noop, onDelete: handlers.onDelete ?? noop,
    });

  it('asks before one failed webhook is deleted', () => {
    const onDelete = vi.fn();
    mount(webhooks({ onDelete }));
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Delete failed webhook dlq-1"]')!.click());
    expect(dialog()!.textContent).toContain('dlq-1');
    expect(onDelete).not.toHaveBeenCalled();
    act(() => button('Delete webhook')!.click());
    expect(onDelete).toHaveBeenCalledExactlyOnceWith('dlq-1');
    expect(dialog()).toBeNull();
  });

  it('asks before all failed webhooks are cleared, and says how many', () => {
    const onClearAll = vi.fn();
    mount(webhooks({ onClearAll }));
    act(() => [...host.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === 'Clear all')!.click());
    expect(dialog()!.textContent).toContain('This deletes the failed webhook.');
    expect(onClearAll).not.toHaveBeenCalled();
    act(() => button('Clear all')!.click());
    expect(onClearAll).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });
});

describe('the accessibility of the dialogs', () => {
  const NEEDS_LAYOUT = ['color-contrast', 'target-size', 'scrollable-region-focusable'];
  const audit = async () => {
    // jsdom has no showModal: the attribute is what the browser sets, and axe reads a closed dialog as hidden.
    host.querySelector('dialog')!.setAttribute('open', '');
    const { violations } = await axe.run(host, {
      runOnly: { type: 'tag', values: ['best-practice', 'wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      rules: Object.fromEntries(NEEDS_LAYOUT.map((rule) => [rule, { enabled: false }])),
    });
    return violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`);
  };

  it.each<[TestLocale]>([['en'], ['ko']])('has no axe violation for the key dialog in %s, with a failure shown', async (locale) => {
    keyDialog({ error: 'Could not delete.' }, locale);
    expect(await audit()).toEqual([]);
  });

  it('has no axe violation for the plain confirmation of a file', async () => {
    const FILE = { id: 'f-1', userId: 'u-1', fileName: 'report.pdf', fromFormat: 'pdf', toFormat: 'docx', size: 10, downloadUrl: '/d', createdAt: 0, expiresAt: 0, remainingSeconds: 600, storageKey: 'k' };
    mount(createElement(JobsHistoryPanel, { files: [FILE], deletingFileIds: [], loading: false, onRefresh: noop, onDeleteFile: noop }));
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Delete report.pdf"]')!.click());
    expect(await audit()).toEqual([]);
  });
});
