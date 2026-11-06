import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { FileExtensionSpoofError, isFormatCompatibleWithMagicBytes, assertNotSpoofedFile } from '../src/lib/registry';
import { assertCompoundFileKindInObject } from '../src/lib/security/file-guard';
import { OBJECT_HEADER_BYTES } from '../src/lib/storage/object-header';
import { MAX_CGM_INPUT_CHARS, parseCgmToSvg, convertVectorCad } from '../src/lib/conversions/vector-cad';
import { scanCss } from '../src/lib/conversions/css-references';
import { QPDF_MEMORY_LIMIT_MB, toQpdfError } from '../src/lib/conversions/pdf-postprocess/qpdf-run';
import { HTML_MAX_TABLE_COVERED_CELLS, htmlToDocumentModel } from '../src/lib/conversions/html-model';
import { MAX_CMAP_FORMAT12_CODEPOINTS, parseCmapTable } from '../src/lib/conversions/font';
import { parseHwpxDocument } from '../src/lib/conversions/hwpx';
import { assertOpenDocumentGraphic } from '../src/lib/conversions/office';
import { buildCompoundFile, placeDirectory } from './helpers/cfb-craft';
import { SandboxedMemoryLimitError } from '../src/lib/security/process-sandbox';
import {
  ConversionFailedError,
  CorruptStreamError,
  PayloadLimitError,
  PdfPostprocessError,
} from '../src/lib/types';

function writeCompoundRootClassId(file: Buffer, guid: string): Buffer {
  const [d1, d2, d3, d4, d5] = guid.split('-');
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(parseInt(d1, 16), 0);
  bytes.writeUInt16LE(parseInt(d2, 16), 4);
  bytes.writeUInt16LE(parseInt(d3, 16), 6);
  Buffer.from(d4 + d5, 'hex').copy(bytes, 8);
  const rootEntryOffset = (file.readUInt32LE(48) + 1) * 512;
  bytes.copy(file, rootEntryOffset + 80);
  return file;
}

function makePalmPdbHeader(name: string, typeCreator: string, numRecords: number): Buffer {
  const buf = Buffer.alloc(80, 0);
  buf.write(name.slice(0, 31), 0, 'ascii');
  buf[31] = 0;
  buf.write(typeCreator, 60, 'ascii');
  buf.writeUInt16BE(numRecords, 76);
  return buf;
}

function makeFormat12CmapBuffer(groups: Array<{ startCharCode: number; endCharCode: number; startGlyphId: number }>): Buffer {
  const subtableOffset = 12;
  const subtableLen = 16 + groups.length * 12;
  const buf = Buffer.alloc(subtableOffset + subtableLen, 0);
  buf.writeUInt16BE(0, 0);
  buf.writeUInt16BE(1, 2);
  buf.writeUInt16BE(3, 4);
  buf.writeUInt16BE(10, 6);
  buf.writeUInt32BE(subtableOffset, 8);
  buf.writeUInt16BE(12, subtableOffset);
  buf.writeUInt16BE(0, subtableOffset + 2);
  buf.writeUInt32BE(subtableLen, subtableOffset + 4);
  buf.writeUInt32BE(0, subtableOffset + 8);
  buf.writeUInt32BE(groups.length, subtableOffset + 12);
  for (let i = 0; i < groups.length; i++) {
    const off = subtableOffset + 16 + i * 12;
    buf.writeUInt32BE(groups[i].startCharCode >>> 0, off);
    buf.writeUInt32BE(groups[i].endCharCode >>> 0, off + 4);
    buf.writeUInt32BE(groups[i].startGlyphId >>> 0, off + 8);
  }
  return buf;
}

