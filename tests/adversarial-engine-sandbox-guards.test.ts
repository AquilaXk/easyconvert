import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';
import { ARCHIVE_SECURITY_LIMITS } from '../src/lib/conversions/archive';
import { convertImage } from '../src/lib/conversions/image';
import { zipPageImages } from '../src/lib/conversions/image-frame-output';
import { MAX_ANIMATION_FRAMES } from '../src/lib/conversions/image-limits';
import { pageEntryName } from '../src/lib/conversions/page-range';
import { assertPdfJbig2WithinLimits, declaredJbig2Pages, MAX_JBIG2_NAMES_EXAMINED } from '../src/lib/conversions/pdf-jbig2-guard';
import { splitPdfPages } from '../src/lib/conversions/pdf-postprocess/page-ops';
import { convertToPdfA } from '../src/lib/conversions/pdf-postprocess/pdfa';
import { createZipBuffer, ZipWriter } from '../src/lib/conversions/zip-writer';
import { sanitizeSvgString } from '../src/lib/security/svg-sanitizer';
import { ConversionFailedError, DecompressionLimitError, PayloadLimitError } from '../src/lib/types';
import {
  convertWithHeadlessOffice,
  convertWithNativeFfmpeg,
  convertWithNativePoppler,
  convertPdfPagesWithNativeTools,
  libreOfficePool,
  safeOutputStem,
} from '../src/worker/engines';
import { LibreOfficePoolManager, type SandboxedProcessRunner } from '../src/worker/libreoffice-pool';
import { buildApngFile, rgbaImage, type ApngSpec } from './helpers/apng-builder';
import { captureError } from './helpers/capture-error';
import { buildPdf, type CraftObject } from './helpers/pdf-craft';
import { skipWithoutTools } from './helpers/strict-skip';
import { runWithoutFileConfinement } from './helpers/unconfined-files';
import { buildAnimatedWebpFromStill } from './helpers/webp-builder';

runWithoutFileConfinement();

const sandboxSpies = vi.hoisted(() => ({
  executeCalls: [] as Array<{ binary: string; args: string[]; options: Record<string, unknown> | undefined }>,
  launchCalls: [] as Array<{ binary: string; args: string[]; options: Record<string, unknown> | undefined }>,
  zipFileCalls: [] as Array<{ filePath: string; entryNames: string[] }>,
}));

vi.mock('../src/lib/security/process-sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/security/process-sandbox')>();
  return {
    ...actual,
    executeSandboxedBinary: async (
      binaryPath: string,
      args: string[],
      options?: Parameters<typeof actual.executeSandboxedBinary>[2]
    ) => {
      sandboxSpies.executeCalls.push({
        binary: binaryPath,
        args: [...args],
        options: options as Record<string, unknown> | undefined,
      });
      return actual.executeSandboxedBinary(binaryPath, args, options);
    },
  };
});

vi.mock('../src/lib/security/sandbox-launcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/security/sandbox-launcher')>();
  return {
    ...actual,
    launchSandboxedBinary: async (
      binaryPath: string,
      args: string[],
      options?: Parameters<typeof actual.launchSandboxedBinary>[2]
    ) => {
      sandboxSpies.launchCalls.push({
        binary: binaryPath,
        args: [...args],
        options: options as Record<string, unknown> | undefined,
      });
      return actual.launchSandboxedBinary(binaryPath, args, options);
    },
  };
});

vi.mock('../src/lib/conversions/zip-writer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/conversions/zip-writer')>();
  return {
    ...actual,
    writeDeflatedZipFile: async (
      filePath: string,
      files: Parameters<typeof actual.writeDeflatedZipFile>[1]
    ) => {
      sandboxSpies.zipFileCalls.push({
        filePath,
        entryNames: files.map((file) => file.name),
      });
      return actual.writeDeflatedZipFile(filePath, files);
    },
  };
});

vi.setConfig({ testTimeout: 60_000 });

const ROOT = path.resolve(__dirname, '..');
const toolsMissingPdfOps = skipWithoutTools('qpdf');
const toolsMissingPoppler = skipWithoutTools('pdftoppm', 'pdfinfo');

function resetCallSpies(): void {
  sandboxSpies.executeCalls.length = 0;
  sandboxSpies.launchCalls.length = 0;
  sandboxSpies.zipFileCalls.length = 0;
}

