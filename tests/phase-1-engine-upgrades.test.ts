import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  convertOffice,
  getExcelColumnIndex,
  getExcelColumnName,
  extractTextFromDoc,
} from '../src/lib/conversions/office';
import { demuxMp4 } from '../src/lib/edge/workers/webcodecs.worker';
import { convertDocument } from '../src/lib/conversions/document';
import { UnsupportedTargetError } from '../src/lib/types';
import PDFDocument from 'pdfkit';
import { countVideoPackets, ffmpegTestVideoMp4, toArrayBuffer } from './helpers/media-lossy-oracle';
import { oracleTest } from './helpers/oracle-test';
import { avcProfileAndLevelHex, ffprobeReport } from './helpers/ffprobe-json';

describe('Phase 1: Core Domain High-Fidelity Engine Upgrades', () => {
  describe('1. Spreadsheet Sparse Cell & Inline String Parsing', () => {
    it('accurately parses bijective base-26 column indices', () => {
      expect(getExcelColumnIndex('A')).toBe(0);
      expect(getExcelColumnIndex('B')).toBe(1);
      expect(getExcelColumnIndex('C')).toBe(2);
      expect(getExcelColumnIndex('Z')).toBe(25);
      expect(getExcelColumnIndex('AA')).toBe(26);
      expect(getExcelColumnIndex('AB')).toBe(27);
      expect(getExcelColumnIndex('AZ')).toBe(51);
      expect(getExcelColumnIndex('BA')).toBe(52);
      expect(getExcelColumnName(0)).toBe('A');
      expect(getExcelColumnName(25)).toBe('Z');
      expect(getExcelColumnName(26)).toBe('AA');
    });

    it('preserves sparse cell positions without shifting columns to the left', async () => {
      const zip = new JSZip();
      zip.file(
        '[Content_Types].xml',
        `<?xml version="1.0" encoding="UTF-8"?>
        <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
          <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
          <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
        </Types>`
      );
      zip.file(
        'xl/workbook.xml',
        `<?xml version="1.0" encoding="UTF-8"?>
        <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
          <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
        </workbook>`
      );
      // Row 1 has cell A1 and D1 (skipping B1, C1).
      // Row 2 has cell B2 and C2.
      // Also test inlineStr and boolean cells.
      zip.file(
        'xl/worksheets/sheet1.xml',
        `<?xml version="1.0" encoding="UTF-8"?>
        <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
          <sheetData>
            <row r="1">
              <c r="A1"><v>100</v></c>
              <c r="D1" t="inlineStr"><is><t>Sparse Value</t></is></c>
            </row>
            <row r="2">
              <c r="B2" t="b"><v>1</v></c>
              <c r="C2"><v>300</v></c>
            </row>
          </sheetData>
        </worksheet>`
      );

      const xlsxBuffer = await zip.generateAsync({ type: 'nodebuffer' });
      const csvResult = await convertOffice(xlsxBuffer, 'xlsx', 'csv');
      const csvLines = csvResult.buffer.toString('utf-8').trim().split('\n');

      expect(csvLines).toHaveLength(2);
      const row1Cols = csvLines[0].split(',');
      expect(row1Cols[0]).toBe('100');
      expect(row1Cols[1]).toBe('');
      expect(row1Cols[2]).toBe('');
      expect(row1Cols[3]).toBe('Sparse Value');

      const row2Cols = csvLines[1].split(',');
      expect(row2Cols[0]).toBe('');
      expect(row2Cols[1]).toBe('TRUE');
      expect(row2Cols[2]).toBe('300');
    });
  });

  describe('2. Word 97-2003 OLE2 CFBF Unicode Parser Integration', () => {
    it('gracefully handles raw fallback text in doc files', () => {
      const dummyDoc = Buffer.from('This is a legacy binary Word document payload with readable ASCII text.', 'utf-8');
      const extracted = extractTextFromDoc(dummyDoc);
      expect(extracted).toContain('legacy binary Word document');
    });
  });

  describe('3. Dynamic Media Duration & ISO BMFF MP4 Demuxing', () => {
    for (const faststart of [true, false]) {
      oracleTest(
        `demuxes the sample table of a reference-authored H.264 MP4 (faststart=${faststart})`,
        ['ffmpeg', 'ffprobe'],
        () => {
          const mp4 = ffmpegTestVideoMp4({ width: 320, height: 240, fps: 30, seconds: 2, gop: 15, faststart });
          const referencePackets = countVideoPackets(mp4, 'mp4');
          expect(referencePackets).toBe(60);

          const demuxed = demuxMp4(toArrayBuffer(mp4));

          expect(demuxed).not.toBeNull();
          expect(demuxed?.type).toBe('video');
          // RFC 6381 string from the reference decoder's view of the same stream: avc1.<profile><constraints><level>
          const probed = ffprobeReport(new Uint8Array(mp4), 'mp4').streams.find((stream) => stream.codec_type === 'video');
          const { profileIdc, level } = avcProfileAndLevelHex(probed!);
          expect(demuxed?.codec).toMatch(new RegExp(`^avc1\\.${profileIdc}[0-9a-f]{2}${level}$`));
          expect(demuxed?.width).toBe(320);
          expect(demuxed?.height).toBe(240);
          expect(demuxed?.samples.length).toBe(referencePackets);
          expect(demuxed?.samples[0].timestampMicros).toBe(0);
          // Keyframes sit at 0 and every 15 frames, none elsewhere
          const keyframeIndices = demuxed!.samples.flatMap((sample, index) => (sample.isKeyFrame ? [index] : []));
          expect(keyframeIndices).toEqual([0, 15, 30, 45]);
        }
      );
    }
  });

  describe('4. Fail-Closed PDF Vector Export Without Synthesized Text Frames', () => {
    it('fails closed when converting PDF to SVG without a native vector graphics renderer', async () => {
      const chunks: Buffer[] = [];
      const doc = new PDFDocument();
      doc.on('data', (c) => chunks.push(c));
      const pdfPromise = new Promise<Buffer>((resolve) => {
        doc.on('end', () => resolve(Buffer.concat(chunks)));
      });

      // Write 60 distinct lines
      for (let i = 1; i <= 60; i++) {
        doc.fontSize(10).text(`Line number ${i} of the comprehensive test document.`);
      }
      doc.end();
      const pdfBuf = await pdfPromise;

      await expect(convertDocument(pdfBuf, 'pdf', 'svg', {}, 'long_doc.pdf')).rejects.toThrow(
        UnsupportedTargetError
      );
    });
  });
});
