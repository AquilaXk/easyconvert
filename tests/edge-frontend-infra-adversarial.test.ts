import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as securityTxtGet } from '../src/app/.well-known/security.txt/route';
import { GET as queueJobGet } from '../src/app/api/queue/jobs/[id]/route';
import { openCheckout } from '../src/components/billing/paddle-checkout';
import { decodeHeaderFilename } from '../src/components/UrlImportModal';
import { toolAccepts } from '../src/hooks/useToolRun';
import { middleware } from '../src/middleware';
import { ClientEdgeEscalationError, executeItemConversion, tryProcessClientEdge } from '../src/lib/client-converter';
import * as opfsPipeline from '../src/lib/edge/pipelines/opfs-streaming-pipeline';
import { WasmWorkerManager } from '../src/lib/edge/pipelines/wasm-simd-pipeline';
import { convertWithWebCodecs } from '../src/lib/edge/pipelines/webcodecs-pipeline';
import { executeWebGpuCompute } from '../src/lib/edge/pipelines/webgpu-compute-pipeline';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { startCaptureGate } from '../src/lib/security/capture-gate';
import type { ConversionQueueItem } from '../src/lib/types';

const ROOT = path.resolve(__dirname, '..');
const readRepoFile = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

/** Minimal valid 2-frame GIF89a (1x1 canvas, two 0x2C image descriptors). */
function buildTwoFrameGif(): Uint8Array {
  return new Uint8Array([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
    0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, // LSD 1x1 + GCT (2 colors)
    0x00, 0x00, 0x00, 0xff, 0xff, 0xff, // GCT black, white
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // Frame 1 (1x1)
    0x02, 0x02, 0x44, 0x01, 0x00, // LZW min code 2 + 2-byte sub-block + terminator
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // Frame 2 (1x1)
    0x02, 0x02, 0x4c, 0x01, 0x00,
    0x3b, // Trailer
  ]);
}

