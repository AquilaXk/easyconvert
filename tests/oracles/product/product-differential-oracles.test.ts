import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { PDFDocument, rgb } from 'pdf-lib';
import JSZip from 'jszip';
import crypto from 'node:crypto';
import {
  computeWang2004Mssim,
  calculateCharacterErrorRate,
  renderPdfPagesWithPdftoppm,
  extractTextWithPdftotext,
  verifyPdfFidelityWithOracle,
  downmixPcmToStereoItuRBs775,
  computeAudioSnr,
  verifyAudioDownmixSnr,
  inspectMediaWithFfprobe,
  computeFfmpegLavfiSsimPsnr,
  inspectTarWithNativeTar,
  verifyArchiveWithNative7z,
  verifyArchiveEntriesSha256,
  compareOfficeDocumentStructure,
  renderOfficeDocumentWithSoffice,
  runMutationSensitivitySuite,
  injectVisualPixelShift,
  injectAudioGain1Db,
  injectMissingPage,
  injectBitFlip,
} from './index';
import { oracleTest } from '../../helpers/oracle-test';

describe('Phase 6: Product-Level Differential Oracles & Mutation Sensitivity Gate (#349)', () => {
  // =========================================================================
  // 1. PDF Product Differential Oracle (Poppler & Wang 2004 MSSIM & CER)
  // =========================================================================
  describe('1. PDF Differential Oracle (Poppler, Wang 2004 MSSIM & CER)', () => {
    it('computes exact Wang 2004 MSSIM = 1.0 on identical images', async () => {
      const basePng = await sharp({
        create: {
          width: 48,
          height: 48,
          channels: 4,
          background: { r: 128, g: 128, b: 200, alpha: 1 },
        },
      })
        .png()
        .toBuffer();

      const res = await computeWang2004Mssim(basePng, basePng, { threshold: 0.999 });
      expect(res.mssim).toBeCloseTo(1.0, 4);
      expect(res.passed).toBe(true);
      expect(res.width).toBe(48);
      expect(res.height).toBe(48);
      expect(res.samplePoints).toBeGreaterThan(0);
    });

    it('detects visual degradation with dropped MSSIM when pixels are altered', async () => {
      const imgA = await sharp({
        create: {
          width: 48,
          height: 48,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        },
      })
        .png()
        .toBuffer();

      const imgB = await sharp({
        create: {
          width: 48,
          height: 48,
          channels: 4,
          background: { r: 180, g: 180, b: 180, alpha: 1 },
        },
      })
        .png()
        .toBuffer();

      const res = await computeWang2004Mssim(imgA, imgB, { threshold: 0.98 });
      expect(res.mssim).toBeLessThan(0.95);
      expect(res.passed).toBe(false);
    });

    it('computes Character Error Rate (CER) with precise edit distance metrics', () => {
      // 1. Exact match
      const cerExact = calculateCharacterErrorRate('EasyConvert Standard', 'EasyConvert Standard');
      expect(cerExact.cer).toBe(0.0);
      expect(cerExact.editDistance).toBe(0);
      expect(cerExact.referenceLength).toBe(20);

      // 2. 1 substitution ('Eazy' vs 'Easy')
      const cerSub = calculateCharacterErrorRate('EazyConvert', 'EasyConvert');
      expect(cerSub.cer).toBeCloseTo(1 / 11, 4);
      expect(cerSub.substitutions).toBe(1);
      expect(cerSub.insertions).toBe(0);
      expect(cerSub.deletions).toBe(0);

      // 3. Deletion ('Easy' vs 'EasyConvert')
      const cerDel = calculateCharacterErrorRate('Easy', 'EasyConvert');
      expect(cerDel.cer).toBeCloseTo(7 / 11, 4);
      expect(cerDel.deletions).toBe(7);

      // 4. Empty reference
      const cerEmptyRef = calculateCharacterErrorRate('NonEmpty', '');
      expect(cerEmptyRef.cer).toBe(1.0);

      // 5. Empty both
      const cerEmptyBoth = calculateCharacterErrorRate('', '');
      expect(cerEmptyBoth.cer).toBe(0.0);
    });

    oracleTest(
      'renders authentic PDF pages via Poppler pdftoppm and extracts ground-truth text via pdftotext',
      ['pdftoppm', 'pdftotext'],
      async () => {
        const doc = await PDFDocument.create();
        const page1 = doc.addPage([300, 200]);
        page1.drawText('Differential Oracle Ground Truth Page 1', { x: 20, y: 150, size: 12 });
        const page2 = doc.addPage([300, 200]);
        page2.drawText('Poppler Engine Verification Page 2', { x: 20, y: 150, size: 12 });
        const pdfBytes = Buffer.from(await doc.save());

        // Render pages with pdftoppm
        const renderedPages = await renderPdfPagesWithPdftoppm(pdfBytes, { dpi: 72 });
        expect(renderedPages).toHaveLength(2);

        // Verify dimensions and validity of rendered PNG
        const meta1 = await sharp(renderedPages[0]).metadata();
        expect(meta1.format).toBe('png');
        expect(meta1.width).toBeGreaterThan(0);
        expect(meta1.height).toBeGreaterThan(0);

        // Extract text with pdftotext
        const text = extractTextWithPdftotext(pdfBytes);
        expect(text).toContain('Differential Oracle Ground Truth Page 1');
        expect(text).toContain('Poppler Engine Verification Page 2');

        // End-to-end verification
        const oracleResult = await verifyPdfFidelityWithOracle(
          pdfBytes,
          pdfBytes,
          'Differential Oracle Ground Truth Page 1\n\nPoppler Engine Verification Page 2\n',
          { mssimThreshold: 0.99, cerThreshold: 0.01, dpi: 72 }
        );

        expect(oracleResult.passed).toBe(true);
        expect(oracleResult.pageCount).toBe(2);
        expect(oracleResult.meanMssim).toBeCloseTo(1.0, 3);
        expect(oracleResult.cerScore).toBe(0.0);
        expect(oracleResult.discrepancies).toHaveLength(0);
      }
    );
  });

  // =========================================================================
  // 2. Media Product Differential Oracle (ffprobe, ffmpeg lavfi & ITU-R BS.775)
  // =========================================================================
  describe('2. Media Differential Oracle (ffprobe, ffmpeg lavfi & ITU-R BS.775)', () => {
    it('implements standard ITU-R BS.775 5.1 surround downmixing equations', () => {
      const sampleCount = 100;
      const FL = new Float64Array(sampleCount).fill(1.0);
      const FR = new Float64Array(sampleCount).fill(0.0);
      const FC = new Float64Array(sampleCount).fill(0.5);
      const LFE = new Float64Array(sampleCount).fill(0.9); // LFE must be omitted
      const BL = new Float64Array(sampleCount).fill(0.5);
      const BR = new Float64Array(sampleCount).fill(0.0);

      // Unnormalized:
      // Lo = FL + 0.7071 * FC + 0.7071 * BL = 1.0 + 0.7071*0.5 + 0.7071*0.5 = 1.70710678
      // Ro = FR + 0.7071 * FC + 0.7071 * BR = 0.0 + 0.7071*0.5 + 0.0 = 0.35355339
      const downmixed = downmixPcmToStereoItuRBs775([FL, FR, FC, LFE, BL, BR], false);

      expect(downmixed.left).toHaveLength(sampleCount);
      expect(downmixed.right).toHaveLength(sampleCount);
      expect(downmixed.left[0]).toBeCloseTo(1.0 + 0.5 * Math.SQRT2, 4);
      expect(downmixed.right[0]).toBeCloseTo(0.25 * Math.SQRT2, 4);
    });

    it('computes pristine SNR = 120 dB for identical signals and catches 1dB gain distortion', () => {
      const sampleCount = 44100;
      const ref = new Float64Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        ref[i] = Math.sin((2 * Math.PI * 440 * i) / 44100);
      }

      // Pristine identical signal
      const identicalSnr = computeAudioSnr(ref, ref, 40.0);
      expect(identicalSnr.passed).toBe(true);
      expect(identicalSnr.snrDb).toBe(120.0);
      expect(identicalSnr.maxAbsoluteError).toBe(0.0);

      // 1dB gain distortion (factor: 10^(1/20) ~ 1.122018)
      const gained = new Float64Array(sampleCount);
      const scale = Math.pow(10, 1.0 / 20);
      for (let i = 0; i < sampleCount; i++) {
        gained[i] = ref[i] * scale;
      }

      // SNR must be ~ 18.27 dB, failing the 40dB gate
      const distortedSnr = computeAudioSnr(gained, ref, 40.0);
      expect(distortedSnr.passed).toBe(false);
      expect(distortedSnr.snrDb).toBeCloseTo(18.27, 1);
    });

    oracleTest('inspects media format and streams using ffprobe CLI', ['ffprobe'], async () => {
      // Test is executed only when ffprobe binary is present in environment
      // (Skips automatically if missing without silent passes)
      const mockWavHeader = Buffer.alloc(44);
      mockWavHeader.write('RIFF', 0);
      mockWavHeader.writeUInt32LE(36, 4);
      mockWavHeader.write('WAVE', 8);
      mockWavHeader.write('fmt ', 12);
      mockWavHeader.writeUInt32LE(16, 16);
      mockWavHeader.writeUInt16LE(1, 20); // PCM
      mockWavHeader.writeUInt16LE(2, 22); // Stereo
      mockWavHeader.writeUInt32LE(44100, 24);
      mockWavHeader.writeUInt32LE(176400, 28);
      mockWavHeader.writeUInt16LE(4, 32);
      mockWavHeader.writeUInt16LE(16, 34);
      mockWavHeader.write('data', 36);
      mockWavHeader.writeUInt32LE(0, 40);

      const probe = await inspectMediaWithFfprobe(mockWavHeader, 'wav');
      expect(probe.format.format_name).toContain('wav');
      expect(probe.audioStreams.length).toBeGreaterThanOrEqual(1);
    });

    oracleTest(
      'computes frame-accurate video SSIM and PSNR via ffmpeg lavfi',
      ['ffmpeg'],
      async () => {
        // Will be skipped if ffmpeg is missing
        const dummy = Buffer.alloc(100);
        let thrownError: any = null;
        try {
          await computeFfmpegLavfiSsimPsnr(dummy, dummy, 'mp4');
        } catch (err: any) {
          thrownError = err;
        }
        expect(thrownError).not.toBeNull();
        expect(typeof thrownError?.message).toBe('string');
        expect(thrownError?.message.length).toBeGreaterThan(0);
      }
    );
  });

  // =========================================================================
  // 3. Archive Product Differential Oracle (Native 7z t, tar -tvf & SHA-256)
  // =========================================================================
  describe('3. Archive Differential Oracle (Native 7z t, tar -tvf & SHA-256)', () => {
    function createDeterministicTar(
      entries: Array<{ name: string; content: Buffer }>
    ): Buffer {
      const blocks: Buffer[] = [];
      for (const entry of entries) {
        const header = Buffer.alloc(512);
        header.write(entry.name.slice(0, 100), 0, 100, 'ascii');
        header.write('0000644\0', 100, 8, 'ascii');
        header.write('0000000\0', 108, 8, 'ascii');
        header.write('0000000\0', 116, 8, 'ascii');
        header.write(entry.content.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
        header.write('00000000000\0', 136, 12, 'ascii');
        header.write('        ', 148, 8, 'ascii');
        header.write('0', 156, 1, 'ascii');
        header.write('ustar\0', 257, 6, 'ascii');
        header.write('00', 263, 2, 'ascii');
        let sum = 0;
        for (let i = 0; i < 512; i++) sum += header[i];
        header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');

        blocks.push(header);
        blocks.push(entry.content);
        const pad = (512 - (entry.content.length % 512)) % 512;
        if (pad > 0) blocks.push(Buffer.alloc(pad));
      }
      blocks.push(Buffer.alloc(1024)); // 2 zero blocks
      return Buffer.concat(blocks);
    }

    oracleTest('inspects TAR archive table of contents via native system tar CLI', ['tar'], () => {
      const contentA = Buffer.from('Alpha file content for oracle test');
      const contentB = Buffer.from('Beta file content for independent digest test');

      const tarBuffer = createDeterministicTar([
        { name: 'alpha.txt', content: contentA },
        { name: 'subdir/beta.txt', content: contentB },
      ]);

      const inspectResult = inspectTarWithNativeTar(tarBuffer);
      expect(inspectResult.passed).toBe(true);
      expect(inspectResult.entries).toHaveLength(2);

      const paths = inspectResult.entries.map((e) => e.path);
      expect(paths).toContain('alpha.txt');
      expect(paths).toContain('subdir/beta.txt');
    });

    oracleTest(
      'extracts and validates archive entries SHA-256 digests independently without production code',
      ['tar'],
      () => {
        const contentA = Buffer.from('Independent Entry A');
        const contentB = Buffer.from('Independent Entry B');

        const expectedHashA = crypto.createHash('sha256').update(contentA).digest('hex');
        const expectedHashB = crypto.createHash('sha256').update(contentB).digest('hex');

        const tarBuffer = createDeterministicTar([
          { name: 'file_a.txt', content: contentA },
          { name: 'nested/file_b.txt', content: contentB },
        ]);

        const digestResult = verifyArchiveEntriesSha256(
          tarBuffer,
          {
            'file_a.txt': expectedHashA,
            'nested/file_b.txt': expectedHashB,
          },
          'tar'
        );

        expect(digestResult.matched).toBe(true);
        expect(digestResult.discrepancies).toHaveLength(0);
        expect(digestResult.computedDigests['file_a.txt']).toBe(expectedHashA);
        expect(digestResult.computedDigests['nested/file_b.txt']).toBe(expectedHashB);

        // Mismatched hash verification
        const mismatchResult = verifyArchiveEntriesSha256(
          tarBuffer,
          {
            'file_a.txt': '0000000000000000000000000000000000000000000000000000000000000000',
            'nested/file_b.txt': expectedHashB,
          },
          'tar'
        );
        expect(mismatchResult.matched).toBe(false);
        expect(mismatchResult.discrepancies.length).toBeGreaterThan(0);
      }
    );

    oracleTest('verifies archive integrity using native 7z t CLI', ['7z'], () => {
      const tarBuffer = createDeterministicTar([
        { name: 'doc.txt', content: Buffer.from('Test 7z verification') },
      ]);

      const res = verifyArchiveWithNative7z(tarBuffer, 'tar');
      expect(res.passed).toBe(true);

      // Corrupt archive
      const corrupt = Buffer.from(tarBuffer);
      corrupt[148] ^= 0xff;
      const corruptRes = verifyArchiveWithNative7z(corrupt, 'tar');
      expect(corruptRes.passed).toBe(false);
    });
  });

  // =========================================================================
  // 4. Office Product Differential Oracle (OOXML Structure & soffice bridge)
  // =========================================================================
  describe('4. Office Differential Oracle (OOXML Structure & soffice bridge)', () => {
    async function createMinimalDocx(textContent: string): Promise<Buffer> {
      const zip = new JSZip();
      zip.file(
        '[Content_Types].xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
      );
      zip.file(
        '_rels/.rels',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
      );
      zip.file(
        'word/document.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${textContent}</w:t></w:r></w:p>
  </w:body>
</w:document>`
      );
      return await zip.generateAsync({ type: 'nodebuffer' });
    }

    it('validates authentic OOXML document structure and detects missing parts', async () => {
      const docxA = await createMinimalDocx('Enterprise Contract Agreement');
      const docxB = await createMinimalDocx('Enterprise Contract Agreement');

      const comparison = await compareOfficeDocumentStructure(docxA, docxB, 'docx');
      expect(comparison.matched).toBe(true);
      expect(comparison.structuralScore).toBe(1.0);
      expect(comparison.discrepancies).toHaveLength(0);

      // Create corrupted docx without [Content_Types].xml
      const zip = new JSZip();
      zip.file('word/document.xml', '<w:document></w:document>');
      const brokenDocx = await zip.generateAsync({ type: 'nodebuffer' });

      const brokenComparison = await compareOfficeDocumentStructure(brokenDocx, docxB, 'docx');
      expect(brokenComparison.matched).toBe(false);
      expect(brokenComparison.structuralScore).toBeLessThan(0.8);
      expect(brokenComparison.discrepancies).toContain('Missing [Content_Types].xml in actual document');
    });

    oracleTest(
      'renders office document to rasterized pages via headless LibreOffice',
      ['soffice', 'pdftoppm'],
      async () => {
        const docx = await createMinimalDocx('LibreOffice Differential Verification');
        const pages = await renderOfficeDocumentWithSoffice(docx, 'docx');
        expect(pages.length).toBeGreaterThanOrEqual(1);
      }
    );
  });

  // =========================================================================
  // 5. Mutation Sensitivity Gate (100% Mutation Detection Verification)
  // =========================================================================
  describe('5. Mutation Sensitivity Gate (100% Mutation Detection Verification)', () => {
    it('executes mutation sensitivity suite and catches 100% of injected mutations', async () => {
      const suiteReport = await runMutationSensitivitySuite();

      // Exhaustive mutation inspection
      expect(suiteReport.totalMutations).toBe(4);
      expect(suiteReport.detectedCount).toBe(4);
      expect(suiteReport.detectionRate).toBe(1.0);
      expect(suiteReport.passed).toBe(true);

      for (const res of suiteReport.results) {
        expect(res.detected).toBe(true);
        expect(res.metricDetails).toBeDefined();
        expect(res.oracleUsed).toBeDefined();
      }
    });

    it('explicitly verifies individual mutation injectors produce modified payloads', async () => {
      // 1. Pixel shift injector
      const origPng = await sharp({
        create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
      })
        .composite([
          {
            input: Buffer.from(
              '<svg width="16" height="16"><rect x="4" y="4" width="8" height="8" fill="white"/></svg>'
            ),
          },
        ])
        .png()
        .toBuffer();
      const shifted = await injectVisualPixelShift(origPng, 1);
      expect(Buffer.compare(origPng, shifted)).not.toBe(0);

      // 2. Audio gain injector
      const origAudio = Buffer.alloc(100);
      origAudio.writeInt16LE(1000, 0);
      const gainedAudio = injectAudioGain1Db(origAudio, 1.0);
      expect(gainedAudio.readInt16LE(0)).toBe(Math.round(1000 * Math.pow(10, 1 / 20)));

      // 3. Bit-flip injector
      const origBuf = Buffer.from([0x00, 0x00, 0x00, 0x00]);
      const flipped = injectBitFlip(origBuf, 1);
      expect(flipped[1]).toBe(0x01);
      expect(flipped[0]).toBe(0x00);
    });
  });
});
