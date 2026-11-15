import { describe, expect, it } from 'vitest';
import { assertToolInput, parseToolOptions, runWebTool, WebToolRefusal } from '../src/lib/tools/web-tools';
import { WEB_TOOLS } from '../src/lib/tools/tool-names';

describe('Commercial Web Tools (13 tools)', () => {
  it('includes all 13 tools in WEB_TOOLS', () => {
    expect(WEB_TOOLS).toEqual([
      'merge',
      'archive-create',
      'archive-extract',
      'split',
      'rotate',
      'protect',
      'unlock',
      'watermark',
      'extract-pages',
      'delete-pages',
      'reorder-pages',
      'archive-inspect',
      'zip-repair',
    ]);
  });

  describe('file type constraints', () => {
    it('refuses non-PDF files for PDF tools', () => {
      const pdfTools = ['protect', 'unlock', 'watermark', 'extract-pages', 'delete-pages', 'reorder-pages'] as const;
      for (const tool of pdfTools) {
        expect(() =>
          assertToolInput(tool, [{ name: 'test.docx', buffer: Buffer.from('hello') }])
        ).toThrow(WebToolRefusal);
      }
    });

    it('refuses non-zip files for zip-repair', () => {
      expect(() =>
        assertToolInput('zip-repair', [{ name: 'test.tar.gz', buffer: Buffer.from('hello') }])
      ).toThrow(WebToolRefusal);
    });

    it('accepts archives for archive-inspect', () => {
      expect(() =>
        assertToolInput('archive-inspect', [{ name: 'test.docx', buffer: Buffer.from('hello') }])
      ).toThrow(WebToolRefusal);
    });
  });

  describe('options parsing', () => {
    it('parses protect options with keyLength and passwords', () => {
      const opts = parseToolOptions('protect', JSON.stringify({
        userPassword: 'user123',
        ownerPassword: 'owner123',
        keyLength: 256,
        permissions: { print: 'low', modify: 'annotate' },
      }));
      expect(opts.protect?.userPassword).toBe('user123');
      expect(opts.protect?.ownerPassword).toBe('owner123');
      expect(opts.protect?.keyLength).toBe(256);
      expect(opts.protect?.permissions?.print).toBe('low');
    });

    it('parses unlock options', () => {
      const opts = parseToolOptions('unlock', JSON.stringify({
        password: 'secretPassword',
        confirmEditRights: true,
      }));
      expect(opts.unlock?.password).toBe('secretPassword');
      expect(opts.unlock?.confirmEditRights).toBe(true);
    });

    it('parses watermark options', () => {
      const opts = parseToolOptions('watermark', JSON.stringify({
        text: 'DRAFT',
        opacity: 0.5,
        rotation: 45,
        position: 'center',
      }));
      expect(opts.watermark?.text).toBe('DRAFT');
      expect(opts.watermark?.opacity).toBe(0.5);
      expect(opts.watermark?.rotation).toBe(45);
      expect(opts.watermark?.position).toBe('center');
    });

    it('parses split with everyNPages or ranges', () => {
      const opts = parseToolOptions('split', JSON.stringify({
        split: { ranges: '1-3,5', everyNPages: 2 },
      }));
      expect(opts.split?.ranges).toBe('1-3,5');
      expect(opts.split?.everyNPages).toBe(2);
    });

    it('parses rotate with rotations list', () => {
      const opts = parseToolOptions('rotate', JSON.stringify({
        rotate: {
          rotations: [
            { angle: 90, pages: '1-2' },
            { angle: 180, pages: '3-4' },
          ],
        },
      }));
      expect(opts.rotate?.rotations).toHaveLength(2);
      expect(opts.rotate?.rotations?.[0].rotation).toBe(90);
    });

    it('parses page ops options', () => {
      const ext = parseToolOptions('extract-pages', JSON.stringify({ pages: '2-4' }));
      expect(ext.extractPages?.pages).toBe('2-4');

      const del = parseToolOptions('delete-pages', JSON.stringify({ pages: '1,3' }));
      expect(del.deletePages?.pages).toBe('1,3');

      const reorder = parseToolOptions('reorder-pages', JSON.stringify({ order: [3, 1, 2] }));
      expect(reorder.reorderPages?.order).toEqual([3, 1, 2]);
    });
  });

  describe('execution on sample archives', () => {
    it('runs archive-inspect on a sample zip buffer', async () => {
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip();
      zip.addFile('sample.txt', Buffer.from('hello world content'));
      const buffer = zip.toBuffer();

      const output = await runWebTool('archive-inspect', [{ name: 'test.zip', buffer }], {});
      expect(output.kind).toBe('inspection');
      if (output.kind === 'inspection') {
        expect(output.inspection.totalEntries).toBe(1);
        expect(output.inspection.extractable).toBe(true);
      }
    });
  });

  describe('async tool jobs route (/api/tools/jobs) ownership and stored keys', () => {
    it('executes an async tool job from stored upload keys and enforces owner isolation (404 IDOR check)', async () => {
      const { NextRequest } = await import('next/server');
      const { PDFDocument } = await import('pdf-lib');
      const { storageProvider } = await import('../src/lib/storage');
      const { redisKeyStore } = await import('../src/lib/api-keys/redis-key-store');
      const { redisUserStore } = await import('../src/lib/auth/redis-user-store');
      const { POST: createToolJob } = await import('../src/app/api/tools/jobs/route');
      const { GET: getToolJobRoute, DELETE: deleteToolJobRoute } = await import('../src/app/api/tools/jobs/[id]/route');

      const docA = await PDFDocument.create();
      docA.addPage([200, 200]);
      const bufA = Buffer.from(await docA.save());
      const docB = await PDFDocument.create();
      docB.addPage([200, 200]);
      const bufB = Buffer.from(await docB.save());

      const keyA = `uploads/${crypto.randomUUID()}_a.pdf`;
      const keyB = `uploads/${crypto.randomUUID()}_b.pdf`;
      await storageProvider.saveObject(keyA, bufA, 'application/pdf', 'a.pdf');
      await storageProvider.saveObject(keyB, bufB, 'application/pdf', 'b.pdf');

      const ownerUser = await redisUserStore.createUser({
        name: 'Owner',
        email: `owner-${crypto.randomUUID()}@example.test`,
        passwordHash: 'hash',
        emailVerified: true,
      });
      const intruderUser = await redisUserStore.createUser({
        name: 'Intruder',
        email: `intruder-${crypto.randomUUID()}@example.test`,
        passwordHash: 'hash',
        emailVerified: true,
      });
      const ownerKey = await redisKeyStore.generateApiKey(ownerUser.id, 'owner', { scopes: ['convert:write', 'convert:read'] });
      const intruderKey = await redisKeyStore.generateApiKey(intruderUser.id, 'intruder', { scopes: ['convert:write', 'convert:read'] });

      const createReq = new NextRequest('http://localhost/api/tools/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerKey.secretKey}`,
        },
        body: JSON.stringify({
          tool: 'merge',
          files: [
            { key: keyA, name: 'a.pdf' },
            { key: keyB, name: 'b.pdf' },
          ],
          options: {},
        }),
      });

      const createRes = await createToolJob(createReq);
      expect(createRes.status).toBe(201);
      const { id: jobId } = (await createRes.json()) as { id: string };
      expect(jobId).toMatch(/^[0-9a-f-]{36}$/i);

      // Intruder GET and DELETE must receive 404 (not 200 or 403) so owned job IDs cannot be probed or cancelled.
      const intruderGet = await getToolJobRoute(
        new NextRequest(`http://localhost/api/tools/jobs/${jobId}`, {
          headers: { Authorization: `Bearer ${intruderKey.secretKey}` },
        }),
        { params: Promise.resolve({ id: jobId }) }
      );
      expect(intruderGet.status).toBe(404);

      const intruderDelete = await deleteToolJobRoute(
        new NextRequest(`http://localhost/api/tools/jobs/${jobId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${intruderKey.secretKey}` },
        }),
        { params: Promise.resolve({ id: jobId }) }
      );
      expect(intruderDelete.status).toBe(404);

      // Owner polls until completed and verifies temporary upload keys were cleaned up.
      let completedBody: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 40; attempt++) {
        const ownerGet = await getToolJobRoute(
          new NextRequest(`http://localhost/api/tools/jobs/${jobId}`, {
            headers: { Authorization: `Bearer ${ownerKey.secretKey}` },
          }),
          { params: Promise.resolve({ id: jobId }) }
        );
        expect(ownerGet.status).toBe(200);
        const body = (await ownerGet.json()) as Record<string, unknown>;
        if (body.status === 'completed') {
          completedBody = body;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(completedBody?.status).toBe('completed');
      const resultFile = completedBody?.result as { key?: string; size: number; url: string };
      expect(resultFile.size).toBeGreaterThan(100);
      expect(resultFile.key).toMatch(new RegExp(`^conversions/${ownerUser.id}/[0-9a-f-]{36}_merged\\.pdf$`));
      expect(await storageProvider.stat(keyA)).toBeNull();
      expect(await storageProvider.stat(keyB)).toBeNull();
    });
  });
});
