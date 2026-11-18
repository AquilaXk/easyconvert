import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { startingOptionsFor } from '../src/components/workbench/options/options-capabilities';
import { isPlainCompression } from '../src/lib/image-compression';
import { executeItemConversion } from '../src/lib/client-converter';
import { assertPdfPostProcessOptions, convertFile } from '../src/lib/conversions';
import { getQpdfBinaryPath } from '../src/lib/conversions/pdf-postprocess';
import { resolveConversionTier, resolveTierAfterEdgeFailure } from '../src/lib/edge/tier-router';
import { convertPureCanvas } from '../src/lib/edge/pure/pure-canvas';
import { EdgeUnsupportedError } from '../src/lib/edge/workers/worker-errors';
import { socialMetadata } from '../src/i18n/metadata';
import { generateMetadata as generateApiDocsTopicMetadata } from '../src/app/[locale]/api-docs/[topic]/page';
import { legalPageMetadata } from '../src/components/legal/LegalDocumentPage';

vi.mock('next-intl/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl/server')>()),
  setRequestLocale: () => undefined,
  getTranslations: async ({ locale, namespace }: { locale: 'en' | 'ko'; namespace: string }) =>
    (await import('./helpers/intl')).testTranslator(locale, namespace as never),
}));

/** Builds a minimal valid 2-page / 1-page uncompressed PDF with an embedded raw RGB image stream so lossless qpdf shrinks it without triggering OCR. */
function buildUncompressedImageOnlyPdf(): Buffer {
  const width = 64;
  const height = 64;
  const rawRgb = Buffer.alloc(width * height * 3, 0xab);
  const objects: Buffer[] = [];
  const pushObj = (id: number, body: string | Buffer) => {
    const head = Buffer.from(`${id} 0 obj\n`, 'ascii');
    const tail = Buffer.from('\nendobj\n', 'ascii');
    objects.push(Buffer.concat([head, typeof body === 'string' ? Buffer.from(body, 'ascii') : body, tail]));
  };

  pushObj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  pushObj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  pushObj(
    3,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'
  );
  const imgDict = Buffer.from(
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${rawRgb.length} >>\nstream\n`,
    'ascii'
  );
  pushObj(4, Buffer.concat([imgDict, rawRgb, Buffer.from('\nendstream', 'ascii')]));
  const contentStream = 'q 200 0 0 200 0 0 cm /Im0 Do Q';
  pushObj(5, `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`);

  const header = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary');
  const offsets: number[] = [0];
  let cursor = header.length;
  for (const obj of objects) {
    offsets.push(cursor);
    cursor += obj.length;
  }
  const xrefLines = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f '];
  for (let i = 1; i < offsets.length; i++) {
    xrefLines.push(`${String(offsets[i]).padStart(10, '0')} 00000 n `);
  }
  const trailer = Buffer.from(
    `${xrefLines.join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`,
    'ascii'
  );
  return Buffer.concat([header, ...objects, trailer]);
}

function buildGifBytes(frameCount: 1 | 2): Uint8Array {
  // Minimal GIF89a header + Logical Screen Descriptor (1x1, no GCT) + frameCount image descriptors (0x2C) + trailer (0x3B)
  const frameBlock = [
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // Image Descriptor 1x1, no LCT
    0x02, 0x02, 0x4c, 0x01, 0x00, // LZW min code size 2, 2 bytes sub-block, terminator
  ];
  const bytes = [
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
    0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, // LSD 1x1
    ...frameBlock,
    ...(frameCount === 2 ? frameBlock : []),
    0x3b,
  ];
  return new Uint8Array(bytes);
}

function buildWebpVp8xBytes(flags: number): Uint8Array {
  // RIFF (20+10=30 bytes) WEBP VP8X (10 bytes payload)
  const out = new Uint8Array(30);
  const view = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  view.setUint32(4, 22, true);
  out.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  out.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  view.setUint32(16, 10, true);
  out[20] = flags; // bit 1 (0x02) = animation, bit 5 (0x20) = ICC, bit 3 (0x08) = EXIF, bit 2 (0x04) = XMP
  return out;
}

function buildPngHeaderWithChunks(bitDepth: number, extraChunkTag?: string): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = new Uint8Array(25);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, 13, false);
  ihdr.set([0x49, 0x48, 0x44, 0x52], 4); // IHDR
  ihdrView.setUint32(8, 2, false);
  ihdrView.setUint32(12, 2, false);
  ihdr[16] = bitDepth;
  ihdr[17] = 6; // RGBA
  const extra = extraChunkTag
    ? (() => {
        const payload = extraChunkTag === 'iTXt' ? new TextEncoder().encode('XML:com.adobe.xmp\0\0\0\0\0<xmp/>') : new Uint8Array(4);
        const buf = new Uint8Array(12 + payload.length);
        new DataView(buf.buffer).setUint32(0, payload.length, false);
        buf.set(
          [extraChunkTag.charCodeAt(0), extraChunkTag.charCodeAt(1), extraChunkTag.charCodeAt(2), extraChunkTag.charCodeAt(3)],
          4
        );
        buf.set(payload, 8);
        return buf;
      })()
    : new Uint8Array(0);
  const iend = new Uint8Array([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  const total = new Uint8Array(sig.length + ihdr.length + extra.length + iend.length);
  total.set(sig, 0);
  total.set(ihdr, sig.length);
  total.set(extra, sig.length + ihdr.length);
  total.set(iend, sig.length + ihdr.length + extra.length);
  return total;
}

function buildJpegWithSegment(marker: number, identifierAscii: string): Uint8Array {
  const idBytes = new TextEncoder().encode(identifierAscii);
  const segLen = 2 + idBytes.length + 4;
  const out = new Uint8Array(2 + 2 + segLen + 2);
  out[0] = 0xff;
  out[1] = 0xd8; // SOI
  out[2] = 0xff;
  out[3] = marker;
  out[4] = (segLen >> 8) & 0xff;
  out[5] = segLen & 0xff;
  out.set(idBytes, 6);
  out[out.length - 2] = 0xff;
  out[out.length - 1] = 0xd9; // EOI
  return out;
}

function readPngDimensions(png: Uint8Array): { width: number; height: number } {
  expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect(String.fromCharCode(png[12], png[13], png[14], png[15])).toBe('IHDR');
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

describe('1. /compress-pdf end-to-end wiring', () => {
  it('defaults startingOptionsFor("compress", "pdf", "pdf") to { optimize: { profile: "web" } }', () => {
    expect(startingOptionsFor('compress', 'pdf', 'pdf')).toEqual({ optimize: { profile: 'web' } });
    expect(startingOptionsFor('compress', 'PDF', '')).toMatchObject({ optimize: { profile: 'web' } });
    expect(startingOptionsFor('compress', 'jpg', 'jpg')).toEqual({});
  });

  it('treats plain PDF optimization as a plain compression so non-shrinking outputs return unchanged', async () => {
    expect(isPlainCompression('pdf', 'pdf', { optimize: { profile: 'web' } })).toBe(true);
    expect(isPlainCompression('PDF', 'pdf', { optimize: {} })).toBe(true);
    expect(isPlainCompression('pdf', 'pdf', {})).toBe(false);
    expect(isPlainCompression('pdf', 'pdf', { optimize: { profile: 'web' }, password: 'secret' })).toBe(false);
    expect(isPlainCompression('pdf', 'pdf', { optimize: { profile: 'web' }, watermark: { text: 'CONFIDENTIAL' } })).toBe(false);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(1200), { status: 200 })));
    try {
      const onSuccess = vi.fn();
      await executeItemConversion(
        {
          id: 'pdf-1',
          file: new File([new Uint8Array(1000)], 'compact.pdf', { type: 'application/pdf' }),
          name: 'compact.pdf',
          size: 1000,
          sourceFormat: 'pdf',
          targetFormat: 'pdf',
          status: 'ready',
          options: { optimize: { profile: 'web' } },
        },
        {
          onProgress: () => undefined,
          onSuccess,
          onError: (err) => {
            throw new Error(JSON.stringify(err));
          },
        }
      );
      const [, size, , , , unchanged] = onSuccess.mock.calls[0];
      expect(size).toBe(1000);
      expect(unchanged).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects unknown PDF optimize profiles in assertPdfPostProcessOptions', () => {
    expect(() => assertPdfPostProcessOptions({ optimize: { profile: 'bogus' as never } })).toThrow(/PDF optimize profile/);
  });

  it('compresses an image-only PDF via convertFile without falling into scan OCR', async () => {
    expect(getQpdfBinaryPath(), 'qpdf must be installed in developer/CI environment').toBeTruthy();
    const rawPdf = buildUncompressedImageOnlyPdf();
    const res = await convertFile(rawPdf, 'pdf', 'pdf', { optimize: { profile: 'archive' } }, 'scan.pdf');
    expect(res.mimeType).toBe('application/pdf');
    expect(res.buffer).toBeInstanceOf(Buffer);
    expect(res.buffer!.length).toBeLessThan(rawPdf.length);
    expect(res.ocrExtractedText).toBeUndefined();
  });
});

describe('2. Edge L0 Canvas quality, animation, bit-depth, metadata, and option parity', () => {
  it('keeps basic default PNG->JPG routing on L0 while routing unsupported options to L4 server', () => {
    expect(resolveConversionTier('png', 'jpg', 500_000, {}, { hasCanvas: true }).tier).toBe('L0');
    expect(resolveConversionTier('jpg', 'png', 500_000, { optimizePng: true }, { hasCanvas: true }).tier).toBe('L4');
    expect(resolveConversionTier('jpg', 'webp', 500_000, { stripMetadata: false }, { hasCanvas: true }).tier).toBe('L4');
    expect(resolveConversionTier('jpg', 'png', 500_000, { kernel: 'nearest' }, { hasCanvas: true }).tier).toBe('L4');
    expect(resolveConversionTier('jpg', 'png', 500_000, { targetColorSpace: 'display-p3' }, { hasCanvas: true }).tier).toBe('L4');
    expect(resolveConversionTier('jpg', 'png', 500_000, { outputDepth: 16 }, { hasCanvas: true }).tier).toBe('L4');
    expect(resolveConversionTier('png', 'jpg', 500_000, { gainMap: true }, { hasCanvas: true }).tier).toBe('L4');
    expect(resolveConversionTier('gif', 'png', 500_000, { page: 2 }, { hasCanvas: true }).tier).toBe('L4');
    expect(resolveConversionTier('jpg', 'png', 500_000, { dpi: 300 }, { hasCanvas: true }).tier).toBe('L4');
    expect(resolveConversionTier('jpg', 'png', 500_000, { quality: 65 }, { hasCanvas: true }).tier).toBe('L4');
  });

  it('escalates animated GIF, animated WebP, 16-bit PNG, and ICC/EXIF/XMP-tagged inputs via EdgeUnsupportedError', async () => {
    const origCreateImageBitmap = globalThis.createImageBitmap;
    const origOffscreenCanvas = globalThis.OffscreenCanvas;
    let lastFillStyle = '';
    globalThis.createImageBitmap = (async () => ({
      width: 4,
      height: 4,
      close: () => undefined,
    })) as unknown as typeof createImageBitmap;
    globalThis.OffscreenCanvas = class {
      width: number;
      height: number;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
      }
      getContext() {
        return {
          set fillStyle(val: string) {
            lastFillStyle = val;
          },
          get fillStyle() {
            return lastFillStyle;
          },
          imageSmoothingEnabled: true,
          imageSmoothingQuality: 'high',
          fillRect: () => undefined,
          drawImage: () => undefined,
          getImageData: (_x: number, _y: number, w: number, h: number) => ({
            width: w,
            height: h,
            data: new Uint8ClampedArray(w * h * 4),
          }),
        };
      }
    } as unknown as typeof OffscreenCanvas;

    try {
      // Static 1-frame GIF succeeds on L0; 2-frame animated GIF escalates to L4
      const staticGifRes = await convertPureCanvas(buildGifBytes(1), 'gif', 'bmp');
      expect(staticGifRes.width).toBe(4);
      const animGifErr = await convertPureCanvas(buildGifBytes(2), 'gif', 'bmp').catch((e) => e);
      expect(animGifErr).toBeInstanceOf(EdgeUnsupportedError);
      expect(resolveTierAfterEdgeFailure('L0', animGifErr)?.tier).toBe('L4');

      // Animated WebP (VP8X bit 0x02) escalates to L4
      await expect(convertPureCanvas(buildWebpVp8xBytes(0x02), 'webp', 'bmp')).rejects.toThrow(EdgeUnsupportedError);
      // WebP with ICC profile (VP8X bit 0x20) escalates unless stripMetadata: true
      await expect(convertPureCanvas(buildWebpVp8xBytes(0x20), 'webp', 'bmp')).rejects.toThrow(EdgeUnsupportedError);
      await expect(convertPureCanvas(buildWebpVp8xBytes(0x20), 'webp', 'bmp', { stripMetadata: true })).resolves.toMatchObject({ width: 4 });

      // 16-bit PNG escalates even when stripMetadata: true
      await expect(convertPureCanvas(buildPngHeaderWithChunks(16), 'png', 'bmp', { stripMetadata: true })).rejects.toThrow(
        EdgeUnsupportedError
      );
      // 8-bit PNG with iCCP / eXIf / XMP escalates unless stripMetadata: true
      for (const chunk of ['iCCP', 'eXIf', 'iTXt']) {
        await expect(convertPureCanvas(buildPngHeaderWithChunks(8, chunk), 'png', 'bmp')).rejects.toThrow(EdgeUnsupportedError);
        await expect(convertPureCanvas(buildPngHeaderWithChunks(8, chunk), 'png', 'bmp', { stripMetadata: true })).resolves.toMatchObject({
          width: 4,
        });
      }

      // JPEG with EXIF (APP1) or ICC_PROFILE (APP2) escalates unless stripMetadata: true
      const exifJpeg = buildJpegWithSegment(0xe1, 'Exif\0\0');
      const iccJpeg = buildJpegWithSegment(0xe2, 'ICC_PROFILE\0');
      await expect(convertPureCanvas(exifJpeg, 'jpg', 'bmp')).rejects.toThrow(EdgeUnsupportedError);
      await expect(convertPureCanvas(iccJpeg, 'jpg', 'bmp')).rejects.toThrow(EdgeUnsupportedError);
      await expect(convertPureCanvas(exifJpeg, 'jpg', 'bmp', { stripMetadata: true })).resolves.toMatchObject({ width: 4 });

      // Custom hex background color is honored; malformed background color escalates
      await convertPureCanvas(buildPngHeaderWithChunks(8), 'png', 'bmp', { background: '#ff0055' });
      expect(lastFillStyle.toLowerCase()).toBe('#ff0055');
      await expect(convertPureCanvas(buildPngHeaderWithChunks(8), 'png', 'bmp', { background: 'oklch(0.7 0.2 30)' })).rejects.toThrow(
        EdgeUnsupportedError
      );

      // Adversarial truncated / huge chunk headers terminate safely without throwing out-of-bounds RangeError
      const corruptPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xff, 0xff, 0xff, 0x49, 0x48, 0x44, 0x52]);
      await expect(convertPureCanvas(corruptPng, 'png', 'bmp')).resolves.toMatchObject({ width: 4 });
    } finally {
      globalThis.createImageBitmap = origCreateImageBitmap;
      globalThis.OffscreenCanvas = origOffscreenCanvas;
    }
  });
});

describe('3. Dynamic localized OpenGraph / Twitter / KakaoTalk 1200x630 preview cards', () => {
  it('wires socialMetadata with dynamic localized /api/og URLs, dimensions, and alt text across all public page types', async () => {
    const pairMeta = socialMetadata('ko', '/jpg-to-webp', 'JPG → WEBP 변환기 | EasyConvert', '빠른 온라인 변환');
    expect(pairMeta.openGraph?.images).toEqual([
      {
        url: '/api/og?locale=ko&path=%2Fjpg-to-webp',
        width: 1200,
        height: 630,
        type: 'image/png',
        alt: 'JPG → WEBP 변환기 | EasyConvert',
      },
    ]);
    expect(pairMeta.twitter?.images).toEqual([
      {
        url: '/api/og?locale=ko&path=%2Fjpg-to-webp',
        width: 1200,
        height: 630,
        alt: 'JPG → WEBP 변환기 | EasyConvert',
      },
    ]);

    const topicMeta = await generateApiDocsTopicMetadata({ params: Promise.resolve({ locale: 'ko', topic: 'jobs' }) });
    expect(topicMeta.openGraph).toBeDefined();
    expect(topicMeta.twitter).toBeDefined();

    const legalMeta = await legalPageMetadata(Promise.resolve({ locale: 'ko' }), 'privacy');
    expect(legalMeta.openGraph).toBeDefined();
    expect(legalMeta.twitter).toBeDefined();
  });

  it('renders distinct valid 1200x630 PNG preview cards on GET /api/og and rejects spoofed paths', async () => {
    const { GET } = await import('../src/app/api/og/route');
    const [homeEnRes, pairKoRes, toolKoRes] = await Promise.all([
      GET(new NextRequest('https://convert.aquilaxk.site/api/og?locale=en&path=%2F')),
      GET(new NextRequest('https://convert.aquilaxk.site/api/og?locale=ko&path=%2Fjpg-to-webp')),
      GET(new NextRequest('https://convert.aquilaxk.site/api/og?locale=ko&path=%2Fmerge-pdf')),
    ]);

    for (const res of [homeEnRes, pairKoRes, toolKoRes]) {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cache-control')).toContain('public');
    }

    const [homePng, pairPng, toolPng] = await Promise.all([
      homeEnRes.arrayBuffer().then((b) => new Uint8Array(b)),
      pairKoRes.arrayBuffer().then((b) => new Uint8Array(b)),
      toolKoRes.arrayBuffer().then((b) => new Uint8Array(b)),
    ]);

    expect(readPngDimensions(homePng)).toEqual({ width: 1200, height: 630 });
    expect(readPngDimensions(pairPng)).toEqual({ width: 1200, height: 630 });
    expect(readPngDimensions(toolPng)).toEqual({ width: 1200, height: 630 });
    expect(Buffer.from(pairPng).equals(Buffer.from(homePng))).toBe(false);
    expect(Buffer.from(pairPng).equals(Buffer.from(toolPng))).toBe(false);

    // Static fallback public/og.png is also a valid 1200x630 PNG
    const staticOg = fs.readFileSync(path.join(process.cwd(), 'public', 'og.png'));
    expect(readPngDimensions(staticOg)).toEqual({ width: 1200, height: 630 });

    // Spoofed / unknown paths and locales fail closed
    const badLocale = await GET(new NextRequest('https://convert.aquilaxk.site/api/og?locale=fr&path=%2F'));
    expect(badLocale.status).toBe(400);
    const spoofPath = await GET(new NextRequest('https://convert.aquilaxk.site/api/og?locale=en&path=%2Ffree-crypto-giveaway'));
    expect(spoofPath.status).toBe(404);
    const protocolRelative = await GET(new NextRequest('https://convert.aquilaxk.site/api/og?locale=en&path=%2F%2Fevil.com'));
    expect(protocolRelative.status).toBe(400);
  }, 30_000);
});
