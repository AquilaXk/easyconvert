import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  convertOffice,
  getExcelColumnIndex,
  getExcelColumnName,
  extractTextFromDoc,
} from '../src/lib/conversions/office';
import { encodePureH264Mp4 } from '../src/lib/conversions/media-encoder';
import { demuxMp4 } from '../src/lib/edge/workers/webcodecs.worker';
import { convertDocument } from '../src/lib/conversions/document';
import { UnsupportedTargetError } from '../src/lib/types';
import PDFDocument from 'pdfkit';

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
    it('dynamically calculates totalFrames in encodePureH264Mp4 from audio duration', () => {
      const sampleRate = 44100;
      const channels = 1;
      // 2 seconds of audio at 44100Hz = 88200 samples
      const pcmSamples = new Int16Array(sampleRate * 2);
      for (let i = 0; i < pcmSamples.length; i++) {
        pcmSamples[i] = Math.round(Math.sin((i / sampleRate) * 440 * 2 * Math.PI) * 10000);
      }

      const mp4Buffer = encodePureH264Mp4(pcmSamples, sampleRate, channels, { videoFps: 30 }, 'Test Dynamic');
      expect(mp4Buffer.toString('ascii', 4, 8)).toBe('ftyp');

      const arrayBuffer = mp4Buffer.buffer.slice(
        mp4Buffer.byteOffset,
        mp4Buffer.byteOffset + mp4Buffer.byteLength
      );
      const demuxed = demuxMp4(arrayBuffer);

      expect(demuxed).not.toBeNull();
      expect(demuxed?.type).toBe('video');
      // At 30 fps for 2 seconds, totalFrames should be ~60 frames, NOT hardcoded 15!
      expect(demuxed?.samples.length).toBe(60);
      expect(demuxed?.samples[0].timestampMicros).toBe(0);
      // Keyframe at 0 and every 15 frames
      expect(demuxed?.samples[0].isKeyFrame).toBe(true);
      expect(demuxed?.samples[15].isKeyFrame).toBe(true);
      expect(demuxed?.samples[1].isKeyFrame).toBe(false);
    });

    it('demuxes standard stbl box extracting exact sample boundaries and timescale', () => {
      const pcmSamples = new Int16Array(44100); // 1 second
      const mp4 = encodePureH264Mp4(pcmSamples, 44100, 1, { videoFps: 25 }, '1-Sec MP4');
      const ab = mp4.buffer.slice(mp4.byteOffset, mp4.byteOffset + mp4.byteLength);

      const track = demuxMp4(ab);
      expect(track).toBeDefined();
      expect(track?.samples.length).toBe(25); // 25 fps * 1s
      expect(track?.width).toBe(320);
      expect(track?.height).toBe(240);
      expect(track?.codec).toBe('avc1');
    });
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