describe('Launch-blocking spoof and parser bounds (#761)', () => {
  describe('binary-only extensions and dedicated .lwp, .wpd, .lrf, .pdb signatures', () => {
    const binaryExtensions = [
      'pub',
      'wps',
      'dps',
      'et',
      'doc',
      'xls',
      'ppt',
      'png',
      'jpg',
      'tif',
      'dng',
      'cr2',
      'nef',
      'arw',
      '3fr',
      'dcr',
      'erf',
      'mos',
      'pef',
      'parquet',
      'woff',
      'woff2',
      'otf',
      'ttf',
      'zip',
      '7z',
      'gz',
      'bz2',
      'zst',
      'rar',
      'wav',
      'flac',
      'ogg',
      'mp3',
      'mkv',
      'webm',
      'pdf',
      'ai',
      'lwp',
      'wpd',
      'lrf',
      'pdb',
      'mobi',
      'azw',
      'azw3',
      'azw4',
      'prc',
    ];

    it.each(binaryExtensions)('rejects unsigned short and long ASCII/HTML payloads under .%s', (ext) => {
      expect(isFormatCompatibleWithMagicBytes(Buffer.from('hi'), ext)).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(Buffer.from('plain text payload >= 8 bytes'), ext)).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(Buffer.from('<html><body>hello</body></html>'), ext)).toBe(false);
      expect(() => assertNotSpoofedFile(Buffer.from('plain text payload >= 8 bytes'), ext)).toThrow(FileExtensionSpoofError);
    });

    it('accepts valid .lwp headers and refuses Lotus WordPro bytes under other extensions', () => {
      const lwpNull = Buffer.concat([Buffer.from('WordPro\0', 'ascii'), Buffer.alloc(16, 0)]);
      const lwpCr = Buffer.concat([Buffer.from('WordPro\r', 'ascii'), Buffer.alloc(16, 0)]);
      expect(isFormatCompatibleWithMagicBytes(lwpNull, 'lwp')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(lwpCr, 'lwp')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(lwpNull, 'txt')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(lwpNull, 'doc')).toBe(false);
    });

    it('accepts valid .wpd headers (\\xffWPC and CFBF WordPerfect 7+ root class ID) and refuses mismatched CFBF or extension', async () => {
      const wpcHeader = Buffer.from([0xff, 0x57, 0x50, 0x43, 0x10, 0x00, 0x00, 0x00, 0x01, 0x0a]);
      const wpdCfbf = writeCompoundRootClassId(
        buildCompoundFile([{ name: 'PerfectOffice_MAIN', data: Buffer.from('wpd-body') }]),
        '519873FF-2DAD-0220-1937-0000929679CD'
      );
      const docCfbf = buildCompoundFile([{ name: 'WordDocument', data: Buffer.from('doc-body') }]);
      expect(isFormatCompatibleWithMagicBytes(wpcHeader, 'wpd')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(wpdCfbf, 'wpd')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(docCfbf, 'wpd')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(wpcHeader, 'txt')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(wpdCfbf, 'doc')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(wpdCfbf, 'pub')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(wpdCfbf, 'vsd')).toBe(false);

      const largeWpd = placeDirectory(wpdCfbf, { directorySectors: [OBJECT_HEADER_BYTES / 512 + 10] });
      const largeDoc = placeDirectory(docCfbf, { directorySectors: [OBJECT_HEADER_BYTES / 512 + 10] });
      const storeOf = (bytes: Buffer) => ({
        openReadStream: async (_key: string, range?: { start: number; end: number }) =>
          Readable.from([bytes.subarray(range?.start ?? 0, (range?.end ?? bytes.length - 1) + 1)]),
      });
      await expect(
        assertCompoundFileKindInObject(storeOf(largeWpd), 'uploads/wpd', largeWpd.length, largeWpd.subarray(0, OBJECT_HEADER_BYTES), 'wpd')
      ).resolves.toBeUndefined();
      await expect(
        assertCompoundFileKindInObject(storeOf(largeDoc), 'uploads/doc-as-wpd', largeDoc.length, largeDoc.subarray(0, OBJECT_HEADER_BYTES), 'wpd')
      ).rejects.toBeInstanceOf(FileExtensionSpoofError);
    });

    it('accepts valid .lrf headers and refuses Sony BBeB bytes under other extensions', () => {
      const lrfHeader = Buffer.from([0x4c, 0x00, 0x52, 0x00, 0x46, 0x00, 0x00, 0x00, 0x12, 0x34]);
      expect(isFormatCompatibleWithMagicBytes(lrfHeader, 'lrf')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(lrfHeader, 'txt')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(lrfHeader, 'epub')).toBe(false);
    });

    it('accepts valid .pdb and .mobi/.azw/.azw3/.azw4/.prc headers and rejects mismatched creator signatures or offset-60 spoofs', () => {
      expect(isFormatCompatibleWithMagicBytes(makePalmPdbHeader('SampleBook', 'TEXtREAd', 2), 'pdb')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(makePalmPdbHeader('PluckerDoc', 'DataPlkr', 1), 'pdb')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(makePalmPdbHeader('TealDoc', 'TEXtTlDc', 1), 'pdb')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(makePalmPdbHeader('ZTxtBook', 'zTXTGPlm', 1), 'pdb')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(makePalmPdbHeader('MobiBook', 'BOOKMOBI', 2), 'pdb')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(makePalmPdbHeader('MobiBook', 'BOOKMOBI', 2), 'mobi')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(makePalmPdbHeader('MobiBook', 'BOOKMOBI', 2), 'azw')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(makePalmPdbHeader('MobiBook', 'BOOKMOBI', 2), 'azw3')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(makePalmPdbHeader('MobiBook', 'BOOKMOBI', 2), 'azw4')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(makePalmPdbHeader('MobiBook', 'BOOKMOBI', 2), 'prc')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(makePalmPdbHeader('SampleBook', 'TEXtREAd', 2), 'mobi')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(makePalmPdbHeader('PluckerDoc', 'DataPlkr', 1), 'mobi')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(makePalmPdbHeader('MobiBook', 'BOOKMOBI', 2), 'txt')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(makePalmPdbHeader('BEGMF chart', 'BOOKMOBI', 2), 'cgm')).toBe(false);
      const pdfWithMobiAt60 = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(51, 0x20), Buffer.from('BOOKMOBI'), Buffer.alloc(8, 0), Buffer.from([0, 1, 0, 0])]);
      expect(isFormatCompatibleWithMagicBytes(pdfWithMobiAt60, 'mobi')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(pdfWithMobiAt60, 'pdf')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(Buffer.from(`${'A'.repeat(60)}BOOKMOBI${'B'.repeat(10)}`), 'txt')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(makePalmPdbHeader('EmptyBook', 'TEXtREAd', 0), 'pdb')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(makePalmPdbHeader('UnknownApp', 'ABCD1234', 2), 'pdb')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(Buffer.alloc(40, 0x41), 'pdb')).toBe(false);
      const fullNamePdb = makePalmPdbHeader('Universal Declaration of Human R', 'TEXtTlDc', 4);
      fullNamePdb.write('Universal Declaration of Human R', 0, 'ascii');
      expect(isFormatCompatibleWithMagicBytes(fullNamePdb, 'pdb')).toBe(true);
    });

    it('accepts Zstandard skippable frames, bare BIFF streams, pre-OLE2 Word headers, and HWP 3.0 headers only for their families', () => {
      const zstdSkippable = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0x04, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04]);
      expect(isFormatCompatibleWithMagicBytes(zstdSkippable, 'zst')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(zstdSkippable, 'txt')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(zstdSkippable, 'zip')).toBe(false);

      const bareBiff = Buffer.from([0x09, 0x08, 0x10, 0x00, 0x00, 0x06, 0x05, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      expect(isFormatCompatibleWithMagicBytes(bareBiff, 'xls')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(bareBiff, 'xlt')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(bareBiff, 'txt')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(bareBiff, 'doc')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(bareBiff, 'ppt')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(bareBiff, 'hwp')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(bareBiff, 'msg')).toBe(false);

      const macWord5 = Buffer.from([0xfe, 0x37, 0x00, 0x23, 0, 0, 0, 0, 0, 0]);
      expect(isFormatCompatibleWithMagicBytes(macWord5, 'doc')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(macWord5, 'dot')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(macWord5, 'txt')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(macWord5, 'xls')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(macWord5, 'ppt')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(macWord5, 'hwp')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(macWord5, 'msg')).toBe(false);

      const hwp3 = Buffer.from('HWP Document File V3.00 \x1a\x01\x02\x03\x04\x05\x00\x00', 'latin1');
      expect(isFormatCompatibleWithMagicBytes(hwp3, 'hwp')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(hwp3, 'txt')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(hwp3, 'doc')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(hwp3, 'xls')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(hwp3, 'ppt')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(hwp3, 'msg')).toBe(false);

      expect(isFormatCompatibleWithMagicBytes(Buffer.from([0x9b, 0xa5, 0x82, 0xa0]), 'txt')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(Buffer.from('\t\r\na\tb\r\nc\td\r\n', 'utf16le'), 'tsv')).toBe(true);
    });

    it('isolates .pdf from font headers and restricts font magic bytes to font extensions', () => {
      const pdfHeader = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n', 'ascii');
      const woffHeader = Buffer.from([0x77, 0x4f, 0x46, 0x46, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
      const woff2Header = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
      const otfHeader = Buffer.from([0x4f, 0x54, 0x54, 0x4f, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
      const ttfHeader = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);

      expect(isFormatCompatibleWithMagicBytes(pdfHeader, 'pdf')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(woffHeader, 'pdf')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(woff2Header, 'pdf')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(otfHeader, 'pdf')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(ttfHeader, 'pdf')).toBe(false);

      expect(isFormatCompatibleWithMagicBytes(woffHeader, 'woff')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(woffHeader, 'woff2')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(woff2Header, 'woff2')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(woff2Header, 'woff')).toBe(false);
      expect(isFormatCompatibleWithMagicBytes(otfHeader, 'otf')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(ttfHeader, 'ttf')).toBe(true);
    });
  });

  describe('clear-text CGM input size cap', () => {
    it('rejects CGM strings and buffers larger than MAX_CGM_INPUT_CHARS with PayloadLimitError', async () => {
      const oversized = `BEGMF ${'A'.repeat(MAX_CGM_INPUT_CHARS)}`;
      expect(() => parseCgmToSvg(oversized)).toThrow(PayloadLimitError);
      await expect(convertVectorCad(Buffer.from(oversized, 'utf-8'), 'cgm', 'svg')).rejects.toThrow(PayloadLimitError);
    });
  });

  describe('CSS @ token validation in scanCss', () => {
    it('rejects comment-split, whitespace-split, or bare @ tokens in CSS', () => {
      expect(() => scanCss('@/**/import "file:///etc/passwd";', () => true)).toThrow(ConversionFailedError);
      expect(() => scanCss('@ import "https://example.com/a.css";', () => true)).toThrow(ConversionFailedError);
      expect(() => scanCss('body { color: #111; } @', () => true)).toThrow(ConversionFailedError);
    });

    it('accepts valid @media, @page, @supports, and @ inside strings or comments', () => {
      const result = scanCss('@media print { @page { margin: 1cm; } body::after { content: "@"; /* @ */ } }', () => true);
      expect(result.reference).toBeNull();
    });
  });

  describe('qpdf sandbox memory limit', () => {
    it('defines QPDF_MEMORY_LIMIT_MB = 512 and maps SandboxedMemoryLimitError to PdfPostprocessError', () => {
      expect(QPDF_MEMORY_LIMIT_MB).toBe(512);
      const mapped = toQpdfError(
        new SandboxedMemoryLimitError(512),
        { dir: '/tmp/qpdf', inputPath: '/tmp/qpdf/input.pdf' },
        'Linearizing the PDF'
      );
      expect(mapped).toBeInstanceOf(PdfPostprocessError);
      expect((mapped as Error).message).toBe('Linearizing the PDF failed: the document exceeds the 512 MB memory limit.');
    });
  });

  describe('HTML table covered-cell cap', () => {
    it('rejects HTML tables whose rowspan or colspan cells exceed HTML_MAX_TABLE_COVERED_CELLS', async () => {
      expect(HTML_MAX_TABLE_COVERED_CELLS).toBe(250_000);
      const rowSpanCells = '<td rowspan="1001">x</td>'.repeat(260);
      await expect(htmlToDocumentModel(`<!DOCTYPE html><html><body><table><tr>${rowSpanCells}</tr></table></body></html>`)).rejects.toThrow(
        PayloadLimitError
      );
      const colSpanCells = '<td colspan="1000">x</td>'.repeat(260);
      await expect(htmlToDocumentModel(`<!DOCTYPE html><html><body><table><tr>${colSpanCells}</tr></table></body></html>`)).rejects.toThrow(
        PayloadLimitError
      );
    });

    it('accepts normal HTML tables with modest rowspan attributes', async () => {
      const html = '<!DOCTYPE html><html><body><table><tr><td rowspan="2">A</td><td>B</td></tr><tr><td>C</td></tr></table></body></html>';
      const model = await htmlToDocumentModel(html);
      expect(model.sections[0].blocks.length).toBe(1);
    });
  });

  describe('OpenType cmap Format 12 range and codepoint bounds', () => {
    it('rejects inverted ranges, codepoints above U+10FFFF, glyph IDs above 0xFFFF, and total codepoints above MAX_CMAP_FORMAT12_CODEPOINTS', () => {
      expect(MAX_CMAP_FORMAT12_CODEPOINTS).toBe(262_144);
      expect(() =>
        parseCmapTable(makeFormat12CmapBuffer([{ startCharCode: 100, endCharCode: 50, startGlyphId: 1 }]))
      ).toThrow(CorruptStreamError);
      expect(() =>
        parseCmapTable(makeFormat12CmapBuffer([{ startCharCode: 0x10fffe, endCharCode: 0x110000, startGlyphId: 1 }]))
      ).toThrow(CorruptStreamError);
      expect(() =>
        parseCmapTable(makeFormat12CmapBuffer([{ startCharCode: 0x20, endCharCode: 0x30, startGlyphId: 0xfff5 }]))
      ).toThrow(CorruptStreamError);
      expect(() =>
        parseCmapTable(
          makeFormat12CmapBuffer([
            { startCharCode: 0x20, endCharCode: 0x30, startGlyphId: 1 },
            { startCharCode: 0x30, endCharCode: 0x40, startGlyphId: 18 },
          ])
        )
      ).toThrow(CorruptStreamError);
      expect(() =>
        parseCmapTable(
          makeFormat12CmapBuffer([
            { startCharCode: 0x0000, endCharCode: 0x0ffff, startGlyphId: 1 },
            { startCharCode: 0x10000, endCharCode: 0x1ffff, startGlyphId: 1 },
            { startCharCode: 0x20000, endCharCode: 0x2ffff, startGlyphId: 1 },
            { startCharCode: 0x30000, endCharCode: 0x3ffff, startGlyphId: 1 },
            { startCharCode: 0x40000, endCharCode: 0x40000, startGlyphId: 1 },
          ])
        )
      ).toThrow(CorruptStreamError);
    });
  });

  describe('openPackage error messages on malformed ZIP containers', () => {
    it('preserves typed error messages in parseHwpxDocument and assertOpenDocumentGraphic', async () => {
      await expect(parseHwpxDocument(Buffer.alloc(32, 0x41))).rejects.toThrow(
        new CorruptStreamError('Invalid HWPX package: Not a valid ZIP archive (The HWPX file is not a valid ZIP package.).')
      );
      await expect(assertOpenDocumentGraphic(Buffer.alloc(32, 0x41), 'odg')).rejects.toThrow(
        new ConversionFailedError('The ODG file is not a valid OpenDocument package.')
      );
    });
  });
});
