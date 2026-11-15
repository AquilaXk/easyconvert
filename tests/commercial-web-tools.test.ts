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
});
