import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Queue, Worker, type IQueueEngine } from '../src/lib/queue/bullmq-engine';
import {
  allConversionQueues,
  conversionQueue,
  fastLaneReservationOptions,
  resourceQueues,
} from '../src/lib/queue/conversion-queue';
import { executeResumableCloudConversion } from '../src/lib/edge/pipelines/resumable-cloud-pipeline';
import { UPLOAD_PART_MAX_BYTES } from '../src/lib/plan-limits';
import { validateOrProblem } from '../src/lib/api/contracts/validate';
import { ConversionOptionsSchema } from '../src/lib/api/contracts/schemas';
import { buildFfmpegArguments } from '../src/lib/conversions/media-ffmpeg-args';
import { openMediaInput } from '../src/lib/conversions/media-process';
import { InvalidMediaOptionError } from '../src/lib/types';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { isAltoXmlPrefix, promoteAltoXmlSource } from '../src/lib/conversions/ocr-alto-sniff';
import { POST as convertPost } from '../src/app/api/convert/route';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';

const ROOT = path.resolve(__dirname, '..');

const SAMPLE_ALTO_XML = `<?xml version="1.0" encoding="UTF-8"?>
<alto xmlns="http://www.loc.gov/standards/alto/ns-v4#" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Description><MeasurementUnit>pixel</MeasurementUnit></Description>
  <Layout>
    <Page ID="P1" PHYSICAL_IMG_NR="1" WIDTH="800" HEIGHT="600">
      <PrintSpace HPOS="0" VPOS="0" WIDTH="800" HEIGHT="600">
        <ComposedBlock ID="CB1" HPOS="40" VPOS="50" WIDTH="500" HEIGHT="80">
          <TextBlock ID="TB1" HPOS="40" VPOS="50" WIDTH="500" HEIGHT="80">
            <TextLine ID="TL1" HPOS="40" VPOS="50" WIDTH="500" HEIGHT="30">
              <String ID="S1" CONTENT="OpenBeta" HPOS="40" VPOS="50" WIDTH="180" HEIGHT="30" WC="0.98"/>
              <SP WIDTH="12" HPOS="220" VPOS="50"/>
              <String ID="S2" CONTENT="Ready" HPOS="232" VPOS="50" WIDTH="120" HEIGHT="30" WC="0.97"/>
            </TextLine>
          </TextBlock>
        </ComposedBlock>
      </PrintSpace>
    </Page>
  </Layout>
</alto>`;

