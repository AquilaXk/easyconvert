import cp from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryGraphScheduler } from '@/lib/queue/graph/scheduler';
import { sealGraph } from '@/lib/queue/graph/node-jobs';
import { resolveObjectOwnership } from '@/lib/api-keys/owner-access';
import { storageProvider } from '@/lib/storage';
import { SpreadsheetDagEngine } from '@/lib/conversions/office/spreadsheet-formula';
import { parseAllXlsxWorksheets } from '@/lib/conversions/office/xlsx-parse';
import { ConversionFailedError, PayloadLimitError } from '@/lib/types';
import { stripOfficeMacros } from '@/lib/conversions/office-macro-strip';
import { safeExtractXmlElements } from '@/lib/conversions/safe-xml-scanner';
import * as secretEnc from '@/lib/api-keys/secret-encryption';
import { RedisKeyStore, redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { toPublicApiKey } from '@/lib/api-keys/public-views';
import {
  InMemoryWebhookSecretStore,
  RedisWebhookSecretStore,
} from '@/lib/api-keys/webhook-secret-store';
import { readUserJobs } from '@/lib/queue/user-job-list';
import { RedisRetentionLedger } from '@/lib/storage/retention-ledger';
import { calculateJobPriorityScore } from '@/lib/queue/bullmq-engine';
import { readOldestWaitingSince } from '@/lib/queue/queue-queries';
import { fileBackedObject, SharedObjectStore } from '@/lib/storage/shared-store';
import { zlibFrame, zlibInBlocks } from '@/lib/conversions/deflate-blocks';
import { filterRowsByEntropy } from '@/lib/conversions/png-row-filter';
import { stripEntryBlocks } from '@/lib/storage/s3-list-xml';
import { applyRgbaInvert, applyRgbaQuantize, WasmEngine } from '@/lib/edge/workers/wasm-engine.worker';
import { compressBzip2, decompressBzip2 } from '@/lib/conversions/bzip2';
import { readFb2Model } from '@/lib/conversions/fb2-model';
import { expectNoHang } from './helpers/timing';

async function buildXlsxBuffer(stylesXml: string, sheetXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
  );
  zip.file(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>',
  );
  zip.file('xl/styles.xml', stylesXml);
  zip.file('xl/worksheets/sheet1.xml', sheetXml);
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

function unfilterIndexedPngScanlines(filtered: Uint8Array, width: number, height: number): Uint8Array {
  const rowBytes = 1 + width;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const srcOff = y * rowBytes;
    const filter = filtered[srcOff];
    const dstOff = y * width;
    const prevOff = (y - 1) * width;
    for (let x = 0; x < width; x++) {
      const raw = filtered[srcOff + 1 + x];
      const left = x > 0 ? out[dstOff + x - 1] : 0;
      const up = y > 0 ? out[prevOff + x] : 0;
      const upLeft = y > 0 && x > 0 ? out[prevOff + x - 1] : 0;
      if (filter === 0) out[dstOff + x] = raw;
      else if (filter === 1) out[dstOff + x] = (raw + left) & 0xff;
      else if (filter === 2) out[dstOff + x] = (raw + up) & 0xff;
      else if (filter === 3) out[dstOff + x] = (raw + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const pr = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        out[dstOff + x] = (raw + pr) & 0xff;
      } else {
        throw new Error(`Unexpected PNG filter byte ${filter}`);
      }
    }
  }
  return out;
}

