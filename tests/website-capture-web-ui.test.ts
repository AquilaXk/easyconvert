// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureAvailabilityProvider } from '../src/components/CaptureAvailabilityProvider';
import { TOOL_ROUTES, toolGroupsFor } from '../src/components/site-links';
import { ANONYMOUS_DAILY_CREDITS } from '../src/lib/plan-limits';
import { parsedSlug } from './helpers/intl';
import { testMessages, type TestLocale } from './helpers/intl-messages';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => Promise.resolve() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));

const { default: ConverterPageView } = await import('../src/components/pages/ConverterPageView');
const { default: Header } = await import('../src/components/Header');

let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 401 })));
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountCaptureSlug(slug: string, locale: TestLocale = 'en'): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      createElement(NextIntlClientProvider, {
        locale,
        messages: testMessages(locale),
        timeZone: 'UTC',
        children: createElement(ConverterPageView, {
          parsed: parsedSlug(slug),
          dailyLimit: ANONYMOUS_DAILY_CREDITS,
        }),
      })
    );
  });
  return host;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('Dedicated URL-input workbench UI for website capture pages', () => {
  it.each([
    ['en', 'save-website-as-pdf', 'Save Website as PDF', 'Save as PDF'],
    ['en', 'website-png-screenshot', 'Website PNG Screenshot', 'Capture PNG'],
    ['en', 'website-jpg-screenshot', 'Website JPG Screenshot', 'Capture JPG'],
    ['ko', 'save-website-as-pdf', '웹사이트 PDF 저장', 'PDF로 저장'],
    ['ko', 'website-png-screenshot', '웹사이트 PNG 스크린샷', 'PNG 캡처'],
    ['ko', 'website-jpg-screenshot', '웹사이트 JPG 스크린샷', 'JPG 캡처'],
  ] as const)(
    'renders URL-only UI in %s on /%s without format tiles, file dropzone, or bottom HTML format cards',
    async (locale, slug, h1Text, submitLabel) => {
      const host = await mountCaptureSlug(slug, locale);
      expect(host.querySelector('main h1')?.textContent).toBe(h1Text);
      expect(host.querySelector('input#capture-url-input')).not.toBeNull();
      expect(host.querySelector('button[type=submit]')?.textContent).toBe(submitLabel);

      // Zero format tiles, zero file inputs/dropzone, zero bottom HTML format cards.
      expect(host.querySelector('[data-testid=hero-source-format-btn]')).toBeNull();
      expect(host.querySelector('[data-testid=hero-target-format-btn]')).toBeNull();
      expect(host.querySelector('input[type=file]')).toBeNull();
      const formatCardSectionLabel = locale === 'en' ? 'Formats' : '형식';
      expect(host.querySelector(`main section[aria-label="${formatCardSectionLabel}"]`)).toBeNull();
      expect(host.textContent).not.toContain('HTML HyperText Markup Language');
    }
  );

  it('validates empty, unsupported schemes, credentials, and non-web ports client-side without calling fetch', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const host = await mountCaptureSlug('save-website-as-pdf', 'en');
    const initialCalls = fetchMock.mock.calls.length;

    const input = host.querySelector<HTMLInputElement>('#capture-url-input')!;
    const form = host.querySelector('form')!;

    for (const [badUrl, expectedText] of [
      ['', 'Enter a web page address first.'],
      ['not-a-url', 'Enter a valid web page address'],
      ['ftp://example.com/file', 'Only public http and https web addresses'],
      ['https://user:pass@example.com/', 'Addresses containing a user name or password'],
      ['https://example.com:8443/', 'Only standard web ports (80 and 443)'],
    ] as const) {
      await act(async () => {
        setInputValue(input, badUrl);
      });
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(host.querySelector('[role=alert]')?.textContent).toContain(expectedText);
      expect(fetchMock.mock.calls.length).toBe(initialCalls);
    }
  });

  it('configures capture options in modal, submits POST /api/capture/jobs, polls until completed, renders download, and resets', async () => {
    let pollCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/viewer/plan') return new Response(JSON.stringify({ success: false }), { status: 401 });
      if (url === '/api/capture/jobs' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ success: true, jobId: 'cap-job-1', status: 'waiting', progress: 0, queue: 'easyconvert-jobs:memory' }),
          { status: 201 }
        );
      }
      if (url === '/api/queue/jobs/cap-job-1') {
        pollCount += 1;
        if (pollCount === 1) {
          return new Response(JSON.stringify({ id: 'cap-job-1', state: 'active', progress: 40 }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            id: 'cap-job-1',
            state: 'completed',
            progress: 100,
            returnvalue: {
              jobId: 'cap-job-1',
              status: 'completed',
              downloadUrl: '/api/storage/file/results%2Fcap-job-1%2Fexample.com.jpg',
              filename: 'example.com.jpg',
              size: 4096,
              warnings: ['1 request blocked'],
            },
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const host = await mountCaptureSlug('website-jpg-screenshot', 'en');
    const optionsBtn = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Options'))!;
    await act(async () => optionsBtn.click());

    const fullPageCheck = document.querySelector<HTMLInputElement>('dialog input[type=checkbox]')!;
    const qualityInput = document.querySelector<HTMLInputElement>('#capture-jpg-quality')!;
    await act(async () => {
      fullPageCheck.click();
      setInputValue(qualityInput, '92');
    });
    const saveBtn = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find((b) => b.textContent === 'Save')!;
    await act(async () => saveBtn.click());
    expect(document.querySelector('dialog')).toBeNull();

    const urlInput = host.querySelector<HTMLInputElement>('#capture-url-input')!;
    await act(async () => setInputValue(urlInput, 'https://example.com'));
    await act(async () => {
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    await vi.waitFor(() => {
      const link = host.querySelector<HTMLAnchorElement>('a[download="example.com.jpg"]');
      expect(link).not.toBeNull();
      expect(link!.getAttribute('href')).toBe('/api/storage/file/results%2Fcap-job-1%2Fexample.com.jpg');
    });

    expect(host.textContent).toContain('Some page requests were blocked');

    const postCall = fetchMock.mock.calls.find(([reqUrl]) => reqUrl === '/api/capture/jobs');
    expect(postCall).toBeDefined();
    const sentBody = JSON.parse(String(postCall![1]?.body));
    expect(sentBody).toEqual({
      url: 'https://example.com',
      targetFormat: 'jpg',
      options: { fullPage: true, quality: 92 },
    });

    const resetBtn = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Capture another URL')!;
    await act(async () => resetBtn.click());
    expect(host.querySelector('a[download]')).toBeNull();
    expect(urlInput.value).toBe('');
  });

  it('allows clearing and typing multi-digit viewport dimensions keystroke-by-keystroke and resets cleanly on format switch', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/viewer/plan') return new Response(JSON.stringify({ success: false }), { status: 401 });
      if (url === '/api/capture/jobs' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ success: true, jobId: 'cap-nav-1', status: 'waiting', progress: 0 }),
          { status: 201 }
        );
      }
      if (url === '/api/queue/jobs/cap-nav-1') {
        return new Response(
          JSON.stringify({
            id: 'cap-nav-1',
            state: 'completed',
            progress: 100,
            returnvalue: {
              jobId: 'cap-nav-1',
              status: 'completed',
              downloadUrl: '/api/storage/file/results%2Fcap-nav-1%2Fexample.com.png',
              filename: 'example.com.png',
              size: 1024,
            },
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    // 1. Start on PDF page, configure PDF options, then switch to PNG page via re-render (same tree position).
    const host = await mountCaptureSlug('save-website-as-pdf', 'en');
    const pdfOptionsBtn = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Options'))!;
    await act(async () => pdfOptionsBtn.click());
    const landscapeCheck = document.querySelector<HTMLInputElement>('dialog input[type=checkbox]')!;
    await act(async () => landscapeCheck.click());
    const pdfSaveBtn = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find((b) => b.textContent === 'Save')!;
    await act(async () => pdfSaveBtn.click());

    await act(async () => {
      root!.render(
        createElement(NextIntlClientProvider, {
          locale: 'en',
          messages: testMessages('en'),
          timeZone: 'UTC',
          children: createElement(ConverterPageView, {
            parsed: parsedSlug('website-png-screenshot'),
            dailyLimit: ANONYMOUS_DAILY_CREDITS,
          }),
        })
      );
    });

    const pngOptionsBtn = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Options'))!;
    await act(async () => pngOptionsBtn.click());

    const widthInput = document.querySelector<HTMLInputElement>('#capture-viewport-width')!;
    const heightInput = document.querySelector<HTMLInputElement>('#capture-viewport-height')!;
    for (const step of ['', '8', '80', '800']) {
      await act(async () => setInputValue(widthInput, step));
      expect(widthInput.value).toBe(step);
    }
    for (const step of ['', '7', '72', '720']) {
      await act(async () => setInputValue(heightInput, step));
      expect(heightInput.value).toBe(step);
    }

    const saveBtn = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find((b) => b.textContent === 'Save')!;
    await act(async () => saveBtn.click());

    await act(async () => setInputValue(host.querySelector<HTMLInputElement>('#capture-url-input')!, 'https://example.com'));
    await act(async () => {
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    await vi.waitFor(() => expect(host.querySelector('a[download="example.com.png"]')).not.toBeNull());
    const postCall = fetchMock.mock.calls.find(([reqUrl]) => reqUrl === '/api/capture/jobs');
    expect(JSON.parse(String(postCall![1]?.body))).toEqual({
      url: 'https://example.com',
      targetFormat: 'png',
      options: { viewport: { width: 800, height: 720 } },
    });

    // Switching to JPG unmounts previous completed PNG result card cleanly.
    await act(async () => {
      root!.render(
        createElement(NextIntlClientProvider, {
          locale: 'en',
          messages: testMessages('en'),
          timeZone: 'UTC',
          children: createElement(ConverterPageView, {
            parsed: parsedSlug('website-jpg-screenshot'),
            dailyLimit: ANONYMOUS_DAILY_CREDITS,
          }),
        })
      );
    });
    expect(host.querySelector('a[download]')).toBeNull();
  });

  it('cancels an active capture job via DELETE /api/queue/jobs/[id]', async () => {
    const deleteCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/viewer/plan') return new Response(JSON.stringify({ success: false }), { status: 401 });
        if (url === '/api/capture/jobs') {
          return new Response(JSON.stringify({ success: true, jobId: 'cap-cancel-1', status: 'waiting', progress: 0 }), { status: 201 });
        }
        if (url === '/api/queue/jobs/cap-cancel-1' && init?.method === 'DELETE') {
          deleteCalls.push(url);
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        if (url === '/api/queue/jobs/cap-cancel-1') {
          return new Response(JSON.stringify({ id: 'cap-cancel-1', state: 'active', progress: 30 }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      })
    );

    const host = await mountCaptureSlug('save-website-as-pdf', 'en');
    await act(async () => setInputValue(host.querySelector<HTMLInputElement>('#capture-url-input')!, 'https://example.com'));
    await act(async () => {
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    await vi.waitFor(() => expect(host.querySelector('progress')).not.toBeNull());
    const cancelBtn = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!;
    await act(async () => cancelBtn.click());

    expect(deleteCalls).toEqual(['/api/queue/jobs/cap-cancel-1']);
    expect(host.querySelector('progress')).toBeNull();
  });

  it('maps server refusals (capture_target_blocked, capture_unavailable, quota_exceeded) in Korean and English without leaking server detail', async () => {
    const cases = [
      {
        locale: 'ko' as const,
        status: 422,
        body: { status: 422, code: 'capture_target_blocked', detail: 'INTERNAL_SECRET_DETAIL_DO_NOT_SHOW' },
        expectedText: '이 주소는 캡처할 수 없습니다. 일반 웹 포트의 공개 웹 페이지만 캡처할 수 있습니다.',
        expectQuotaLinks: false,
      },
      {
        locale: 'en' as const,
        status: 422,
        body: { status: 422, code: 'capture_unavailable', detail: 'INTERNAL_SECRET_DETAIL_DO_NOT_SHOW' },
        expectedText: 'Website capture is not turned on for this server.',
        expectQuotaLinks: false,
      },
      {
        locale: 'en' as const,
        status: 429,
        body: {
          status: 429,
          type: 'https://easyconvert.local/problems/quota-exceeded',
          code: 'quota_exceeded',
          dailyLimit: 10,
          remaining: 0,
          period: 'day',
          detail: 'INTERNAL_SECRET_DETAIL_DO_NOT_SHOW',
        },
        expectedText: 'This job needs more credits than are left. Try again after your credits reset.',
        expectQuotaLinks: true,
      },
    ];

    for (const testCase of cases) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === 'string' ? input : input.toString();
          if (url === '/api/viewer/plan') return new Response(JSON.stringify({ success: false }), { status: 401 });
          if (url === '/api/capture/jobs') {
            return new Response(JSON.stringify(testCase.body), { status: testCase.status });
          }
          return new Response('{}', { status: 404 });
        })
      );

      const host = await mountCaptureSlug('save-website-as-pdf', testCase.locale);
      await act(async () => setInputValue(host.querySelector<HTMLInputElement>('#capture-url-input')!, 'https://example.com'));
      await act(async () => {
        host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      await vi.waitFor(() => {
        const alertText = host.querySelector('[role=alert]')?.textContent ?? '';
        expect(alertText).toBe(testCase.expectedText);
        expect(alertText).not.toContain('INTERNAL_SECRET_DETAIL_DO_NOT_SHOW');
      });

      const actionLinks = [...host.querySelectorAll<HTMLAnchorElement>('main a')].map((a) => a.getAttribute('href'));
      if (testCase.expectQuotaLinks) {
        expect(actionLinks).toEqual(['/auth', '/pricing']);
      } else {
        expect(actionLinks).toEqual([]);
      }

      act(() => root?.unmount());
      root = undefined;
      document.body.innerHTML = '';
    }
  });
});

describe('Header and MobileMenu hide Website Capture navigation when CAPTURE_WEBSITE_ENABLED=false', () => {
  it.each([
    ['en', 'Website Capture', 'Open menu', 'Tools'],
    ['ko', '웹사이트 캡처', '메뉴 열기', '도구'],
  ] as const)(
    'omits websiteCapture section and capture links from both desktop dropdown and mobile menu in %s when disabled',
    async (locale, groupHeading, openMenuLabel, toolsLabel) => {
      expect(toolGroupsFor(false).map((g) => g.key)).not.toContain('websiteCapture');
      expect(toolGroupsFor(true).map((g) => g.key)).toContain('websiteCapture');

      const host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
      await act(async () => {
        root!.render(
          createElement(NextIntlClientProvider, {
            locale,
            messages: testMessages(locale),
            timeZone: 'UTC',
            children: createElement(CaptureAvailabilityProvider, {
              enabled: false,
              children: createElement(Header),
            }),
          })
        );
      });

      const toolsBtn = document.querySelector<HTMLButtonElement>('button[aria-haspopup=true]')!;
      await act(async () => toolsBtn.click());
      const desktopLinks = [...document.querySelectorAll<HTMLAnchorElement>('nav[aria-label] .grid a')];
      expect(desktopLinks).toHaveLength(TOOL_ROUTES.length - 3 + 1);
      const desktopHrefs = desktopLinks.map((a) => a.getAttribute('href') ?? '');
      for (const hiddenSlug of ['save-website-as-pdf', 'website-png-screenshot', 'website-jpg-screenshot']) {
        expect(desktopHrefs.some((h) => h.endsWith(`/${hiddenSlug}`))).toBe(false);
      }
      expect(document.querySelector('nav[aria-label] .grid')?.textContent).not.toContain(groupHeading);

      const mobileMenuBtn = document.querySelector<HTMLButtonElement>(`button[aria-label="${openMenuLabel}"]`)!;
      await act(async () => mobileMenuBtn.click());
      const sheet = document.querySelector<HTMLDialogElement>('dialog')!;
      const mobileToolsBtn = [...sheet.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((b) => b.textContent === toolsLabel)!;
      await act(async () => mobileToolsBtn.click());

      const mobileLinks = [...sheet.querySelectorAll<HTMLAnchorElement>('#mobile-menu-tools a')];
      expect(mobileLinks).toHaveLength(TOOL_ROUTES.length - 3 + 1);
      const mobileHrefs = mobileLinks.map((a) => a.getAttribute('href') ?? '');
      for (const hiddenSlug of ['save-website-as-pdf', 'website-png-screenshot', 'website-jpg-screenshot']) {
        expect(mobileHrefs.some((h) => h.endsWith(`/${hiddenSlug}`))).toBe(false);
      }
      expect(sheet.querySelector('#mobile-menu-tools')?.textContent).not.toContain(groupHeading);
    }
  );
});
