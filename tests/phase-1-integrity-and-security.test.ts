import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as fetchUrl } from '../src/app/api/fetch-url/route';
import { isBlockedIp, isBlockedIpv4, isBlockedIpv6, validateUrlForSsrf } from '../src/lib/security/ssrf';
import {
  extractZipArchive,
  extractTarArchive,
  createZipArchive,
  ARCHIVE_SECURITY_LIMITS,
} from '../src/lib/conversions/archive';
import {
  getExcelColumnName,
  generateXlsxFromData,
  convertOffice,
} from '../src/lib/conversions/office';
import { convertMedia } from '../src/lib/conversions/media';
import { convertVectorCad } from '../src/lib/conversions/vector-cad';
import { parseXmlDocument, xmlToJsonMl } from '../src/lib/conversions/data-xml';
import { DataLimitExceededError, DataParseError } from '../src/lib/types';
import JSZip from 'jszip';

describe('Phase 1: Architecture Integrity & Emergency Security/Bug Patches', () => {
  describe('1. Fail-Closed Removal of Fake Synthesizers and Generators', () => {
    it('fails closed when audio decoder is unavailable instead of synthesizing fake audio', async () => {
      const dummyMp3Buffer = Buffer.from('NOT_A_WAV_FILE_JUST_SOME_ARBITRARY_BYTES_DATA');
      await expect(
        convertMedia(dummyMp3Buffer, 'mp3', 'wav', {}, 'track.mp3')
      ).rejects.toThrow(/(Unsupported audio format|Native FFmpeg transcoding failed)/i);
    });

    it('fails closed on binary DWG decoding when native decoder is unavailable', async () => {
      const dummyDwg = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);
      await expect(
        convertVectorCad(dummyDwg, 'dwg', 'dxf', {}, 'drawing.dwg')
      ).rejects.toThrow('Unsupported CAD format: DWG binary decoder unavailable');
    });

    it('fails closed on DWG encoding when native encoder is unavailable', async () => {
      const dxfContent = '0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n0.0\n20\n0.0\n11\n1.0\n21\n1.0\n0\nENDSEC\n0\nEOF\n';
      await expect(
        convertVectorCad(Buffer.from(dxfContent, 'utf-8'), 'dxf', 'dwg', {}, 'plan.dxf')
      ).rejects.toThrow('Unsupported CAD format: DWG binary encoder unavailable');
    });

    it('fails closed when converting to Apple iWork targets (pages, numbers, key)', async () => {
      const textBuffer = Buffer.from('Quarterly Financial Summary 2026');
      await expect(
        convertOffice(textBuffer, 'txt', 'pages', {}, 'summary.txt')
      ).rejects.toThrow("Unsupported office conversion: target iWork format 'pages' is not supported");

      await expect(
        convertOffice(textBuffer, 'csv', 'numbers', {}, 'summary.csv')
      ).rejects.toThrow("Unsupported office conversion: target iWork format 'numbers' is not supported");

      await expect(
        convertOffice(textBuffer, 'txt', 'key', {}, 'summary.txt')
      ).rejects.toThrow("Unsupported office conversion: target iWork format 'key' is not supported");
    });
  });

  describe('2. SSRF Hardening & Blocklist Enforcement', () => {
    it('blocks private IPv4 ranges, loopback, link-local, and cloud metadata', () => {
      expect(isBlockedIpv4('127.0.0.1')).toBe(true);
      expect(isBlockedIpv4('127.1.2.3')).toBe(true);
      expect(isBlockedIpv4('10.0.0.1')).toBe(true);
      expect(isBlockedIpv4('10.255.255.255')).toBe(true);
      expect(isBlockedIpv4('172.16.0.1')).toBe(true);
      expect(isBlockedIpv4('172.31.255.254')).toBe(true);
      expect(isBlockedIpv4('192.168.1.1')).toBe(true);
      expect(isBlockedIpv4('169.254.169.254')).toBe(true);
      expect(isBlockedIpv4('0.0.0.0')).toBe(true);
      expect(isBlockedIpv4('100.64.0.1')).toBe(true);
      expect(isBlockedIpv4('224.0.0.1')).toBe(true);

      // Public IP should not be blocked
      expect(isBlockedIpv4('8.8.8.8')).toBe(false);
      expect(isBlockedIpv4('1.1.1.1')).toBe(false);
    });

    it('blocks IPv6 loopback, link-local, and IPv4-mapped IPv6 ranges', () => {
      expect(isBlockedIpv6('::1')).toBe(true);
      expect(isBlockedIpv6('0:0:0:0:0:0:0:1')).toBe(true);
      expect(isBlockedIpv6('fe80::1')).toBe(true);
      expect(isBlockedIpv6('fe80::dead:beef')).toBe(true);
      expect(isBlockedIpv6('fc00::1')).toBe(true);
      expect(isBlockedIpv6('fd00::1')).toBe(true);
      expect(isBlockedIpv6('::ffff:127.0.0.1')).toBe(true);
      expect(isBlockedIpv6('::ffff:169.254.169.254')).toBe(true);
      expect(isBlockedIpv6('::ffff:10.0.0.5')).toBe(true);
      expect(isBlockedIpv6('::ffff:7f00:0001')).toBe(true);
      expect(isBlockedIp('[::ffff:127.0.0.1]')).toBe(true);
    });

    it('POST /api/fetch-url blocks SSRF requests with 403', async () => {
      const maliciousUrls = [
        'http://127.0.0.1:8080/admin',
        'http://169.254.169.254/latest/meta-data/',
        'http://[::1]/secret',
        'http://[::ffff:127.0.0.1]/status',
        'http://10.0.0.1/internal',
        'http://localhost/metrics',
      ];

      for (const url of maliciousUrls) {
        const req = new NextRequest('http://localhost/api/fetch-url', {
          method: 'POST',
          body: JSON.stringify({ url }),
        });
        const res = await fetchUrl(req);
        expect(res.status).toBe(403);
        const data = await res.json();
        expect(data.error).toContain('Requests to internal/private addresses are blocked');
      }
    });

    it('validates DNS and blocks unresolved or forbidden domains', async () => {
      const invalidDomainUrl = new URL('http://this-domain-does-not-exist-at-all-12345.com');
      const isValid = await validateUrlForSsrf(invalidDomainUrl);
      expect(isValid).toBe(false);
    });
  });

  describe('3. Zip Bomb & Archive Security Limits', () => {
    it('enforces maximum file count limit (1000 files)', async () => {
      const zip = new JSZip();
      for (let i = 0; i < 1005; i++) {
        zip.file(`file_${i}.txt`, 'a');
      }
      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

      await expect(extractZipArchive(zipBuffer)).rejects.toThrow(
        /Archive bomb detected: file count .* exceeds limit/
      );
    });

    it('enforces maximum uncompressed size limit (500MB)', async () => {
      const zip = new JSZip();
      // Mock entry that simulates over 500MB
      zip.file('huge.bin', Buffer.alloc(100)); // small in mock zip
      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

      const origMax = ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE;
      try {
        ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE = 50; // set low threshold for test
        await expect(extractZipArchive(zipBuffer)).rejects.toThrow(
          /Archive bomb detected: uncompressed size exceeds limit/
        );
      } finally {
        ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE = origMax;
      }
    });

    it('enforces maximum compression ratio limit (100:1)', async () => {
      // 50KB of zeros compresses to ~100 bytes in DEFLATE, ratio > 100:1
      const repetitiveData = Buffer.alloc(50000, 0);
      const zip = new JSZip();
      zip.file('repetitive.bin', repetitiveData, { compression: 'DEFLATE', compressionOptions: { level: 9 } });
      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

      expect(repetitiveData.length / zipBuffer.length).toBeGreaterThan(100);
      await expect(extractZipArchive(zipBuffer)).rejects.toThrow(
        /Archive bomb detected: compression ratio .* exceeds 100:1 limit/
      );
    });
  });

  describe('4. Bijective Base-26 Excel Coordinates & RFC 4180 CSV Parsing', () => {
    it('calculates Excel columns correctly beyond 26 columns using Bijective Base-26', () => {
      expect(getExcelColumnName(0)).toBe('A');
      expect(getExcelColumnName(25)).toBe('Z');
      expect(getExcelColumnName(26)).toBe('AA');
      expect(getExcelColumnName(27)).toBe('AB');
      expect(getExcelColumnName(51)).toBe('AZ');
      expect(getExcelColumnName(52)).toBe('BA');
      expect(getExcelColumnName(701)).toBe('ZZ');
      expect(getExcelColumnName(702)).toBe('AAA');
    });

    it('generates XLSX with correct cell coordinates for >26 columns without duplicate A1 coordinates', async () => {
      const headers = Array.from({ length: 30 }, (_, i) => `Col${i + 1}`).join(',');
      const values = Array.from({ length: 30 }, (_, i) => `Val${i + 1}`).join(',');
      const csv = `${headers}\n${values}`;

      const xlsxBuffer = await generateXlsxFromData(Buffer.from(csv, 'utf-8'), 'csv', {}, 'wide_sheet');
      const zip = await JSZip.loadAsync(xlsxBuffer);
      const sheetXml = await zip.file('xl/worksheets/sheet1.xml')!.async('text');

      // Verify Column 1 is A1, Column 26 is Z1, Column 27 is AA1, Column 30 is AD1
      expect(sheetXml).toContain('r="A1"');
      expect(sheetXml).toContain('r="Z1"');
      expect(sheetXml).toContain('r="AA1"');
      expect(sheetXml).toContain('r="AB1"');
      expect(sheetXml).toContain('r="AD1"');
      // Verify AA1 has its correct value Val27
      expect(sheetXml).toMatch(/<c r="AA1" t="inlineStr"><is><t>Col27<\/t><\/is><\/c>/);
      expect(sheetXml).toMatch(/<c r="AA2" t="inlineStr"><is><t>Val27<\/t><\/is><\/c>/);
    });

    it('parses CSV with quoted commas cleanly using Papa.parse without splitting fields', async () => {
      const csv = 'Name,Bio,Role\n"Smith, John","Software Engineer, Lead",Architect';
      const xlsxBuffer = await generateXlsxFromData(Buffer.from(csv, 'utf-8'), 'csv', {}, 'quoted_sheet');
      const zip = await JSZip.loadAsync(xlsxBuffer);
      const sheetXml = await zip.file('xl/worksheets/sheet1.xml')!.async('text');

      expect(sheetXml).toContain('Smith, John');
      expect(sheetXml).toContain('Software Engineer, Lead');
      expect(sheetXml).toContain('Architect');
      // Ensure Row 2 only has 3 cells (A2, B2, C2), not split into 5 cells
      expect(sheetXml).toContain('r="A2"');
      expect(sheetXml).toContain('r="B2"');
      expect(sheetXml).toContain('r="C2"');
      expect(sheetXml).not.toContain('r="D2"');
    });
  });

  describe('5. E-Book Format Conversions (azw3, mobi, lrf, oeb, pdb)', () => {
    it('successfully converts to azw3, mobi, lrf, oeb, and pdb without throwing unsupported', async () => {
      const textBuffer = Buffer.from('# Chapter 1: The Odyssey\n\nSing in me, Muse, and through me tell the story.');
      const ebookTargets = ['azw3', 'mobi', 'lrf', 'oeb', 'pdb'];

      for (const tgt of ebookTargets) {
        const res = await convertOffice(textBuffer, 'txt', tgt, {}, 'odyssey.txt');
        expect(res.filename).toBe(`odyssey.${tgt}`);
        expect(res.size).toBeGreaterThan(0);
        expect(res.buffer.length).toBeGreaterThan(0);

        if (tgt === 'pdb') {
          expect(res.mimeType).toBe('application/vnd.palm');
          // Check Palm Database header 'BOOK' or 'TEXt'
          expect(res.buffer.toString('ascii', 60, 64)).toBe('TEXt');
        } else if (tgt === 'mobi') {
          expect(res.mimeType).toBe('application/x-mobipocket-ebook');
          expect(res.buffer.toString('ascii', 60, 64)).toBe('BOOK');
          expect(res.buffer.indexOf('MOBI')).toBeGreaterThan(0);
        } else if (tgt === 'azw3') {
          expect(res.mimeType).toBe('application/vnd.amazon.mobi8-ebook');
          expect(res.buffer.toString('ascii', 60, 64)).toBe('BOOK');
          expect(res.buffer.indexOf('MOBI')).toBeGreaterThan(0);
        } else if (tgt === 'oeb') {
          expect(res.mimeType).toBe('application/x-oeb1-package+xml');
          expect(res.buffer.toString('utf-8')).toContain('<package');
          expect(res.buffer.toString('utf-8')).toContain('The Odyssey');
        } else if (tgt === 'lrf') {
          expect(res.mimeType).toBe('application/x-sony-bbeb');
          expect(res.buffer.toString('ascii', 2, 6)).toBe('L001');
        }
      }
    });
  });

  describe('6. ReDoS-Safe XML Parsing', () => {
    it('parses XML with nested tags and attributes into ordered JsonML', () => {
      const xml = '<catalog version="2.0"><item id="A1" active="true"><name>Widget</name><price>19.99</price></item><item id="A2"><name>Gadget</name></item></catalog>';
      expect(xmlToJsonMl(parseXmlDocument(xml))).toEqual([
        'catalog',
        { version: '2.0' },
        ['item', { id: 'A1', active: 'true' }, ['name', 'Widget'], ['price', '19.99']],
        ['item', { id: 'A2' }, ['name', 'Gadget']],
      ]);
    });

    it('rejects deeply nested unclosed tags with typed errors instead of guessing a tree', () => {
      const rejectionOf = (xml: string): Error => {
        try {
          parseXmlDocument(xml);
        } catch (err) {
          return err as Error;
        }
        throw new Error('expected the XML to be rejected');
      };
      // The input that made a regex parser backtrack: 1,001 open elements stop at the nesting cap.
      const deep = rejectionOf('<div>' + '<p><span>'.repeat(500) + 'test text' + '</div>');
      expect(deep).toBeInstanceOf(DataLimitExceededError);
      expect(deep.message).toMatch(/nesting exceeds 512 levels/);
      // Within the cap, the mismatched close tag is reported as a parse error.
      const shallow = rejectionOf('<div>' + '<p><span>'.repeat(50) + 'test text' + '</div>');
      expect(shallow).toBeInstanceOf(DataParseError);
      expect(shallow.message).toMatch(/unexpected close tag/);
    });
  });
});
