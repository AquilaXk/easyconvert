import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { convertOffice } from '../src/lib/conversions/office';
import { extractZipArchive } from '../src/lib/conversions/archive';
import { triangulatePolygonEarcut, Point3D } from '../src/lib/conversions/cad-nurbs';
import { demuxMp4 } from '../src/lib/edge/workers/webcodecs.worker';
import { EdgeUnsupportedError } from '../src/lib/edge/workers/worker-errors';
import { performOcr } from '../src/lib/conversions/ocr';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { oracleTest } from './helpers/oracle-test';
import { OracleToolMissingError } from './helpers/differential-oracle';

const KOREAN_TESSDATA_DIRS = [
  ...(process.env.TESSDATA_PREFIX ? [process.env.TESSDATA_PREFIX] : []),
  '/usr/share/tesseract-ocr/5/tessdata',
  '/usr/share/tesseract-ocr/4.00/tessdata',
  '/usr/share/tessdata',
];
const OCR_TEST_TIMEOUT_MS = 120_000;

describe('Skeptical Audit & Robustness Verification', () => {
  it('preserves sparse row coordinates in OpenXML XLSX (Row 1 and Row 4)', async () => {
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
      </Types>`
    );
    zip.file(
      'xl/worksheets/sheet1.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <sheetData>
          <row r="1"><c r="A1"><v>Header</v></c></row>
          <row r="4"><c r="A4"><v>Row 4 Data</v></c></row>
        </sheetData>
      </worksheet>`
    );

    const xlsxBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    const csvResult = await convertOffice(xlsxBuffer, 'xlsx', 'csv');
    const csvLines = csvResult.buffer.toString('utf-8').trim().split('\n');

    expect(csvLines).toHaveLength(4);
    expect(csvLines[0]).toBe('Header');
    expect(csvLines[3]).toBe('Row 4 Data');
  });

  it('preserves 3D face normal in triangulatePolygonEarcut when normal points along -Z', () => {
    const normal: [number, number, number] = [0, 0, -1];
    const polygon: Point3D[] = [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 1, y: 1, z: 0 },
      { x: 1, y: 0, z: 0 },
    ];

    const triangles = triangulatePolygonEarcut(polygon, normal);
    expect(triangles).toHaveLength(2);

    for (const [i0, i1, i2] of triangles) {
      const p0 = polygon[i0];
      const p1 = polygon[i1];
      const p2 = polygon[i2];
      const v0x = p1.x - p0.x;
      const v0y = p1.y - p0.y;
      const v1x = p2.x - p0.x;
      const v1y = p2.y - p0.y;

      const crossZ = v0x * v1y - v0y * v1x;
      expect(crossZ).toBeLessThan(0);
    }
  });

  it('fails closed when extractZipArchive is given a corrupted archive', async () => {
    const corruptedZip = Buffer.from('NOT_A_VALID_ZIP_HEADER_JUST_GARBAGE');
    await expect(extractZipArchive(corruptedZip)).rejects.toThrow();
  });

  it('safely handles corrupted tkhd box with small tSize in demuxMp4', () => {
    const buf = Buffer.alloc(100);
    buf.writeUInt32BE(100, 0); // root moov
    buf.write('moov', 4, 'ascii');
    buf.writeUInt32BE(92, 8); // trak
    buf.write('trak', 12, 'ascii');
    buf.writeUInt32BE(4, 16); // corrupted tkhd with tSize = 4 (< 8)
    buf.write('tkhd', 20, 'ascii');

    const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    // A typed refusal, never a RangeError from reading past the box
    expect(() => demuxMp4(arrayBuf)).toThrow(EdgeUnsupportedError);
  });

  // Confidence calibration is tracked separately; this asserts what was recognized.
  oracleTest('routes CJK language requests to CJK OCR pipeline in performOcr', ['tesseract'], async () => {
    const hasKorean = KOREAN_TESSDATA_DIRS.some((dir) => fs.existsSync(path.join(dir, 'kor.traineddata')));
    if (!hasKorean) throw new OracleToolMissingError('kor.traineddata', 'kor.traineddata is not installed');
    const testImage = await sharp({
      create: { width: 120, height: 40, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([
        {
          input: Buffer.from('<svg width="120" height="40"><text x="10" y="28" font-family="monospace" font-size="20" fill="black">한글</text></svg>'),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();

    const result = await performOcr(testImage, 'ko');
    expect(result.text).toContain('한글');
    expect(result.imageWidth).toBe(120);
    expect(result.imageHeight).toBe(40);
  }, OCR_TEST_TIMEOUT_MS);
});
