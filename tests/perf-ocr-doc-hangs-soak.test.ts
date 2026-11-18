import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  ensureSample,
  readRemoteManifest,
  resetVerifiedSamples,
  sha256,
  type PinnedFile,
} from '../bench/corpora';
import { ARCHIVE_SECURITY_LIMITS } from '../src/lib/conversions/archive';
import { DOCX_MAX_ANCHORED_SHAPES, documentToDocx } from '../src/lib/conversions/document-model/docx';
import type { DocumentModel, TableCellBlock } from '../src/lib/conversions/document-model/model';
import { convertImage } from '../src/lib/conversions/image';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { tryDirectOcrSearchablePdf } from '../src/lib/conversions/ocr-direct-pdf';
import { preprocessOcrImage } from '../src/lib/conversions/ocr-preprocess';
import { OcrWorkerPool } from '../src/lib/conversions/ocr-worker-pool';
import { hasWordFloatingShapes, stripWordFloatingShapes } from '../src/lib/conversions/office/doc-reader';
import { CFBF_MAGIC } from '../src/lib/format-signatures';
import { CompoundFileStructureError, PayloadLimitError } from '../src/lib/types';
import { convertPdfPagesWithNativeTools, libreOfficePool, resetNativeBinaryCache } from '../src/worker/engines';
import { assertLegacyCompoundFileReadable } from '../src/worker/office-input-checks';
import { convertBridgedTarget, withWordAnchoredLayoutRetry, type OfficeSuiteRequest, type OfficeSuiteRouteDeps } from '../src/worker/office-suite-route';
import { SandboxedProcessError, SandboxedTimeoutError } from '../src/worker/sandbox';

const ROOT = path.resolve(__dirname, '..');

