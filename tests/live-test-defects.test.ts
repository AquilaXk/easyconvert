// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChargeEntry, QuotaUsage } from '../src/lib/api-keys/types';
import type { User, UserTier } from '../src/lib/auth/types';
import type { ConversionQueueItem } from '../src/lib/types';
import {
  executeServerlessCloudFallback,
  filenameFromContentDisposition,
} from '../src/lib/edge/pipelines/fallback-pipeline';
import { executeResumableCloudConversion, type ResumableTiming } from '../src/lib/edge/pipelines/resumable-cloud-pipeline';
import { executeItemConversion, tryProcessClientEdge } from '../src/lib/client-converter';
import * as tierRouter from '../src/lib/edge/tier-router';
import { persistCompletedServerQueue, restoreCompletedServerQueue } from '../src/lib/queue-session-persistence';
import { validateApiAccess } from '../src/lib/api-keys/guard';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { RedisUserStore } from '../src/lib/auth/redis-user-store';
import { userStore } from '../src/lib/auth/user-store';
import { setViewerPlan, applySessionChange } from '../src/lib/viewer-plan';
import { countsAsAnonymousForConversions } from '../src/lib/auth/email-verified';
import { registerSessionCleanupOnPageExit } from '../src/lib/edge/opfs/storage-gc';
import { WEB_TOOLS } from '../src/lib/tools/tool-names';
import { testMessages, type TestLocale } from './helpers/intl-messages';

const searchState = vi.hoisted(() => ({ tab: '' }));

vi.mock('../src/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard',
  getPathname: ({ href }: { href: string }) => href,
  Link: ({ href, className, children }: { href: string; className?: string; children?: React.ReactNode }) =>
    createElement('a', { href, className }, children),
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useSearchParams: () => new URLSearchParams(searchState.tab ? `tab=${searchState.tab}` : ''),
}));

const { RecentCharges } = await import('../src/components/dashboard/RecentCharges');
const { AccountQuotaPanel } = await import('../src/components/dashboard/AccountQuotaPanel');
const { useDashboardController } = await import('../src/components/dashboard/useDashboardController');
const { default: QueueItemRow } = await import('../src/components/workbench/QueueItemRow');
const { default: ConversionQueue } = await import('../src/components/ConversionQueue');
const { buildQueuedFileItem, useClientQueue } = await import('../src/hooks/useClientQueue');

let container: HTMLDivElement | undefined;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

