import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { convertFile } from '../src/lib/conversions/index';
import { stageHtmlForNativeEngine } from '../src/lib/conversions/html-native-staging';
import { overrideImageFetchRules } from '../src/lib/conversions/html-image-fetch';
import { HTML_IMAGE_CAPS, parseHtmlTree } from '../src/lib/conversions/html-blocks';
import { loadExternalImages, pickCandidate } from '../src/lib/conversions/html-image-loader';
import { OmittedExternalImages, srcsetCandidates } from '../src/lib/conversions/html-omitted-resources';
import { executeWorkerConversion } from '../src/worker/engines';
import { ConversionFailedError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';
import { withMissingBinary } from './helpers/native-tools';
import { noisyJpeg, solidPng, startImageServer, type ImageServer } from './helpers/image-server';

/**
 * The external images of an HTML page are fetched and embedded before the page is rendered, on both routes (the
 * in-process renderer and the staging for LibreOffice). A local server on 127.0.0.1 stands in for a public host: the
 * resolver is replaced so `images.test` answers 127.0.0.1 and only that address is let through. Poppler's pdfimages is
 * the independent reader of the PDFs.
 */

const LOOPBACK = '127.0.0.1';
const HOST = 'images.test';
const OTHER_HOST = 'other.test';
const PRIVATE_HOST = 'private.test';
const PAGE_TEXT = 'Gallery of the quarter.';

let server: ImageServer;
let restore: (() => void) | undefined;
let png: Buffer;
let jpeg: Buffer;

function useLoopbackAsPublic(): void {
  restore?.();
  // The fetcher child answers `images.test` and the like from this table and lets only the one loopback address through.
  restore = overrideImageFetchRules({
    hosts: { [HOST]: [LOOPBACK], [OTHER_HOST]: [LOOPBACK], [PRIVATE_HOST]: ['10.0.0.5'] },
    permitAddresses: [LOOPBACK],
    anyPort: true,
  });
}

const at = (pathAndQuery: string, host = HOST): string => `http://${host}:${server.port}${pathAndQuery}`;

function html(body: string): Buffer {
  return Buffer.from(`<html><head><title>Gallery</title></head><body><p>${PAGE_TEXT}</p>${body}</body></html>`, 'utf-8');
}

function withTempDir<T>(work: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-load-oracle-'));
  try {
    return work(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The images pdfimages finds in a PDF: how many, and the files it extracts (JPEG streams byte for byte). */
function pdfImages(pdf: Buffer): { count: number; files: Array<{ name: string; bytes: Buffer }> } {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    const tool = requireOracleTool('pdfimages');
    const listing = execFileSync(tool, ['-list', file], { encoding: 'utf-8' });
    // Columns: page, num, type; a soft mask of an image with transparency is a row of type "smask" and no image of its own.
    const count = listing
      .split('\n')
      .slice(2)
      .filter((line) => line.trim().split(/\s+/)[2] === 'image').length;
    execFileSync(tool, ['-all', file, path.join(dir, 'img')]);
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith('img-'))
      .sort()
      .map((name) => ({ name, bytes: fs.readFileSync(path.join(dir, name)) }));
    return { count, files };
  });
}

const sha256 = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex');

async function rawPixels(bytes: Buffer): Promise<{ data: string; width: number; height: number }> {
  const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: sha256(data), width: info.width, height: info.height };
}

const toPdf = (source: Buffer, options: Record<string, unknown> = {}): ReturnType<typeof convertFile> =>
  withMissingBinary('SOFFICE_PATH', () => convertFile(source, 'html', 'pdf', options, 'page.html'));

beforeEach(async () => {
  server = await startImageServer();
  png = await solidPng(24, 16, { r: 20, g: 120, b: 220 });
  jpeg = await noisyJpeg(48, 32);
  server.serve('/photo.png', png);
  server.serve('/photo.jpg', jpeg, 'image/jpeg');
  useLoopbackAsPublic();
});