describe('P0-1: ZipWriter, pageEntryName, and worker stem path-traversal guards', () => {
  let shimDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(name: string, value: string): void {
    if (!(name in savedEnv)) savedEnv[name] = process.env[name];
    process.env[name] = value;
  }

  function writeShim(name: string, body: string): string {
    const file = path.join(shimDir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  }

  beforeAll(() => {
    shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-p0-guards-'));
  });

  afterEach(() => {
    resetCallSpies();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      delete savedEnv[k];
    }
  });

  afterAll(() => {
    fs.rmSync(shimDir, { recursive: true, force: true });
  });

  it.each([
    '../escape.txt',
    'a/../b.txt',
    './foo.txt',
    'a/./b.txt',
    '.',
    '..',
    './',
    '../',
    'a/..',
    'a/.',
    '/etc/passwd',
    '/',
    'foo\\bar.txt',
    '..\\evil.txt',
    'C:\\Windows\\win.ini',
    'C:',
    'C:/evil.txt',
    'd:/secret.txt',
    'foo\0bar.txt',
    'a//b.txt',
  ])('ZipWriter.addEntry rejects unsafe zip-slip/traversal path %j', async (badName) => {
    const writer = new ZipWriter(() => undefined);
    await expect(writer.addEntry({ name: badName, data: Buffer.from('x') })).rejects.toThrow(/ZIP writer:/);
  });

  it('ZipWriter.addEntry allows clean relative nested paths and directories', async () => {
    const buf = await createZipBuffer([
      { name: 'dir/', data: undefined },
      { name: 'word/document.xml', data: Buffer.from('<w:document/>') },
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      { name: 'seg_000.ts', data: Buffer.from('ts-bytes') },
    ]);
    const zip = await JSZip.loadAsync(buf);
    expect(Object.keys(zip.files).sort()).toEqual(['[Content_Types].xml', 'dir/', 'seg_000.ts', 'word/document.xml']);
    expect(await zip.file('word/document.xml')!.async('string')).toBe('<w:document/>');
  });

  it('pageEntryName sanitizes directory prefixes, .., drive letters, and control characters', () => {
    expect(pageEntryName('../../etc/passwd', 1, 10, 'png')).toBe('passwd-p001.png');
    expect(pageEntryName('../..', 2, 10, 'png')).toBe('page-p002.png');
    expect(pageEntryName('a/b/..', 3, 10, 'png')).toBe('page-p003.png');
    expect(pageEntryName('C:\\Users\\bob\\report', 4, 100, 'png')).toBe('report-p004.png');
    expect(pageEntryName('foo\x00\n..bar', 5, 100, 'png')).toBe('foobar-p005.png');
  });

  it('safeOutputStem extracts safe leaf stem with bounded length and fallback', () => {
    expect(safeOutputStem(undefined)).toBe('converted');
    expect(safeOutputStem('')).toBe('converted');
    expect(safeOutputStem('../../etc/passwd')).toBe('passwd');
    expect(safeOutputStem('../../etc/cron.d/pwn.pdf')).toBe('pwn');
    expect(safeOutputStem('../../../')).toBe('converted');
    expect(safeOutputStem('..')).toBe('converted');
    expect(safeOutputStem('.')).toBe('converted');
    expect(safeOutputStem('..pdf')).toBe('converted');
    expect(safeOutputStem('.hidden')).toBe('converted');
    expect(safeOutputStem('C:\\Windows\\System32\\cmd.exe')).toBe('cmd');
    expect(safeOutputStem('C:evil.txt')).toBe('evil');
    expect(safeOutputStem('a\x00/../../b\r\n..c.png')).toBe('bc');
    expect(safeOutputStem('report.v2.pdf')).toBe('report.v2');
    const longStem = safeOutputStem(`${'x'.repeat(200)}.pdf`);
    expect(longStem).toHaveLength(120);
    expect(longStem).toBe('x'.repeat(120));
  });

  it('convertWithNativeFfmpeg packaging uses fixed packaged-output.zip inside tempDir and sanitized display filename', async () => {
    const sentinelTarget = path.join(os.tmpdir(), `ec-zipslip-sentinel-${Date.now()}`);
    const sentinelZip = `${sentinelTarget}-hls.zip`;
    const fakeFfmpeg = writeShim(
      'fake-ffmpeg',
      [
        'if [ "$1" = "-version" ]; then echo "ffmpeg version 7.1"; exit 0; fi',
        'last=""',
        'for arg in "$@"; do last="$arg"; done',
        'case "$*" in',
        '  *".m3u8"*)',
        '    dir="$(dirname "$last")"',
        '    printf "#EXTM3U\\n" > "$dir/playlist.m3u8"',
        '    printf "seg0" > "$dir/seg_000.ts"',
        '    exit 0',
        '    ;;',
        'esac',
        'exit 0',
      ].join('\n')
    );
    const fakeFfprobe = writeShim(
      'fake-ffprobe',
      [
        'if [ "$1" = "-version" ]; then echo "ffprobe version 7.1"; exit 0; fi',
        'case "$*" in *stream=channels*) printf "2\\n"; exit 0 ;; *stream=index*) printf "0\\n"; exit 0 ;; esac',
        'printf \'{"format":{"duration":"1.0"},"streams":[{"index":0,"codec_type":"video","codec_name":"h264","width":320,"height":240,"r_frame_rate":"30/1","avg_frame_rate":"30/1"}]}\'',
      ].join('\n')
    );
    setEnv('FFMPEG_PATH', fakeFfmpeg);
    setEnv('FFPROBE_PATH', fakeFfprobe);

    const traversalName = path.relative(os.tmpdir(), sentinelTarget);
    const result = await convertWithNativeFfmpeg(
      Buffer.from('fake-mp4'),
      'mp4',
      'hls',
      { packaging: { format: 'hls' }, throwOnUnavailable: true },
      `../../${traversalName}.mp4`
    );

    expect(result).not.toBeNull();
    expect(result!.filename).toBe(`${path.basename(sentinelTarget)}-hls.zip`);
    expect(result!.filename).not.toContain('/');
    expect(result!.filename).not.toContain('..');
    expect(fs.existsSync(sentinelZip)).toBe(false);
    expect(sandboxSpies.zipFileCalls).toHaveLength(1);
    expect(path.basename(sandboxSpies.zipFileCalls[0].filePath)).toBe('packaged-output.zip');
  });

  it.skipIf(toolsMissingPoppler)(
    'convertWithNativePoppler multi-page uses fixed pages-output.zip inside tempDir and sanitized ZIP entry names',
    async () => {
      const pdfDoc = await PDFDocument.create();
      pdfDoc.addPage([200, 200]);
      pdfDoc.addPage([200, 200]);
      const pdf = Buffer.from(await pdfDoc.save());

      const result = await convertWithNativePoppler(
        pdf,
        'pdf',
        'png',
        { throwOnUnavailable: true },
        '../../../../tmp/evil-poppler-escape.pdf'
      );

      expect(result).not.toBeNull();
      expect(result!.filename).toBe('evil-poppler-escape.zip');
      expect(sandboxSpies.zipFileCalls).toHaveLength(1);
      expect(path.basename(sandboxSpies.zipFileCalls[0].filePath)).toBe('pages-output.zip');
      const zip = await JSZip.loadAsync(result!.buffer);
      expect(Object.keys(zip.files).sort()).toEqual(['evil-poppler-escape-p001.png', 'evil-poppler-escape-p002.png']);
    }
  );

  it('convertImage, zipPageImages, and splitPdfPages sanitize traversal stems', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 255, g: 0, b: 0 } } })
      .png()
      .toBuffer();

    const imgRes = await convertImage(png, 'jpg', {}, '../../../../etc/passwd.png', 'png');
    expect(imgRes.filename).toBe('passwd.jpg');
    const dotRes = await convertImage(png, 'jpg', {}, '../../../..', 'png');
    expect(dotRes.filename).toBe('image.jpg');

    const zipBuf = await zipPageImages(
      [1, 2],
      async () => ({ buffer: png, mimeType: 'image/png', filename: 'p.png', size: png.length }),
      '../../etc/passwd',
      'png'
    );
    const frameZip = await JSZip.loadAsync(zipBuf);
    expect(Object.keys(frameZip.files).sort()).toEqual(['passwd-p001.png', 'passwd-p002.png']);

    const emptyBaseZip = await zipPageImages(
      [1],
      async () => ({ buffer: png, mimeType: 'image/png', filename: 'p.png', size: png.length }),
      '../..',
      'png'
    );
    expect(Object.keys((await JSZip.loadAsync(emptyBaseZip)).files)).toEqual(['page-p001.png']);
  });

  it.skipIf(toolsMissingPdfOps)('splitPdfPages sanitizes traversal baseName in ZIP entries', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    doc.addPage([200, 200]);
    const pdf = Buffer.from(await doc.save());

    const splitZipBuf = await splitPdfPages(pdf, { everyNPages: 1 }, {}, '../../etc/passwd');
    const splitZip = await JSZip.loadAsync(splitZipBuf);
    expect(Object.keys(splitZip.files).sort()).toEqual(['passwd-part001.pdf', 'passwd-part002.pdf']);

    const fallbackZipBuf = await splitPdfPages(pdf, { everyNPages: 1 }, {}, '../..');
    const fallbackZip = await JSZip.loadAsync(fallbackZipBuf);
    expect(Object.keys(fallbackZip.files).sort()).toEqual(['document-part001.pdf', 'document-part002.pdf']);
  });
});