function mountDom(element: ReactElement, locale: TestLocale = 'en'): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(
      createElement(NextIntlClientProvider, {
        locale,
        messages: testMessages(locale),
        timeZone: 'UTC',
        children: element,
      })
    );
  });
  return container;
}

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = undefined;
  searchState.tab = '';
  setViewerPlan('anonymous');
  applySessionChange(null);
  sessionStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('1. Dedicated Edge Workers avoid typeof-window dead-code stripping and forward capabilities', () => {
  const WORKER_FILES = [
    'src/lib/edge/workers/opfs-vfs.worker.ts',
    'src/lib/edge/workers/wasm-engine.worker.ts',
    'src/lib/edge/workers/webcodecs.worker.ts',
  ];

  it.each(WORKER_FILES)('%s uses isDedicatedWorkerScope rather than typeof window === undefined', (relPath) => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', relPath), 'utf8');
    expect(source).not.toMatch(/typeof\s+window\s*===\s*['"]undefined['"]/);
    expect(source).toContain('isDedicatedWorkerScope');
    const helperSource = fs.readFileSync(path.resolve(__dirname, '..', 'src/lib/edge/workers/worker-scope.ts'), 'utf8');
    expect(helperSource).not.toMatch(/typeof\s+window\s*===\s*['"]undefined['"]/);
    expect(helperSource).toContain('WorkerGlobalScope');
  });

  const PIPELINE_WORKER_CALLERS = [
    'src/lib/edge/pipelines/opfs-streaming-pipeline.ts',
    'src/lib/edge/pipelines/wasm-simd-pipeline.ts',
    'src/lib/edge/pipelines/webcodecs-pipeline.ts',
  ];

  it.each(PIPELINE_WORKER_CALLERS)('%s instantiates classic Worker without type: module for Next.js importScripts chunk loading', (relPath) => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', relPath), 'utf8');
    expect(source).toContain('new Worker(');
    expect(source).not.toMatch(/type:\s*['"]module['"]/);
  });

  it('attaches self.onmessage inside a WorkerGlobalScope and handles messages without touching non-worker envs', async () => {
    class FakeWorkerGlobalScope {
      postMessage = vi.fn();
      onmessage: ((e: MessageEvent) => Promise<void> | void) | null = null;
    }
    const workerGlobal = new FakeWorkerGlobalScope();
    vi.stubGlobal('WorkerGlobalScope', FakeWorkerGlobalScope);
    vi.stubGlobal('self', workerGlobal);

    vi.resetModules();
    await import('../src/lib/edge/workers/opfs-vfs.worker');
    expect(typeof workerGlobal.onmessage).toBe('function');

    await workerGlobal.onmessage!({
      data: {
        type: 'START_OPFS_STREAM',
        jobId: 'bad-1',
        sourceFormat: 'mp4',
        targetFormat: 'webm',
        totalSize: 16,
        file: new Blob(['0123456789abcdef']),
      },
    } as MessageEvent);
    expect(workerGlobal.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ERROR', jobId: 'bad-1' }),
      []
    );
  });

  it('passes probed EdgeCapabilities (e.g. hasWebCodecsVideo, deviceMemory) from tryProcessClientEdge to resolveConversionTier', async () => {
    const probed: tierRouter.EdgeCapabilities = {
      hasWebCodecsVideo: true,
      hasWebCodecsAudio: true,
      hasOpfsSyncAccess: true,
      hasWasmSimd: true,
      hasCanvas: true,
      isCrossOriginIsolated: false,
      hardwareConcurrency: 8,
      deviceMemory: 8,
      hasWebGpu: false,
      supportedVideoEncoders: ['avc1.42001e'],
      supportedAudioEncoders: ['opus'],
    };
    const probeSpy = vi.spyOn(tierRouter, 'probeEdgeCapabilities').mockResolvedValue(probed);
    const resolveSpy = vi.spyOn(tierRouter, 'resolveConversionTier').mockReturnValue({
      tier: 'L4',
      tierName: 'Cloud',
      isClientEdge: false,
      reason: 'Delegated in test',
    });

    const item: ConversionQueueItem = {
      id: 'cap-1',
      file: new File(['id,name\n1,a\n'], 'big.csv', { type: 'text/csv' }),
      name: 'big.csv',
      size: 105 * 1024 * 1024,
      sourceFormat: 'csv',
      targetFormat: 'tsv',
      status: 'ready',
      options: {},
    };

    const result = await tryProcessClientEdge(item);
    expect(result).toBeNull();
    expect(probeSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalledWith('csv', 'tsv', item.size, item.options, probed);
  });
});

describe('2. Multi-page PDF to image preserves server .zip filename instead of forcing targetFormat extension', () => {
  it('parses RFC 5987 filename* and plain filename parameters cleanly', () => {
    expect(
      filenameFromContentDisposition('attachment; filename="report.zip"; filename*=UTF-8\'\'report.zip')
    ).toBe('report.zip');
    expect(
      filenameFromContentDisposition("attachment; filename=\"___.zip\"; filename*=UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C.zip")
    ).toBe('보고서.zip');
    expect(filenameFromContentDisposition('attachment; filename="../escape/bad.zip"')).toBe('bad.zip');
    expect(filenameFromContentDisposition(null)).toBeUndefined();
  });

  it('propagates .zip filename from /api/convert through executeItemConversion and renders <a download="*.zip"> in QueueItemRow', async () => {
    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:mock-pdf-pages-zip',
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(zipBytes, {
          status: 200,
          headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': "attachment; filename=\"slides.zip\"; filename*=UTF-8''%EB%B0%9C%ED%91%9C%20%EC%9E%90%EB%A3%8C.zip",
          },
        })
      )
    );

    const item: ConversionQueueItem = {
      id: 'pdf-zip-1',
      file: new File(['%PDF-1.4\n'], '발표 자료.pdf', { type: 'application/pdf' }),
      name: '발표 자료.pdf',
      size: 9,
      sourceFormat: 'pdf',
      targetFormat: 'jpg',
      status: 'ready',
      options: { clientEdgeMode: false },
    };

    const cloudRes = await executeServerlessCloudFallback(item.file, item.targetFormat);
    expect(cloudRes.filename).toBe('발표 자료.zip');

    const onOutputFilename = vi.fn();
    const onSuccess = vi.fn();
    await executeItemConversion(item, { onProgress: vi.fn(), onStage: vi.fn(), onOutputFilename, onSuccess, onError: vi.fn() });
    expect(onOutputFilename).toHaveBeenCalledWith('발표 자료.zip');
    expect(onSuccess).toHaveBeenCalledWith(
      'blob:mock-pdf-pages-zip',
      zipBytes.length,
      false,
      'Cloud',
      undefined,
      undefined
    );

    const completedItem: ConversionQueueItem = {
      ...item,
      status: 'completed',
      progress: 100,
      resultUrl: 'blob:mock-pdf-pages-zip',
      resultSize: zipBytes.length,
      resultFilename: '발표 자료.zip',
    };
    const host = mountDom(
      createElement(QueueItemRow, {
        item: completedItem,
        onSelectTargetFormat: vi.fn(),
        onOpenOptions: vi.fn(),
        onRemove: vi.fn(),
      }),
      'ko'
    );
    const link = host.querySelector('a[download]');
    expect(link?.getAttribute('download')).toBe('발표 자료.zip');
  });

  it('infers .zip when /api/convert answers application/zip without Content-Disposition and preserves filename on resumable jobs & sessionStorage', async () => {
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:zip-only', revokeObjectURL: vi.fn() });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/convert') {
          return new Response(new Uint8Array([0x50, 0x4b]), {
            status: 200,
            headers: { 'Content-Type': 'application/zip' },
          });
        }
        if (url.includes('action=initiate')) {
          return new Response(JSON.stringify({ uploadId: 'up-zip', key: 'k', partSize: 64 * 1024 * 1024 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('action=chunk')) {
          return new Response(JSON.stringify({ etag: 'etag-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('action=complete')) {
          return new Response(JSON.stringify({ key: 'uploads/up-zip_deck.pdf' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url === '/api/queue/jobs' && init?.method === 'POST') {
          return new Response(JSON.stringify({ jobId: 'job-zip-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url === '/api/queue/jobs/job-zip-1') {
          return new Response(
            JSON.stringify({
              id: 'job-zip-1',
              state: 'completed',
              progress: 100,
              returnvalue: {
                downloadUrl: '/api/storage/file/res-zip-1',
                size: 4096,
                filename: 'deck.zip',
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response('{}', { status: 404 });
      })
    );

    const inferred = await executeServerlessCloudFallback(new File(['%PDF'], 'deck.pdf'), 'png');
    expect(inferred.filename).toBe('deck.zip');

    const timing: ResumableTiming = { pollIntervalMs: 0, retryDelayMs: 0, maxWaitMs: 5000, partInFlightWaitMs: 5000 };
    const resumable = await executeResumableCloudConversion(
      new File(['%PDF'], 'deck.pdf'),
      'png',
      {},
      { onProgress: vi.fn() },
      timing
    );
    expect(resumable.filename).toBe('deck.zip');

    const serverItem: ConversionQueueItem = {
      id: 'srv-zip-1',
      file: new File([], 'deck.pdf'),
      name: 'deck.pdf',
      size: 1024,
      sourceFormat: 'pdf',
      targetFormat: 'png',
      status: 'completed',
      progress: 100,
      options: {},
      resultUrl: '/api/storage/file/res-zip-1',
      resultSize: 4096,
      resultFilename: 'deck.zip',
    };
    persistCompletedServerQueue([serverItem], 'test-zip');
    const restored = restoreCompletedServerQueue('test-zip');
    expect(restored[0]?.resultFilename).toBe('deck.zip');
  });
});

describe('3. Legacy enterprise account tier normalizes safely across user store, key store, burst limiter, and UI', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-26T12:00:00.000Z'));
  });

  it('normalizes retired enterprise tier in RedisUserStore reads and clamps burst limit + withCreditTier to free when uncredited', async () => {
    const rawMap = new Map<string, string>();
    const fakeRedis = {
      get: async (k: string) => rawMap.get(k) ?? null,
    };
    const store = new RedisUserStore({ redisClient: fakeRedis as never, keyPrefix: 'test:{user}:' });
    const legacyRecord = {
      id: 'usr_legacy_ent',
      email: 'legacy@ent.test',
      name: 'Legacy QA',
      tier: 'enterprise',
      provider: 'email',
      emailVerified: true,
      createdAt: 1000,
      updatedAt: 1000,
    };
    rawMap.set('test:{user}:usr_legacy_ent', JSON.stringify(legacyRecord));

    const loaded = await store.findById('usr_legacy_ent');
    expect(loaded?.tier).toBe('free');

    const legacyUserObj = { id: 'usr_legacy_credit_check', tier: 'enterprise' as UserTier };
    const zeroBalanceTier = await redisKeyStore.withCreditTier(legacyUserObj);
    expect(zeroBalanceTier.tier).toBe('free');

    // Legacy user record stored in memory with un-migrated 'enterprise' tier string still gets free burst cap (20), not fallback default (50)
    const created = await userStore.createUser({
      email: `ent_guard_${Math.random()}@ent.test`,
      name: 'Enterprise Guard',
      tier: 'enterprise' as UserTier,
      emailVerified: true,
    });
    const { secretKey } = await redisKeyStore.generateApiKey(created.id, 'ent-key', { scopes: ['*'] });
    let authorized = 0;
    for (let i = 0; i < 25; i++) {
      const auth = await validateApiAccess(
        new NextRequest('http://localhost:3000/api/v1/jobs', { headers: { Authorization: `Bearer ${secretKey}` } }),
        0
      );
      if (auth.authorized) authorized++;
    }
    expect(authorized).toBe(20);
  });

  it('displays normalized Free tier badge in AccountQuotaPanel instead of raw legacy tier', () => {
    const user: User = {
      id: 'u-ent',
      email: 'qa@example.com',
      name: 'QA',
      tier: 'free',
      provider: 'email',
      createdAt: 0,
      updatedAt: 0,
    };
    const quota: QuotaUsage = {
      tier: 'free',
      period: 'day',
      dailyLimit: 10,
      usedToday: 9,
      remaining: 1,
      resetAt: Date.UTC(2026, 11, 2),
      packageCredits: 0,
      promoCredits: 0,
    };
    const host = mountDom(
      createElement(AccountQuotaPanel, { user, quota, apiKeys: [], charges: [] }),
      'en'
    );
    const texts = Array.from(host.querySelectorAll('span, p')).map((el) => el.textContent?.trim());
    expect(texts).toContain('Plan: Free');
    expect(texts.find((text) => text?.includes('left today'))).toBe('1 credit left today');
  });
});

describe('4. UI/UX defects: RecentCharges translations, English plurals, ?tab=usage, 0B & unsupported blocking, multipart abort', () => {
  it('translates capture.website pairs and all WEB_TOOLS charge entries in English and Korean', () => {
    const toolCharges: ChargeEntry[] = [
      { at: Date.UTC(2026, 10, 26, 8, 0), from: 'capture.website', to: 'pdf', base: 1, credits: 1, fromPackage: 0 },
      { at: Date.UTC(2026, 10, 26, 8, 1), from: 'capture.website', to: 'png', base: 1, credits: 1, fromPackage: 0 },
      ...WEB_TOOLS.map((tool, index) => ({
        at: Date.UTC(2026, 10, 26, 8, 2 + index),
        from: tool,
        base: 1,
        credits: 1,
        fromPackage: 0,
      })),
    ];

    const enHost = mountDom(createElement(RecentCharges, { charges: toolCharges }), 'en');
    expect(enHost.textContent).toContain('Website to PDF');
    expect(enHost.textContent).toContain('Website to PNG');
    expect(enHost.textContent).toContain('Merge PDF');
    expect(enHost.textContent).toContain('Create archive');
    expect(enHost.textContent).not.toContain('CAPTURE.WEBSITE');
    expect(enHost.textContent).not.toMatch(/\bmerge\b/);

    act(() => {
      root?.unmount();
      root = null;
    });

    const koHost = mountDom(createElement(RecentCharges, { charges: toolCharges }), 'ko');
    expect(koHost.textContent).toContain('웹 페이지 → PDF');
    expect(koHost.textContent).toContain('PDF 병합');
    expect(koHost.textContent).toContain('압축 파일 만들기');
    expect(koHost.textContent).not.toContain('CAPTURE.WEBSITE');
  });

  it('pluralizes English subscription & daily remaining credits correctly for 1 vs >1', () => {
    const user: User = { id: 'u-p', email: 'p@example.com', name: 'P', tier: 'paid', provider: 'email', createdAt: 0, updatedAt: 0 };
    const monthOneLeft: QuotaUsage = {
      tier: 'paid',
      period: 'month',
      dailyLimit: 1000,
      usedToday: 999,
      remaining: 1,
      resetAt: Date.UTC(2026, 11, 2),
      packageCredits: 0,
      promoCredits: 0,
    };
    const host = mountDom(createElement(AccountQuotaPanel, { user, quota: monthOneLeft, apiKeys: [], charges: [] }), 'en');
    const remainingText = Array.from(host.querySelectorAll('p'))
      .map((el) => el.textContent?.trim())
      .find((text) => text?.includes('left this period'));
    expect(remainingText).toBe('1 subscription credit left this period');

    act(() => {
      root?.unmount();
      root = null;
    });
    const twoLeftHost = mountDom(
      createElement(AccountQuotaPanel, { user, quota: { ...monthOneLeft, usedToday: 998, remaining: 2 }, apiKeys: [], charges: [] }),
      'en'
    );
    const twoRemainingText = Array.from(twoLeftHost.querySelectorAll('p'))
      .map((el) => el.textContent?.trim())
      .find((text) => text?.includes('left this period'));
    expect(twoRemainingText).toBe('2 subscription credits left this period');
  });

  it('initializes useDashboardController activeTab from ?tab=usage and falls back to api for invalid tab values', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/auth/me') {
          return new Response(JSON.stringify({ success: true, user: { id: 'u1', email: 'a@b.test', name: 'A', tier: 'free' } }), { status: 200 });
        }
        return new Response(JSON.stringify({ success: true, keys: [], files: [], entries: [] }), { status: 200 });
      })
    );

    searchState.tab = 'usage';
    let controller: ReturnType<typeof useDashboardController> | undefined;
    function Probe() {
      controller = useDashboardController();
      return null;
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'en',
        messages: testMessages('en'),
        timeZone: 'UTC',
        children: createElement(Probe),
      })
    );
    await vi.waitFor(() => expect(controller?.activeTab).toBe('usage'));

    act(() => {
      root?.unmount();
      root = null;
    });
    searchState.tab = 'not-a-tab';
    root = createRoot(container);
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'en',
        messages: testMessages('en'),
        timeZone: 'UTC',
        children: createElement(Probe),
      })
    );
    await vi.waitFor(() => expect(controller?.activeTab).toBe('api'));
  });

  it('blocks 0B files and unsupported extensions in UI, ConversionQueue, and useClientQueue before conversion runs', async () => {
    const fetchSpy = vi.fn(async (_input: string | URL) =>
      new Response(JSON.stringify({ success: false, authenticated: false, user: null, paidPlansOnSale: false }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchSpy);

    const unsupportedOnPair = buildQueuedFileItem(new File(['hello'], 'mystery.xyz'), 'jpg');
    expect(unsupportedOnPair.targetFormat).toBe('');

    const emptyPng = buildQueuedFileItem(new File([], 'empty.png', { type: 'image/png' }), 'jpg');
    expect(emptyPng.size).toBe(0);

    let hookApi: ReturnType<typeof useClientQueue> | undefined;
    function QueueHarness() {
      hookApi = useClientQueue();
      return createElement(ConversionQueue, {
        items: hookApi.queue,
        onRemoveItem: hookApi.handleRemoveItem,
        onClearAll: hookApi.handleClearAll,
        onUpdateTargetFormat: hookApi.handleUpdateTargetFormat,
        onUpdateAllTargets: hookApi.handleUpdateAllTargets,
        onUpdateOptions: hookApi.handleUpdateOptions,
        onConvertAll: hookApi.handleConvertAll,
        onAddMoreFiles: vi.fn(),
        onImportFile: vi.fn(),
        onDownloadAllZip: hookApi.handleDownloadAllZip,
        isConverting: hookApi.isConverting,
        zipError: hookApi.zipError,
        onDismissZipError: hookApi.clearZipError,
      });
    }

    const host = mountDom(createElement(QueueHarness), 'en');
    await act(async () => {
      hookApi!.handleFilesSelected([
        new File([], 'empty.png', { type: 'image/png' }),
        new File(['binary'], 'unknown.xyz'),
      ], 'jpg');
    });

    const alerts = Array.from(host.querySelectorAll('[role="alert"]')).map((el) => el.textContent);
    expect(alerts).toContain('This file is empty (0 bytes) and cannot be converted.');
    expect(alerts).toContain('XYZ files are not supported for conversion.');

    const convertBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Convert'));
    expect(convertBtn?.hasAttribute('disabled')).toBe(true);
    expect(host.querySelector('[data-testid="queue-target-format-btn"]')?.hasAttribute('disabled')).toBe(true);

    await act(async () => {
      await hookApi!.handleConvertAll();
    });
    expect(
      fetchSpy.mock.calls.filter(([u]) => {
        const url = String(u);
        return url !== '/api/auth/me';
      })
    ).toHaveLength(0);
  });

  it('cancels an in-flight multipart upload immediately on handleRemoveItem without queuing a job', async () => {
    const calls: string[] = [];
    let releaseInitiate!: (res: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === '/api/auth/me') {
          return Promise.resolve(new Response(JSON.stringify({ success: false, authenticated: false, user: null, paidPlansOnSale: false }), { status: 200 }));
        }
        if (url.includes('action=initiate')) {
          return new Promise<Response>((resolve) => {
            releaseInitiate = resolve;
          });
        }
        return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
      })
    );

    let hookApi: ReturnType<typeof useClientQueue> | undefined;
    function QueueHarness() {
      hookApi = useClientQueue();
      return createElement(ConversionQueue, {
        items: hookApi.queue,
        onRemoveItem: hookApi.handleRemoveItem,
        onClearAll: hookApi.handleClearAll,
        onUpdateTargetFormat: hookApi.handleUpdateTargetFormat,
        onUpdateAllTargets: hookApi.handleUpdateAllTargets,
        onUpdateOptions: hookApi.handleUpdateOptions,
        onConvertAll: hookApi.handleConvertAll,
        onAddMoreFiles: vi.fn(),
        onImportFile: vi.fn(),
        onDownloadAllZip: hookApi.handleDownloadAllZip,
        isConverting: hookApi.isConverting,
        zipError: hookApi.zipError,
        onDismissZipError: hookApi.clearZipError,
      });
    }

    const host = mountDom(createElement(QueueHarness), 'ko');
    const bigFile = new File([new Uint8Array(1)], 'large.mp4', { type: 'video/mp4' });
    Object.defineProperty(bigFile, 'size', { value: 66 * 1024 * 1024 });

    await act(async () => {
      hookApi!.handleFilesSelected([bigFile], 'webm');
    });

    let batchPromise!: Promise<void>;
    await act(async () => {
      batchPromise = hookApi!.handleConvertAll();
      await new Promise((r) => setTimeout(r, 10));
    });

    const cancelBtn = host.querySelector('button[aria-label="large.mp4 취소"]') as HTMLButtonElement | null;
    expect(cancelBtn).not.toBeNull();

    await act(async () => {
      cancelBtn!.click();
    });
    expect(hookApi!.queue).toHaveLength(0);
    expect(hookApi!.isConverting).toBe(false);

    await act(async () => {
      releaseInitiate(
        new Response(
          JSON.stringify({ success: true, uploadId: 'up-early-cancel', key: 'uploads/up-early-cancel', partSize: 64 * 1024 * 1024 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
      await batchPromise;
    });

    expect(calls.some((u) => u.includes('action=abort'))).toBe(true);
    expect(calls.some((u) => u === '/api/queue/jobs')).toBe(false);
  });

  it('keeps self.onmessage in worker mocks without WorkerGlobalScope, ignores browser window without WorkerGlobalScope, and preserves storage-gc self fallback', async () => {
    const scope = { postMessage: vi.fn() } as { postMessage: ReturnType<typeof vi.fn>; onmessage?: (e: MessageEvent) => Promise<void> | void };
    vi.stubGlobal('WorkerGlobalScope', undefined);
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('self', scope);
    vi.resetModules();
    await import('../src/lib/edge/workers/opfs-vfs.worker');
    expect(typeof scope.onmessage).toBe('function');

    const winScope = { postMessage: vi.fn() } as { postMessage: ReturnType<typeof vi.fn>; onmessage?: unknown };
    vi.stubGlobal('window', winScope);
    vi.stubGlobal('self', winScope);
    vi.resetModules();
    await import('../src/lib/edge/workers/wasm-engine.worker');
    expect(winScope.onmessage).toBeUndefined();

    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('self', { addEventListener, removeEventListener });
    const unregister = registerSessionCleanupOnPageExit(new Set(['sess-1']));
    expect(addEventListener).toHaveBeenCalledTimes(2);
    unregister();
    expect(removeEventListener).toHaveBeenCalledTimes(2);
  });

  it('supports RFC 5987 language tags in Content-Disposition and clamps unverified legacy tiers as anonymous', () => {
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8'en'%ED%85%8C%EC%8A%A4%ED%8A%B8.zip")).toBe('테스트.zip');
    expect(
      countsAsAnonymousForConversions({
        provider: 'email',
        emailVerified: false,
        tier: 'enterprise' as UserTier,
      })
    ).toBe(true);
    expect(
      countsAsAnonymousForConversions({
        provider: 'email',
        emailVerified: false,
        tier: 'paid',
      })
    ).toBe(false);
  });

  it('blocks extensionless (README, png), trailing-dot (file.), and Object.prototype-keyed files without misclassifying them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: false, authenticated: false, user: null, paidPlansOnSale: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    const weirdFiles = [
      new File(['plain'], 'README', { type: 'text/plain' }),
      new File(['not-a-png'], 'png', { type: 'text/plain' }),
      new File(['trailing-dot'], 'file.', { type: 'application/octet-stream' }),
      new File(['proto'], 'bad.constructor', { type: 'application/octet-stream' }),
    ];
    for (const f of weirdFiles) {
      const built = buildQueuedFileItem(f, 'pdf');
      expect(built.targetFormat).toBe('');
      if (f.name === 'bad.constructor') {
        expect(built.sourceFormat).toBe('constructor');
      } else {
        expect(built.sourceFormat).toBe('');
      }
    }

    let hookApi: ReturnType<typeof useClientQueue> | undefined;
    function Harness() {
      hookApi = useClientQueue();
      return createElement(ConversionQueue, {
        items: hookApi.queue,
        onRemoveItem: hookApi.handleRemoveItem,
        onClearAll: hookApi.handleClearAll,
        onUpdateTargetFormat: hookApi.handleUpdateTargetFormat,
        onUpdateAllTargets: hookApi.handleUpdateAllTargets,
        onUpdateOptions: hookApi.handleUpdateOptions,
        onConvertAll: hookApi.handleConvertAll,
        onAddMoreFiles: vi.fn(),
        onImportFile: vi.fn(),
        onDownloadAllZip: hookApi.handleDownloadAllZip,
        isConverting: hookApi.isConverting,
      });
    }

    const host = mountDom(createElement(Harness), 'en');
    await act(async () => {
      hookApi!.handleFilesSelected([weirdFiles[0]!, weirdFiles[1]!], 'pdf');
    });
    expect(host.textContent).toContain('2 files in queue');
    expect(host.textContent).toContain('Unknown file');
    expect(host.textContent).toContain('This file type is not supported for conversion.');
    const convertBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Convert'));
    expect(convertBtn?.disabled).toBe(true);

    function SingularCountCheck() {
      const t = useTranslations('queue');
      return createElement('span', null, t('filesInQueue', { count: 1 }));
    }
    const singularHost = mountDom(createElement(SingularCountCheck), 'en');
    expect(singularHost.textContent).toBe('1 file in queue');
  });

  it('uses singular English credit wording in RecentCharges when base is 1 and skips tab refetches before dashboard user resolves', async () => {
    const charges: ChargeEntry[] = [
      { at: 1_700_000_000_000, from: 'pdf', to: 'docx', credits: 2, base: 1, surcharge: 1, fromPackage: 0, uncharged: 0 },
    ];
    const chargeHost = mountDom(createElement(RecentCharges, { charges }), 'en');
    expect(chargeHost.textContent).toContain('1 credit and 1 for processing time');

    searchState.tab = 'api';
    let controller!: ReturnType<typeof useDashboardController>;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === '/api/auth/me') {
        return new Response(JSON.stringify({ success: false, authenticated: false }), { status: 401 });
      }
      return new Response(JSON.stringify({ success: true, keys: [], charges: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    function Harness() {
      controller = useDashboardController();
      return createElement('div', null, controller.activeTab);
    }

    const host = mountDom(createElement(Harness), 'en');
    await act(async () => {
      await Promise.resolve();
    });
    searchState.tab = 'usage';
    await act(async () => {
      root!.render(
        createElement(NextIntlClientProvider, {
          locale: 'en',
          messages: testMessages('en'),
          timeZone: 'UTC',
          children: createElement(Harness),
        })
      );
    });
    expect(controller.activeTab).toBe('usage');
    expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/keys')).toBe(false);
    expect(host.textContent).toContain('usage');
  });
});
