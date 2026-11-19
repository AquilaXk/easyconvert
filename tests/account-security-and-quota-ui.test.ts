// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../src/lib/auth/types';
import type { ConversionQueueItem } from '../src/lib/types';
import { getViewerAccount, getViewerPlan, setViewerPlan, applySessionChange } from '../src/lib/viewer-plan';
import { testMessages, type TestLocale } from './helpers/intl-messages';

const ROUTER = {
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
};

vi.mock('../src/i18n/navigation', () => ({
  useRouter: () => ROUTER,
  usePathname: () => '/dashboard',
  getPathname: ({ href }: { href: string }) => href,
  Link: ({ href, className, children }: { href: string; className?: string; children?: React.ReactNode }) =>
    createElement('a', { href, className }, children),
}));

const { AccountSecurityPanel } = await import('../src/components/dashboard/AccountSecurityPanel');
const { DashboardHeader } = await import('../src/components/dashboard/DashboardHeader');
const { default: BrandLogo } = await import('../src/components/BrandLogo');
const { ContactContent } = await import('../src/components/converter/info-page-sections');
const { default: QueueItemRow } = await import('../src/components/workbench/QueueItemRow');

const EMAIL_USER: User = {
  id: 'usr-email',
  email: 'member@example.com',
  name: 'Member',
  tier: 'free',
  provider: 'email',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  emailVerified: true,
};

const GOOGLE_USER: User = {
  ...EMAIL_USER,
  id: 'usr-google',
  email: 'oauth@example.com',
  provider: 'google',
};

let container: HTMLDivElement;
let root: Root | null = null;

function mount(element: React.ReactElement, locale: TestLocale = 'en'): void {
  act(() => {
    root = createRoot(container);
    root.render(
      createElement(NextIntlClientProvider, {
        locale,
        messages: testMessages(locale),
        timeZone: 'UTC',
        children: element,
      })
    );
  });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  ROUTER.replace.mockReset();
  ROUTER.refresh.mockReset();
  setViewerPlan('anonymous');
});

afterEach(() => {
  act(() => {
    root?.unmount();
    root = null;
  });
  container.remove();
  setViewerPlan('anonymous');
  vi.unstubAllGlobals();
});

describe('AccountSecurityPanel password rotation and self-serve erasure UI', () => {
  it('validates password fields locally and posts /api/auth/password-change on valid submission', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    mount(createElement(AccountSecurityPanel, { user: EMAIL_USER }), 'ko');

    const currentInput = container.querySelector<HTMLInputElement>('#account-current-password')!;
    const newInput = container.querySelector<HTMLInputElement>('#account-new-password')!;
    const confirmInput = container.querySelector<HTMLInputElement>('#account-confirm-password')!;
    const form = currentInput.closest('form')!;

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('모두 입력하세요');
    expect(fetchMock).not.toHaveBeenCalled();

    setInputValue(currentInput, 'OldPass123!');
    setInputValue(newInput, 'short');
    setInputValue(confirmInput, 'short');
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('8자 이상');

    setInputValue(newInput, 'NewPass456!');
    setInputValue(confirmInput, 'Different789!');
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('일치하지 않습니다');

    setInputValue(confirmInput, 'NewPass456!');
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/password-change');
    expect(JSON.parse(String(init.body))).toEqual({
      currentPassword: 'OldPass123!',
      newPassword: 'NewPass456!',
    });
    expect(container.querySelector('output')?.textContent).toContain('비밀번호를 변경했습니다');
    expect(currentInput.value).toBe('');
  });

  it('handles 409 active-job drain notice and 200 erasure with session reset on email accounts', async () => {
    applySessionChange({ id: EMAIL_USER.id, name: EMAIL_USER.name, tier: 'free' });
    expect(getViewerAccount()?.name).toBe('Member');

    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        return new Response(JSON.stringify({ status: 409 }), { status: 409 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    mount(createElement(AccountSecurityPanel, { user: EMAIL_USER }), 'en');

    const openBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.trim() === 'Delete account'
    )!;
    act(() => {
      openBtn.click();
    });

    const dialog = container.querySelector('dialog');
    expect(dialog).not.toBeNull();

    const credInput = container.querySelector<HTMLInputElement>('#account-delete-credential')!;
    const phraseInput = container.querySelector<HTMLInputElement>('#account-delete-phrase')!;
    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Permanently delete account')
    )!;
    expect(confirmBtn.disabled).toBe(true);

    setInputValue(credInput, 'CorrectPass123!');
    setInputValue(phraseInput, 'DELETE');
    expect(confirmBtn.disabled).toBe(false);

    await act(async () => {
      confirmBtn.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Active conversions were stopped');
    expect(ROUTER.replace).not.toHaveBeenCalled();

    await act(async () => {
      confirmBtn.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getViewerPlan()).toBe('anonymous');
    expect(getViewerAccount()).toBeNull();
    expect(ROUTER.replace).toHaveBeenCalledWith('/auth');
  });

  it('shows SSO notice instead of password inputs for Google OAuth accounts and sends confirmEmail on DELETE /api/auth/account', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    mount(createElement(AccountSecurityPanel, { user: GOOGLE_USER }), 'ko');
    expect(container.querySelector('#account-current-password')).toBeNull();
    expect(container.textContent).toContain('Google 계정 설정에서 관리합니다');

    const openBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.trim() === '계정 삭제'
    )!;
    act(() => {
      openBtn.click();
    });

    const emailInput = container.querySelector<HTMLInputElement>('#account-delete-credential')!;
    const phraseInput = container.querySelector<HTMLInputElement>('#account-delete-phrase')!;
    expect(emailInput.type).toBe('email');

    setInputValue(emailInput, 'oauth@example.com');
    setInputValue(phraseInput, 'DELETE');

    await act(async () => {
      emailInput.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/account');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(String(init.body))).toEqual({
      confirm: 'DELETE',
      confirmEmail: 'oauth@example.com',
    });
  });
});

