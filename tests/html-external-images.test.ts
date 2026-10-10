import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { convertFile } from '../src/lib/conversions/index';
import { stageHtmlForNativeEngine } from '../src/lib/conversions/html-native-staging';
import { MAX_REPORTED_OMISSIONS } from '../src/lib/conversions/html-omitted-resources';
import { executeWorkerConversion } from '../src/worker/engines';
import { ConversionFailedError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';
import { withMissingBinary } from './helpers/native-tools';

/**
 * An HTML page whose images are not embedded still converts: the images are left out, never fetched, and each one is
 * reported in the result. Poppler (pdftotext, pdfimages) reads the PDFs; a stand-in LibreOffice records what the
 * native route hands it.
 */

const PAGE_TEXT = 'Quarterly summary: revenue rose by twelve percent.';
const NO_NETWORK_REFERENCE = 'Images/EIC012-1.GIF';

function runPoppler(tool: 'pdftotext' | 'pdfimages', args: string[], pdf: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-images-oracle-'));
  const file = path.join(dir, 'input.pdf');
  try {
    fs.writeFileSync(file, pdf);
    return execFileSync(requireOracleTool(tool), [...args, file, ...(tool === 'pdftotext' ? ['-'] : [])], { encoding: 'utf-8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const pdfText = (pdf: Buffer): string => runPoppler('pdftotext', ['-q'], pdf).replace(/\s+/g, ' ').trim();
const imageCount = (pdf: Buffer): number =>
  runPoppler('pdfimages', ['-list'], pdf)
    .split('\n')
    .slice(2)
    .filter((line) => line.trim().length > 0).length;

async function embeddedPngDataUri(): Promise<string> {
  const png = await sharp({ create: { width: 4, height: 3, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

function html(body: string): Buffer {
  return Buffer.from(`<html><head><title>Report</title></head><body>${body}</body></html>`, 'utf-8');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HTML to PDF with images that are not embedded', () => {
  oracleTest('keeps the page text, leaves the external images out and reports each one', ['pdftotext', 'pdfimages'], async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const connectSpy = vi.spyOn(net.Socket.prototype, 'connect');
    const source = html(
      `<p>${PAGE_TEXT}</p><img src="${NO_NETWORK_REFERENCE}" alt="chart">` +
        '<h2>Details</h2><img src="https://example.com/logo.png">' +
        '<table><tr><td>cell text<img src="//cdn.example.com/inline.png"></td></tr></table>' +
        `<p>Closing remark.</p><img src="${await embeddedPngDataUri()}" alt="swatch">`
    );
    const result = await withMissingBinary('SOFFICE_PATH', () => convertFile(source, 'html', 'pdf', {}, 'report.html'));
    expect(pdfText(result.buffer)).toBe(`${PAGE_TEXT} Details cell text Closing remark.`);
    expect(imageCount(result.buffer)).toBe(1);
    expect(result.metadata?.warnings).toEqual([
      `Left out the image "${NO_NETWORK_REFERENCE}": external resources are not fetched.`,
      'Left out the image "https://example.com/logo.png": external resources are not fetched.',
      'Left out the image "//cdn.example.com/inline.png": external resources are not fetched.',
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
  });

  oracleTest('converts a page whose only images are external', ['pdftotext', 'pdfimages'], async () => {
    const result = await withMissingBinary('SOFFICE_PATH', () =>
      convertFile(html(`<p>${PAGE_TEXT}</p><img src="a.gif"><img src="b.gif">`), 'html', 'pdf', {}, 'plain.html')
    );
    expect(pdfText(result.buffer)).toBe(PAGE_TEXT);
    expect(imageCount(result.buffer)).toBe(0);
    expect(result.metadata?.warnings).toHaveLength(2);
  });

  it('adds no warnings to a page without external images', async () => {
    const result = await withMissingBinary('SOFFICE_PATH', () => convertFile(html(`<p>${PAGE_TEXT}</p>`), 'html', 'pdf', {}, 'plain.html'));
    expect(result.metadata?.warnings).toBeUndefined();
  });

  it('lists at most the reporting limit one by one and counts the rest', async () => {
    const images = Array.from({ length: MAX_REPORTED_OMISSIONS + 7 }, (_, i) => `<img src="img-${i}.png">`).join('');
    const result = await withMissingBinary('SOFFICE_PATH', () => convertFile(html(`<p>${PAGE_TEXT}</p>${images}`), 'html', 'pdf', {}, 'many.html'));
    const warnings = result.metadata?.warnings as string[];
    expect(warnings).toHaveLength(MAX_REPORTED_OMISSIONS + 1);
    expect(warnings[0]).toBe('Left out the image "img-0.png": external resources are not fetched.');
    expect(warnings.at(-1)).toBe('Left out 7 more external images: external resources are not fetched.');
  });

  it('refuses the page with a typed error when every resource is required', async () => {
    const run = withMissingBinary('SOFFICE_PATH', () =>
      convertFile(html(`<p>${PAGE_TEXT}</p><img src="${NO_NETWORK_REFERENCE}">`), 'html', 'pdf', { requireResources: true }, 'strict.html')
    );
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toThrow(`HTML image "${NO_NETWORK_REFERENCE}" is an external reference`);
  });

  it('still refuses an embedded image that is not valid image data', async () => {
    const run = withMissingBinary('SOFFICE_PATH', () =>
      convertFile(html('<p>text</p><img src="data:image/png;base64,bm90IGEgcGljdHVyZQ==">'), 'html', 'pdf', {}, 'broken.html')
    );
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toThrow(/image/i);
  });
});

describe('both routes treat srcset images and picture sources alike', () => {
  const REMOTE_SOURCE = 'https://example.com/wide.webp 2x, https://example.com/narrow.webp 1x';
  const cases: Array<[string, (png: string) => string, string[]]> = [
    [
      'a picture whose source is remote',
      (png) => `<picture><source srcset="${REMOTE_SOURCE}"><img src="${png}"></picture>`,
      [`Left out the image "${REMOTE_SOURCE}": external resources are not fetched.`],
    ],
    [
      'an img that only has a remote srcset',
      () => `<img srcset="${REMOTE_SOURCE}" alt="chart">`,
      [`Left out the image "${REMOTE_SOURCE}": external resources are not fetched.`],
    ],
  ];

  it.each(cases)('%s: converts in process, leaving it out and warning', async (_name, markup, warnings) => {
    const png = await embeddedPngDataUri();
    const result = await withMissingBinary('SOFFICE_PATH', () =>
      convertFile(html(`<p>${PAGE_TEXT}</p>${markup(png)}`), 'html', 'pdf', {}, 'srcset.html')
    );
    expect(result.metadata?.warnings).toEqual(warnings);
  });

  it.each(cases)('%s: stages for the native engine with the same warning', async (_name, markup, warnings) => {
    const staged = await stageHtmlForNativeEngine(`<p>${PAGE_TEXT}</p>${markup(await embeddedPngDataUri())}`);
    expect(staged.warnings).toEqual(warnings);
    expect(staged.html).not.toMatch(/example\.com|srcset|<source/);
  });

  it('refuses both when every resource is required', async () => {
    const markup = `<p>text</p><picture><source srcset="${REMOTE_SOURCE}"></picture>`;
    await expect(stageHtmlForNativeEngine(markup, { requireResources: true })).rejects.toThrow('https://example.com/wide.webp');
    const inProcess = withMissingBinary('SOFFICE_PATH', () => convertFile(html(markup), 'html', 'pdf', { requireResources: true }, 'strict.html'));
    await expect(inProcess).rejects.toThrow('is an external reference');
  });
});

describe('HTML staged for the native engine with images that are not embedded', () => {
  it('writes a document without the external images and reports them', async () => {
    const staged = await stageHtmlForNativeEngine(
      `<p>${PAGE_TEXT}</p><img src="${NO_NETWORK_REFERENCE}"><img srcset="file:///etc/hosts 1x"><p><img src="http://192.0.2.2:18765/m.png"></p>`
    );
    expect(staged.html).toContain(PAGE_TEXT);
    expect(staged.html).not.toMatch(/<img|EIC012|etc\/hosts|192\.0\.2\.2/);
    expect(staged.warnings).toEqual([
      `Left out the image "${NO_NETWORK_REFERENCE}": external resources are not fetched.`,
      'Left out the image "file:///etc/hosts 1x": external resources are not fetched.',
      'Left out the image "http://192.0.2.2:18765/m.png": external resources are not fetched.',
    ]);
  });

  it('keeps embedded images and still refuses every other reference outside the document', async () => {
    const staged = await stageHtmlForNativeEngine(`<p>text</p><img src="${await embeddedPngDataUri()}">`);
    expect(staged.html).toContain('<img');
    expect(staged.warnings).toEqual([]);
    await expect(stageHtmlForNativeEngine('<p>text</p><link rel="stylesheet" href="http://192.0.2.2:18765/s.css">')).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(stageHtmlForNativeEngine('<p style="background:url(http://192.0.2.2:18765/b.png)">text</p>')).rejects.toBeInstanceOf(ConversionFailedError);
  });

  it('refuses the external image when every resource is required', async () => {
    await expect(stageHtmlForNativeEngine('<p>text</p><img src="images/logo.png">', { requireResources: true })).rejects.toThrow(
      '"images/logo.png" is an external reference'
    );
  });

  oracleTest('hands LibreOffice a document without the external reference and reports the omission', ['pdftotext'], async () => {
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
      const source = html('<p>text</p><img src="https://example.com/a.png">');
      const result = await executeWorkerConversion(source, 'html', 'pdf', {}, 'native.html');
      expect(result.engineUsed).toMatch(/^native-soffice/);
      expect(fs.readFileSync(capture, 'utf-8')).not.toMatch(/<img|example\.com/);
      expect(result.metadata?.warnings).toEqual(['Left out the image "https://example.com/a.png": external resources are not fetched.']);
      const strict = executeWorkerConversion(source, 'html', 'pdf', { requireResources: true }, 'native.html');
      await expect(strict).rejects.toBeInstanceOf(ConversionFailedError);
    } finally {
      if (previous === undefined) delete process.env.SOFFICE_PATH;
      else process.env.SOFFICE_PATH = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
