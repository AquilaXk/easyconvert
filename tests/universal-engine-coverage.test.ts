import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { convertFile } from '../src/lib/conversions';
import { decompressBzip2 } from '../src/lib/conversions/bzip2';
import { probeStream } from './helpers/media-lossy-oracle';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';
import { ConversionFailedError } from '../src/lib/types';
import { FileExtensionSpoofError } from '../src/lib/registry';
import { extractTarArchive, extractZipArchive, extractRarArchive, createZipArchive } from '../src/lib/conversions/archive';
import { buildStoredRar4 } from './helpers/rar4-stored';

/** A stored RAR 4.x archive written by the independent fixture writer (tests/helpers/rar4-stored.ts). */
function storedRar(files: { filename: string; buffer: Buffer }[]): Buffer {
  return buildStoredRar4(files.map((file) => ({ name: file.filename, data: file.buffer })));
}

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

/** The A4 page of the drawing fixture at the 150 dpi Poppler renders by default (210 x 297 mm). */
const A4_WIDTH_PX_150_DPI = 1240;
const A4_HEIGHT_PX_150_DPI = 1754;

describe('Universal Engine Conversion Coverage', () => {
  it('converts archive formats (tar.gz, tar.bz2, 7z, rar, etc.) with real binary validation', async () => {
    const rawContent = Buffer.from('Archive test content for universal conversion', 'utf-8');
    const zipArchive = await createZipArchive([{ filename: 'test.txt', buffer: rawContent }]);
    const textData = zipArchive.buffer;

    // zip -> tar.gz
    const res1 = await convertFile(textData, 'zip', 'tar.gz', {}, 'test.zip');
    expect(res1.filename).toBe('test.tar.gz');
    expect(res1.mimeType).toBe('application/gzip');
    // Gzip magic number 0x1F 0x8B
    expect(res1.buffer[0]).toBe(0x1f);
    expect(res1.buffer[1]).toBe(0x8b);

    // zip -> tar.bz2
    const resBz2 = await convertFile(textData, 'zip', 'tar.bz2', {}, 'test.zip');
    expect(resBz2.filename).toBe('test.tar.bz2');
    expect(resBz2.mimeType).toBe('application/x-bzip-compressed-tar');
    expect(resBz2.buffer.subarray(0, 3).toString('ascii')).toBe('BZh');

    // Verify roundtrip decompression of tar.bz2
    const decompressedTar = decompressBzip2(resBz2.buffer);
    const tarFiles = extractTarArchive(decompressedTar);
    expect(tarFiles.length).toBeGreaterThan(0);
    expect(tarFiles[0].buffer.toString('utf-8')).toBe('Archive test content for universal conversion');

    // zip -> 7z
    const res2 = await convertFile(textData, 'zip', '7z', {}, 'test.zip');
    expect(res2.filename).toBe('test.7z');
    expect(res2.mimeType).toBe('application/x-7z-compressed');
    // Standard 7z signature: 0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C
    expect(res2.buffer.subarray(0, 6)).toEqual(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]));

    // zip -> rar: Design Decision D8 permanently removes RAR creation (fail closed)
    await expect(convertFile(textData, 'zip', 'rar', {}, 'test.zip')).rejects.toThrow();

    // rar -> zip roundtrip with synthetic stored RAR fixture
    const syntheticRar = storedRar([
      { filename: 'test.txt', buffer: rawContent },
    ]);
    const rarExtract = extractRarArchive(syntheticRar);
    expect(rarExtract.length).toBeGreaterThan(0);
    expect(rarExtract[0].buffer.toString('utf-8')).toBe('Archive test content for universal conversion');

    const resZipFromRar = await convertFile(syntheticRar, 'rar', 'zip', {}, 'test.rar');
    const zipFiles = await extractZipArchive(resZipFromRar.buffer);
    expect(zipFiles.length).toBeGreaterThan(0);
    expect(zipFiles[0].buffer.toString('utf-8')).toBe('Archive test content for universal conversion');

    // ace has no reader on any engine: a ZIP under an .ace name is refused, never packed into the target as a file
    const aceFailure = await convertFile(textData, 'ace', 'zip', {}, 'test.ace').catch((err: unknown) => err);
    expect(aceFailure).toBeInstanceOf(ConversionFailedError);
    expect((aceFailure as Error).message).toBe('Cannot read .ace archives: no engine reads this format.');
    // and the magic-byte gate names the mislabelling
    await expect(convertFile(textData, 'ace', 'zip', { validateMagicBytes: true }, 'test.ace')).rejects.toBeInstanceOf(FileExtensionSpoofError);
  });

  /** A one-second 440 Hz tone muxed by the reference encoder into the container the extension names. */
  function encodeTone(codec: string, muxer: string, extension: string): Buffer {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tone-'));
    try {
      const out = path.join(dir, `tone.${extension}`);
      execFileSync(requireOracleTool('ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', codec, '-f', muxer, out]);
      return readFileSync(out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  oracleTest('converts audio and video expanded formats through the native engine', ['ffmpeg', 'ffprobe'], async () => {
    // 3gpp -> mp4 (a real 3GPP file)
    const res1 = await convertFile(encodeTone('aac', '3gp', '3gpp'), '3gpp', 'mp4', { validateMagicBytes: true }, 'video.3gpp');
    expect(res1.filename).toBe('video.mp4');
    expect(probeStream(res1.buffer, 'mp4', 'a').codec_name).toBe('aac');

    // weba -> mp3 (a real WebM audio file)
    const res2 = await convertFile(encodeTone('libopus', 'webm', 'weba'), 'weba', 'mp3', { validateMagicBytes: true }, 'audio.weba');
    expect(res2.filename).toBe('audio.mp3');
    expect(probeStream(res2.buffer, 'mp3', 'a').codec_name).toBe('mp3');

    // m4b -> aac (a real MPEG-4 audiobook)
    const res3 = await convertFile(encodeTone('aac', 'ipod', 'm4b'), 'm4b', 'aac', { validateMagicBytes: true }, 'book.m4b');
    expect(res3.filename).toBe('book.aac');
    // ADTS syncword 0xFFF
    expect(res3.buffer[0]).toBe(0xff);
    expect(res3.buffer[1] & 0xf0).toBe(0xf0);
    expect(probeStream(res3.buffer, 'aac', 'a').codec_name).toBe('aac');
  });

  it.each(['3gpp', 'weba', 'm4b'])('a WAV file under the .%s name is refused by the magic-byte gate, not converted', async (extension) => {
    const wav = readFileSync(path.join(__dirname, 'fixtures', 'sample.wav'));
    const failure = await convertFile(wav, extension, 'mp3', { validateMagicBytes: true }, `audio.${extension}`).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(FileExtensionSpoofError);
    expect((failure as Error).message).toBe(
      `File spoofing rejected for file "audio.${extension}": initial magic bytes indicate MIME type "audio/wav", which is incompatible with declared format ".${extension}". Operation failed closed.`
    );
  });

  it('converts vector and CAD formats (svg, emf, wmf, cgm, cdr, bmp, eps) with real encoders', async () => {
    const svgContent = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="purple"/></svg>';
    const svgBuffer = Buffer.from(svgContent, 'utf-8');

    // svg -> dxf
    const res1 = await convertFile(svgBuffer, 'svg', 'dxf', {}, 'drawing.svg');
    expect(res1.filename).toBe('drawing.dxf');
    expect(res1.buffer.toString('utf-8')).toContain('SECTION');

    // cdr -> svg
    const res2 = await convertFile(svgBuffer, 'cdr', 'svg', {}, 'design.cdr');
    expect(res2.filename).toBe('design.svg');
    expect(res2.buffer.toString('utf-8')).toContain('<svg');

    // emf -> png: no EMF decoder exists, so the pair is not advertised and is refused
    await expect(convertFile(svgBuffer, 'emf', 'png', {}, 'graphic.emf')).rejects.toThrow(
      /Cannot convert from Enhanced Metafile \(EMF\) \(\.emf\) to target format \.png/
    );

    // svg -> bmp (must NOT be disguised PNG)
    const resBmp = await convertFile(svgBuffer, 'svg', 'bmp', {}, 'drawing.svg');
    expect(resBmp.filename).toBe('drawing.bmp');
    expect(resBmp.mimeType).toBe('image/bmp');
    expect(resBmp.buffer.subarray(0, 2).toString('ascii')).toBe('BM');

    // svg -> eps (must be valid Level 2 colorimage PostScript, NOT raw SVG)
    const resEps = await convertFile(svgBuffer, 'svg', 'eps', {}, 'drawing.svg');
    expect(resEps.filename).toBe('drawing.eps');
    expect(resEps.mimeType).toBe('application/postscript');
    const epsText = resEps.buffer.toString('utf-8');
    expect(epsText).toContain('%!PS-Adobe-3.0 EPSF-3.0');
    expect(epsText).toContain('colorimage');
    expect(epsText).not.toContain('<svg');

    // cgm -> svg: the CGM reader drops polygon sets, colours and widths, so CGM is not a source
    const cgmContent = Buffer.from('BEGMF "sample"; ENDMF;', 'utf-8');
    await expect(convertFile(cgmContent, 'cgm', 'svg', {}, 'drawing.cgm')).rejects.toThrow(
      /Cannot convert from .+ \(\.cgm\) to target format \.svg/
    );

    // svg -> emf
    const resEmf = await convertFile(svgBuffer, 'svg', 'emf', {}, 'drawing.svg');
    expect(resEmf.filename).toBe('drawing.emf');
    expect(resEmf.mimeType).toBe('image/emf');
    expect(resEmf.size).toBeGreaterThan(88);
    expect(resEmf.buffer.readUInt32LE(0)).toBe(1); // EMR_HEADER
    expect(resEmf.buffer.subarray(40, 44).toString('latin1')).toBe(' EMF');
    expect(resEmf.buffer.readUInt32LE(48)).toBe(resEmf.size); // nBytes
  });

  it('converts image and raw formats (icns, eps, 3fr, crw, etc.) with real PostScript raster', async () => {
    // 1x1 valid PNG buffer
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const pngBuffer = Buffer.from(pngBase64, 'base64');

    // png -> icns
    const res1 = await convertFile(pngBuffer, 'png', 'icns', {}, 'appicon.png');
    expect(res1.filename).toBe('appicon.icns');
    expect(res1.buffer.subarray(0, 4).toString('ascii')).toBe('icns');

    // png -> eps (must contain Level 2 colorimage with hex data, NOT raw PNG bytes)
    const resEps = await convertFile(pngBuffer, 'png', 'eps', {}, 'appicon.png');
    expect(resEps.filename).toBe('appicon.eps');
    expect(resEps.mimeType).toBe('application/postscript');
    const epsStr = resEps.buffer.toString('utf-8');
    expect(epsStr).toContain('%!PS-Adobe-3.0 EPSF-3.0');
    expect(epsStr).toContain('colorimage');
    expect(epsStr).not.toContain('\x89PNG');

    // 3fr -> jpg (with embedded preview)
    const sampleJpeg = Buffer.from(
      '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAEAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z',
      'base64'
    );
    const raw3fr = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(16, 0), sampleJpeg]);
    const res2 = await convertFile(raw3fr, '3fr', 'jpg', { allowEmbeddedPreview: true }, 'photo.3fr');
    expect(res2.filename).toBe('photo.jpg');
    expect(res2.buffer[0]).toBe(0xff);
    expect(res2.buffer[1]).toBe(0xd8);
    expect(res2.isEmbeddedPreview).toBe(true);
  });

  it('converts document, ebook, and spreadsheet formats (hwp, azw4, et) without disguised PDFs', async () => {
    const docData = Buffer.from('Hangul Word Processor text sample', 'utf-8');

    // hwp -> pdf
    const res1 = await convertFile(docData, 'hwp', 'pdf', {}, 'document.hwp');
    expect(res1.filename).toBe('document.pdf');
    expect(res1.buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');

    // azw4 -> epub: a Print Replica book is a PDF inside a PalmDB container, not text. Plain text under the .azw4
    // name is refused with a typed error instead of becoming an EPUB of that text.
    await expect(convertFile(docData.length < 78 ? Buffer.concat([docData, Buffer.alloc(80)]) : docData, 'azw4', 'epub', {}, 'book.azw4')).rejects.toMatchObject({
      name: 'ConversionFailedError',
      message: expect.stringMatching(/not a readable MOBI file/),
    });

    // et -> csv
    const csvData = Buffer.from('Name,Value\nItemA,100\nItemB,200', 'utf-8');
    const res3 = await convertFile(csvData, 'et', 'csv', {}, 'table.et');
    expect(res3.filename).toBe('table.csv');
    expect(res3.buffer.toString('utf-8')).toContain('ItemA');

    // et -> png (must be REAL PNG image, not PDF disguised as PNG!)
    const resEtPng = await convertFile(csvData, 'et', 'png', {}, 'table.et');
    expect(resEtPng.filename).toBe('table.png');
    expect(resEtPng.mimeType).toBe('image/png');
    expect(resEtPng.buffer.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    // et -> jpg (must be REAL JPEG image, not PDF!)
    const resEtJpg = await convertFile(csvData, 'et', 'jpg', {}, 'table.et');
    expect(resEtJpg.filename).toBe('table.jpg');
    expect(resEtJpg.mimeType).toBe('image/jpeg');
    expect(resEtJpg.buffer[0]).toBe(0xff);
    expect(resEtJpg.buffer[1]).toBe(0xd8);
  });

  // odg -> bmp: LibreOffice Draw draws the page, Poppler renders it and the BMP encoder writes the picture.
  oracleTest('converts a real drawing (odg) to a real BMP picture of its page', ['soffice', 'pdftoppm', 'identify'], async () => {
    const drawing = readFileSync(path.join(__dirname, 'fixtures', 'office-sources', 'drawing-two-pages.odg'));
    const res = await dispatchConversion(drawing, 'odg', 'bmp', { multiPageOutput: 'first' }, 'graphic.odg');
    expect(res.filename).toBe('graphic.bmp');
    expect(res.mimeType).toBe('image/bmp');
    expect(res.buffer.subarray(0, 2).toString('ascii')).toBe('BM');
    // The BMP information header holds the pixel size at byte 18 (width) and 22 (height, negative for a top-down image).
    const [width, height] = [res.buffer.readInt32LE(18), Math.abs(res.buffer.readInt32LE(22))];
    expect(Math.abs(width - A4_WIDTH_PX_150_DPI)).toBeLessThanOrEqual(1);
    expect(Math.abs(height - A4_HEIGHT_PX_150_DPI)).toBeLessThanOrEqual(1);
  }, 240_000);
});