describe('QuotaExhaustedActions on QueueItemRow', () => {
  const quotaFailure = {
    code: 'server' as const,
    problem: {
      type: 'https://api.easyconvert.io/problems/quota-exceeded',
      status: 429,
      dailyLimit: 10,
    },
  };

  function makeRow(error: ConversionQueueItem['error']): ConversionQueueItem {
    return {
      id: 'q-1',
      file: new File([new Uint8Array([1, 2, 3])], 'sample.png'),
      name: 'sample.png',
      size: 3,
      sourceFormat: 'png',
      targetFormat: 'pdf',
      status: 'error',
      progress: 0,
      options: {},
      error,
    };
  }

  it('offers sign-in and credit plan links to anonymous visitors on 429 quota-exceeded', () => {
    setViewerPlan('anonymous');
    mount(
      createElement(QueueItemRow, {
        item: makeRow(quotaFailure),
        onSelectTargetFormat: () => undefined,
        onOpenOptions: () => undefined,
        onRemove: () => undefined,
      }),
      'ko'
    );

    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/auth', '/pricing']);
    expect(container.textContent).toContain('로그인');
    expect(container.textContent).toContain('크레딧 충전하기');
  });

  it('offers only plans link to signed-in free accounts on 429 quota-exceeded and none on non-quota errors', () => {
    setViewerPlan('free');
    mount(
      createElement(QueueItemRow, {
        item: makeRow(quotaFailure),
        onSelectTargetFormat: () => undefined,
        onOpenOptions: () => undefined,
        onRemove: () => undefined,
      }),
      'en'
    );
    expect(Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual(['/pricing']);

    act(() => {
      root?.unmount();
      root = null;
    });
    mount(
      createElement(QueueItemRow, {
        item: makeRow({ code: 'conversionFailed' }),
        onSelectTargetFormat: () => undefined,
        onOpenOptions: () => undefined,
        onRemove: () => undefined,
      }),
      'en'
    );
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });
});

describe('Typography weight hierarchy and Korean contact register', () => {
  it('distinguishes active tab (font-medium) from inactive tabs (font-normal) and keeps BrandLogo within 400..700', () => {
    mount(
      createElement(
        'div',
        null,
        createElement(BrandLogo),
        createElement(DashboardHeader, {
          user: EMAIL_USER,
          activeTab: 'security',
          filesCount: 3,
          dlqCount: 2,
          onSelectTab: () => undefined,
          onLogout: () => undefined,
        })
      ),
      'ko'
    );

    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs).toHaveLength(5);
    const active = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')!;
    const inactive = tabs.filter((tab) => tab.getAttribute('aria-selected') === 'false');
    expect(active.className).toContain('font-medium');
    expect(active.className).not.toContain('font-semibold');
    for (const tab of inactive) {
      expect(tab.className).toContain('font-normal');
      expect(tab.className).not.toContain('font-semibold');
    }
    expect(container.innerHTML).not.toContain('font-extrabold');
  });

  it('renders /ko/contact copy in declarative 합니다체 without ~요 endings or 팀 mentions', () => {
    mount(createElement(ContactContent), 'ko');
    const text = container.textContent ?? '';
    expect(text).toContain('받습니다.');
    expect(text).not.toMatch(/세요|팀/);
  });
});
