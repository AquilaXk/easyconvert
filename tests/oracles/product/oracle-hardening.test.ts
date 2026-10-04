import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import JSZip from 'jszip';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { oracleTest } from '../../helpers/oracle-test';
import { getOracleToolPath } from '../../helpers/differential-oracle';
import {
  computeWang2004Mssim,
  verifyPdfFidelityWithOracle,
  computeAudioSnr,
  computeFfmpegLavfiSsimPsnr,
  inspectTarWithNativeTar,
  compareOfficeDocumentStructure,
} from './index';
import { parseVerboseTarLine } from './archive-oracle';
import {
  createTarStreamPacker,
  streamProcessLargePayload,
  TarStreamingPacker,
} from '../../../src/lib/streaming/large-payload-streamer';

/**
 * Regression suite for #352: each oracle must report what it measured, and fail closed on
 * inputs it cannot measure instead of passing them.
 */

const TAR_BLOCK = 512;
const TAR_END_BLOCKS = 2;

/** Minimal ustar writer authored for this suite, independent of the production packer. */
function ustar(entries: Array<{ name: string; content: Buffer }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(TAR_BLOCK);
    header.write(entry.name, 0, 100, 'utf8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${entry.content.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, entry.content, Buffer.alloc((TAR_BLOCK - (entry.content.length % TAR_BLOCK)) % TAR_BLOCK));
  }
  blocks.push(Buffer.alloc(TAR_BLOCK * TAR_END_BLOCKS));
  return Buffer.concat(blocks);
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

describe('archive oracle: native tar table of contents', () => {
  oracleTest('reports names with spaces and zero-byte entries with their exact sizes', ['tar'], () => {
    const report = Buffer.from('quarterly figures, final revision\n');
    const result = inspectTarWithNativeTar(
      ustar([
        { name: 'my report.txt', content: report },
        { name: 'empty.txt', content: Buffer.alloc(0) },
      ])
    );

    expect(result.passed).toBe(true);
    expect(result.entries.map(({ path: p, size }) => ({ path: p, size }))).toEqual([
      { path: 'my report.txt', size: report.length },
      { path: 'empty.txt', size: 0 },
    ]);
  });

  oracleTest('lists GNU tar symlinks and hard links by entry name', ['tar'], () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tar-links-'));
    try {
      const content = Buffer.from('linked payload body\n');
      fs.writeFileSync(path.join(dir, 'target.txt'), content);
      fs.symlinkSync('target.txt', path.join(dir, 'soft link'));
      fs.linkSync(path.join(dir, 'target.txt'), path.join(dir, 'hard.txt'));
      const archivePath = path.join(dir, 'links.tar');
      execFileSync(getOracleToolPath('tar') as string, [
        '--format=gnu', '-cf', archivePath, '-C', dir, 'target.txt', 'soft link', 'hard.txt',
      ]);

      const result = inspectTarWithNativeTar(fs.readFileSync(archivePath));

      expect(result.error).toBeUndefined();
      expect(result.entries.map(({ path: p, size, mode }) => ({ path: p, size, type: mode[0] }))).toEqual([
        { path: 'target.txt', size: content.length, type: '-' },
        { path: 'soft link', size: 0, type: 'l' },
        { path: 'hard.txt', size: 0, type: 'h' },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('archive oracle: verbose tar line parsing', () => {
  it('anchors the bsdtar size column to the trailing date even when the owner looks like a month', () => {
    expect(parseVerboseTarLine('-rw-r--r--  0 Jan    staff    4096 Mar  5 14:07 notes.txt', 'notes.txt')).toEqual({
      path: 'notes.txt',
      size: 4096,
      mode: '-rw-r--r--',
    });
    expect(parseVerboseTarLine('-rw-r--r--  0 Jan    Feb      77 Dec 31  2019 old.txt', 'old.txt')).toEqual({
      path: 'old.txt',
      size: 77,
      mode: '-rw-r--r--',
    });
  });

  it('strips bsdtar link targets before matching the entry name', () => {
    expect(parseVerboseTarLine('lrwxr-xr-x  0 Jan    staff       0 Mar  5 14:07 cur -> v1 -> old', 'cur')).toEqual({
      path: 'cur',
      size: 0,
      mode: 'lrwxr-xr-x',
    });
    expect(parseVerboseTarLine('hrw-r--r--  0 Jan    staff       0 Mar  5 14:07 copy link to notes.txt', 'copy')).toEqual({
      path: 'copy',
      size: 0,
      mode: 'hrw-r--r--',
    });
  });

  it('throws when no date column follows the size', () => {
    expect(() => parseVerboseTarLine('-rw-r--r-- Jan staff 4096 notes.txt', 'notes.txt')).toThrow(/size column/);
  });
});

describe('TarStreamingPacker', () => {
  oracleTest('writes a ustar header for a zero-byte stream', ['tar'], async () => {
    const tar = await collect(Readable.from([]).pipe(createTarStreamPacker('empty.bin', 0)));

    expect(tar.length).toBe(TAR_BLOCK * (1 + TAR_END_BLOCKS));
    expect(tar.subarray(257, 262).toString('latin1')).toBe('ustar');
    const result = inspectTarWithNativeTar(tar);
    expect(result.passed).toBe(true);
    expect(result.entries.map(({ path: p, size }) => ({ path: p, size }))).toEqual([{ path: 'empty.bin', size: 0 }]);
  });

  it('fails when the stream length differs from the size written in the header', async () => {
    const packer = createTarStreamPacker('short.bin', 10);
    await expect(collect(Readable.from([Buffer.from('12345')]).pipe(packer))).rejects.toThrow(/5 bytes.*10/);
  });

  it('fails as soon as the stream exceeds the size written in the header', async () => {
    const packer = createTarStreamPacker('long.bin', 4);
    await expect(collect(Readable.from([Buffer.from('12345')]).pipe(packer))).rejects.toThrow(/5 bytes.*declares 4/);
  });

  it('rejects entry names that do not fit the ustar name field as printable ASCII', () => {
    const USTAR_NAME_LIMIT = 100;
    expect(() => createTarStreamPacker('n'.repeat(USTAR_NAME_LIMIT + 1), 1)).toThrow(/at most 100 printable ASCII/);
    expect(() => createTarStreamPacker('r\u00e9sum\u00e9.bin', 1)).toThrow(/printable ASCII/);
    expect(createTarStreamPacker('n'.repeat(USTAR_NAME_LIMIT), 1)).toBeInstanceOf(TarStreamingPacker);
  });

  it('requires a declared size that fits the ustar size field', () => {
    const USTAR_MAX_SIZE = 0o77777777777;
    expect(() => new TarStreamingPacker('missing.bin', undefined as unknown as number)).toThrow(/size/i);
    expect(() => createTarStreamPacker('negative.bin', -1)).toThrow(/size/i);
    expect(() => createTarStreamPacker('fraction.bin', 1.5)).toThrow(/size/i);
    expect(() => createTarStreamPacker('huge.bin', USTAR_MAX_SIZE + 1)).toThrow(/size/i);
  });
});

describe('media oracle: audio SNR', () => {
  it('throws on empty buffers instead of reporting a perfect match', () => {
    expect(() => computeAudioSnr([], [])).toThrow(/empty/i);
    expect(() => computeAudioSnr([], [0.1, 0.2])).toThrow(/empty/i);
  });

  it('fails a truncated signal even when the overlapping samples match', () => {
    const reference = Float64Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10));
    const truncated = reference.slice(0, 500);

    const result = computeAudioSnr(truncated, reference);

    expect(result.passed).toBe(false);
    expect(result.sampleCount).toBe(500);
    expect(result.failureReason).toMatch(/500 of 1000/);
  });
});

describe('media oracle: ffmpeg lavfi SSIM and PSNR', () => {
  function encode(dir: string, name: string, filter: string): Buffer {
    const out = path.join(dir, name);
    execFileSync(getOracleToolPath('ffmpeg') as string, [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=96x64:rate=10:duration=1',
      '-vf', filter, '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '0', out,
    ]);
    return fs.readFileSync(out);
  }

  oracleTest('measures identical video as a pass and noisy video as a fail', ['ffmpeg'], async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lavfi-'));
    try {
      const clean = encode(dir, 'clean.mp4', 'null');
      const noisy = encode(dir, 'noisy.mp4', 'noise=alls=60:allf=t');

      const same = await computeFfmpegLavfiSsimPsnr(clean, clean, 'mp4');
      expect(same.ssim).toBeGreaterThan(0.999);
      expect(same.psnr).toBeGreaterThan(60);
      expect(same.passed).toBe(true);

      const degraded = await computeFfmpegLavfiSsimPsnr(noisy, clean, 'mp4');
      expect(degraded.ssim).toBeLessThan(0.9);
      expect(degraded.psnr).toBeLessThan(30);
      expect(degraded.passed).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  oracleTest('throws when ffmpeg cannot decode the inputs', ['ffmpeg'], async () => {
    await expect(computeFfmpegLavfiSsimPsnr(Buffer.alloc(100), Buffer.alloc(100), 'mp4')).rejects.toThrow(
      /ffmpeg exited/i
    );
  });
});

describe('streamProcessLargePayload cancellation', () => {
  it('stops the pipeline promptly and rejects when the signal aborts', async () => {
    const CHUNK = Buffer.alloc(64 * 1024, 0x5a);
    let produced = 0;
    const endless = new Readable({
      read() {
        produced += CHUNK.length;
        setImmediate(() => this.push(CHUNK));
      },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();

    await expect(streamProcessLargePayload(endless, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(endless.destroyed).toBe(true);
    const producedAtRejection = produced;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(produced).toBe(producedAtRejection);
  });
});

describe('office oracle: text comparison per format', () => {
  async function pptx(slides: string[]): Promise<Buffer> {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>');
    slides.forEach((text, i) => {
      zip.file(
        `ppt/slides/slide${i + 1}.xml`,
        `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
      );
    });
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  /** Builds a workbook from a shared-string table and the inner XML of each sheet's `sheetData`. */
  async function xlsx(sharedStrings: string[], sheets: string[]): Promise<Buffer> {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    zip.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>');
    zip.file(
      'xl/sharedStrings.xml',
      `<sst xmlns="s" count="${sharedStrings.length}">${sharedStrings.map((s) => `<si>${s}</si>`).join('')}</sst>`
    );
    sheets.forEach((cells, i) => {
      zip.file(`xl/worksheets/sheet${i + 1}.xml`, `<worksheet xmlns="s"><sheetData><row r="1">${cells}</row></sheetData></worksheet>`);
    });
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  async function docx(body: string): Promise<Buffer> {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    zip.file('word/document.xml', `<w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`);
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  const STRINGS = ['<t>Region</t>', '<t>North</t>', '<t>South</t>'];
  const sharedCell = (ref: string, index: number) => `<c r="${ref}" t="s"><v>${index}</v></c>`;
  const numberCell = (ref: string, value: string) => `<c r="${ref}"><v>${value}</v></c>`;

  it('compares slide text, not the presentation part', async () => {
    const reference = await pptx(['Revenue grew 12%', 'Outlook &amp; risks']);

    const same = await compareOfficeDocumentStructure(await pptx(['Revenue grew 12%', 'Outlook &amp; risks']), reference, 'pptx');
    expect(same.matched).toBe(true);
    expect(same.referenceTextLength).toBe('Revenue grew 12% Outlook & risks'.length);

    const changed = await compareOfficeDocumentStructure(await pptx(['Revenue grew 21%', 'Outlook &amp; risks']), reference, 'pptx');
    expect(changed.matched).toBe(false);
    expect(changed.discrepancies.join('\n')).toMatch(/text differs/i);
  });

  it('compares resolved cell values, not the workbook part', async () => {
    const cells = sharedCell('A1', 0) + sharedCell('B1', 1);
    const reference = await xlsx(STRINGS, [cells]);

    const same = await compareOfficeDocumentStructure(await xlsx(STRINGS, [cells]), reference, 'xlsx');
    expect(same.discrepancies).toEqual([]);
    expect(same.matched).toBe(true);

    const changed = await compareOfficeDocumentStructure(
      await xlsx(['<t>Region</t>', '<t>East</t>', '<t>South</t>'], [cells]),
      reference,
      'xlsx'
    );
    expect(changed.matched).toBe(false);
    expect(changed.discrepancies.join('\n')).toMatch(/text differs/i);
  });

  it('fails when cells point at different shared-string indices', async () => {
    const reference = await xlsx(STRINGS, [sharedCell('A1', 0) + sharedCell('B1', 1)]);
    const swapped = await xlsx(STRINGS, [sharedCell('A1', 0) + sharedCell('B1', 2)]);

    const result = await compareOfficeDocumentStructure(swapped, reference, 'xlsx');

    expect(result.matched).toBe(false);
    expect(result.discrepancies.join('\n')).toMatch(/text differs/i);
  });

  it('fails when numeric cell values differ', async () => {
    const reference = await xlsx(STRINGS, [sharedCell('A1', 0) + numberCell('B1', '1250.5')]);
    const changed = await xlsx(STRINGS, [sharedCell('A1', 0) + numberCell('B1', '1205.5')]);

    const result = await compareOfficeDocumentStructure(changed, reference, 'xlsx');

    expect(result.matched).toBe(false);
    expect(result.discrepancies.join('\n')).toMatch(/text differs/i);
  });

  it('fails when a value moves to another sheet', async () => {
    const reference = await xlsx(STRINGS, [sharedCell('A1', 1), sharedCell('A1', 2)]);
    const moved = await xlsx(STRINGS, [sharedCell('A1', 2), sharedCell('A1', 1)]);

    const result = await compareOfficeDocumentStructure(moved, reference, 'xlsx');

    expect(result.matched).toBe(false);
  });

  it('resolves rich-text shared strings and inline strings without splitting their runs', async () => {
    const reference = await xlsx(STRINGS, [sharedCell('A1', 1) + `<c r="B1" t="inlineStr"><is><t>Total</t></is></c>`]);
    const richRuns = await xlsx(
      ['<t>Region</t>', '<r><t>No</t></r><r><rPr><b/></rPr><t>rth</t></r><rPh sb="0" eb="1"><t>ignored</t></rPh>', '<t>South</t>'],
      [sharedCell('A1', 1) + `<c r="B1" t="inlineStr"><is><r><t>To</t></r><r><t>tal</t></r></is></c>`]
    );

    const result = await compareOfficeDocumentStructure(richRuns, reference, 'xlsx');

    expect(result.discrepancies).toEqual([]);
    expect(result.actualTextLength).toBe(result.referenceTextLength);
  });

  it('throws when a cell references a shared string that does not exist', async () => {
    const reference = await xlsx(STRINGS, [sharedCell('A1', 0)]);
    const dangling = await xlsx(STRINGS, [sharedCell('A1', STRINGS.length)]);

    await expect(compareOfficeDocumentStructure(dangling, reference, 'xlsx')).rejects.toThrow(/shared string/i);
  });

  it('joins runs within a paragraph and separates paragraphs', async () => {
    const reference = await docx('<w:p><w:r><w:t>Hello world</w:t></w:r></w:p><w:p><w:r><w:t>Next</w:t></w:r></w:p>');
    const splitRuns = await docx(
      '<w:p><w:pPr/><w:r><w:t>Hel</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>lo</w:t></w:r>' +
        '<w:r><w:t xml:space="preserve"> world</w:t></w:r></w:p><w:p><w:r><w:t>Next</w:t></w:r></w:p>'
    );

    const same = await compareOfficeDocumentStructure(splitRuns, reference, 'docx');
    expect(same.discrepancies).toEqual([]);
    expect(same.referenceTextLength).toBe('Hello world Next'.length);

    const splitParagraphs = await docx('<w:p><w:r><w:t>Hel</w:t></w:r></w:p><w:p><w:r><w:t>lo world</w:t></w:r></w:p><w:p><w:r><w:t>Next</w:t></w:r></w:p>');
    const changed = await compareOfficeDocumentStructure(splitParagraphs, reference, 'docx');
    expect(changed.matched).toBe(false);
    expect(changed.discrepancies.join('\n')).toMatch(/text differs/i);
  });

  it('joins split DrawingML runs inside one slide paragraph', async () => {
    const reference = await pptx(['Outlook &amp; risks']);
    const split = await pptx(['Out</a:t></a:r><a:r><a:t>look &amp; ri</a:t></a:r><a:r><a:t>sks']);

    const result = await compareOfficeDocumentStructure(split, reference, 'pptx');

    expect(result.discrepancies).toEqual([]);
    expect(result.matched).toBe(true);
  });
});

describe('pdf oracle: MSSIM downscaling and page dimensions', () => {
  async function gradient(width: number, height: number): Promise<Buffer> {
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        pixels.fill((x * 255) / width, (y * width + x) * 3, (y * width + x) * 3 + 3);
      }
    }
    return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
  }

  it('applies scaleFactor before measuring', async () => {
    const image = await gradient(200, 100);

    const result = await computeWang2004Mssim(image, image, { scaleFactor: 0.5 });

    expect(result.width).toBe(100);
    expect(result.height).toBe(50);
    expect(result.mssim).toBeCloseTo(1, 10);
  });

  it('rejects a scaleFactor outside (0, 1]', async () => {
    const image = await gradient(40, 40);
    await expect(computeWang2004Mssim(image, image, { scaleFactor: 0 })).rejects.toThrow(/scaleFactor/);
    await expect(computeWang2004Mssim(image, image, { scaleFactor: 2 })).rejects.toThrow(/scaleFactor/);
  });

  oracleTest('reports a page dimension mismatch as a failed page instead of throwing', ['pdftoppm'], async () => {
    async function pdf(width: number, height: number): Promise<Buffer> {
      const doc = await PDFDocument.create();
      doc.addPage([width, height]);
      return Buffer.from(await doc.save());
    }

    const result = await verifyPdfFidelityWithOracle(await pdf(300, 400), await pdf(300, 300), undefined, { dpi: 36 });

    expect(result.passed).toBe(false);
    expect(result.pageCount).toBe(1);
    expect(result.discrepancies.join('\n')).toMatch(/Page 1 dimension mismatch: actual 150x200, reference 150x150/);
  });
});