/** Builds a minimal valid V3 CFBF binary `.doc` with one 4096-byte WordDocument stream and FIB fields. */
function buildSyntheticWord97Doc(options: { corruptRoot?: boolean; plcfSpaMomLcb?: number; plcfSpaHdrLcb?: number } = {}): Buffer {
  const sectorSize = 512;
  const wordSectors = 8; // 4096 bytes (>= miniStreamCutoffSize)
  const totalSectors = 2 + wordSectors; // 0: FAT, 1: Dir, 2..9: WordDocument
  const buf = Buffer.alloc((1 + totalSectors) * sectorSize, 0);

  // Header
  Buffer.from(CFBF_MAGIC).copy(buf, 0);
  buf.writeUInt16LE(0x003e, 24); // minor version
  buf.writeUInt16LE(3, 26); // major version 3
  buf.writeUInt16LE(0xfffe, 28); // little-endian
  buf.writeUInt16LE(9, 30); // sector shift 512
  buf.writeUInt16LE(6, 32); // mini sector shift 64
  buf.writeUInt32LE(1, 44); // csectFat
  buf.writeUInt32LE(1, 48); // sectDirStart
  buf.writeUInt32LE(4096, 56); // miniStreamCutoffSize
  buf.writeUInt32LE(0xfffffffe, 60); // sectMiniFatStart = ENDOFCHAIN
  buf.writeUInt32LE(0xfffffffe, 68); // sectDifatStart = ENDOFCHAIN
  for (let i = 0; i < 109; i++) buf.writeUInt32LE(0xffffffff, 76 + i * 4);
  buf.writeUInt32LE(0, 76);

  // FAT sector 0 (file offset 512)
  const fatOffset = sectorSize;
  for (let i = 0; i < 128; i++) buf.writeUInt32LE(0xffffffff, fatOffset + i * 4);
  buf.writeUInt32LE(0xfffffffd, fatOffset + 0 * 4); // FATSECT
  buf.writeUInt32LE(options.corruptRoot ? 1 : 0xfffffffe, fatOffset + 1 * 4); // corruptRoot: dir chain self-loop -> malformed
  for (let s = 2; s < 2 + wordSectors - 1; s++) buf.writeUInt32LE(s + 1, fatOffset + s * 4);
  buf.writeUInt32LE(0xfffffffe, fatOffset + (2 + wordSectors - 1) * 4);

  // Directory sector 1 (file offset 1024)
  const dirOffset = sectorSize * 2;
  const writeUtf16Name = (entryAt: number, name: string): void => {
    const encoded = Buffer.from(name, 'utf16le');
    encoded.copy(buf, entryAt);
    buf.writeUInt16LE(encoded.length + 2, entryAt + 64);
  };
  // Entry 0: Root Entry
  writeUtf16Name(dirOffset, 'Root Entry');
  buf[dirOffset + 66] = 5; // root storage
  buf.writeUInt32LE(0xffffffff, dirOffset + 68);
  buf.writeUInt32LE(0xffffffff, dirOffset + 72);
  buf.writeUInt32LE(1, dirOffset + 76); // child = entry 1
  buf.writeUInt32LE(0xfffffffe, dirOffset + 116);
  // Entry 1: WordDocument
  const wdEntry = dirOffset + 128;
  writeUtf16Name(wdEntry, 'WordDocument');
  buf[wdEntry + 66] = 2; // user stream
  buf.writeUInt32LE(0xffffffff, wdEntry + 68);
  buf.writeUInt32LE(0xffffffff, wdEntry + 72);
  buf.writeUInt32LE(0xffffffff, wdEntry + 76);
  buf.writeUInt32LE(2, wdEntry + 116); // startSector = 2
  buf.writeUInt32LE(wordSectors * sectorSize, wdEntry + 120);

  // WordDocument stream at file offset 1536 (sector 2)
  const wordAt = sectorSize * 3;
  buf.writeUInt16LE(0xa5ec, wordAt + 0); // wIdent
  buf.writeUInt16LE(0x00c1, wordAt + 2); // nFib (Word 97)
  buf.writeUInt16LE(14, wordAt + 32); // csw
  buf.writeUInt16LE(22, wordAt + 62); // cslw
  buf.writeUInt32LE(512, wordAt + 76); // ccpText sentinel preserved on strip
  buf.writeUInt16LE(93, wordAt + 152); // cbRgFcLcb (Word 97)
  // Pair 40 (fcPlcfSpaMom, lcbPlcfSpaMom) at stream offset 154 + 40 * 8 = 474
  if (options.plcfSpaMomLcb && options.plcfSpaMomLcb > 0) {
    buf.writeUInt32LE(2048, wordAt + 474);
    buf.writeUInt32LE(options.plcfSpaMomLcb, wordAt + 478);
  }
  // Pair 41 (fcPlcfSpaHdr, lcbPlcfSpaHdr) at stream offset 154 + 41 * 8 = 482
  if (options.plcfSpaHdrLcb && options.plcfSpaHdrLcb > 0) {
    buf.writeUInt32LE(3072, wordAt + 482);
    buf.writeUInt32LE(options.plcfSpaHdrLcb, wordAt + 486);
  }
  return buf;
}