describe('Open Beta commercial readiness polish (entry 318)', () => {
  describe('1. Unified worker fast-lane slot reservation', () => {
    const activeWorkers: Worker[] = [];

    afterEach(async () => {
      for (const w of activeWorkers) await w.close();
      activeWorkers.length = 0;
    });

    it('caps heavy queues at concurrency - 1 on unified workers while leaving split and 1-slot workers uncapped', () => {
      const unified = fastLaneReservationOptions(allConversionQueues, 4);
      expect(unified.maxHeavyConcurrency).toBe(3);
      expect(unified.heavyQueueNames?.has(resourceQueues.cpu.name)).toBe(true);
      expect(unified.heavyQueueNames?.has(resourceQueues.memory.name)).toBe(true);
      expect(unified.heavyQueueNames?.has(resourceQueues.gpu.name)).toBe(true);
      expect(unified.heavyQueueNames?.has(resourceQueues.light.name)).toBe(false);
      expect(unified.heavyQueueNames?.has(conversionQueue.name)).toBe(false);

      expect(fastLaneReservationOptions([resourceQueues.cpu], 3)).toEqual({});
      expect(fastLaneReservationOptions(allConversionQueues, 1)).toEqual({});
    });

    it('runs a light job immediately without head-of-line blocking when 4 heavy cpu jobs arrive on a 4-slot worker', async () => {
      const defaultQ = new Queue<{ kind: string }>('easyconvert-jobs');
      const lightQ = new Queue<{ kind: string }>('easyconvert-jobs:light');
      const cpuQ = new Queue<{ kind: string }>('easyconvert-jobs:cpu');
      const queues: IQueueEngine<{ kind: string }, string>[] = [defaultQ, lightQ, cpuQ];

      let releaseHeavy!: () => void;
      const heavyGate = new Promise<void>((resolve) => {
        releaseHeavy = resolve;
      });

      const started: string[] = [];
      const finished: string[] = [];
      let peakHeavyActive = 0;
      let currentHeavyActive = 0;

      const worker = new Worker<{ kind: string }, string>(
        queues,
        async (job) => {
          started.push(job.data.kind);
          if (job.data.kind.startsWith('cpu')) {
            currentHeavyActive++;
            peakHeavyActive = Math.max(peakHeavyActive, currentHeavyActive);
            await heavyGate;
            currentHeavyActive--;
          }
          finished.push(job.data.kind);
          return job.data.kind;
        },
        {
          concurrency: 4,
          heavyQueueNames: new Set(['easyconvert-jobs:cpu']),
          maxHeavyConcurrency: 3,
        }
      );
      activeWorkers.push(worker);

      await Promise.all([
        cpuQ.add('h1', { kind: 'cpu-1' }),
        cpuQ.add('h2', { kind: 'cpu-2' }),
        cpuQ.add('h3', { kind: 'cpu-3' }),
        cpuQ.add('h4', { kind: 'cpu-4' }),
      ]);

      await vi.waitFor(() => expect(started).toHaveLength(3), { timeout: 1_000, interval: 5 });
      expect(peakHeavyActive).toBe(3);

      // Submit a fast light job while 3 heavy jobs hold slots and the 4th heavy job waits.
      await lightQ.add('fast', { kind: 'light-fast' });
      await vi.waitFor(() => expect(finished).toContain('light-fast'), { timeout: 1_000, interval: 5 });
      expect(finished).toEqual(['light-fast']);
      expect(peakHeavyActive).toBe(3);

      releaseHeavy();
      await vi.waitFor(() => expect(finished).toHaveLength(5), { timeout: 1_000, interval: 5 });
      expect(peakHeavyActive).toBeLessThanOrEqual(3);
    });

    it('lets light bursts use all 4 slots when no heavy jobs are active', async () => {
      const lightQ = new Queue<{ id: number }>('easyconvert-jobs:light');
      const cpuQ = new Queue<{ id: number }>('easyconvert-jobs:cpu');
      let releaseLight!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseLight = resolve;
      });
      let activeLight = 0;
      let peakLight = 0;

      const worker = new Worker<{ id: number }, number>(
        [lightQ, cpuQ],
        async (job) => {
          activeLight++;
          peakLight = Math.max(peakLight, activeLight);
          await gate;
          activeLight--;
          return job.data.id;
        },
        {
          concurrency: 4,
          heavyQueueNames: new Set(['easyconvert-jobs:cpu']),
          maxHeavyConcurrency: 3,
        }
      );
      activeWorkers.push(worker);

      await Promise.all([1, 2, 3, 4].map((id) => lightQ.add(`l${id}`, { id })));
      await vi.waitFor(() => expect(peakLight).toBe(4), { timeout: 1_000, interval: 5 });
      releaseLight();
    });
  });

  describe('2. Adaptive fast polling in resumable cloud pipeline', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('starts polling at 150 ms and backs off by 1.5x up to the 1000 ms steady-state cap', async () => {
      vi.useFakeTimers();
      const pollTimes: number[] = [];
      let polls = 0;
      const states = [
        { id: 'job_fast', state: 'active', progress: 10 },
        { id: 'job_fast', state: 'active', progress: 40 },
        { id: 'job_fast', state: 'active', progress: 80 },
        {
          id: 'job_fast',
          state: 'completed',
          progress: 100,
          returnvalue: { downloadUrl: '/api/storage/file/results%2Fjob_fast%2Fout.json', size: 128 },
        },
      ];

      vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
        const url = String(input);
        const method = init.method ?? 'GET';
        if (url.includes('action=initiate')) {
          return new Response(JSON.stringify({ success: true, uploadId: 'up_f', key: 'uploads/up_f.csv', partSize: UPLOAD_PART_MAX_BYTES }), { status: 200 });
        }
        if (url.includes('action=chunk')) {
          return new Response(JSON.stringify({ success: true, partNumber: 1, etag: '"e1"', size: 16 }), { status: 200 });
        }
        if (url.includes('action=complete')) {
          return new Response(JSON.stringify({ success: true, key: 'uploads/up_f.csv', size: 16 }), { status: 200 });
        }
        if (url === '/api/queue/jobs' && method === 'POST') {
          return new Response(JSON.stringify({ success: true, jobId: 'job_fast' }), { status: 200 });
        }
        if (url === '/api/queue/jobs/job_fast' && method === 'GET') {
          pollTimes.push(Date.now());
          const state = states[Math.min(polls++, states.length - 1)];
          return new Response(JSON.stringify({ success: true, ...state }), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      });

      const file = new File([new Uint8Array(16)], 'small.csv', { type: 'text/csv' });
      const startedAt = Date.now();
      const pending = executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined });

      await vi.advanceTimersByTimeAsync(150);
      await vi.advanceTimersByTimeAsync(225);
      await vi.advanceTimersByTimeAsync(338);
      const res = await pending;

      expect(res.size).toBe(128);
      const offsets = pollTimes.map((t) => t - startedAt);
      expect(offsets).toEqual([0, 150, 375, 713]);
    });
  });

  describe('3. OCI production web and worker CPU budget derivation', () => {
    it('allocates 1.2 web CPUs, 2.1 worker CPUs, 0.2 Redis CPUs, and 4 worker concurrency slots at 3.5 OCPU / 20 GiB', () => {
      const out = spawnSync('bash', [path.join(ROOT, 'deploy/oci/deploy.sh'), 'budget'], { encoding: 'utf8' });
      expect(out.status).toBe(0);
      const map = Object.fromEntries(
        out.stdout
          .trim()
          .split('\n')
          .map((line) => line.split('='))
      );
      expect(map.EASYCONVERT_REDIS_CPUS).toBe('0.2');
      expect(map.EASYCONVERT_WEB_CPUS).toBe('1.2');
      expect(map.EASYCONVERT_WORKER_CPUS).toBe('2.1');
      expect(map.EASYCONVERT_WORKER_CONCURRENCY).toBe('4');
    });
  });

  describe('4. Numeric options.trim and ALTO .xml auto-detection across convert routes', () => {
    let secretKey = '';

    beforeEach(async () => {
      const user = await userStore.createUser({
        name: 'Polish Route Tester',
        email: `polish_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
        tier: 'paid',
      });
      const key = await redisKeyStore.generateApiKey(user.id, 'Polish Key', { scopes: ['convert:write', 'convert:read'] });
      secretKey = key.secretKey;
    });

    it('accepts numeric non-negative seconds in ConversionOptionsSchema and buildFfmpegArguments and rejects invalid bounds', async () => {
      expect(validateOrProblem(ConversionOptionsSchema, { trim: { start: 0, end: 1.5 } }).ok).toBe(true);
      expect(validateOrProblem(ConversionOptionsSchema, { trim: { start: 0.5, end: 2.75 } }).ok).toBe(true);
      expect(validateOrProblem(ConversionOptionsSchema, { trim: { start: -0.5 } }).ok).toBe(false);

      const argsZero = await buildFfmpegArguments(
        openMediaInput('/nonexistent/in.mp4', 'mp4'),
        '/tmp/out.mp4',
        'mp4',
        { trim: { start: 0, end: 1.5 } }
      );
      const beforeInputZero = argsZero.slice(0, argsZero.indexOf('-i'));
      expect(beforeInputZero).toContain('-ss');
      expect(beforeInputZero[beforeInputZero.indexOf('-ss') + 1]).toBe('0');
      expect(beforeInputZero).toContain('-to');
      expect(beforeInputZero[beforeInputZero.indexOf('-to') + 1]).toBe('1.5');

      await expect(
        buildFfmpegArguments(openMediaInput('/nonexistent/in.mp4', 'mp4'), '/tmp/out.mp4', 'mp4', {
          trim: { start: 3, end: 1 },
        })
      ).rejects.toBeInstanceOf(InvalidMediaOptionError);

      await expect(
        buildFfmpegArguments(openMediaInput('/nonexistent/in.mp4', 'mp4'), '/tmp/out.mp4', 'mp4', {
          trim: { start: '-i /etc/passwd' },
        })
      ).rejects.toBeInstanceOf(InvalidMediaOptionError);
    });

    it('sniffs ALTO 4.x .xml root elements without misclassifying data XML or XML-to-JSON requests', () => {
      const altoBytes = Buffer.from(SAMPLE_ALTO_XML, 'utf8');
      const dataXmlBytes = Buffer.from('<?xml version="1.0"?><catalog><alto>nested</alto></catalog>', 'utf8');

      expect(isAltoXmlPrefix(altoBytes)).toBe(true);
      expect(isAltoXmlPrefix(dataXmlBytes)).toBe(false);

      expect(promoteAltoXmlSource(FORMAT_REGISTRY.xml, undefined, 'txt', altoBytes)).toBe(FORMAT_REGISTRY.alto);
      expect(promoteAltoXmlSource(FORMAT_REGISTRY.xml, undefined, 'hocr', altoBytes)).toBe(FORMAT_REGISTRY.alto);
      // Converting an ALTO XML file to JSON as generic XML data stays FORMAT_REGISTRY.xml.
      expect(promoteAltoXmlSource(FORMAT_REGISTRY.xml, undefined, 'json', altoBytes)).toBe(FORMAT_REGISTRY.xml);
      // Explicit sourceFormat='xml' is never overridden.
      expect(promoteAltoXmlSource(FORMAT_REGISTRY.xml, 'xml', 'txt', altoBytes)).toBe(FORMAT_REGISTRY.xml);
      // Non-ALTO XML targeting txt stays FORMAT_REGISTRY.xml so the route rejects the unsupported pair.
      expect(promoteAltoXmlSource(FORMAT_REGISTRY.xml, undefined, 'txt', dataXmlBytes)).toBe(FORMAT_REGISTRY.xml);
    });

    it('converts an uploaded .xml ALTO file to TXT and HOCR on POST /api/convert and POST /api/v1/convert without sourceFormat', async () => {
      const webForm = new FormData();
      webForm.append('file', new Blob([SAMPLE_ALTO_XML], { type: 'application/xml' }), 'scan-page.xml');
      webForm.append('targetFormat', 'txt');
      const webRes = await convertPost(
        new NextRequest('http://localhost/api/convert', {
          method: 'POST',
          headers: { Authorization: `Bearer ${secretKey}` },
          body: webForm,
        })
      );
      expect(webRes.status).toBe(200);
      const webText = await webRes.text();
      expect(webText).toContain('OpenBeta Ready');

      const v1Form = new FormData();
      v1Form.append('file', new Blob([SAMPLE_ALTO_XML], { type: 'application/xml' }), 'scan-page.xml');
      v1Form.append('targetFormat', 'hocr');
      const v1Res = await v1ConvertPost(
        new NextRequest('http://localhost/api/v1/convert?raw=true', {
          method: 'POST',
          headers: { Authorization: `Bearer ${secretKey}` },
          body: v1Form,
        })
      );
      expect(v1Res.status).toBe(200);
      const hocrText = await v1Res.text();
      expect(hocrText).toContain('ocrx_word');
      expect(hocrText).toContain('OpenBeta');

      // Non-ALTO .xml -> hocr fails closed with HTTP 400, while non-ALTO .xml -> txt still converts as data XML (200).
      const badForm = new FormData();
      badForm.append('file', new Blob(['<?xml version="1.0"?><items><item>1</item></items>'], { type: 'application/xml' }), 'items.xml');
      badForm.append('targetFormat', 'hocr');
      const badRes = await convertPost(
        new NextRequest('http://localhost/api/convert', {
          method: 'POST',
          headers: { Authorization: `Bearer ${secretKey}` },
          body: badForm,
        })
      );
      expect(badRes.status).toBe(400);

      const dataTxtForm = new FormData();
      dataTxtForm.append('file', new Blob(['<?xml version="1.0"?><items><item>DataVal</item></items>'], { type: 'application/xml' }), 'items.xml');
      dataTxtForm.append('targetFormat', 'txt');
      const dataTxtRes = await convertPost(
        new NextRequest('http://localhost/api/convert', {
          method: 'POST',
          headers: { Authorization: `Bearer ${secretKey}` },
          body: dataTxtForm,
        })
      );
      expect(dataTxtRes.status).toBe(200);
      expect(await dataTxtRes.text()).toContain('DataVal');
    });
  });

  describe('5. Worker container Tesseract global language pack', () => {
    it('installs the 12 commercial Tesseract language packages in Dockerfile.worker', () => {
      const dockerfile = readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf8');
      for (const pkg of [
        'tesseract-ocr-eng',
        'tesseract-ocr-kor',
        'tesseract-ocr-jpn',
        'tesseract-ocr-chi-sim',
        'tesseract-ocr-chi-tra',
        'tesseract-ocr-deu',
        'tesseract-ocr-fra',
        'tesseract-ocr-spa',
        'tesseract-ocr-por',
        'tesseract-ocr-ita',
        'tesseract-ocr-rus',
        'tesseract-ocr-vie',
      ]) {
        expect(dockerfile).toContain(pkg);
      }
    });
  });
});