afterEach(async () => {
  restore?.();
  restore = undefined;
  await server.close();
});

describe('HTML to PDF with images fetched from a public address (in-process route)', () => {
  oracleTest('embeds the fetched PNG and JPEG, and an independent reader finds them', ['pdfimages', 'pdftotext'], async () => {
    const result = await toPdf(html(`<img src="${at('/photo.png')}" alt="a"><p>between</p><img src="${at('/photo.jpg')}" alt="b">`));
    expect(result.metadata?.warnings).toBeUndefined();
    const found = pdfImages(result.buffer);
    expect(found.count).toBe(2);
    const jpegFile = found.files.find((file) => file.name.endsWith('.jpg'));
    expect(jpegFile && sha256(jpegFile.bytes)).toBe(sha256(jpeg));
    const pngFile = found.files.find((file) => !file.name.endsWith('.jpg'));
    expect(pngFile && (await rawPixels(pngFile.bytes))).toEqual(await rawPixels(png));
    expect(server.requests.map((request) => request.url).sort()).toEqual(['/photo.jpg', '/photo.png']);
  });

  oracleTest('redraws a fetched GIF and WebP as PNG', ['pdfimages'], async () => {
    const gif = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#aa3300' } }).gif().toBuffer();
    const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00aa33' } }).webp().toBuffer();
    server.serve('/a.gif', gif, 'image/gif');
    server.serve('/a.webp', webp, 'image/webp');
    const result = await toPdf(html(`<img src="${at('/a.gif')}"><img src="${at('/a.webp')}">`));
    expect(result.metadata?.warnings).toBeUndefined();
    expect(pdfImages(result.buffer).count).toBe(2);
  });

  oracleTest('fetches an image used twice once', ['pdfimages'], async () => {
    const result = await toPdf(html(`<img src="${at('/photo.png')}"><img src="${at('/photo.png')}">`));
    expect(pdfImages(result.buffer).count).toBe(2);
    expect(server.requests).toHaveLength(1);
  });

  oracleTest('loads one candidate of a srcset: the lowest density of at least 1x', ['pdfimages'], async () => {
    server.serve('/one.png', png);
    server.serve('/two.png', png);
    server.serve('/half.png', png);
    const result = await toPdf(html(`<img srcset="${at('/half.png')} 0.5x, ${at('/two.png')} 2x, ${at('/one.png')} 1x">`));
    expect(pdfImages(result.buffer).count).toBe(1);
    expect(server.requests.map((request) => request.url)).toEqual(['/one.png']);
  });

  oracleTest('uses the first supported picture source and skips the rest, including the img', ['pdfimages'], async () => {
    server.serve('/photo.avif', Buffer.from('not decoded'), 'image/avif');
    server.serve('/wide.png', png);
    const markup =
      `<picture><source type="image/avif" srcset="${at('/photo.avif')}"><source srcset="${at('/wide.png')}">` +
      `<img src="${at('/photo.jpg')}" alt="fallback"></picture>`;
    const result = await toPdf(html(markup));
    expect(result.metadata?.warnings).toBeUndefined();
    expect(pdfImages(result.buffer).count).toBe(1);
    expect(server.requests.map((request) => request.url)).toEqual(['/wide.png']);
  });

  oracleTest('falls back to the picture img when its source cannot be loaded, and reports the source', ['pdfimages'], async () => {
    const markup = `<picture><source srcset="${at('/missing.png')}"><img src="${at('/photo.jpg')}" alt="fallback"></picture>`;
    const result = await toPdf(html(markup));
    expect(pdfImages(result.buffer).count).toBe(1);
    expect(result.metadata?.warnings).toEqual([`Left out the image "${at('/missing.png')}": the server answered with status 404.`]);
  });

  oracleTest('leaves out an image that cannot be loaded and keeps the rest of the page', ['pdfimages', 'pdftotext'], async () => {
    const result = await toPdf(html(`<img src="${at('/nothing.png')}"><img src="${at('/photo.png')}">`));
    expect(pdfImages(result.buffer).count).toBe(1);
    expect(result.metadata?.warnings).toEqual([`Left out the image "${at('/nothing.png')}": the server answered with status 404.`]);
  });
});