describe('P1-1: SVG sanitizer CSS url()/src()/image-set() strict allowlist', () => {
  it.each([
    ['data:image/svg+xml base64 in <style>', '<svg><style>g{fill:url("data:image/svg+xml;base64,PHN2Zy8+")}</style></svg>', 'g{fill:none}'],
    ['data:image/svg+xml inline in style=""', '<svg><rect style="fill:url(data:image/svg+xml,<svg/>)"/></svg>', 'style="fill:none"'],
    ['data:image/svg+xml in presentation attr', '<svg><rect fill="url(data:image/svg+xml;base64,PHN2Zy8+)"/></svg>', 'fill="none"'],
    ['entity/tab obfuscated data:image/svg+xml', '<svg><style>g{fill:url("da&#x09;ta:image/svg+xml;base64,PHN2Zy8+")}</style></svg>', 'g{fill:none}'],
    ['CSS-escaped data:text/html in url()', '<svg><style>g{background:url(\\64 ata:text/html,<script>alert(1)</script>)}</style></svg>', 'g{background:none}'],
    ['data:text/html in style=""', '<svg><rect style="background:url(data:text/html;base64,PHNjcmlwdD4=)"/></svg>', 'style="background:none"'],
    ['root-relative path url(/etc/passwd)', '<svg><style>g{fill:url(/etc/passwd)}</style></svg>', 'g{fill:none}'],
    ['root-relative quoted path url("/api/secret")', '<svg><rect fill="url(\'/api/secret\')"/></svg>', 'fill="none"'],
    ['relative path url(relative.svg)', '<svg><style>g{fill:url(relative.svg)}</style></svg>', 'g{fill:none}'],
    ['dot-relative path url(./foo.png)', '<svg><style>g{fill:url(./foo.png)}</style></svg>', 'g{fill:none}'],
    ['unknown scheme jar:', '<svg><style>g{fill:url(jar:file:///app.jar!/x)}</style></svg>', 'g{fill:none}'],
    ['unknown scheme blob:', '<svg><style>g{fill:url(blob:https://evil.test/1)}</style></svg>', 'g{fill:none}'],
    ['unknown scheme chrome:', '<svg><style>g{fill:url(chrome://settings)}</style></svg>', 'g{fill:none}'],
    ['src() relative font', '<svg><style>@font-face{src:src(local-font)}</style></svg>', 'src:none'],
    ['src() root-relative font', '<svg><style>@font-face{src:src("/api/font.woff2")}</style></svg>', 'src:none'],
    ['image-set() relative strings', '<svg><style>g{fill:image-set("a.png" 1x,"b.png" 2x)}</style></svg>', 'g{fill:none}'],
    ['image-set() data:image/svg+xml', '<svg><style>g{fill:image-set("data:image/svg+xml;base64,PHN2Zy8+" 1x)}</style></svg>', 'g{fill:none}'],
    ['-webkit-image-set() root-relative', '<svg><style>g{fill:-webkit-image-set(url(/etc/passwd) 1x)}</style></svg>', 'g{fill:none}'],
    ['fragment injection with quote', '<svg><style>g{fill:url(#a" onclick="alert(1))}</style></svg>', 'g{fill:none}'],
    ['empty url()', '<svg><style>g{fill:url()}</style></svg>', 'g{fill:none}'],
  ])('neutralizes %s to none', (_label, input, expectedSnippet) => {
    const clean = sanitizeSvgString(input);
    expect(clean).toContain(expectedSnippet);
    expect(clean).not.toContain('svg+xml');
    expect(clean).not.toContain('text/html');
    expect(clean).not.toContain('/etc/passwd');
    expect(clean).not.toContain('/api/');
    expect(sanitizeSvgString(clean)).toBe(clean);
  });

  it('strips SMIL animations targeting style or presentation attributes with disallowed url()/src()/image-set()', () => {
    const payloads = [
      '<svg><rect><set attributeName="style" to="fill:url(/etc/passwd)"/></rect></svg>',
      '<svg><rect><animate attributeName="style" values="fill:url(data:image/svg+xml,x)"/></rect></svg>',
      '<svg><rect><set attributeName="style" to="background:url(data:text/html,x)"/></rect></svg>',
      '<svg><rect><set attributeName="fill" to="url(/api/secret)"/></rect></svg>',
      '<svg><rect><animate attributeName="mask" to="url(data:image/svg+xml;base64,PHN2Zy8+)"/></rect></svg>',
    ];
    for (const payload of payloads) {
      expect(sanitizeSvgString(payload)).toBe('<svg><rect></rect></svg>');
    }
  });

  it('keeps local #fragment references, safe raster data URIs, and allowlisted image-set() intact', () => {
    const safeCss =
      'g{fill:url(#grad);mask:url( #m );c:url("data:image/png;base64,iVBORw0KGgo=");d:url(data:image/webp;base64,UklGRh4AAABXRUJQ);e:image-set(url(#a) 1x,url("data:image/png;base64,AAAA") 2x);f:image-set("data:image/jpeg;base64,/9j/4AAQ" 1x)}';
    const doc = `<svg><style>${safeCss}</style><rect clip-path="url(&quot;#c&quot;)" fill="url(#grad)"/></svg>`;
    expect(sanitizeSvgString(doc)).toBe(doc);

    const safeAnim =
      '<svg><rect><set attributeName="style" to="fill:url(#a)"/><animate attributeName="fill" values="url(#a);url(#b)" dur="1s"/></rect></svg>';
    expect(sanitizeSvgString(safeAnim)).toBe(safeAnim);
  });
});