describe('P0 perf / hang / soak / mirror regression guards', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    resetNativeBinaryCache();
    resetVerifiedSamples();
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  const makeTempDir = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  describe('1. OCR direct passthrough & parameter reuse equivalence', () => {
    it('preprocessOcrImage produces identical grayscale buffers with precheckedMeta and skip-metadata fast path', async () => {
      const scanPath = path.join(ROOT, 'bench', 'corpus', 'scan.png');
      const png = fs.readFileSync(scanPath);
      const meta = await sharp(png).metadata();
      const withoutMeta = await preprocessOcrImage(png);
      const withMeta = await preprocessOcrImage(png, undefined, 0, meta);
      expect(withMeta.geometry).toEqual(withoutMeta.geometry);
      expect(withMeta.image.equals(withoutMeta.image)).toBe(true);
    });

    it('convertImage to searchable PDF on scan.png preserves 840x260 pts page geometry without decodePdfPages re-encode', async () => {
      const scanPath = path.join(ROOT, 'bench', 'corpus', 'scan.png');
      const png = fs.readFileSync(scanPath);
      const result = await convertImage(png, 'pdf', { ocrEnabled: true }, 'scan.png', 'png');
      expect(result.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      const loaded = await PDFDocument.load(result.buffer);
      expect(loaded.getPage(0).getSize()).toEqual({ width: 840, height: 260 });

      const skipped = await tryDirectOcrSearchablePdf(png, { ocrEnabled: true, page: 2 }, 'scan', {
        skipDirect: false,
        statesDensity: true,
        mapFailure: (err) => err as Error,
      });
      expect(skipped).toBeNull();
    });

    it('OcrWorkerPool skips redundant setParameters only when skipRepeatedParameters is enabled', async () => {
      let setParamsCalls = 0;
      const fakeWorker = {
        setParameters: async () => {
          setParamsCalls++;
        },
        recognize: async () => ({
          data: { text: 'ok', confidence: 99, hocr: '', tsv: '' },
        }),
        terminate: async () => {},
      };
      const spec = { langs: 'eng', langPath: '/tessdata', gzip: false, engineMode: 1, parameters: { tessedit_pageseg_mode: '3' } };
      const pool = new OcrWorkerPool({ maxWorkersPerKey: 1, maxWorkersTotal: 1, idleTtlMs: 1000 });
      vi.spyOn(pool, 'createWorker').mockResolvedValue(fakeWorker as never);
      await pool.run(spec, async (recognize) => recognize(Buffer.from('a')), undefined, { skipRepeatedParameters: true });
      await pool.run(spec, async (recognize) => recognize(Buffer.from('b')), undefined, { skipRepeatedParameters: true });
      expect(setParamsCalls).toBe(1);
      await pool.run(spec, async (recognize) => recognize(Buffer.from('c')));
      expect(setParamsCalls).toBe(2);
      await pool.shutdown();
    });
  });

  describe('2. Office/PDF hang elimination & fail-closed output caps', () => {
    it('rejects malformed OLE2 CFBF directories before spawning LibreOffice (gd-948342 pattern)', async () => {
      const corruptDoc = buildSyntheticWord97Doc({ corruptRoot: true });
      expect(() => assertLegacyCompoundFileReadable(corruptDoc, 'doc')).toThrow(CompoundFileStructureError);
      const sentinelLog = path.join(makeTempDir('cfbf-no-soffice-'), 'soffice-invoked.txt');
      const fakeSoffice = path.join(path.dirname(sentinelLog), 'soffice');
      fs.writeFileSync(fakeSoffice, `#!/bin/sh\ntouch "${sentinelLog}"\nexit 1\n`, { mode: 0o755 });
      const prevSoffice = process.env.SOFFICE_PATH;
      process.env.SOFFICE_PATH = fakeSoffice;
      resetNativeBinaryCache();
      try {
        await expect(dispatchConversion(corruptDoc, 'doc', 'pdf', {}, 'corrupt.doc')).rejects.toBeInstanceOf(CompoundFileStructureError);
        await expect(dispatchConversion(corruptDoc, 'doc', 'html', {}, 'corrupt.doc')).rejects.toMatchObject({
          cause: expect.any(CompoundFileStructureError),
        });
        expect(fs.existsSync(sentinelLog)).toBe(false);
      } finally {
        if (prevSoffice === undefined) delete process.env.SOFFICE_PATH;
        else process.env.SOFFICE_PATH = prevSoffice;
      }
    });

    it('detects and strips PlcfSpaMom/PlcfSpaHdr offsets cleanly and retries only SandboxedTimeoutError', async () => {
      const withShapes = buildSyntheticWord97Doc({ plcfSpaMomLcb: 874, plcfSpaHdrLcb: 64 });
      expect(hasWordFloatingShapes(withShapes)).toBe(true);
      const stripped = stripWordFloatingShapes(withShapes);
      expect(stripped).toBeDefined();
      expect(hasWordFloatingShapes(stripped!)).toBe(false);
      // Preserves unrelated FIB fields (ccpText at offset 1536 + 76)
      expect(stripped!.readUInt32LE(512 * 3 + 76)).toBe(512);

      const wrappedRun = vi.fn(async (input: Buffer, _src: string, _tgt: string, _opts: unknown, _baseName: string) => {
        if (hasWordFloatingShapes(input)) throw new SandboxedTimeoutError(30_000);
        return { buffer: Buffer.from('ok'), mimeType: 'application/pdf', filename: 'a.pdf', size: 2, engineUsed: 'native-soffice' as const, executionTimeMs: 5 };
      });
      const res = await withWordAnchoredLayoutRetry(wrappedRun as never)(withShapes, 'doc', 'pdf', {}, 'a.doc');
      expect(res?.buffer.toString()).toBe('ok');
      expect(wrappedRun).toHaveBeenCalledTimes(2);
      expect(wrappedRun.mock.calls[0]?.[1]).toBe('doc');

      const crashRun = vi.fn(async () => {
        throw new SandboxedProcessError('Fatal exception: Signal 6', 134, 'Fatal exception: Signal 6', 'SIGABRT');
      });
      await expect(withWordAnchoredLayoutRetry(crashRun as never)(withShapes, 'doc', 'pdf', {}, 'crash.doc')).rejects.toBeInstanceOf(SandboxedProcessError);
      expect(crashRun).toHaveBeenCalledTimes(1);
    });

    it('does not fall through to a second standalone soffice spawn after pool SandboxedTimeoutError', async () => {
      const dir = makeTempDir('pool-timeout-');
      const sentinelLog = path.join(dir, 'standalone-invoked.txt');
      const fakeSoffice = path.join(dir, 'soffice');
      fs.writeFileSync(fakeSoffice, `#!/bin/sh\ntouch "${sentinelLog}"\nexit 1\n`, { mode: 0o755 });
      const prevSoffice = process.env.SOFFICE_PATH;
      process.env.SOFFICE_PATH = fakeSoffice;
      resetNativeBinaryCache();
      vi.spyOn(libreOfficePool, 'isEnabled').mockReturnValue(true);
      vi.spyOn(libreOfficePool, 'convert').mockRejectedValue(new SandboxedTimeoutError(30_000));
      try {
        await expect(dispatchConversion(buildSyntheticWord97Doc(), 'doc', 'pdf', {}, 'a.doc')).rejects.toMatchObject({
          name: expect.stringMatching(/CpuTaskTimeoutError|SandboxedTimeoutError|ConversionFailedError/),
        });
        expect(fs.existsSync(sentinelLog)).toBe(false);
      } finally {
        if (prevSoffice === undefined) delete process.env.SOFFICE_PATH;
        else process.env.SOFFICE_PATH = prevSoffice;
      }
    });

    it('unwraps giant layout wrapper tables, chunks >400-row tables without breaking vMerge, deduplicates Code rFonts, and enforces maxAnchoredShapes', async () => {
      const giantCode = Array.from({ length: 250 }, (_, i) => `line_${i}`).join('\n');
      const vMergeRows: TableCellBlock[][] = Array.from({ length: 850 }, (_, r) => [
        {
          paragraphs: [{ type: 'paragraph', runs: [{ text: `R${r}`, bold: false, italic: false, monospace: false }], rtl: false, align: 'left' }],
          colSpan: 1,
          rowSpan: r === 399 ? 3 : 1,
          continuation: r === 400 || r === 401,
          header: false,
        },
      ]);
      const denseShapes = Array.from({ length: 450 }, (_, i) => ({
        kind: 'rect' as const,
        x: 10 + (i % 10),
        y: 10,
        width: 20,
        height: 10,
        fill: '112233',
      }));
      const model: DocumentModel = {
        pageCount: 1,
        pageWidthPt: 612,
        pageHeightPt: 792,
        margins: { top: 72, right: 72, bottom: 72, left: 72 },
        bodyFont: 'sans',
        bodySize: 11,
        headingSizes: [20],
        images: [],
        sections: [
          {
            columns: 1,
            blocks: [
              // Outer layout shell (1 row, 2 cols, bordered, 250-line code block inside cell 1)
              {
                type: 'table',
                columnWidths: [100, 360],
                bordered: true,
                rows: [
                  [
                    {
                      paragraphs: [{ type: 'paragraph', runs: [{ text: 'nav', bold: false, italic: false, monospace: false }], rtl: false, align: 'left' }],
                      colSpan: 1,
                      rowSpan: 1,
                      continuation: false,
                      header: false,
                    },
                    { paragraphs: [], blocks: [{ type: 'code', text: giantCode }], colSpan: 1, rowSpan: 1, continuation: false, header: false },
                  ],
                ],
              },
              // Huge 850-row data table with vMerge spanning across row 400 boundary
              {
                type: 'table',
                columnWidths: [460],
                bordered: false,
                rows: vMergeRows,
              },
              {
                type: 'paragraph',
                runs: [{ text: 'chart', bold: false, italic: false, monospace: false }],
                rtl: false,
                align: 'left',
                shapes: denseShapes,
              },
            ],
          },
        ],
      };

      const bridgedDocx = await documentToDocx(model, { maxAnchoredShapes: 200 });
      const bridgedXml = await (await JSZip.loadAsync(bridgedDocx)).file('word/document.xml')!.async('string');
      // 850-row data table stays chunked into 3 tables (402 + 400 + 48 rows so row 399..401 stay in chunk 1), outer layout wrapper unwrapped
      const tables = bridgedXml.match(/<w:tbl>/g) ?? [];
      expect(tables).toHaveLength(3);
      expect(bridgedXml).toContain('<w:t xml:space="preserve">nav</w:t>');
      expect(bridgedXml).toContain('<w:t xml:space="preserve">line_249</w:t>');
      // Code paragraphs omit redundant per-run rFonts
      expect(bridgedXml).not.toContain('<w:rFonts w:ascii="Courier New"');
      // Dense shapes omitted under maxAnchoredShapes: 200
      expect(bridgedXml).not.toContain('<wp:anchor');

      const fullDocx = await documentToDocx(model, { maxAnchoredShapes: 500 });
      const fullXml = await (await JSZip.loadAsync(fullDocx)).file('word/document.xml')!.async('string');
      expect((fullXml.match(/<wp:anchor\b/g) ?? []).length).toBe(450);

      // Verify convertBridgedTarget forwards DOCX_MAX_ANCHORED_SHAPES only when tgt === 'doc'
      const seenOptions: Record<string, unknown>[] = [];
      const mockDeps: OfficeSuiteRouteDeps = {
        async writeWithOfficeSuite() {
          return { buffer: Buffer.from('doc'), mimeType: 'application/msword', filename: 'a.doc', size: 3, engineUsed: 'native-soffice', executionTimeMs: 1 };
        },
        async convert(_in, _src, _tgt, opts) {
          seenOptions.push(opts as unknown as Record<string, unknown>);
          return { buffer: Buffer.from('docx'), mimeType: 'application/octet-stream', filename: 'a.docx', size: 4, engineUsed: 'internal-fallback', executionTimeMs: 1 };
        },
        discardOutput() {},
      };
      const req = (tgt: string): OfficeSuiteRequest => ({ input: Buffer.from('%PDF-'), src: 'pdf', tgt, options: {}, originalFilename: 'x.pdf' });
      await convertBridgedTarget(mockDeps, req('doc'), async () => { throw new Error('unexpected'); });
      expect((seenOptions[0] as Record<symbol, unknown>)[DOCX_MAX_ANCHORED_SHAPES]).toBeTypeOf('number');
    });

    it('fails closed before Poppler raster render when multi-page PDF to BMP exceeds 500 MiB uncompressed limit', async () => {
      const dir = makeTempDir('bmp-limit-');
      const doc = await PDFDocument.create();
      for (let i = 0; i < 310; i++) doc.addPage([612, 792]);
      const pdfBytes = Buffer.from(await doc.save());

      const sentinelLog = path.join(dir, 'pdftoppm-invoked.txt');
      const fakePdftoppm = path.join(dir, 'pdftoppm');
      fs.writeFileSync(fakePdftoppm, `#!/bin/sh\ntouch "${sentinelLog}"\nexit 1\n`, { mode: 0o755 });
      const prevPdftoppm = process.env.PDFTOPPM_PATH;
      process.env.PDFTOPPM_PATH = fakePdftoppm;
      resetNativeBinaryCache();
      try {
        await expect(convertPdfPagesWithNativeTools(pdfBytes, 'bmp', {}, '310p.pdf')).rejects.toMatchObject({
          name: 'PayloadLimitError',
          status: 413,
          message: expect.stringContaining(`${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE}`),
        });
        expect(fs.existsSync(sentinelLog)).toBe(false);
      } finally {
        if (prevPdftoppm === undefined) delete process.env.PDFTOPPM_PATH;
        else process.env.PDFTOPPM_PATH = prevPdftoppm;
      }
    });
  });

  describe('3. Endurance soak workflow staging & atomic SIGTERM telemetry flush', () => {
    it('configures soak-test.yml jobs safely inside GitHub 360-minute limit with sequential matrix', () => {
      const yml = parseYaml(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'soak-test.yml'), 'utf-8')) as {
        env: Record<string, string>;
        jobs: {
          plan: { outputs: Record<string, string> };
          'endurance-soak': {
            'timeout-minutes': number;
            strategy: { 'max-parallel': number; matrix: { stage: string } };
            steps: Array<{ name?: string; uses?: string; if?: string; with?: Record<string, string> }>;
          };
        };
      };
      expect(Number(yml.env.MAX_STAGE_SECONDS)).toBeLessThanOrEqual(19_800);
      expect(yml.jobs['endurance-soak']['timeout-minutes']).toBeLessThan(360);
      expect(yml.jobs['endurance-soak'].strategy['max-parallel']).toBe(1);
      const upload = yml.jobs['endurance-soak'].steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
      expect(upload?.if).toBe('always()');
      expect(upload?.with?.name).toContain('${{ matrix.stage.stage }}');
    });

    it('writes periodic telemetry snapshots and flushes soak-telemetry JSON on SIGTERM', async () => {
      const dir = makeTempDir('soak-sigterm-');
      const outputPath = path.join(dir, 'soak-telemetry.json');
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          path.join(ROOT, 'scripts', 'run-endurance-soak.ts'),
          '--duration',
          '30s',
          '--target-mb',
          '2',
          '--snapshot-interval-ms',
          '100',
          '--quiet',
          '--output',
          outputPath,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      try {
        const deadline = Date.now() + 10_000;
        while (!fs.existsSync(outputPath) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(fs.existsSync(outputPath)).toBe(true);
        const midReport = JSON.parse(fs.readFileSync(outputPath, 'utf-8')) as { totalIterations: number; isMemoryStable: boolean };
        expect(midReport.totalIterations).toBeGreaterThanOrEqual(1);

        child.kill('SIGTERM');
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          const killTimer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('soak child did not exit within 5s of SIGTERM'));
          }, 5000);
          child.on('exit', (code) => {
            clearTimeout(killTimer);
            resolve(code);
          });
        });
        expect(exitCode).toBe(0);
        const finalReport = JSON.parse(fs.readFileSync(outputPath, 'utf-8')) as {
          totalIterations: number;
          totalBytesProcessed: number;
          isMemoryStable: boolean;
        };
        expect(finalReport.totalIterations).toBeGreaterThanOrEqual(1);
        expect(finalReport.totalBytesProcessed).toBeGreaterThan(0);
        expect(finalReport.isMemoryStable).toBe(true);
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    }, 20_000);
  });

  describe('4. Public sample mirror fallback resilience', () => {
    it('fails over immediately when origin returns 503 Retry-After: 3600 to verified Wayback mirror bytes', async () => {
      const manifest = readRemoteManifest();
      const pg345 = manifest.samples.find((s) => s.id === 'book-pg345.mobi');
      expect(pg345?.origin.kind).toBe('file');
      if (pg345?.origin.kind === 'file') {
        expect(pg345.origin.mirrors?.length).toBeGreaterThanOrEqual(2);
      }

      const payload = Buffer.from('verified mobi payload bytes');
      const dir = makeTempDir('mirror-503-');
      const busyOrigin = http.createServer((_req, res) => {
        res.writeHead(503, { 'retry-after': '3600', 'content-length': 0 }).end();
      });
      const deadMirror = http.createServer((_req, res) => {
        res.writeHead(503, { 'content-length': 0 }).end();
      });
      const healthyMirror = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-length': payload.length }).end(payload);
      });
      await Promise.all([busyOrigin, deadMirror, healthyMirror].map((s) => new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))));
      try {
        const portBusy = (busyOrigin.address() as AddressInfo).port;
        const portDead = (deadMirror.address() as AddressInfo).port;
        const portOk = (healthyMirror.address() as AddressInfo).port;
        const sample: PinnedFile = {
          id: 'book-pg345.mobi',
          family: 'ebook',
          set: 'gutenberg',
          origin: {
            kind: 'file',
            url: `http://127.0.0.1:${portBusy}/pg345-images.mobi`,
            mirrors: [`http://127.0.0.1:${portDead}/m1`, `http://127.0.0.1:${portOk}/m2`],
          },
          bytes: payload.length,
          sha256: sha256(payload),
        };
        const cached = await ensureSample(sample, { cacheDir: dir });
        expect(fs.readFileSync(cached).equals(payload)).toBe(true);
      } finally {
        await Promise.all([busyOrigin, deadMirror, healthyMirror].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
      }
    }, 20_000);
  });
});