describe('the staging for LibreOffice embeds the fetched images', () => {
  it('writes data: URIs only, so the renderer has nothing to fetch', async () => {
    const markup = `<img src="${at('/photo.png')}"><picture><source srcset="${at('/photo.jpg')} 2x"><img alt="x"></picture>`;
    const staged = await stageHtmlForNativeEngine(`<p>${PAGE_TEXT}</p>${markup}`);
    expect(staged.warnings).toEqual([]);
    expect(staged.html).toContain(`data:image/png;base64,${png.toString('base64')}`);
    expect(staged.html).toContain(`data:image/jpeg;base64,${jpeg.toString('base64')}`);
    expect(staged.html).not.toMatch(/images\.test|srcset|<source|http:/);
    expect(staged.html.match(/<img/g)).toHaveLength(2);
  });

  oracleTest('hands LibreOffice the embedded image after the worker fetched it', ['pdftotext'], async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-soffice-'));
    const capture = path.join(dir, 'captured.html');
    const prebuilt = path.join(dir, 'prebuilt.pdf');
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    fs.writeFileSync(prebuilt, await pdf.save());
    const stub = path.join(dir, 'soffice');
    fs.writeFileSync(
      stub,
      [
        '#!/bin/sh',
        'case "$*" in *--help*) exit 0;; esac',
        'outdir=""; input=""',
        'while [ $# -gt 0 ]; do',
        '  if [ "$1" = "--outdir" ]; then outdir="$2"; fi',
        '  input="$1"',
        '  shift',
        'done',
        'name=$(basename "$input"); name="${name%.*}"',
        `case "$input" in *.html) cp "$input" '${capture}';; esac`,
        `cp '${prebuilt}' "$outdir/$name.pdf"`,
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    const previous = process.env.SOFFICE_PATH;
    process.env.SOFFICE_PATH = stub;
    try {
      const result = await executeWorkerConversion(html(`<img src="${at('/photo.png')}"><img src="${at('/nothing.png')}">`), 'html', 'pdf', {}, 'native.html');
      expect(result.engineUsed).toMatch(/^native-soffice/);
      const handed = fs.readFileSync(capture, 'utf-8');
      expect(handed).toContain(`data:image/png;base64,${png.toString('base64')}`);
      expect(handed).not.toMatch(/images\.test|http:/);
      expect(result.metadata?.warnings).toEqual([`Left out the image "${at('/nothing.png')}": the server answered with status 404.`]);
    } finally {
      if (previous === undefined) delete process.env.SOFFICE_PATH;
      else process.env.SOFFICE_PATH = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('images that are refused or fail stay out of the page', () => {
  async function warningsOf(markup: string): Promise<string[]> {
    const result = await toPdf(html(markup));
    return (result.metadata?.warnings ?? []) as string[];
  }

  it('does not connect to a loopback, private or metadata address under the production address rules', async () => {
    restore?.();
    restore = overrideImageFetchRules({ anyPort: true });
    const markup =
      `<img src="http://${LOOPBACK}:${server.port}/photo.png">` +
      `<img src="http://localhost:${server.port}/photo.png">` +
      '<img src="http://169.254.169.254/latest/meta-data/">' +
      '<img src="http://[fd00:ec2::254]/latest/meta-data/">' +
      '<img src="http://10.0.0.1/logo.png">';
    const warnings = await warningsOf(markup);
    expect(warnings).toHaveLength(5);
    expect(warnings.filter((line) => /the host is not a public address\.$|the host name is not allowed\.$/.test(line))).toHaveLength(5);
    expect(server.connections()).toBe(0);
  });

  it('refuses a host that resolves to a private address, and a redirect to one', async () => {
    server.route('/bounce.png', (_request, response) => {
      response.writeHead(302, { location: at('/photo.png', PRIVATE_HOST) });
      response.end();
    });
    const warnings = await warningsOf(`<img src="${at('/photo.png', PRIVATE_HOST)}"><img src="${at('/bounce.png')}">`);
    expect(warnings).toEqual([
      `Left out the image "${at('/photo.png', PRIVATE_HOST)}": the host is not a public address.`,
      `Left out the image "${at('/bounce.png')}": the host is not a public address.`,
    ]);
    expect(server.requests.map((request) => request.url)).toEqual(['/bounce.png']);
  });

  it('leaves out a response that is not an image and one above the size cap', async () => {
    server.serve('/page.png', '<html>not an image</html>', 'image/png');
    server.route('/big.png', (_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(11 * 1024 * 1024) });
      response.write(Buffer.alloc(1024));
    });
    const warnings = await warningsOf(`<img src="${at('/page.png')}"><img src="${at('/big.png')}">`);
    expect(warnings).toEqual([
      `Left out the image "${at('/page.png')}": the response is not a PNG, JPEG, GIF or WebP image.`,
      `Left out the image "${at('/big.png')}": the image is larger than 10485760 bytes.`,
    ]);
  });

  it('leaves out an image that carries an image signature but cannot be decoded, and one with too many pixels', async () => {
    server.serve('/broken.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]));
    server.serve('/huge.png', await solidPng(6000, 6000, { r: 1, g: 2, b: 3 }));
    const warnings = await warningsOf(`<img src="${at('/broken.png')}"><img src="${at('/huge.png')}">`);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/broken\.png": the image could not be decoded\.$/);
    expect(warnings[1]).toMatch(/huge\.png": the image is 6000x6000 pixels, above the limit of 25000000 pixels\.$/);
  });

  it('embeds at most the images the caps leave and reports the rest', async () => {
    const tree = parseHtmlTree(`<p>${PAGE_TEXT}</p>${Array.from({ length: 5 }, (_, i) => `<img src="${at(`/photo.png?n=${i}`)}">`).join('')}`).root;
    const omitted = new OmittedExternalImages();
    await loadExternalImages(tree, {}, omitted, { maxImages: 3, maxImagePixels: 25_000_000, maxDocumentPixels: 100_000_000 });
    expect(server.requests).toHaveLength(3);
    expect(omitted.warnings()).toHaveLength(2);
    expect(omitted.warnings()[0]).toMatch(/the document already holds the most images it can embed \(3\)\.$/);
  });

  it('keeps the renderers\' own limit of embedded images', () => {
    expect(HTML_IMAGE_CAPS.maxImages).toBe(64);
  });
});

describe('requireResources', () => {
  const strict = { requireResources: true };

  oracleTest('accepts a page whose images all load', ['pdfimages'], async () => {
    const result = await toPdf(html(`<img src="${at('/photo.png')}">`), strict);
    expect(result.metadata?.warnings).toBeUndefined();
    expect(pdfImages(result.buffer).count).toBe(1);
    await expect(stageHtmlForNativeEngine(`<img src="${at('/photo.png')}">`, strict)).resolves.toMatchObject({ warnings: [] });
  });

  it.each([
    ['an image the server does not have', (): string => at('/nothing.png'), 'the server answered with status 404'],
    ['a host that resolves to a private address', (): string => at('/photo.png', PRIVATE_HOST), 'the host is not a public address'],
    ['a host that does not exist', (): string => at('/photo.png', 'nowhere.test'), 'the host could not be resolved'],
  ])('refuses with a 400 for %s, on both routes', async (_name, target, reason) => {
    const markup = `<img src="${at('/photo.png')}"><img src="${target()}">`;
    const inProcess = toPdf(html(markup), strict);
    await expect(inProcess).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(inProcess).rejects.toThrow(`could not be loaded: ${reason}`);
    const staged = stageHtmlForNativeEngine(markup, strict);
    await expect(staged).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(staged).rejects.toThrow(`could not be loaded: ${reason}`);
  });

  it('refuses a reference that is not an absolute http or https URL', async () => {
    await expect(toPdf(html('<img src="images/logo.png">'), strict)).rejects.toThrow('"images/logo.png" is an external reference');
    await expect(stageHtmlForNativeEngine('<img src="file:///etc/hosts">', strict)).rejects.toThrow('"file:///etc/hosts" is an external reference');
  });
});

describe('an absolute http or https <base href>', () => {
  const base = (host = HOST, path = '/gallery/'): string => `<base href="${at(path, host)}">`;

  beforeEach(() => {
    server.serve('/gallery/photo.png', png);
    server.serve('/gallery/up.png', png);
  });

  it('resolves relative image URLs on both routes, and the base itself is not kept', async () => {
    const markup = `${base()}<img src="photo.png"><img src="../photo.png"><img srcset="/gallery/up.png 1x"><img src="//${OTHER_HOST}:${server.port}/photo.png">`;
    const staged = await stageHtmlForNativeEngine(`<p>${PAGE_TEXT}</p>${markup}`);
    expect(staged.warnings).toEqual([]);
    expect(staged.html.match(/data:image\/png;base64/g)).toHaveLength(4);
    expect(staged.html).not.toMatch(/<base|images\.test/);
    expect(server.requests.map((request) => request.url).sort()).toEqual(['/gallery/photo.png', '/gallery/up.png', '/photo.png', '/photo.png']);
    const inProcess = await toPdf(html(markup));
    expect(inProcess.metadata?.warnings).toBeUndefined();
  });

  oracleTest('gives the same images in the PDF', ['pdfimages'], async () => {
    const result = await toPdf(html(`${base()}<img src="photo.png">`));
    expect(pdfImages(result.buffer).count).toBe(1);
  });

  it('applies the same guards to what the base points at', async () => {
    const warnings = ((await toPdf(html(`${base(PRIVATE_HOST)}<img src="photo.png">`))).metadata?.warnings ?? []) as string[];
    expect(warnings).toEqual(['Left out the image "photo.png": the host is not a public address.']);
    expect(server.requests).toHaveLength(0);
  });

  it('leaves a relative image out when the base is not an http or https URL, and without a base', async () => {
    const warnings = ((await toPdf(html('<base href="file:///srv/pages/"><img src="photo.png">'))).metadata?.warnings ?? []) as string[];
    expect(warnings).toEqual(['Left out the image "photo.png": only absolute http and https images are loaded.']);
  });

  it('is still strict about a relative image that cannot be placed', async () => {
    await expect(toPdf(html('<img src="photo.png">'), { requireResources: true })).rejects.toThrow('"photo.png" is an external reference');
    await expect(stageHtmlForNativeEngine(`${base()}<img src="missing.png">`, { requireResources: true })).rejects.toThrow(
      'could not be loaded: the server answered with status 404'
    );
  });
});

describe('one fetch session per job', () => {
  oracleTest('does not fetch the images again when the LibreOffice route fails and the in-process route follows', ['pdfimages'], async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failing-soffice-'));
    const stub = path.join(dir, 'soffice');
    fs.writeFileSync(stub, '#!/bin/sh\ncase "$*" in *--help*) exit 0;; esac\nexit 1\n', { mode: 0o755 });
    const previous = process.env.SOFFICE_PATH;
    process.env.SOFFICE_PATH = stub;
    try {
      const result = await executeWorkerConversion(html(`<img src="${at('/photo.png')}"><img src="${at('/photo.jpg')}">`), 'html', 'pdf', {}, 'p.html');
      expect(result.engineUsed).toBe('internal-fallback');
      expect(result.fallbackChain?.[0]).toMatch(/^native-soffice/);
      expect(pdfImages(result.buffer).count).toBe(2);
      expect(server.requests).toHaveLength(2);
    } finally {
      if (previous === undefined) delete process.env.SOFFICE_PATH;
      else process.env.SOFFICE_PATH = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops loading images when the job is cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('job cancelled'));
    await expect(
      withMissingBinary('SOFFICE_PATH', () =>
        executeWorkerConversion(html(`<img src="${at('/photo.png')}">`), 'html', 'pdf', { signal: controller.signal }, 'p.html')
      )
    ).rejects.toThrow('job cancelled');
    expect(server.requests).toHaveLength(0);
  });
});

describe('HTML_IMAGE_FETCH=off', () => {
  const previous = process.env.HTML_IMAGE_FETCH;
  beforeEach(() => {
    process.env.HTML_IMAGE_FETCH = 'off';
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.HTML_IMAGE_FETCH;
    else process.env.HTML_IMAGE_FETCH = previous;
  });

  it('leaves every external image out with a warning on both routes, and fetches nothing', async () => {
    const warning = `Left out the image "${at('/photo.png')}": loading images is turned off on this server.`;
    const staged = await stageHtmlForNativeEngine(`<p>${PAGE_TEXT}</p><img src="${at('/photo.png')}">`);
    expect(staged.warnings).toEqual([warning]);
    expect(staged.html).not.toContain('<img');
    expect(((await toPdf(html(`<img src="${at('/photo.png')}">`))).metadata?.warnings ?? []) as string[]).toEqual([warning]);
    expect(server.requests).toHaveLength(0);
  });

  it('refuses with a 400 when every resource is required', async () => {
    await expect(toPdf(html(`<img src="${at('/photo.png')}">`), { requireResources: true })).rejects.toThrow(
      'could not be loaded: loading images is turned off on this server'
    );
  });

  it('keeps embedded images', async () => {
    const staged = await stageHtmlForNativeEngine(`<img src="data:image/png;base64,${png.toString('base64')}">`);
    expect(staged.warnings).toEqual([]);
    expect(staged.html).toContain('<img');
  });
});

describe('references other than images keep their handling', () => {
  it('still refuses CSS url(), stylesheets and frames, and fetches nothing for them', async () => {
    await expect(stageHtmlForNativeEngine(`<p style="background:url(${at('/photo.png')})">x</p>`)).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(stageHtmlForNativeEngine(`<link rel="stylesheet" href="${at('/photo.png')}">`)).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(stageHtmlForNativeEngine(`<iframe src="${at('/photo.png')}"></iframe>`)).rejects.toBeTruthy();
    expect(server.requests).toHaveLength(0);
  });
});

describe('the srcset candidate that is loaded', () => {
  it.each([
    ['a.png 1x, b.png 2x', 'a.png'],
    ['b.png 2x, a.png 1x', 'a.png'],
    ['a.png 3x, b.png 2x', 'b.png'],
    ['a.png 0.5x, b.png 0.75x', 'b.png'],
    ['a.png 0.5x, b.png 2x', 'b.png'],
    ['a.png 480w, b.png 800w, c.png 1600w', 'b.png'],
    ['a.png 480w, b.png 640w', 'b.png'],
    ['a.png, b.png 2x', 'a.png'],
    ['only.png', 'only.png'],
  ])('%s -> %s', (srcset, expected) => {
    expect(pickCandidate(srcsetCandidates(srcset))?.url).toBe(expected);
  });

  it('reads a data: URI candidate with commas as one candidate', () => {
    expect(srcsetCandidates('data:image/png;base64,AAAA 1x, https://x.test/b.png 2x').map((candidate) => candidate.url)).toEqual([
      'data:image/png;base64,AAAA',
      'https://x.test/b.png',
    ]);
  });
});