describe('P1-2: JBIG2 #XX escape & Flate chain & name cap, sandbox limits, animation frame decode cap, Dockerfile.worker', () => {
  const BOMB_PAGE_INFORMATION = Buffer.from('0000000030000100000013000186a0000186a00000000000000000010000', 'hex');
  const SCAN_PAGE_INFORMATION = Buffer.from('0000000030000100000013000009b000000db40000000000000000010000', 'hex');
  const SCAN_DECODED_BYTES = 310 * 3508;

  let shimDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(name: string, value: string): void {
    if (!(name in savedEnv)) savedEnv[name] = process.env[name];
    process.env[name] = value;
  }

  function writeShim(name: string, body: string): string {
    const file = path.join(shimDir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  }

  beforeAll(() => {
    shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-p1-guards-'));
  });

  afterEach(() => {
    resetCallSpies();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      delete savedEnv[k];
    }
  });

  afterAll(() => {
    fs.rmSync(shimDir, { recursive: true, force: true });
  });

  it.each([
    ['/Filter /#4aBIG2Decode'],
    ['/Filter /JBIG#32Decode'],
    ['/#46ilter /#4a#42#49#47#32#44#65#63#6f#64#65'],
    ['/Filter [/#4aBIG2Decode]'],
  ])('pdf-jbig2-guard decodes hex-escaped filter %s and refuses 1.25 GB JBIG2 bomb with 413', (dict) => {
    const pdf = buildPdf(
      [
        { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
        { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
        { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >>' },
        { id: 4, dict, stream: BOMB_PAGE_INFORMATION },
      ],
      1
    ).buffer;

    expect(() => assertPdfJbig2WithinLimits(pdf)).toThrow(DecompressionLimitError);
    const scanPdf = buildPdf(
      [
        { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
        { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
        { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >>' },
        { id: 4, dict, stream: SCAN_PAGE_INFORMATION },
      ],
      1
    ).buffer;
    expect([...declaredJbig2Pages(scanPdf)]).toEqual([
      { objectNumber: 4, width: 2480, height: 3508, decodedBytes: SCAN_DECODED_BYTES },
    ]);
  });

  it('pdf-jbig2-guard inspects /Filter [/FlateDecode /JBIG2Decode] (and hex-escaped variants) and refuses compressed JBIG2 bombs', () => {
    const bombDeflated = zlib.deflateSync(BOMB_PAGE_INFORMATION);
    const scanDeflated = zlib.deflateSync(SCAN_PAGE_INFORMATION);

    for (const dict of ['/Filter [/FlateDecode /JBIG2Decode]', '/Filter [/#46lateDecode /#4aBIG2Decode]']) {
      const bombPdf = buildPdf(
        [
          { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
          { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
          { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >>' },
          { id: 4, dict, stream: bombDeflated },
        ],
        1
      ).buffer;
      expect(() => assertPdfJbig2WithinLimits(bombPdf)).toThrow(DecompressionLimitError);

      const scanPdf = buildPdf(
        [
          { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
          { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
          { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >>' },
          { id: 4, dict, stream: scanDeflated },
        ],
        1
      ).buffer;
      expect([...declaredJbig2Pages(scanPdf)]).toEqual([
        { objectNumber: 4, width: 2480, height: 3508, decodedBytes: SCAN_DECODED_BYTES },
      ]);
      expect(() => assertPdfJbig2WithinLimits(scanPdf)).not.toThrow();
    }

    // Flate bomb > 64 MiB inside [/FlateDecode /JBIG2Decode] also throws 413
    const bigZeros = Buffer.alloc(65 * 1024 * 1024);
    const flateBombPdf = buildPdf(
      [
        { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
        { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
        { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >>' },
        { id: 4, dict: '/Filter [/FlateDecode /JBIG2Decode]', stream: zlib.deflateSync(bigZeros) },
      ],
      1
    ).buffer;
    expect(() => assertPdfJbig2WithinLimits(flateBombPdf)).toThrow(DecompressionLimitError);
  });

  it('pdf-jbig2-guard throws DecompressionLimitError (413) fail-closed when > 4096 JBIG2 names exist in PDF', () => {
    const decoy = '1 0 obj << /Note /JBIG2Decode >> endobj\n';
    const bomb = buildPdf(
      [
        { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
        { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
        { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >>' },
        { id: 4, dict: '/Filter /JBIG2Decode', stream: BOMB_PAGE_INFORMATION },
      ],
      1
    )
      .buffer.toString('latin1')
      .replace('%PDF-1.7\n', '');

    const paddedBomb = Buffer.from(`%PDF-1.7\n${decoy.repeat(MAX_JBIG2_NAMES_EXAMINED)}${bomb}`, 'latin1');
    expect(() => assertPdfJbig2WithinLimits(paddedBomb)).toThrow(DecompressionLimitError);

    const exactLimitDecoys = Buffer.from(`%PDF-1.7\n${decoy.repeat(MAX_JBIG2_NAMES_EXAMINED)}`, 'latin1');
    expect(() => assertPdfJbig2WithinLimits(exactLimitDecoys)).not.toThrow();
  });

  it('LibreOfficePoolManager enforces memoryLimitMb, maxFileSize, and wide rlimits.asBytes for JVM/UNO', async () => {
    const seen: Array<{ memoryLimitMb?: number; maxFileSize?: number; asBytes?: number }> = [];
    const executor: SandboxedProcessRunner = async (_bin, args, options) => {
      seen.push({
        memoryLimitMb: options?.memoryLimitMb,
        maxFileSize: options?.maxFileSize,
        asBytes: options?.rlimits?.asBytes,
      });
      if (args.includes('--convert-to') && options?.cwd) {
        const srcArg = args[args.length - 1];
        const stem = path.basename(srcArg, path.extname(srcArg));
        fs.writeFileSync(path.join(options.cwd, `${stem}.pdf`), Buffer.from('%PDF-1.7 stub'));
      }
      return {
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        durationMs: 1,
        sandboxed: true,
        sandboxType: 'host',
      };
    };

    const pool = new LibreOfficePoolManager({
      sofficePath: '/usr/bin/soffice',
      minWorkers: 1,
      maxWorkers: 1,
      enabled: true,
      readinessProbe: true,
      executor,
    });

    try {
      await pool.convert(Buffer.from('hello'), 'txt', 'pdf', {}, 'sample.txt');
      expect(seen.length).toBeGreaterThanOrEqual(2);
      for (const item of seen) {
        expect(item.memoryLimitMb).toBeGreaterThanOrEqual(1536);
        expect(item.memoryLimitMb).toBeLessThanOrEqual(3328);
        expect(item.maxFileSize).toBe(ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE);
        expect(item.asBytes).toBeGreaterThan(item.memoryLimitMb! * 1024 * 1024);
      }
    } finally {
      await pool.shutdown();
    }
  });

  it('standalone LibreOffice (engines.ts) and PDF/A soffice (pdfa.ts) pass memoryLimitMb, maxFileSize, and wide rlimits.asBytes', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 200]).drawText('archival', {
      x: 20,
      y: 100,
      size: 14,
      font: await doc.embedFont(StandardFonts.Helvetica),
    });
    const xmp =
      '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>1</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
    doc.catalog.set(
      PDFName.of('Metadata'),
      doc.context.register(doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' }))
    );
    const pdfaOut = Buffer.from(await doc.save());
    const pdfaFile = path.join(shimDir, 'pdfa-out.pdf');
    fs.writeFileSync(pdfaFile, pdfaOut);

    const fakeSoffice = writeShim(
      'fake-soffice',
      [
        'out=""; prev=""',
        'for a in "$@"; do [ "$prev" = "--outdir" ] && out="$a"; prev="$a"; done',
        'if [ -n "$out" ]; then',
        `  cp "${pdfaFile}" "$out/input.pdf"`,
        `  cp "${pdfaFile}" "$out/source.pdf"`,
        'fi',
      ].join('\n')
    );
    const verdictFile = path.join(shimDir, 'verdict.json');
    fs.writeFileSync(
      verdictFile,
      JSON.stringify({ report: { jobs: [{ validationResult: [{ compliant: true, profileName: 'PDF/A-1B' }] }] } })
    );
    const fakeVerapdf = writeShim('fake-verapdf', `cat "${verdictFile}"`);

    setEnv('SOFFICE_PATH', fakeSoffice);
    setEnv('VERAPDF_PATH', fakeVerapdf);

    // 1. Standalone LibreOffice path via keepEmbeddedExcelObjects (bypasses pool)
    resetCallSpies();
    const officeRes = await convertWithHeadlessOffice(
      Buffer.from('plain text'),
      'txt',
      'pdf',
      { keepEmbeddedExcelObjects: true, throwOnUnavailable: true },
      'note.txt'
    );
    expect(officeRes).not.toBeNull();
    const standaloneSofficeCall = sandboxSpies.executeCalls.find((c) => c.binary === fakeSoffice && c.args.includes('--convert-to'));
    expect(standaloneSofficeCall?.options).toBeTruthy();
    expect(standaloneSofficeCall!.options!.memoryLimitMb).toBeGreaterThanOrEqual(1536);
    expect(standaloneSofficeCall!.options!.maxFileSize).toBe(ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE);
    expect((standaloneSofficeCall!.options!.rlimits as { asBytes?: number } | undefined)?.asBytes).toBeGreaterThan(
      (standaloneSofficeCall!.options!.memoryLimitMb as number) * 1024 * 1024
    );

    // 2. PDF/A soffice call
    resetCallSpies();
    const plainDoc = await PDFDocument.create();
    plainDoc.addPage([200, 200]);
    const pdfaRes = await convertToPdfA(Buffer.from(await plainDoc.save()), { conformance: 'pdfa-1b' });
    expect(pdfaRes.pdfaValidated).toBe(true);
    const pdfaSofficeCall = sandboxSpies.executeCalls.find((c) => c.binary === fakeSoffice && c.args.includes('--convert-to'));
    expect(pdfaSofficeCall?.options).toBeTruthy();
    expect(pdfaSofficeCall!.options!.memoryLimitMb).toBeGreaterThanOrEqual(1536);
    expect(pdfaSofficeCall!.options!.maxFileSize).toBe(ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE);
    expect((pdfaSofficeCall!.options!.rlimits as { asBytes?: number } | undefined)?.asBytes).toBeGreaterThan(
      (pdfaSofficeCall!.options!.memoryLimitMb as number) * 1024 * 1024
    );
  });

  it('Poppler utilities (pdfinfo, pdftotext, pdftoppm, pdftocairo, pdftops) enforce memoryLimitMb and maxFileSize', async () => {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([200, 200]);
    page.drawText('Poppler bounds test', { x: 10, y: 100, size: 12, font: await pdfDoc.embedFont(StandardFonts.Helvetica) });
    const pdf = Buffer.from(await pdfDoc.save());

    const fakePdfinfo = writeShim('fake-pdfinfo', 'printf "Pages:          1\\n"');
    const fakePdftotext = writeShim(
      'fake-pdftotext',
      'last=""; for a in "$@"; do last="$a"; done; printf "hello" > "$last"'
    );
    const fakePdftoppm = writeShim(
      'fake-pdftoppm',
      [
        'if [ "$1" = "-v" ]; then echo "pdftoppm version 24.02"; exit 0; fi',
        'last=""; for a in "$@"; do last="$a"; done',
        'printf "P6\\n2 1\\n255\\n\\377\\000\\000\\000\\377\\000" > "${last}-1.ppm"',
      ].join('\n')
    );
    const fakePdftocairo = writeShim(
      'fake-pdftocairo',
      'last=""; for a in "$@"; do last="$a"; done; printf "<svg xmlns=\\"http://www.w3.org/2000/svg\\"><rect width=\\"10\\" height=\\"10\\"/></svg>" > "$last"'
    );
    const fakePdftops = writeShim(
      'fake-pdftops',
      'last=""; for a in "$@"; do last="$a"; done; printf "%%!PS-Adobe-3.0\\nshowpage\\n" > "$last"'
    );

    setEnv('PDFINFO_PATH', fakePdfinfo);
    setEnv('PDFTOTEXT_PATH', fakePdftotext);
    setEnv('PDFTOPPM_PATH', fakePdftoppm);
    setEnv('PDFTOCAIRO_PATH', fakePdftocairo);
    setEnv('PDFTOPS_PATH', fakePdftops);

    resetCallSpies();
    await convertWithNativePoppler(pdf, 'pdf', 'txt', { throwOnUnavailable: true }, 'doc.pdf');
    await convertWithNativePoppler(pdf, 'pdf', 'png', { throwOnUnavailable: true }, 'doc.pdf');
    await convertWithNativePoppler(pdf, 'pdf', 'svg', { throwOnUnavailable: true }, 'doc.pdf');
    await convertPdfPagesWithNativeTools(pdf, 'ps', { throwOnUnavailable: true }, 'doc.pdf');
    await convertPdfPagesWithNativeTools(pdf, 'eps', { throwOnUnavailable: true }, 'doc.pdf');

    const popplerBins = new Set([fakePdfinfo, fakePdftotext, fakePdftoppm, fakePdftocairo, fakePdftops]);
    const allCalls = [...sandboxSpies.executeCalls, ...sandboxSpies.launchCalls].filter((c) => popplerBins.has(c.binary));
    expect(allCalls.length).toBeGreaterThanOrEqual(5);

    for (const bin of [fakePdfinfo, fakePdftotext, fakePdftoppm, fakePdftocairo, fakePdftops]) {
      const binCalls = allCalls.filter((c) => c.binary === bin);
      expect(binCalls.length).toBeGreaterThanOrEqual(1);
      for (const call of binCalls) {
        expect(call.options?.memoryLimitMb).toBe(2048);
        expect(call.options?.maxFileSize).toBeGreaterThan(0);
        expect(call.options?.maxFileSize).toBeLessThanOrEqual(ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE);
      }
    }
  });

  it('watchDirectoryGrowth aborts runaway disk growth in Poppler and LibreOffice tempDir with PayloadLimitError', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([200, 200]);
    const pdf = Buffer.from(await pdfDoc.save());

    // Sparse files exceed the directory byte budget instantaneously with 0 real disk blocks allocated.
    const runawayPoppler = writeShim(
      'runaway-pdftotext',
      [
        'node -e "const fs = require(\'node:fs\'); for (let i = 0; i < 4; i++) { fs.writeFileSync(\'bomb-\' + i + \'.bin\', \'\'); fs.truncateSync(\'bomb-\' + i + \'.bin\', 400 * 1024 * 1024); } setTimeout(() => {}, 10000);"',
      ].join('\n')
    );
    setEnv('PDFTOTEXT_PATH', runawayPoppler);

    const popplerErr = await captureError(() =>
      convertWithNativePoppler(pdf, 'pdf', 'txt', { throwOnUnavailable: true, timeoutMs: 10_000 }, 'bomb.pdf')
    );
    expect(popplerErr).toBeInstanceOf(PayloadLimitError);
    expect((popplerErr as Error).message).toMatch(/temporary disk budget/);

    const runawaySoffice = writeShim(
      'runaway-soffice',
      [
        'node -e "const fs = require(\'node:fs\'); for (let i = 0; i < 4; i++) { fs.writeFileSync(\'bomb-\' + i + \'.bin\', \'\'); fs.truncateSync(\'bomb-\' + i + \'.bin\', 400 * 1024 * 1024); } setTimeout(() => {}, 10000);"',
      ].join('\n')
    );
    setEnv('SOFFICE_PATH', runawaySoffice);
    const sofficeErr = await captureError(() =>
      convertWithHeadlessOffice(
        Buffer.from('hello'),
        'txt',
        'pdf',
        { keepEmbeddedExcelObjects: true, throwOnUnavailable: true, timeoutMs: 10_000 },
        'bomb.txt'
      )
    );
    expect(sofficeErr).toBeInstanceOf(PayloadLimitError);
    expect((sofficeErr as Error).message).toMatch(/temporary disk budget/);
  });

  it('enforces animation decode budget when extracting a single late frame (page=200) from animated WebP, GIF, and APNG', async () => {
    const side = 1000;
    const frames = 200;

    // 1. Animated WebP (1000x1000 x 200 frames): page=200 exceeds 512 MiB decode budget
    const stillWebp = await sharp({ create: { width: side, height: side, channels: 3, background: { r: 20, g: 40, b: 60 } } })
      .webp({ lossless: true, effort: 0 })
      .toBuffer();
    const animWebp = buildAnimatedWebpFromStill(stillWebp, { width: side, height: side, frames });

    const webpErr = await captureError(() => convertImage(animWebp, 'png', { page: frames }, 'bomb.webp', 'webp'));
    expect(webpErr).toBeInstanceOf(ConversionFailedError);
    expect(webpErr.message).toMatch(/decoded animation limit/);

    const webpPage1 = await convertImage(animWebp, 'png', { page: 1 }, 'bomb.webp', 'webp');
    expect(webpPage1.frameUsed).toBe(1);

    // 2. Animated GIF (1000x1000 logical canvas with 200 tiny 1x1 sub-frames): page=200 exceeds 512 MiB decode budget
    const gifParts: Buffer[] = [
      Buffer.from('GIF89a', 'latin1'),
      Buffer.from([side & 0xff, (side >> 8) & 0xff, side & 0xff, (side >> 8) & 0xff, 0x80, 0, 0]),
      Buffer.from([255, 0, 0, 0, 0, 255]),
    ];
    for (let i = 0; i < frames; i++) {
      const pixel = i % 2 === 0 ? Buffer.from([0x44, 0x01]) : Buffer.from([0x4c, 0x01]);
      gifParts.push(
        Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0]),
        Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]),
        Buffer.from([2, pixel.length]),
        pixel,
        Buffer.from([0])
      );
    }
    gifParts.push(Buffer.from([0x3b]));
    const animGif = Buffer.concat(gifParts);

    const gifErr = await captureError(() => convertImage(animGif, 'png', { page: frames }, 'bomb.gif', 'gif'));
    expect(gifErr).toBeInstanceOf(ConversionFailedError);
    expect(gifErr.message).toMatch(/decoded animation limit/);

    const gifPage1 = await convertImage(animGif, 'png', { page: 1 }, 'bomb.gif', 'gif');
    expect(gifPage1.frameUsed).toBe(1);

    // 3. Animated PNG (1000x1000 canvas with 200 tiny sub-frames): page=200 exceeds 512 MiB decode budget
    const apngPixel = rgbaImage(1, 1, () => [10, 20, 30, 255]);
    const apngSpec: ApngSpec = {
      width: side,
      height: side,
      frames: Array.from({ length: frames }, () => ({ image: apngPixel })),
    };
    const forgedApng = buildApngFile(apngSpec, (chunks) => {
      const first = chunks.find((c) => c.type === 'fcTL')!;
      first.data.writeUInt32BE(side, 4);
      first.data.writeUInt32BE(side, 8);
    });
    const apngErr = await captureError(() => convertImage(forgedApng, 'png', { page: frames }, 'bomb.png', 'png'));
    expect(apngErr).toBeInstanceOf(ConversionFailedError);
    expect(apngErr.message).toMatch(/decoded animation limit/);
  });

  it('Dockerfile.worker runner stage enables STRICT_SANDBOX=true by default', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8');
    const runnerStage = dockerfile.slice(dockerfile.indexOf('AS runner'));
    expect(runnerStage).toMatch(/^ENV\s+STRICT_SANDBOX=true\b/m);
  });
});
