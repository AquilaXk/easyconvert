import { describe, it, expect } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { decompressBzip2 } from '../src/lib/conversions/bzip2';
import { extractTarArchive, extractZipArchive, extractRarArchive } from '../src/lib/conversions/archive';

describe('Universal Engine Conversion Coverage', () => {
  it('converts archive formats (tar.gz, tar.bz2, 7z, rar, etc.) with real binary validation', async () => {
    const textData = Buffer.from('Archive test content for universal conversion', 'utf-8');

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

    // zip -> rar
    const resRar = await convertFile(textData, 'zip', 'rar', {}, 'test.zip');
    expect(resRar.filename).toBe('test.rar');
    expect(resRar.mimeType).toBe('application/x-rar-compressed');
    // Standard RAR signature: Rar!\x1a\x07\x00
    expect(resRar.buffer.subarray(0, 7)).toEqual(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]));

    // rar -> zip roundtrip
    const rarExtract = extractRarArchive(resRar.buffer);
    expect(rarExtract.length).toBeGreaterThan(0);
    expect(rarExtract[0].buffer.toString('utf-8')).toBe('Archive test content for universal conversion');

    const resZipFromRar = await convertFile(resRar.buffer, 'rar', 'zip', {}, 'test.rar');
    const zipFiles = await extractZipArchive(resZipFromRar.buffer);
    expect(zipFiles.length).toBeGreaterThan(0);
    expect(zipFiles[0].buffer.toString('utf-8')).toBe('Archive test content for universal conversion');

    // ace -> zip
    const res3 = await convertFile(textData, 'ace', 'zip', {}, 'test.ace');
    expect(res3.filename).toBe('test.zip');
    expect(res3.buffer.length).toBeGreaterThan(0);
  });

  it('converts audio and video expanded formats', async () => {
    const audioData = Buffer.from('RIFF$\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x44\xac\x00\x00\x88\x58\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00', 'binary');

    // 3gpp -> mp4
    const res1 = await convertFile(audioData, '3gpp', 'mp4', {}, 'video.3gpp');
    expect(res1.filename).toBe('video.mp4');
    expect(res1.buffer.length).toBeGreaterThan(0);

    // weba -> mp3
    const res2 = await convertFile(audioData, 'weba', 'mp3', {}, 'audio.weba');
    expect(res2.filename).toBe('audio.mp3');
    expect(res2.buffer.length).toBeGreaterThan(0);

    // m4b -> aac
    const res3 = await convertFile(audioData, 'm4b', 'aac', {}, 'book.m4b');
    expect(res3.filename).toBe('book.aac');
    expect(res3.buffer.length).toBeGreaterThan(0);
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

    // emf -> png
    const res3 = await convertFile(svgBuffer, 'emf', 'png', {}, 'graphic.emf');
    expect(res3.filename).toBe('graphic.png');
    // Real PNG signature
    expect(res3.buffer.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

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

    // cgm -> svg
    const cgmContent = Buffer.from('BEGMF "sample"; ENDMF;', 'utf-8');
    const resCgm = await convertFile(cgmContent, 'cgm', 'svg', {}, 'drawing.cgm');
    expect(resCgm.filename).toBe('drawing.svg');
    expect(resCgm.mimeType).toBe('image/svg+xml');
    expect(resCgm.buffer.toString('utf-8')).toContain('<svg');

    // svg -> emf
    const resEmf = await convertFile(svgBuffer, 'svg', 'emf', {}, 'drawing.svg');
    expect(resEmf.filename).toBe('drawing.emf');
    expect(resEmf.mimeType).toBe('image/emf');
    expect(resEmf.buffer.length).toBeGreaterThan(0);
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

    // 3fr -> jpg
    const res2 = await convertFile(pngBuffer, '3fr', 'jpg', {}, 'photo.3fr');
    expect(res2.filename).toBe('photo.jpg');
    expect(res2.buffer[0]).toBe(0xff);
    expect(res2.buffer[1]).toBe(0xd8);
  });

  it('converts document, ebook, and spreadsheet formats (hwp, azw4, et, odg) without disguised PDFs', async () => {
    const docData = Buffer.from('Hangul Word Processor text sample', 'utf-8');

    // hwp -> pdf
    const res1 = await convertFile(docData, 'hwp', 'pdf', {}, 'document.hwp');
    expect(res1.filename).toBe('document.pdf');
    expect(res1.buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');

    // azw4 -> epub
    const res2 = await convertFile(docData, 'azw4', 'epub', {}, 'book.azw4');
    expect(res2.filename).toBe('book.epub');
    expect(res2.buffer.length).toBeGreaterThan(0);

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

    // odg -> bmp (must be REAL BMP image, not PDF!)
    const resOdgBmp = await convertFile(docData, 'odg', 'bmp', {}, 'graphic.odg');
    expect(resOdgBmp.filename).toBe('graphic.bmp');
    expect(resOdgBmp.mimeType).toBe('image/bmp');
    expect(resOdgBmp.buffer.subarray(0, 2).toString('ascii')).toBe('BM');
  });
});