describe('Adversarial Edge, Frontend, Proxy & Container Hardening', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    WasmWorkerManager.recycleWorker();
  });

  it('1. toolAccepts("archive-extract") accepts all 17 backend archive extensions', () => {
    const supported = [
      'a.zip', 'a.7z', 'a.rar', 'a.tar', 'a.tar.gz', 'a.tgz',
      'a.tar.bz2', 'a.tbz2', 'a.tbz', 'a.tar.xz', 'a.txz',
      'a.tar.zst', 'a.tzst', 'a.bz2', 'a.xz', 'a.zst', 'a.gz',
    ];
    for (const name of supported) {
      expect(toolAccepts('archive-extract', name), name).toBe(true);
    }
    expect(toolAccepts('archive-extract', 'document.pdf')).toBe(false);
  });

  it('2. L1A/L2 edge image filter escalates animated GIF instead of dropping frames via createImageBitmap', async () => {
    const createBitmapSpy = vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() }));
    vi.stubGlobal('window', {});
    vi.stubGlobal('createImageBitmap', createBitmapSpy);
    vi.stubGlobal('OffscreenCanvas', class {
      width = 1;
      height = 1;
      getContext() {
        return {
          drawImage: vi.fn(),
          getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
          putImageData: vi.fn(),
        };
      }
      convertToBlob() {
        return Promise.resolve(new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])], { type: 'image/webp' }));
      }
    });

    const gifBytes = buildTwoFrameGif();
    const file = new File([gifBytes], 'anim.gif', { type: 'image/gif' });
    const item: ConversionQueueItem = {
      id: 'item-gif',
      file,
      name: 'anim.gif',
      size: file.size,
      sourceFormat: 'gif',
      targetFormat: 'webp',
      status: 'converting',
      progress: 0,
      options: { palette: true, colors: 64 },
    };

    let caught: unknown;
    try {
      await tryProcessClientEdge(item);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClientEdgeEscalationError);
    expect((caught as ClientEdgeEscalationError).fallbackFrom).toBe('L2');
    expect((caught as Error).message).toMatch(/animated/i);
    expect(createBitmapSpy).not.toHaveBeenCalled();
  });

  it('3. executeWebGpuCompute destroys all 4 GPU buffers in finally when mapAsync rejects', async () => {
    const destroys: string[] = [];
    let bufferIndex = 0;
    const names = ['uniform', 'input', 'output', 'readback'];
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async () => ({
          requestDevice: async () => ({
            createShaderModule: () => ({}),
            createBuffer: () => {
              const label = names[bufferIndex++] ?? 'extra';
              return {
                destroy: () => destroys.push(label),
                mapAsync: async () => {
                  throw new Error('GPU device lost during mapAsync');
                },
              };
            },
            createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
            createBindGroup: () => ({}),
            createCommandEncoder: () => ({
              beginComputePass: () => ({
                setPipeline: () => undefined,
                setBindGroup: () => undefined,
                dispatchWorkgroups: () => undefined,
                end: () => undefined,
              }),
              copyBufferToBuffer: () => undefined,
              finish: () => ({}),
            }),
            queue: {
              writeBuffer: () => undefined,
              submit: () => undefined,
            },
          }),
        }),
      },
    });

    const res = await executeWebGpuCompute({
      width: 2,
      height: 2,
      data: new Uint8Array(16),
      task: { type: 'color-transform', options: { mode: 'invert' } },
    });
    expect(res).toBeNull();
    expect(destroys).toEqual(['uniform', 'input', 'output', 'readback']);
  });

  it('4. convertWithWebCodecs transfers File handle via structured clone without 2x main-thread arrayBuffer copy and terminates Worker on abort', async () => {
    let postedPayload: Record<string, unknown> | undefined;
    let terminated = false;
    vi.stubGlobal('window', {});
    vi.stubGlobal('Worker', class MockWebCodecsWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      postMessage(msg: Record<string, unknown>) {
        postedPayload = msg;
      }
      terminate() {
        terminated = true;
      }
    });

    const baseFile = new File([new Uint8Array(1024)], 'clip.mp4', { type: 'video/mp4' });
    const arrayBufferSpy = vi.spyOn(baseFile, 'arrayBuffer');
    const controller = new AbortController();

    const promise = (convertWithWebCodecs as unknown as (
      f: File,
      s: string,
      t: string,
      o: Record<string, unknown>,
      p?: (n: number) => void,
      sig?: AbortSignal
    ) => Promise<unknown>)(baseFile, 'mp4', 'webm', {}, undefined, controller.signal);

    await new Promise((r) => setTimeout(r, 10));
    expect(arrayBufferSpy).not.toHaveBeenCalled();
    expect(postedPayload?.file).toBe(baseFile);

    controller.abort(new Error('user cancelled'));
    await expect(promise).rejects.toThrow(/abort|cancel/i);
    expect(terminated).toBe(true);
  });

  it('5. OPFS result cleanup registry invokes session destroy when URL is released, and executeItemConversion skips onSuccess when aborted', async () => {
    expect(typeof (opfsPipeline as Record<string, unknown>).registerEdgeResultCleanup).toBe('function');
    expect(typeof (opfsPipeline as Record<string, unknown>).releaseEdgeResultResources).toBe('function');

    const destroySpy = vi.fn(async () => true);
    const register = (opfsPipeline as unknown as {
      registerEdgeResultCleanup: (url: string, fn: () => Promise<boolean>) => void;
      releaseEdgeResultResources: (url: string) => Promise<void>;
    }).registerEdgeResultCleanup;
    const release = (opfsPipeline as unknown as {
      releaseEdgeResultResources: (url: string) => Promise<void>;
    }).releaseEdgeResultResources;

    register('blob:test-opfs-1', destroySpy);
    await release('blob:test-opfs-1');
    expect(destroySpy).toHaveBeenCalledTimes(1);

    const abortController = new AbortController();
    abortController.abort();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const item: ConversionQueueItem = {
      id: 'aborted-1',
      file: new File(['hello'], 'test.png', { type: 'image/png' }),
      name: 'test.png',
      size: 5,
      sourceFormat: 'png',
      targetFormat: 'webp',
      status: 'converting',
      progress: 0,
      options: {},
    };
    await executeItemConversion(item, { onProgress: vi.fn(), onSuccess, onError }, abortController.signal);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('6. paddle-checkout evicts rejected load promise so subsequent retry succeeds', async () => {
    let calls = 0;
    const checkoutOpen = vi.fn();
    vi.doMock('@paddle/paddle-js', () => ({
      initializePaddle: async () => {
        calls++;
        if (calls === 1) throw new Error('Transient CDN failure');
        return { Checkout: { open: checkoutOpen } };
      },
    }));

    const cfg = {
      enabled: true as const,
      environment: 'sandbox' as const,
      clientToken: `tok_retry_${Date.now()}`,
      packages: [],
      subscriptions: [],
    };
    const input = {
      items: [{ priceId: 'pri_1', quantity: 1 }],
      customer: { email: 'buyer@example.com' },
      customData: { userId: 'u_1' },
    };

    await expect(openCheckout(cfg, input, 'en')).rejects.toThrow('Transient CDN failure');
    await expect(openCheckout(cfg, input, 'en')).resolves.toBe(true);
    expect(checkoutOpen).toHaveBeenCalledTimes(1);
  });

  it('7. security.txt Policy points to the canonical GitHub security policy (not a 404 route), SSE sends keepalive comments, and capture-gate destroys plain-HTTP upstream on client abort', async () => {
    const secBody = await securityTxtGet().text();
    expect(secBody).toContain('Policy: https://github.com/AquilaXk/easyconvert/security/policy');
    expect(secBody).not.toContain('/security\n');

    // SSE keepalive test
    vi.useFakeTimers();
    try {
      const job = await conversionQueue.add('convert', {
        jobId: `sse_keepalive_${Date.now()}`,
        originalFilename: 'doc.pdf',
        sourceFormat: 'pdf',
        targetFormat: 'png',
        fileSize: 100,
        options: {},
      });
      const abort = new AbortController();
      const res = await queueJobGet(
        new NextRequest(`http://localhost/api/queue/jobs/${job.id}?stream=true`, { signal: abort.signal }),
        { params: Promise.resolve({ id: job.id }) }
      );
      const reader = res.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain('event: initial');

      await vi.advanceTimersByTimeAsync(26_000);
      const second = new TextDecoder().decode((await reader.read()).value);
      expect(second).toContain(': keepalive');
      abort.abort();
      await conversionQueue.remove(job.id).catch(() => undefined);
    } finally {
      vi.useRealTimers();
    }

    // capture-gate plain HTTP upstream socket teardown on client disconnect
    let upstreamDestroyed = false;
    const slowUpstream = http.createServer((_req, _res) => {
      // Hold open without responding
    });
    await new Promise<void>((r) => slowUpstream.listen(0, '127.0.0.1', r));
    const upstreamPort = (slowUpstream.address() as net.AddressInfo).port;

    const gate = await startCaptureGate({
      lookup: (_host, _opts, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]),
      permitPort: () => true,
      dial: () => {
        const sock = net.connect({ host: '127.0.0.1', port: upstreamPort });
        sock.once('close', () => {
          upstreamDestroyed = true;
        });
        return sock;
      },
    });

    try {
      const client = net.connect({ host: '127.0.0.1', port: gate.port });
      await new Promise<void>((r) => client.once('connect', r));
      client.write('GET http://example.com/slow HTTP/1.1\r\nHost: example.com\r\n\r\n');
      await new Promise((r) => setTimeout(r, 40));
      client.destroy();
      await new Promise((r) => setTimeout(r, 60));
      expect(upstreamDestroyed).toBe(true);
    } finally {
      await gate.close();
      await new Promise<void>((r) => slowUpstream.close(() => r()));
    }
  });

  it('8. Dockerfile.web webslim runs as UID 10001, nginx 429 includes v1 CORS & problem+json, API middleware emits HSTS + nosniff, UrlImportModal survives malformed X-Filename, and tracked configs contain no agent tool names', async () => {
    const dockerfileWeb = readRepoFile('Dockerfile.web');
    const webslimStage = dockerfileWeb.slice(
      dockerfileWeb.indexOf('FROM ${NODE_IMAGE} AS webslim'),
      dockerfileWeb.indexOf('FROM ${WORKER_IMAGE} AS web')
    );
    expect(webslimStage).toContain('10001');
    expect(webslimStage).toContain('USER easyconvert:easyconvert');
    expect(webslimStage).not.toContain('USER node');

    const nginx = readRepoFile('deploy/oci/nginx-easyconvert.conf');
    expect(nginx).toContain('application/problem+json');
    expect(nginx).toContain('Access-Control-Allow-Origin');
    expect(nginx).toContain('Strict-Transport-Security');

    const apiRes = await middleware(new NextRequest('http://localhost/api/health'));
    expect(apiRes.headers.get('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains');
    expect(apiRes.headers.get('X-Content-Type-Options')).toBe('nosniff');

    expect(decodeHeaderFilename('report%20final.pdf')).toBe('report final.pdf');
    expect(decodeHeaderFilename('100%raw_filename.pdf')).toBe('100%raw_filename.pdf');

    for (const file of ['.gitignore', 'tsconfig.json', 'vitest.config.ts']) {
      const content = readRepoFile(file);
      expect(content.toLowerCase(), file).not.toMatch(/claude|codex|gemini|coderabbit|copilot|chatgpt/);
    }
  });
});