describe('Adversarial Deep Review Hardening & Optimizations', () => {
  describe('SEC-01: DAG export billing finality and unsettled output revocation', () => {
    it('settles accumulated units when an export node already completed before fail_fast failure or cancel', async () => {
      const settleSpy = vi.spyOn(redisKeyStore, 'settleQuota').mockResolvedValue({ success: true } as never);
      const rollbackSpy = vi.spyOn(redisKeyStore, 'rollbackQuota').mockResolvedValue(true);
      try {
        const scheduler = new InMemoryGraphScheduler();
        const graphId = `g_settled_${crypto.randomUUID()}`;
        await scheduler.initGraph(
          graphId,
          sealGraph(graphId, {
            failurePolicy: 'fail_fast',
            nodes: {
              n_in: { op: 'import.upload', storageKey: 'uploads/in.txt' },
              n_conv: { op: 'convert', input: 'n_in', targetFormat: 'pdf' },
              n_exp_ok: { op: 'export.url', input: 'n_conv' },
              n_exp_fail: { op: 'export.url', input: 'n_conv' },
            },
          }),
          { ownerUserId: 'user_1', reservationId: 'res_1' },
        );

        await scheduler.onNodeStarted(graphId, 'n_in');
        await scheduler.onNodeCompleted(graphId, 'n_in', ['uploads/in.txt'], 0);
        await scheduler.onNodeStarted(graphId, 'n_conv');
        await scheduler.onNodeCompleted(graphId, 'n_conv', [`intermediate/${graphId}/n_conv/out.pdf`], 4);
        await scheduler.onNodeStarted(graphId, 'n_exp_ok');
        await scheduler.onNodeCompleted(graphId, 'n_exp_ok', [`results/${graphId}/n_exp_ok/out.pdf`], 0);
        await scheduler.onNodeStarted(graphId, 'n_exp_fail');

        await scheduler.onNodeFailed(graphId, 'n_exp_fail', 'S3 refused');
        expect(settleSpy).toHaveBeenCalledWith('res_1', 4, expect.anything());
        expect(rollbackSpy).not.toHaveBeenCalledWith('res_1');

        const cancelGraphId = `g_cancel_settled_${crypto.randomUUID()}`;
        await scheduler.initGraph(
          cancelGraphId,
          sealGraph(cancelGraphId, {
            failurePolicy: 'fail_fast',
            nodes: {
              n_in: { op: 'import.upload', storageKey: 'uploads/in.txt' },
              n_conv: { op: 'convert', input: 'n_in', targetFormat: 'pdf' },
              n_exp_ok: { op: 'export.url', input: 'n_conv' },
              n_slow: { op: 'convert', input: 'n_conv', targetFormat: 'txt' },
            },
          }),
          { ownerUserId: 'user_1', reservationId: 'res_2' },
        );
        await scheduler.onNodeStarted(cancelGraphId, 'n_in');
        await scheduler.onNodeCompleted(cancelGraphId, 'n_in', ['uploads/in.txt'], 0);
        await scheduler.onNodeStarted(cancelGraphId, 'n_conv');
        await scheduler.onNodeCompleted(cancelGraphId, 'n_conv', [`intermediate/${cancelGraphId}/n_conv/out.pdf`], 3);
        await scheduler.onNodeStarted(cancelGraphId, 'n_exp_ok');
        await scheduler.onNodeCompleted(cancelGraphId, 'n_exp_ok', [`results/${cancelGraphId}/n_exp_ok/out.pdf`], 0);

        await scheduler.cancelGraph(cancelGraphId);
        expect(settleSpy).toHaveBeenCalledWith('res_2', 3, expect.anything());
        expect(rollbackSpy).not.toHaveBeenCalledWith('res_2');
      } finally {
        settleSpy.mockRestore();
        rollbackSpy.mockRestore();
      }
    });

    it('purges results/ and denies ownership resolution when a graph rolls back with zero completed exports', async () => {
      const rollbackSpy = vi.spyOn(redisKeyStore, 'rollbackQuota').mockResolvedValue(true);
      try {
        const scheduler = new InMemoryGraphScheduler();
        const graphId = `g_unsettled_${crypto.randomUUID()}`;
        const resultKey = `results/${graphId}/n_exp/leaked.pdf`;
        const interKey = `intermediate/${graphId}/n_conv/stage.pdf`;
        await storageProvider.saveObject(resultKey, Buffer.from('unpaid-result'), 'application/pdf', 'leaked.pdf');
        await storageProvider.saveObject(interKey, Buffer.from('unpaid-stage'), 'application/pdf', 'stage.pdf');

        await scheduler.initGraph(
          graphId,
          sealGraph(graphId, {
            failurePolicy: 'fail_fast',
            nodes: {
              n_in: { op: 'import.upload', storageKey: 'uploads/in.txt' },
              n_conv: { op: 'convert', input: 'n_in', targetFormat: 'pdf' },
              n_exp: { op: 'export.url', input: 'n_conv' },
            },
          }),
          { ownerUserId: 'user_unpaid', reservationId: 'res_unpaid' },
        );
        await scheduler.onNodeStarted(graphId, 'n_in');
        await scheduler.onNodeCompleted(graphId, 'n_in', ['uploads/in.txt'], 0);
        await scheduler.onNodeStarted(graphId, 'n_conv');
        await scheduler.onNodeCompleted(graphId, 'n_conv', [interKey], 4);
        await scheduler.onNodeStarted(graphId, 'n_exp');
        await scheduler.onNodeFailed(graphId, 'n_exp', 'export crashed');

        expect(rollbackSpy).toHaveBeenCalledWith('res_unpaid');
        expect(await storageProvider.getObject(resultKey)).toBeUndefined();
        expect(await storageProvider.getObject(interKey)).toBeUndefined();

        const ownershipRes = await resolveObjectOwnership(resultKey, {
          getJob: async () => undefined,
          graphScheduler: scheduler,
        });
        const interOwnership = await resolveObjectOwnership(interKey, {
          getJob: async () => undefined,
          graphScheduler: scheduler,
        });
        expect(ownershipRes.resolved).toBe(false);
        expect(interOwnership.resolved).toBe(false);
      } finally {
        rollbackSpy.mockRestore();
      }
    });
  });

  describe('SEC-02 & SEC-08b: XLSX formula range caps, sparse DAG dependencies, and numFmt attribute order', () => {
    it('rejects oversized ranges (>100k cells, including A1:XFD1048576) immediately with PayloadLimitError', async () => {
      await expectNoHang('XLSX oversized range guard', () => {
        const engine = new SpreadsheetDagEngine({ A1: '1' });
        expect(() =>
          engine.evaluateWithDag([{ ref: 'B1', formula: 'SUM(A1:Z5000)', rowIdx: 0, colIdx: 1 }]),
        ).toThrow(PayloadLimitError);
        expect(() =>
          engine.evaluateWithDag([
            { ref: 'B2', formula: 'IFERROR(SUM(A1:XFD1048576), 0)', rowIdx: 1, colIdx: 1 },
          ]),
        ).toThrow(PayloadLimitError);
      });
    });

    it('evaluates sparse formula dependencies inside bounded rectangular ranges accurately', () => {
      const engine = new SpreadsheetDagEngine({ B2: '7' });
      const { evaluated, cycles } = engine.evaluateWithDag([
        { ref: 'D1', formula: 'SUM(A1:C20)', rowIdx: 0, colIdx: 3 },
        { ref: 'C12', formula: 'A5*2', rowIdx: 11, colIdx: 2 },
        { ref: 'A5', formula: '10+5', rowIdx: 4, colIdx: 0 },
      ]);
      expect(cycles).toEqual([]);
      expect(evaluated.A5).toBe(15);
      expect(evaluated.C12).toBe(30);
      expect(evaluated.D1).toBe(52);
    });

    it('parses <numFmt> custom date formats regardless of attribute order or single quotes', async () => {
      const stylesXml =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        "<numFmts count='1'><numFmt formatCode='yyyy-mm-dd' numFmtId='164'/></numFmts>" +
        '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs>' +
        '</styleSheet>';
      const sheetXml =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheetData><row r="1"><c r="A1" s="1"><v>45292</v></c></row></sheetData>' +
        '</worksheet>';
      const buf = await buildXlsxBuffer(stylesXml, sheetXml);
      const sheets = await parseAllXlsxWorksheets(buf);
      expect(sheets[0]?.rows[0]?.[0]).toBe('2024-01-01');
    });
  });

  describe('SEC-04 & LOW-04: OOXML macro strip fail-closed XML depth, comment skipping, and %XX target decoding', () => {
    it('fails closed when [Content_Types].xml exceeds maximum XML nesting depth', async () => {
      const zip = new JSZip();
      const openWrappers = '<Wrap>'.repeat(70);
      const closeWrappers = '</Wrap>'.repeat(70);
      zip.file(
        '[Content_Types].xml',
        `<?xml version="1.0" encoding="UTF-8"?><Types>${openWrappers}` +
          '<Override PartName="/word/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>' +
          `${closeWrappers}</Types>`,
      );
      zip.file('word/vbaProject.bin', Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
      const input = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
      await expect(stripOfficeMacros(input)).rejects.toThrow(ConversionFailedError);
    });

    it('strips macros hidden behind XML comments or percent-encoded relationship targets', async () => {
      const zip = new JSZip();
      zip.file(
        '[Content_Types].xml',
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<!-- <Override PartName="/word/decoy.bin"> </Override> -->' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '</Types>',
      );
      zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>');
      zip.file(
        'word/_rels/document.xml.rels',
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="%76baProject.bin"/>' +
          '</Relationships>',
      );
      zip.file('word/vbaProject.bin', Buffer.from('VBA_PAYLOAD'));
      const input = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));

      const stripped = await stripOfficeMacros(input);
      expect(stripped.droppedMacros).toBe(true);
      const outZip = await JSZip.loadAsync(stripped.buffer);
      expect(outZip.file('word/vbaProject.bin')).toBeNull();
    });

    it('preserves element nesting depth when nested opening tags contain > inside attribute quotes', () => {
      const xml = '<root><item label="outer"><item label="a > b">inner</item>tail</item></root>';
      const items = safeExtractXmlElements(xml, 'item');
      expect(items).toHaveLength(1);
      expect(items[0]?.content).toBe('<item label="a > b">inner</item>tail');
    });
  });

  describe('SEC-05, SEC-07 & QRY-08: Secret AAD binding, atomic Redis key mutations, and decryption-free listing', () => {
    it('binds webhook secret ciphertexts to ownerUserId and targetId via AAD', async () => {
      const memStore = new InMemoryWebhookSecretStore();
      await memStore.setPrimarySecret('user_a', 'key_a', 'whsec_top_secret_123456');
      expect((await memStore.getSecretRecord('user_a', 'key_a'))?.primary).toBe('whsec_top_secret_123456');

      const rawRedis = new Map<string, string>();
      const fakeRedis = {
        get: async (k: string) => rawRedis.get(k) ?? null,
        set: async (k: string, v: string) => {
          rawRedis.set(k, v);
          return 'OK';
        },
        del: async (k: string) => (rawRedis.delete(k) ? 1 : 0),
        eval: async (_script: string, _numKeys: number, key: string, primaryEncrypted: string, now: string) => {
          rawRedis.set(key, JSON.stringify({ primaryEncrypted, createdAt: Number(now) }));
          return 1;
        },
      };
      const redisStore = new RedisWebhookSecretStore({ redisClient: fakeRedis as never });
      await redisStore.setPrimarySecret('user_a', 'key_a', 'whsec_redis_secret_123456');

      const recordA = rawRedis.get('webhook:sec:{user_a}:key_a');
      expect(recordA).toContain('enc:wh:v2:');
      expect((await redisStore.getSecretRecord('user_a', 'key_a'))?.primary).toBe('whsec_redis_secret_123456');

      // Transplanting user_a's encrypted record onto user_b's Redis key fails AAD verification
      rawRedis.set('webhook:sec:{user_b}:key_b', recordA!);
      expect(await redisStore.getSecretRecord('user_b', 'key_b')).toBeNull();
    });

    it('lists API keys without decrypting webhook secrets when decryptSecrets is false, and enforces AAD on stored keys', async () => {
      const hashes = new Map<string, Record<string, string>>();
      const userSets = new Map<string, Set<string>>();
      const fakeRedis = {
        hset: async (k: string, fieldOrObj: string | Record<string, string>, val?: string) => {
          const map = hashes.get(k) ?? {};
          if (typeof fieldOrObj === 'string') {
            map[fieldOrObj] = val ?? '';
          } else {
            Object.assign(map, fieldOrObj);
          }
          hashes.set(k, map);
          return 1;
        },
        hget: async (k: string, field: string) => hashes.get(k)?.[field] ?? null,
        hgetall: async (k: string) => hashes.get(k) ?? {},
        hdel: async (k: string, field: string) => {
          const map = hashes.get(k);
          if (!map || !(field in map)) return 0;
          delete map[field];
          return 1;
        },
        sadd: async (k: string, member: string) => {
          let s = userSets.get(k);
          if (!s) {
            s = new Set();
            userSets.set(k, s);
          }
          s.add(member);
          return 1;
        },
        smembers: async (k: string) => [...(userSets.get(k) ?? [])],
      };

      const store = new RedisKeyStore({ redisClient: fakeRedis as never, isolated: true });
      const created = await store.generateApiKey('user_1', 'Prod Key', {
        webhookUrl: 'https://example.com/hook',
        webhookSecret: 'whsec_super_secret_value_12345',
      });

      const storedHash = hashes.get(`easyconvert:apikeys:${created.key.id}`)!;
      const storedRaw = JSON.parse(storedHash.data!) as { webhookSecret: string };
      expect(storedRaw.webhookSecret.startsWith('enc:v2:')).toBe(true);
      expect(() => secretEnc.decryptSecret(storedRaw.webhookSecret, 'apikey:other_user:other_key')).toThrow();

      const decryptSpy = vi.spyOn(secretEnc, 'decryptSecret');
      const listedFast = await store.listApiKeys('user_1', { decryptSecrets: false });
      expect(decryptSpy).not.toHaveBeenCalled();
      expect(listedFast).toHaveLength(1);
      expect(toPublicApiKey(listedFast[0]!).hasWebhookSecret).toBe(true);
      decryptSpy.mockRestore();
    });
  });

  describe('QRY-01, QRY-03, QRY-06, QRY-07: Windowed ZSET reads, cluster hash tags, monotonic wait clamp, and bounded file cache', () => {
    it('reads user jobs in bounded ZREVRANGE windows instead of 0..-1', async () => {
      const zrevrangeCalls: Array<[number, number]> = [];
      const redis = {
        zrevrange: async (_key: string, start: number, stop: number) => {
          zrevrangeCalls.push([start, stop]);
          return ['j2', 'j1'];
        },
        eval: async () => [
          ['id', 'j2', 'userId', 'u1', 'status', 'completed', 'createdAt', '200'],
          ['id', 'j1', 'userId', 'u1', 'status', 'completed', 'createdAt', '100'],
        ],
      };
      const jobs = await readUserJobs(redis as never, {
        indexKey: 'easyconvert:{jobs}:user:u1',
        jobKeyPrefix: 'easyconvert:{jobs}:job:',
        offset: 0,
        limit: 10,
        toJob: (flat) => ({ id: flat[1]! }),
      });
      expect(jobs.map((j) => j.id)).toEqual(['j2', 'j1']);
      expect(zrevrangeCalls).toHaveLength(1);
      expect(zrevrangeCalls[0]?.[1]).toBeGreaterThanOrEqual(9);
      expect(zrevrangeCalls[0]?.[1]).toBeLessThan(500);
    });

    it('uses a shared Redis Cluster hash-tag slot across RetentionLedger keys', async () => {
      const seenKeys: string[] = [];
      const fakeClient = {
        mget: async (keys: string[]) => {
          seenKeys.push(...keys);
          return keys.map(() => null);
        },
      };
      const ledger = new RedisRetentionLedger(fakeClient as never);
      await ledger.getMany(['results/a.pdf', 'results/b.pdf']);
      expect(seenKeys).toHaveLength(2);
      expect(seenKeys.every((k) => k.includes('{retention}'))).toBe(true);
    });

    it('clamps sub-millisecond monotonic priority timestamp lead to zero wait instead of 31.7 years', async () => {
      const now = Date.now();
      const scoreSlightlyAhead = calculateJobPriorityScore(10, now + 200);
      const fakeRedis = {
        zrangebyscore: async (_k: string, from: string) =>
          from === '-inf' ? ['job_1', String(scoreSlightlyAhead)] : [],
      };
      const oldest = await readOldestWaitingSince(
        fakeRedis as never,
        'easyconvert:jobs:waiting',
        1e12,
        10,
        () => {},
      );
      expect(oldest).toBeGreaterThanOrEqual(now - 50);
    });

    it('bounds SharedObjectStore disk-backed buffer cache memory and reuses parsed meta entries on deleteByPrefix', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-shared-store-test-'));
      const prevDir = process.env.LOCAL_STORAGE_DIR;
      process.env.LOCAL_STORAGE_DIR = tmpDir;
      try {
        const store = new SharedObjectStore({ maxCachedBytes: 4096 });
        for (let i = 0; i < 6; i++) {
          const srcPath = path.join(tmpDir, `src_${i}.bin`);
          fs.writeFileSync(srcPath, Buffer.alloc(2048, i + 1));
          const stored = await store.storeFile(`batch/item_${i}.bin`, srcPath, {
            key: `batch/item_${i}.bin`,
            filename: `item_${i}.bin`,
            mimeType: 'application/octet-stream',
            size: 2048,
            etag: `"etag_${i}"`,
            uploadedAt: Date.now(),
            expiresAt: Date.now() + 60_000,
          });
          expect(stored.buffer.byteLength).toBe(2048);
        }
        expect(store.getCachedBufferBytes()).toBeLessThanOrEqual(4096);

        store.deleteByPrefix('nonexistent/');
        const readFileSpy = vi.spyOn(fs, 'readFileSync');
        store.deleteByPrefix('nonexistent/');
        expect(readFileSpy).not.toHaveBeenCalled();
        readFileSpy.mockRestore();

        const standalone = fileBackedObject(
          {
            key: 'standalone',
            filename: 's.bin',
            mimeType: 'application/octet-stream',
            size: 16,
            etag: '"e"',
            uploadedAt: Date.now(),
            expiresAt: Date.now() + 60_000,
          },
          store.objectPath('batch/item_0.bin'),
        );
        expect(standalone.buffer.byteLength).toBe(2048);
      } finally {
        if (prevDir === undefined) delete process.env.LOCAL_STORAGE_DIR;
        else process.env.LOCAL_STORAGE_DIR = prevDir;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('LOW-03, LOW-05, LOW-08: Pure Adler-32, single-pass PNG row filtering, and S3 XML stripping', () => {
    it('computes RFC 1950 zlib frames with pure byte-level Adler-32 and zero zlib.deflateSync calls', async () => {
      const deflateSpy = vi.spyOn(zlib, 'deflateSync');
      for (const size of [0, 1, 5552, 5553, 16_384, 70_000]) {
        const payload = crypto.randomBytes(size);
        const raw = zlib.deflateRawSync(payload);
        const framed = zlibFrame(raw, payload, 6);
        expect(Buffer.compare(zlib.inflateSync(framed), payload)).toBe(0);
      }
      const multiPayload = crypto.randomBytes(600 * 1024);
      const multi = await zlibInBlocks(multiPayload, 6);
      expect(Buffer.compare(zlib.inflateSync(multi), multiPayload)).toBe(0);
      expect(deflateSpy).not.toHaveBeenCalled();
      deflateSpy.mockRestore();
    });

    it('produces reversible PNG filtered scanlines matching exact palette indices in a single pass', () => {
      const width = 37;
      const height = 19;
      const indices = new Uint8Array(crypto.randomBytes(width * height));
      const filtered = filterRowsByEntropy(indices, width, height);
      expect(filtered.byteLength).toBe(height * (1 + width));
      const reconstructed = unfilterIndexedPngScanlines(filtered, width, height);
      expect(Buffer.compare(reconstructed, indices)).toBe(0);
    });

    it('strips S3 <Contents> and <CommonPrefixes> blocks accurately and short-circuits when absent', () => {
      const clean = '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>';
      expect(stripEntryBlocks(clean, ['Contents', 'CommonPrefixes'])).toBe(clean);

      const withEntries =
        '<ListBucketResult><Name>b</Name><Contents><Key>a</Key></Contents>' +
        '<CommonPrefixes><Prefix>p/</Prefix></CommonPrefixes><NextContinuationToken>tok</NextContinuationToken></ListBucketResult>';
      expect(stripEntryBlocks(withEntries, ['Contents', 'CommonPrefixes'])).toBe(
        '<ListBucketResult><Name>b</Name><NextContinuationToken>tok</NextContinuationToken></ListBucketResult>',
      );
    });

    it('inverts RGBA pixels via 32-bit word XOR while preserving alpha on aligned and unaligned views, and swaps dither buffers cleanly', async () => {
      const backing = new Uint8Array(1 + 16);
      const pixels = new Uint8Array([
        0, 128, 255, 200,
        10, 20, 30, 0,
        255, 0, 64, 255,
        100, 150, 200, 42,
      ]);
      const expected = new Uint8Array([
        255, 127, 0, 200,
        245, 235, 225, 0,
        0, 255, 191, 255,
        155, 105, 55, 42,
      ]);
      expect(Buffer.compare(applyRgbaInvert(pixels), expected)).toBe(0);
      backing.set(pixels, 1);
      expect(Buffer.compare(applyRgbaInvert(backing.subarray(1, 17)), expected)).toBe(0);

      const dithered = applyRgbaQuantize(pixels, 2, 2, 8, true);
      expect(dithered[3]).toBe(200);
      expect(dithered[7]).toBe(0);

      const engine = new WasmEngine();
      const taskOut = await engine.executeTask({
        jobId: 'wasm_invert_1',
        task: 'rgba-invert',
        buffer: pixels.slice().buffer,
      });
      expect(Buffer.compare(new Uint8Array(taskOut.buffer), expected)).toBe(0);
    });

    it('decodes multi-tree bzip2 streams verified against system bzip2 oracle and decodes whitespace-wrapped FB2 base64 covers', async () => {
      const sample = Buffer.concat([
        Buffer.from('EasyConvert adversarial review bzip2 selector test. '.repeat(250)),
        crypto.randomBytes(4096),
      ]);
      const encodedBySystem = cp.spawnSync('bzip2', ['-1', '-c'], { input: sample });
      expect(encodedBySystem.error).toBeUndefined();
      expect(encodedBySystem.status).toBe(0);
      expect(Buffer.compare(decompressBzip2(encodedBySystem.stdout), sample)).toBe(0);

      const bz = compressBzip2(sample);
      const decodedBySystem = cp.spawnSync('bzip2', ['-d', '-c'], { input: bz });
      expect(decodedBySystem.error).toBeUndefined();
      expect(decodedBySystem.status).toBe(0);
      expect(Buffer.compare(decodedBySystem.stdout, sample)).toBe(0);

      const oneByOnePng = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      );
      const wrappedBase64 = oneByOnePng.toString('base64').replace(/(.{16})/g, '$1\r\n  ');
      const fb2Xml =
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">' +
        '<description><title-info><book-title>Test Book</book-title><coverpage><image l:href="#cover.png"/></coverpage></title-info></description>' +
        '<body><section><p>Hello world.</p></section></body>' +
        `<binary id="cover.png" content-type="image/png">\n${wrappedBase64}\n</binary>` +
        '</FictionBook>';
      const model = await readFb2Model(fb2Xml, 'Fallback');
      expect(model.images).toHaveLength(1);
      expect(Buffer.compare(model.images[0]!.data, oneByOnePng)).toBe(0);
    });
  });
});
