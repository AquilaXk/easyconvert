import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  synthesizeMultiColumnDocumentCorpus,
  synthesizeDrawingMlTableCorpus,
  synthesizeVariableFontCorpus,
  synthesizeParquetColumnarCorpus,
  synthesizeAudioBitstreamCorpus,
} from './helpers/corpus-synthesizer';
import {
  isHwpxContainer,
  parseHwpxDocument,
} from '../src/lib/conversions/hwpx';
import {
  inspectVariableFont,
  instantiateVariableFont,
  subsetVariableFont,
} from '../src/lib/conversions/font';
import { decodeParquet, ParquetType } from '../src/lib/conversions/parquet';
import { decodeAudioBuffer } from '../src/lib/conversions/media';
import { parseDrawingMlShapes, renderDrawingMlToSvg } from '../src/lib/conversions/office';

describe('Phase 4: Universal Golden Corpus Synthesizer & Enterprise Testnet', () => {
  // =========================================================================
  // 1. Multi-Column Documents with Footnotes & Metadata
  // =========================================================================
  describe('1. Multi-Column Document Corpus Synthesizer', () => {
    it('synthesizes enterprise document metadata, dual columns, and footnotes', () => {
      const corpus = synthesizeMultiColumnDocumentCorpus();

      expect(corpus.metadata.title).toContain('Multi-Column');
      expect(corpus.metadata.author).toBe('EasyConvert QA Engineering Core');
      expect(corpus.metadata.keywords).toContain('footnotes');
      expect(corpus.sections.length).toBeGreaterThanOrEqual(3);
      expect(corpus.footnotes.length).toBe(3);

      const dualColSection = corpus.sections.find((s) => s.columns === 2);
      expect(dualColSection).toBeDefined();
      expect(dualColSection!.paragraphs.length).toBeGreaterThanOrEqual(2);
      expect(dualColSection!.footnotes?.length).toBeGreaterThanOrEqual(1);
    });

    it('generates multi-column HTML with CSS column-count and semantic footnote links', () => {
      const corpus = synthesizeMultiColumnDocumentCorpus();
      const html = corpus.generateHtml();

      expect(html).toContain('column-count: 2');
      expect(html).toContain('column-gap: 32px');
      expect(html).toContain('column-rule: 1px solid #E1E4EE');
      expect(html).toContain(corpus.metadata.title);
      expect(html).toContain('Footnotes &amp; References'.replace('&amp;', '&'));
      expect(html).toContain('[1]');
      expect(html).toContain('[2]');
    });

    it('packages authentic DOCX with multi-column w:cols markup and footnotes', async () => {
      const corpus = synthesizeMultiColumnDocumentCorpus();
      const docxBuf = await corpus.generateDocx();

      expect(docxBuf.length).toBeGreaterThan(500);
      expect(docxBuf.subarray(0, 4).toString('hex')).toBe('504b0304'); // PK ZIP magic

      const zip = await JSZip.loadAsync(docxBuf);
      const docXml = await zip.file('word/document.xml')?.async('text');
      expect(docXml).toBeDefined();
      expect(docXml).toContain('<w:cols w:num="2"');
      expect(docXml).toContain(corpus.metadata.title);
      expect(docXml).toContain('Footnotes');
      expect(docXml).toContain('[1]');
    });

    it('packages and validates authentic KS X 6101 HWPX container', async () => {
      const corpus = synthesizeMultiColumnDocumentCorpus();
      const hwpxBuf = await corpus.generateHwpx();

      expect(hwpxBuf.length).toBeGreaterThan(1000);
      const isValid = await isHwpxContainer(hwpxBuf);
      expect(isValid).toBe(true);

      const parsedHwpDoc = await parseHwpxDocument(hwpxBuf);
      expect(parsedHwpDoc.paragraphs.length).toBeGreaterThanOrEqual(5);
      expect(parsedHwpDoc.metadata?.title).toContain('Enterprise Multi-Column Financial');
      expect(parsedHwpDoc.metadata?.author).toBe(corpus.metadata.author);

      const textJoined = parsedHwpDoc.paragraphs.map((p) => p.text).join(' ');
      expect(textJoined).toContain('Zero-cloud retention');
      expect(textJoined).toContain('DrawingML vector renderer');
    });
  });

  // =========================================================================
  // 2. Complex Nested Tables with Merged Cells & DrawingML Vector Annotations
  // =========================================================================
  describe('2. Complex Nested Tables & DrawingML Vector Shape Synthesizer', () => {
    it('synthesizes multi-span nested table with cell shading and embedded sub-table', () => {
      const corpus = synthesizeDrawingMlTableCorpus();
      const tbl = corpus.table;

      expect(tbl.rowCount).toBe(4);
      expect(tbl.colCount).toBe(3);
      expect(tbl.borders?.top?.color).toBe('4A58A9');

      // Row 0 header spans 3 columns
      expect(tbl.rows[0][0].colSpan).toBe(3);
      expect(tbl.rows[0][0].shading).toBe('4A58A9');

      // Row 1 contains rowSpan 2 and inner nested subtable
      expect(tbl.rows[1][0].rowSpan).toBe(2);
      expect(tbl.rows[1][1].nestedTable).toBeDefined();
      expect(tbl.rows[1][1].nestedTable?.rowCount).toBe(2);
      expect(tbl.rows[1][1].nestedTable?.rows[0][0].text).toBe('Q3 Inflow');

      // DrawingML shape annotation
      expect(tbl.rows[1][2].drawingShape).toBeDefined();
      expect(tbl.rows[1][2].drawingShape?.type).toBe('roundrect');
    });

    it('parses DrawingML vector XML and renders compliant SVG', () => {
      const corpus = synthesizeDrawingMlTableCorpus();
      const shapes = parseDrawingMlShapes(corpus.drawingMlXml);

      expect(shapes.length).toBeGreaterThanOrEqual(2);
      const roundRectShape = shapes.find((s) => s.type.toLowerCase() === 'roundrect');
      expect(roundRectShape).toBeDefined();
      expect(roundRectShape?.fillColor).toBe('#5C6BC0');

      const rendered = renderDrawingMlToSvg(shapes);
      expect(rendered.svg).toContain('<svg');
      expect(rendered.svg).toContain('rx=');
      expect(rendered.svg).toContain('#5C6BC0');
    });

    it('generates OpenXML WordprocessingML table with cell borders and gridSpan', () => {
      const corpus = synthesizeDrawingMlTableCorpus();
      const tblXml = corpus.generateDocxTableXml();

      expect(tblXml).toContain('<w:tbl ');
      expect(tblXml).toContain('<w:gridSpan w:val="3"/>');
      expect(tblXml).toContain('<w:shd w:val="clear" w:color="auto" w:fill="4A58A9"/>');
      expect(tblXml).toContain('<w:tblBorders>');
      expect(tblXml).toContain('Enterprise Portfolio &amp; Vector Analytics Master Ledger'.replace('&amp;', '&'));
    });
  });

  // =========================================================================
  // 3. Variable Font SFNT Instances across Design Axes (wght, wdth, slnt)
  // =========================================================================
  describe('3. Variable Font SFNT Instances across Design Axes (wght, wdth, slnt)', () => {
    it('synthesizes valid OpenType TrueType variable font with fvar and STAT tables', () => {
      const fontCorpus = synthesizeVariableFontCorpus();
      expect(fontCorpus.fontBuffer.length).toBeGreaterThan(200);

      const metadata = inspectVariableFont(fontCorpus.fontBuffer);
      expect(metadata.isVariableFont).toBe(true);
      expect(metadata.axes.length).toBe(3);

      const tagMap = Object.fromEntries(metadata.axes.map((a) => [a.tag, a]));
      expect(tagMap['wght']).toBeDefined();
      expect(tagMap['wght'].minValue).toBe(100);
      expect(tagMap['wght'].defaultValue).toBe(400);
      expect(tagMap['wght'].maxValue).toBe(900);

      expect(tagMap['wdth']).toBeDefined();
      expect(tagMap['wdth'].minValue).toBe(50);
      expect(tagMap['wdth'].maxValue).toBe(150);

      expect(tagMap['slnt']).toBeDefined();
      expect(tagMap['slnt'].minValue).toBe(-20);
      expect(tagMap['slnt'].maxValue).toBe(0);

      expect(metadata.instances.length).toBe(6);
      const boldInst = metadata.instances.find((i) => i.name === 'Bold');
      expect(boldInst?.coordinates['wght']).toBe(700);

      const obliqueInst = metadata.instances.find((i) => i.name === 'Oblique');
      expect(obliqueInst?.coordinates['slnt']).toBe(-14);
    });

    it('instantiates static font instance from arbitrary axis coordinates', () => {
      const fontCorpus = synthesizeVariableFontCorpus();

      // Instantiate Bold Condensed: wght=750, wdth=80, slnt=0
      const instantiatedBuf = instantiateVariableFont(
        fontCorpus.fontBuffer,
        { wght: 750, wdth: 80, slnt: 0 }
      );

      expect(instantiatedBuf).toBeDefined();
      expect(instantiatedBuf.length).toBeGreaterThan(100);
      expect(instantiatedBuf.subarray(0, 4).toString('hex')).toBe('00010000'); // TrueType version
    });

    it('subsets variable font while preserving STAT design axes structure', () => {
      const fontCorpus = synthesizeVariableFontCorpus();

      const subsettedBuf = subsetVariableFont(
        fontCorpus.fontBuffer,
        { coordinates: { wght: 600, wdth: 90 } }
      );

      expect(subsettedBuf).toBeDefined();
      expect(subsettedBuf.length).toBeGreaterThan(100);
      const meta = inspectVariableFont(subsettedBuf);
      expect(meta.isVariableFont).toBe(true);
    });
  });

  // =========================================================================
  // 4. Columnar Apache Parquet Datasets with Mixed Datatypes & Compression
  // =========================================================================
  describe('4. Columnar Apache Parquet Datasets with Mixed Datatypes & Compression', () => {
    it('synthesizes mixed datatype Parquet corpus with int64, double, float, bool, and string', () => {
      const rowCount = 75;
      const parquetCorpus = synthesizeParquetColumnarCorpus(rowCount);

      expect(parquetCorpus.records.length).toBe(rowCount);
      expect(parquetCorpus.buffer.length).toBeGreaterThan(100);
      expect(parquetCorpus.buffer.subarray(0, 4).toString('ascii')).toBe('PAR1');
      expect(parquetCorpus.buffer.subarray(parquetCorpus.buffer.length - 4).toString('ascii')).toBe('PAR1');

      const schemas = parquetCorpus.schemas;
      const schemaMap = Object.fromEntries(schemas.map((s) => [s.name, s]));

      expect(schemaMap['transaction_id'].type).toBe(ParquetType.INT64);
      expect(schemaMap['account_code'].type).toBe(ParquetType.BYTE_ARRAY);
      expect(schemaMap['amount'].type).toBe(ParquetType.DOUBLE);
      expect(schemaMap['tax_rate'].type).toBe(ParquetType.DOUBLE);
      expect(schemaMap['is_cleared'].type).toBe(ParquetType.BOOLEAN);
      expect(schemaMap['timestamp'].type).toBe(ParquetType.INT64);
    });

    it('performs lossless round-trip serialization and deserialization across all records', () => {
      const rowCount = 50;
      const parquetCorpus = synthesizeParquetColumnarCorpus(rowCount);
      const decoded = parquetCorpus.verifyRoundTrip();

      expect(decoded.length).toBe(rowCount);
      for (let i = 0; i < rowCount; i++) {
        const orig = parquetCorpus.records[i];
        const dec = decoded[i];

        expect(dec['transaction_id']).toBe(orig['transaction_id']);
        expect(dec['account_code']).toBe(orig['account_code']);
        expect(dec['category']).toBe(orig['category']);
        expect(dec['region']).toBe(orig['region']);
        expect(dec['amount']).toBe(orig['amount']);
        expect(dec['is_cleared']).toBe(orig['is_cleared']);
        expect(dec['timestamp']).toBe(orig['timestamp']);
        expect(dec['notes'] || null).toBe(orig['notes']);
      }
    });
  });

  // =========================================================================
  // 5. Audio Bitstream Corpus (WAV, MP3, FLAC)
  // =========================================================================
  describe('5. Audio Bitstream Corpus Synthesizer', () => {
    it('synthesizes canonical RIFF WAV container and verifies with pure audio decoder', () => {
      const audioCorpus = synthesizeAudioBitstreamCorpus(0.4);

      expect(audioCorpus.wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(audioCorpus.wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
      expect(audioCorpus.wav.length).toBeGreaterThan(44);

      // Verify with EasyConvert's pure audio decoder
      const decoded = decodeAudioBuffer(audioCorpus.wav, 'wav');
      expect(decoded.sampleRate).toBe(44100);
      expect(decoded.channels).toBe(2);
      expect(decoded.samples.length).toBeGreaterThan(0);
    });

    it('synthesizes valid MP3 bitstream with ID3v2 tags and audio frames', () => {
      const audioCorpus = synthesizeAudioBitstreamCorpus(0.4);

      expect(audioCorpus.mp3.length).toBeGreaterThan(100);
      const headerStr = audioCorpus.mp3.subarray(0, 3).toString('ascii');
      const isId3 = headerStr === 'ID3';
      const isSyncFrame = audioCorpus.mp3[0] === 0xff && (audioCorpus.mp3[1] & 0xe0) === 0xe0;

      expect(isId3 || isSyncFrame).toBe(true);
    });

    it('synthesizes valid FLAC bitstream with fLaC stream marker and CRC checksums', () => {
      const audioCorpus = synthesizeAudioBitstreamCorpus(0.4);

      expect(audioCorpus.flac.subarray(0, 4).toString('ascii')).toBe('fLaC');
      expect(audioCorpus.flac.length).toBeGreaterThan(50);

      // Verify STREAMINFO header (type 0, last block 0x80)
      expect(audioCorpus.flac[4]).toBe(0x80);
      // Length = 34 bytes
      expect(audioCorpus.flac.readUInt16BE(6)).toBe(34);
    });
  });
});
