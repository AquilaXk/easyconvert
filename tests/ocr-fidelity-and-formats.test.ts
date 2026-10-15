import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import {
  performOcr,
  exportHocr,
  exportAlto,
  parseHocr,
  parseAlto,
  inspectPdfPagesTextDensity,
  performSmartMultiPagePdfOcr,
  convertFile,
} from '../src/lib/conversions/index';
import { OcrResult, OcrLineBlock } from '../src/lib/conversions/ocr-pdf-combiner';
import { OcrLanguageUnavailableError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { extractPdfTextLayerPages } from '../src/lib/conversions/pdf-text-geometry';
import { hocrWords, matchedIou, ocrWords, popplerWords } from './helpers/poppler-words';
import { validateAlto44, xmlWellFormed, xpathAttributes } from './helpers/xml-oracle';

describe('OCR Fidelity, Exports (hOCR 1.2, ALTO 4.x), Smart Multi-Page, and Vertical Models', () => {
  // -------------------------------------------------------------
  // 1. hOCR 1.2 Export Structure & Bounding Box Fidelity
  // -------------------------------------------------------------
  describe('hOCR 1.2 XHTML Export', () => {
    const mockLineBlocks: OcrLineBlock[] = [
      {
        text: 'EASYCONVERT OCR 2026',
        bbox: { x: 50, y: 100, width: 300, height: 25 },
        words: [
          { text: 'EASYCONVERT', bbox: { x: 50, y: 100, width: 140, height: 25 }, confidence: 0.95 },
          { text: 'OCR', bbox: { x: 200, y: 100, width: 45, height: 25 }, confidence: 0.92 },
          { text: '2026', bbox: { x: 255, y: 100, width: 95, height: 25 }, confidence: 0.98 },
        ],
      },
      {
        text: 'High-Fidelity Document Processing & Analysis',
        bbox: { x: 50, y: 140, width: 420, height: 20 },
        words: [
          { text: 'High-Fidelity', bbox: { x: 50, y: 140, width: 95, height: 20 }, confidence: 0.89 },
          { text: 'Document', bbox: { x: 155, y: 140, width: 80, height: 20 }, confidence: 0.93 },
          { text: 'Processing', bbox: { x: 245, y: 140, width: 85, height: 20 }, confidence: 0.91 },
          { text: '&', bbox: { x: 338, y: 140, width: 12, height: 20 }, confidence: 0.99 },
          { text: 'Analysis', bbox: { x: 358, y: 140, width: 65, height: 20 }, confidence: 0.94 },
        ],
      },
    ];

    const sampleOcrResult: OcrResult = {
      text: 'EASYCONVERT OCR 2026\nHigh-Fidelity Document Processing & Analysis',
      confidence: 0.94,
      wordCount: 8,
      lines: ['EASYCONVERT OCR 2026', 'High-Fidelity Document Processing & Analysis'],
      lineBlocks: mockLineBlocks,
      imageWidth: 600,
      imageHeight: 800,
    };

    it('generates valid hOCR 1.2 compliant XHTML markup with standard OCR classes', () => {
      const hocr = exportHocr(sampleOcrResult, {
        documentTitle: 'Invoice Verification',
        filename: 'invoice.png',
      });

      // Valid XHTML / hOCR standard root elements
      expect(hocr).toContain('<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"');
      expect(hocr).toContain('<html xmlns="http://www.w3.org/1999/xhtml"');
      expect(hocr).toContain('<title>Invoice Verification</title>');
      expect(hocr).toContain('<meta name="ocr-system" content="easyconvert-ocr" />');
      expect(hocr).toContain(
        '<meta name="ocr-capabilities" content="ocr_page ocr_carea ocr_par ocr_line ocrx_word ocrp_wconf" />'
      );

      // Hierarchical OCR structure
      expect(hocr).toContain('class="ocr_page"');
      expect(hocr).toContain('id="page_1"');
      // hOCR counts physical pages from zero, and the image name is a double-quoted string.
      expect(hocr).toContain('title="image &quot;invoice.png&quot;; bbox 0 0 600 800; ppageno 0"');

      expect(hocr).toContain('class="ocr_carea"');
      expect(hocr).toContain('id="block_1_1"');

      expect(hocr).toContain('class="ocr_par"');
      expect(hocr).toContain('id="par_1_1"');

      expect(hocr).toContain('class="ocr_line"');
      expect(hocr).toContain('id="line_1_1"');

      expect(hocr).toContain('class="ocrx_word"');
      expect(hocr).toContain('id="word_1_1_1"');
      expect(hocr).toContain('title="bbox 50 100 190 125; x_wconf 95">EASYCONVERT</span>');
      expect(hocr).toContain('title="bbox 200 100 245 125; x_wconf 92">OCR</span>');
      expect(hocr).toContain('title="bbox 255 100 350 125; x_wconf 98">2026</span>');

      // Escapes XML special characters like '&'
      expect(hocr).toContain('&amp;');

      // Substantive structural counts
      expect(hocr.match(/<span class="ocrx_word"/g)?.length).toBe(8);
      expect(hocr.match(/<div class="ocr_carea"/g)?.length).toBe(2);
      expect(hocr.length).toBeGreaterThan(500);
    });

    it('converts bitmap image to .hocr file via convertFile registry dispatch', async () => {
      // Create a test raster image
      const imageBuffer = await sharp({
        create: {
          width: 300,
          height: 100,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .composite([
          {
            input: Buffer.from(
              `<svg width="300" height="100">
                <text x="20" y="50" font-family="monospace" font-size="24" fill="black">EXPORT HOCR</text>
              </svg>`
            ),
            top: 0,
            left: 0,
          },
        ])
        .png()
        .toBuffer();

      const result = await convertFile(imageBuffer, 'png', 'hocr', {}, 'test-export.png');
      expect(result.mimeType).toBe('application/xhtml+xml');
      expect(result.filename).toBe('test-export.hocr');
      expect(result.size).toBeGreaterThan(0);

      const hocrContent = result.buffer.toString('utf-8');
      expect(hocrContent).toContain('class="ocr_page"');
      expect(hocrContent).toContain('class="ocrx_word"');
      expect(hocrContent).toContain('x_wconf');
    });
  });

  // -------------------------------------------------------------
  // 2. ALTO 4.x XML Export Structure & Schema Tags
  // -------------------------------------------------------------
  describe('ALTO 4.x XML Export', () => {
    const mockLineBlocks: OcrLineBlock[] = [
      {
        text: 'DIGITAL PRESERVATION STANDARD',
        bbox: { x: 40, y: 80, width: 350, height: 22 },
        words: [
          { text: 'DIGITAL', bbox: { x: 40, y: 80, width: 90, height: 22 }, confidence: 0.96 },
          { text: 'PRESERVATION', bbox: { x: 140, y: 80, width: 140, height: 22 }, confidence: 0.93 },
          { text: 'STANDARD', bbox: { x: 290, y: 80, width: 100, height: 22 }, confidence: 0.95 },
        ],
      },
    ];

    const sampleOcrResult: OcrResult = {
      text: 'DIGITAL PRESERVATION STANDARD',
      confidence: 0.95,
      wordCount: 3,
      lines: ['DIGITAL PRESERVATION STANDARD'],
      lineBlocks: mockLineBlocks,
      imageWidth: 612,
      imageHeight: 792,
    };

    it('generates authentic Library of Congress ALTO 4.x schema XML elements and attributes', () => {
      const altoXml = exportAlto(sampleOcrResult, { filename: 'preservation_sample.pdf' });

      // XML declaration & root namespace
      expect(altoXml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(altoXml).toContain('<alto xmlns="http://www.loc.gov/standards/alto/ns-v4#"');
      expect(altoXml).toContain('xsi:schemaLocation="http://www.loc.gov/standards/alto/ns-v4# http://www.loc.gov/standards/alto/v4/alto-4-4.xsd"');

      // Description metadata
      expect(altoXml).toContain('<Description>');
      expect(altoXml).toContain('<MeasurementUnit>pixel</MeasurementUnit>');
      expect(altoXml).toContain('<fileName>preservation_sample.pdf</fileName>');
      expect(altoXml).toContain('<softwareName>EasyConvert OCR</softwareName>');

      // Layout hierarchy
      expect(altoXml).toContain('<Layout>');
      expect(altoXml).toContain('<Page ID="PAGE_1" PHYSICAL_IMG_NR="1" WIDTH="612" HEIGHT="792">');
      expect(altoXml).toContain('<PrintSpace HPOS="0" VPOS="0" WIDTH="612" HEIGHT="792">');
      expect(altoXml).toContain('<TextBlock ID="TB_1_1" HPOS="40" VPOS="80" WIDTH="350" HEIGHT="22">');
      expect(altoXml).toContain('<TextLine ID="TL_1_1" HPOS="40" VPOS="80" WIDTH="350" HEIGHT="22">');

      // String elements with HPOS, VPOS, WIDTH, HEIGHT, WC
      expect(altoXml).toContain('<String CONTENT="DIGITAL" HPOS="40" VPOS="80" WIDTH="90" HEIGHT="22" WC="0.96" />');
      expect(altoXml).toContain('<String CONTENT="PRESERVATION" HPOS="140" VPOS="80" WIDTH="140" HEIGHT="22" WC="0.93" />');
      expect(altoXml).toContain('<String CONTENT="STANDARD" HPOS="290" VPOS="80" WIDTH="100" HEIGHT="22" WC="0.95" />');

      // Inter-word spacing delimiter <SP>
      expect(altoXml).toContain('<SP HPOS="130" VPOS="80" WIDTH="10" />');
      expect(altoXml).toContain('<SP HPOS="280" VPOS="80" WIDTH="10" />');

      // Substantive tag and length checks
      expect(altoXml.match(/<String CONTENT=/g)?.length).toBe(3);
      expect(altoXml.match(/<SP HPOS=/g)?.length).toBe(2);
      expect(altoXml.length).toBeGreaterThan(500);
    });

    it('converts bitmap image to .xml ALTO file via convertFile registry dispatch', async () => {
      const imageBuffer = await sharp({
        create: {
          width: 300,
          height: 100,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .composite([
          {
            input: Buffer.from(
              `<svg width="300" height="100">
                <text x="20" y="50" font-family="monospace" font-size="24" fill="black">EXPORT ALTO</text>
              </svg>`
            ),
            top: 0,
            left: 0,
          },
        ])
        .png()
        .toBuffer();

      const result = await convertFile(imageBuffer, 'png', 'alto', {}, 'test-export.png');
      expect(result.mimeType).toBe('application/xml');
      expect(result.filename).toBe('test-export.xml');
      expect(result.size).toBeGreaterThan(0);

      const xmlContent = result.buffer.toString('utf-8');
      expect(xmlContent).toContain('<alto xmlns="http://www.loc.gov/standards/alto/ns-v4#"');
      expect(xmlContent).toContain('<String CONTENT=');
      expect(xmlContent).toContain('WC=');
    });
  });

  // -------------------------------------------------------------
  // 3. Smart Multi-Page OCR with Page Skipping
  // -------------------------------------------------------------
  describe('Smart Multi-Page OCR with Page Skipping', () => {
    async function createTestMultiPagePdf(): Promise<Buffer> {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);

      // Page 1: Digital page with authentic extractable vector text layer
      const page1 = doc.addPage([600, 400]);
      page1.drawText('This is native digital vector text on page 1 of the test document.', {
        x: 50,
        y: 350,
        size: 16,
        font,
        color: rgb(0, 0, 0),
      });

      // Page 2: Scanned bitmap page with NO digital text layer
      const page2 = doc.addPage([600, 400]);
      const scannedBitmap = await sharp({
        create: {
          width: 500,
          height: 200,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .composite([
          {
            input: Buffer.from(
              `<svg width="500" height="200">
                <text x="20" y="70" font-family="monospace" font-size="30" fill="black">SCANNED RECEIPT 2026</text>
              </svg>`
            ),
            top: 0,
            left: 0,
          },
        ])
        .png()
        .toBuffer();

      const embeddedImg = await doc.embedPng(scannedBitmap);
      page2.drawImage(embeddedImg, {
        x: 50,
        y: 100,
        width: 500,
        height: 200,
      });

      const pdfBytes = await doc.save();
      return Buffer.from(pdfBytes);
    }

    it('correctly inspects text layer density per page', async () => {
      const pdfBuffer = await createTestMultiPagePdf();
      const analyses = await inspectPdfPagesTextDensity(pdfBuffer, 15);

      expect(analyses.length).toBe(2);

      // Page 1 has native digital text
      expect(analyses[0].pageNumber).toBe(1);
      expect(analyses[0].hasTextLayer).toBe(true);
      expect(analyses[0].charCount).toBeGreaterThan(30);
      expect(analyses[0].text).toContain('native digital vector text');

      // Page 2 is a scanned image with 0 text layer
      expect(analyses[1].pageNumber).toBe(2);
      expect(analyses[1].hasTextLayer).toBe(false);
      expect(analyses[1].charCount).toBe(0);
    });

    it('skips pages with existing text and OCRs only scanned pages in skip_text mode', async () => {
      const pdfBuffer = await createTestMultiPagePdf();
      const smartResult = await performSmartMultiPagePdfOcr(pdfBuffer, {
        ocrMode: 'skip_text',
        ocrLanguage: 'eng',
      });

      // Page 1 was skipped because it already has text
      const p1Decision = smartResult.pageDecisions.find((d) => d.pageNumber === 1);
      expect(p1Decision?.skipped).toBe(true);
      expect(p1Decision?.reason).toBe('has_text');
      expect(smartResult.ocrResults.has(1)).toBe(false);

      // Page 2 was OCR-scanned because it had no text layer
      const p2Decision = smartResult.pageDecisions.find((d) => d.pageNumber === 2);
      expect(p2Decision?.skipped).toBe(false);
      expect(p2Decision?.reason).toBe('no_text');
      expect(smartResult.ocrResults.has(2)).toBe(true);

      const p2Ocr = smartResult.ocrResults.get(2);
      expect(p2Ocr).toBeDefined();
      expect(p2Ocr?.text).toContain('SCANNED');

      // Output buffer is valid PDF
      expect(smartResult.buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
    });

    it('forces OCR on all pages unconditionally when ocrMode is force or redo', async () => {
      const pdfBuffer = await createTestMultiPagePdf();
      const forceResult = await performSmartMultiPagePdfOcr(pdfBuffer, {
        ocrMode: 'force',
        ocrLanguage: 'eng',
      });

      const p1Decision = forceResult.pageDecisions.find((d) => d.pageNumber === 1);
      expect(p1Decision?.skipped).toBe(false);
      expect(p1Decision?.reason).toBe('forced');

      const p2Decision = forceResult.pageDecisions.find((d) => d.pageNumber === 2);
      expect(p2Decision?.skipped).toBe(false);
      expect(p2Decision?.reason).toBe('forced');
    });

    it('converts multi-page PDF with mixed text/scanned pages to searchable PDF preserving vectors', async () => {
      const pdfBuffer = await createTestMultiPagePdf();
      const result = await convertFile(pdfBuffer, 'pdf', 'pdf', {
        ocrEnabled: true,
        ocrMode: 'skip_text',
      }, 'contract.pdf');

      expect(result.mimeType).toBe('application/pdf');
      expect(result.filename).toBe('contract.pdf');
      expect(result.size).toBeGreaterThan(0);
      expect(result.buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
    });

    oracleTest(
      'exports a digital page plus a scanned page to multi-page hOCR and ALTO, with word boxes from the PDF text layer',
      ['pdftotext', 'xmllint', 'tesseract'],
      async () => {
        const pdfBuffer = await createTestMultiPagePdf();

        const hocrResult = await convertFile(pdfBuffer, 'pdf', 'hocr', { ocrEnabled: true, ocrMode: 'skip_text' }, 'contract.pdf');
        expect(hocrResult.mimeType).toBe('application/xhtml+xml');
        expect(hocrResult.filename).toBe('contract.hocr');
        const hocr = hocrResult.buffer.toString('utf-8');
        expect(xmlWellFormed(hocr).stderr).toBe('');
        expect(xpathAttributes(hocr, "//*[@class='ocr_page']/@id")).toEqual(['page_1', 'page_2']);

        // Page 1 is the digital page: its words must sit where the reference extractor puts them.
        const reference = popplerWords(pdfBuffer).filter((w) => w.page === 1);
        const mine = hocrWords(hocr);
        const digital = mine.filter((w) => w.page === 1);
        expect(digital).toHaveLength(reference.length);
        // The hOCR boxes are rounded to whole pixels, which costs a two-letter word up to about 17%.
        matchedIou(reference, digital).forEach((iou, index) => {
          expect(iou, `word '${reference[index].text}'`).toBeGreaterThanOrEqual(0.8);
        });
        const exactDigital = ocrWords(await extractPdfTextLayerPages(pdfBuffer, new Set([1])));
        matchedIou(reference, exactDigital).forEach((iou, index) => {
          expect(iou, `exact word '${reference[index].text}'`).toBeGreaterThanOrEqual(0.9);
        });
        // Page 2 is the scanned page, read by OCR.
        expect(mine.filter((w) => w.page === 2).map((w) => w.text.toUpperCase())).toContain('SCANNED');

        const altoResult = await convertFile(pdfBuffer, 'pdf', 'alto', { ocrEnabled: true, ocrMode: 'skip_text' }, 'contract.pdf');
        expect(altoResult.mimeType).toBe('application/xml');
        expect(altoResult.filename).toBe('contract.xml');
        const alto = altoResult.buffer.toString('utf-8');
        expect(validateAlto44(alto).stderr.trim()).toBe('- validates');
        expect(xpathAttributes(alto, "//*[local-name()='Page']/@ID")).toEqual(['PAGE_1', 'PAGE_2']);
      },
      120_000
    );
  });

  // -------------------------------------------------------------
  // 4. Vertical Language Model Support & Fail-Closed
  // -------------------------------------------------------------
  describe('Vertical Language Models & Fail-Closed Handling', () => {
    const dummyImage = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );

    it('supports vertical language model identifiers jpn_vert, chi_sim_vert, chi_tra_vert and fails closed when traineddata is unavailable', async () => {
      // jpn_vert
      await expect(
        performOcr(dummyImage, 'jpn_vert')
      ).rejects.toThrow(OcrLanguageUnavailableError);

      try {
        await performOcr(dummyImage, 'jpn_vert');
      } catch (err: any) {
        expect(err).toBeInstanceOf(OcrLanguageUnavailableError);
        expect(err.name).toBe('OcrLanguageUnavailableError');
        expect(err.message).toContain('jpn_vert.traineddata');
      }

      // chi_sim_vert
      await expect(
        performOcr(dummyImage, 'chi_sim_vert')
      ).rejects.toThrow(OcrLanguageUnavailableError);

      try {
        await performOcr(dummyImage, 'chi_sim_vert');
      } catch (err: any) {
        expect(err).toBeInstanceOf(OcrLanguageUnavailableError);
        expect(err.message).toContain('chi_sim_vert.traineddata');
      }

      // chi_tra_vert
      await expect(
        performOcr(dummyImage, 'chi_tra_vert')
      ).rejects.toThrow(OcrLanguageUnavailableError);

      try {
        await performOcr(dummyImage, 'chi_tra_vert');
      } catch (err: any) {
        expect(err).toBeInstanceOf(OcrLanguageUnavailableError);
        expect(err.message).toContain('chi_tra_vert.traineddata');
      }
    });

    it('supports hyphenated vertical model aliases jpn-vert, chi-sim-vert, chi-tra-vert and fails closed when traineddata is unavailable', async () => {
      await expect(
        performOcr(dummyImage, 'jpn-vert')
      ).rejects.toThrow(OcrLanguageUnavailableError);

      try {
        await performOcr(dummyImage, 'jpn-vert');
      } catch (err: any) {
        expect(err).toBeInstanceOf(OcrLanguageUnavailableError);
        expect(err.message).toContain('jpn_vert.traineddata');
      }

      await expect(
        performOcr(dummyImage, 'chi-sim-vert')
      ).rejects.toThrow(OcrLanguageUnavailableError);

      try {
        await performOcr(dummyImage, 'chi-sim-vert');
      } catch (err: any) {
        expect(err).toBeInstanceOf(OcrLanguageUnavailableError);
        expect(err.message).toContain('chi_sim_vert.traineddata');
      }

      await expect(
        performOcr(dummyImage, 'chi-tra-vert')
      ).rejects.toThrow(OcrLanguageUnavailableError);

      try {
        await performOcr(dummyImage, 'chi-tra-vert');
      } catch (err: any) {
        expect(err).toBeInstanceOf(OcrLanguageUnavailableError);
        expect(err.message).toContain('chi_tra_vert.traineddata');
      }
    });

    it('rejects unsupported languages and lists supported languages including vertical models', async () => {
      let thrownError: any = null;
      try {
        await performOcr(dummyImage, 'invalid_vertical_lang');
      } catch (err: any) {
        thrownError = err;
      }
      expect(thrownError).not.toBeNull();
      expect(thrownError.name).toBe('OcrLanguageUnavailableError');
      expect(thrownError.status).toBe(400);
      expect(thrownError.message).toContain('Unsupported or unrecognized OCR language: \'invalid_vertical_lang\'');
      expect(thrownError.message).toContain('jpn_vert');
      expect(thrownError.message).toContain('chi_sim_vert');
      expect(thrownError.message).toContain('chi_tra_vert');
    });
  });

  // -------------------------------------------------------------
  // 5. Bidirectional hOCR 1.2 and ALTO 4.x Cross-Conversion & Clean Text Extraction
  // -------------------------------------------------------------
  describe('Bidirectional hOCR / ALTO Cross-Conversion & Clean Text Extraction', () => {
    const sampleHocr = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
<head><title>Test HOCR</title></head>
<body>
  <div class="ocr_page" id="page_1" title="image 'test.png'; bbox 0 0 800 600; ppageno 1">
    <div class="ocr_carea" id="block_1_1" title="bbox 40 80 400 120">
      <p class="ocr_par" id="par_1_1">
        <span class="ocr_line" id="line_1_1" title="bbox 40 80 400 120">
          <span class="ocrx_word" id="w_1" title="bbox 40 80 140 120; x_wconf 95">EASYCONVERT</span>
          <span class="ocrx_word" id="w_2" title="bbox 160 80 260 120; x_wconf 92">PRECISION</span>
        </span>
      </p>
    </div>
  </div>
</body>
</html>`;

    const sampleAlto = `<?xml version="1.0" encoding="UTF-8"?>
<alto xmlns="http://www.loc.gov/standards/alto/ns-v4#"
      xsi:schemaLocation="http://www.loc.gov/standards/alto/ns-v4# http://www.loc.gov/standards/alto/v4/alto-4-2.xsd">
  <Description>
    <MeasurementUnit>pixel</MeasurementUnit>
    <sourceImageInformation><fileName>test.png</fileName></sourceImageInformation>
  </Description>
  <Layout>
    <Page ID="PAGE_1" PHYSICAL_IMG_NR="1" WIDTH="800" HEIGHT="600">
      <PrintSpace HPOS="0" VPOS="0" WIDTH="800" HEIGHT="600">
        <TextBlock ID="TB_1" HPOS="40" VPOS="80" WIDTH="360" HEIGHT="40">
          <TextLine ID="TL_1" HPOS="40" VPOS="80" WIDTH="360" HEIGHT="40">
            <String CONTENT="EASYCONVERT" HPOS="40" VPOS="80" WIDTH="100" HEIGHT="40" WC="0.95" />
            <SP HPOS="140" VPOS="80" WIDTH="20" />
            <String CONTENT="PRECISION" HPOS="160" VPOS="80" WIDTH="100" HEIGHT="40" WC="0.92" />
          </TextLine>
        </TextBlock>
      </PrintSpace>
    </Page>
  </Layout>
</alto>`;

    it('parses hOCR markup accurately into OcrResult', () => {
      const parsed = parseHocr(sampleHocr);
      expect(parsed.text).toBe('EASYCONVERT PRECISION');
      expect(parsed.wordCount).toBe(2);
      expect(parsed.pages?.length).toBe(1);
      expect(parsed.pages?.[0].width).toBe(800);
      expect(parsed.pages?.[0].height).toBe(600);
      expect(parsed.lineBlocks?.[0].words.length).toBe(2);
      expect(parsed.lineBlocks?.[0].words[0].text).toBe('EASYCONVERT');
      expect(parsed.lineBlocks?.[0].words[0].bbox.x).toBe(40);
      expect(parsed.lineBlocks?.[0].words[1].text).toBe('PRECISION');
    });

    it('parses ALTO XML markup accurately into OcrResult', () => {
      const parsed = parseAlto(sampleAlto);
      expect(parsed.text).toBe('EASYCONVERT PRECISION');
      expect(parsed.wordCount).toBe(2);
      expect(parsed.pages?.length).toBe(1);
      expect(parsed.pages?.[0].width).toBe(800);
      expect(parsed.pages?.[0].height).toBe(600);
      expect(parsed.lineBlocks?.[0].words.length).toBe(2);
      expect(parsed.lineBlocks?.[0].words[0].text).toBe('EASYCONVERT');
      expect(parsed.lineBlocks?.[0].words[0].bbox.width).toBe(100);
    });

    it('converts hocr to alto format via convertFile', async () => {
      const result = await convertFile(Buffer.from(sampleHocr), 'hocr', 'alto', {}, 'input.hocr');
      expect(result.mimeType).toBe('application/xml');
      expect(result.filename).toBe('input.xml');
      const xml = result.buffer.toString('utf-8');
      expect(xml).toContain('<alto xmlns="http://www.loc.gov/standards/alto/ns-v4#"');
      expect(xml).toContain('CONTENT="EASYCONVERT"');
      expect(xml).toContain('CONTENT="PRECISION"');
      expect(xml).toContain('WC=');
    });

    it('converts alto to hocr format via convertFile', async () => {
      const result = await convertFile(Buffer.from(sampleAlto), 'alto', 'hocr', {}, 'input.xml');
      expect(result.mimeType).toBe('application/xhtml+xml');
      expect(result.filename).toBe('input.hocr');
      const hocr = result.buffer.toString('utf-8');
      expect(hocr).toContain('class="ocr_page"');
      expect(hocr).toContain('class="ocrx_word"');
      expect(hocr).toContain('EASYCONVERT');
      expect(hocr).toContain('PRECISION');
    });

    it('extracts clean plain text from hocr without leaking any HTML or XML markup', async () => {
      const result = await convertFile(Buffer.from(sampleHocr), 'hocr', 'txt', {}, 'input.hocr');
      expect(result.mimeType).toBe('text/plain');
      const txt = result.buffer.toString('utf-8').trim();
      expect(txt).toBe('EASYCONVERT PRECISION');
      expect(txt).not.toContain('<');
      expect(txt).not.toContain('>');
      expect(txt).not.toContain('ocr_page');
    });

    it('extracts clean plain text from alto without leaking any XML markup', async () => {
      const result = await convertFile(Buffer.from(sampleAlto), 'alto', 'txt', {}, 'input.xml');
      expect(result.mimeType).toBe('text/plain');
      const txt = result.buffer.toString('utf-8').trim();
      expect(txt).toBe('EASYCONVERT PRECISION');
      expect(txt).not.toContain('<');
      expect(txt).not.toContain('>');
      expect(txt).not.toContain('alto');
    });

    it('converts hocr to structured PDF preserving page dimensions without dumping raw markup', async () => {
      const result = await convertFile(Buffer.from(sampleHocr), 'hocr', 'pdf', {}, 'input.hocr');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');

      const pdfText = result.ocrExtractedText || '';
      expect(pdfText).toContain('EASYCONVERT');
      expect(pdfText).not.toContain('<div class="ocr_page"');
    });
  });

  // -------------------------------------------------------------
  // 6. Mixed-Orientation Multi-Page PDF Coordinate Parity
  // -------------------------------------------------------------
  describe('Mixed-Orientation Multi-Page Viewport Parity', () => {
    oracleTest(
      'exports landscape and portrait digital pages with their own sizes and word boxes from the text layer',
      ['pdftotext', 'xmllint'],
      async () => {
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);

        // Page 1: Landscape (1000 x 500)
        doc.addPage([1000, 500]).drawText('Wide landscape legal banner text with significant horizontal width across the entire layout', {
          x: 50,
          y: 400,
          size: 18,
          font,
        });
        // Page 2: Portrait (500 x 800)
        doc.addPage([500, 800]).drawText('Standard vertical portrait document text', { x: 50, y: 700, size: 14, font });

        const pdfBuffer = Buffer.from(await doc.save());

        // Both pages have native text and are skipped by OCR.
        const hocr = (await convertFile(pdfBuffer, 'pdf', 'hocr', { ocrEnabled: true, ocrMode: 'skip_text' }, 'mixed.pdf')).buffer.toString('utf-8');
        expect(xmlWellFormed(hocr).stderr).toBe('');
        expect(xpathAttributes(hocr, "//*[@class='ocr_page']/@title").map((t) => /bbox (0 0 \d+ \d+)/.exec(t)?.[1])).toEqual([
          '0 0 1000 500',
          '0 0 500 800',
        ]);
        const reference = popplerWords(pdfBuffer);
        const mine = hocrWords(hocr);
        expect(mine).toHaveLength(reference.length);
        matchedIou(reference, mine).forEach((iou, index) => {
          expect(iou, `page ${reference[index].page} word '${reference[index].text}'`).toBeGreaterThanOrEqual(0.8);
        });
        const exact = ocrWords(await extractPdfTextLayerPages(pdfBuffer, new Set([1, 2])));
        matchedIou(reference, exact).forEach((iou, index) => {
          expect(iou, `exact page ${reference[index].page} word '${reference[index].text}'`).toBeGreaterThanOrEqual(0.9);
        });
        // The banner on page 1 runs past the 612 pt width of a default letter page.
        expect(Math.max(...mine.filter((w) => w.page === 1).map((w) => w.x1))).toBeGreaterThan(612);

        const alto = (await convertFile(pdfBuffer, 'pdf', 'alto', { ocrEnabled: true, ocrMode: 'skip_text' }, 'mixed.pdf')).buffer.toString('utf-8');
        expect(validateAlto44(alto).stderr.trim()).toBe('- validates');
        expect(xpathAttributes(alto, "//*[local-name()='Page']/@WIDTH")).toEqual(['1000', '500']);
        expect(xpathAttributes(alto, "//*[local-name()='Page']/@HEIGHT")).toEqual(['500', '800']);
      },
      120_000
    );
  });
});

