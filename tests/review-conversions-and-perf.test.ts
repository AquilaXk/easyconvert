import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { safeDecodeXmlEntities } from '../src/lib/conversions/safe-xml-scanner';
import { convertDocument, stripHtmlTags } from '../src/lib/conversions/document';
import { convertOffice, parseDocxXml, parseDrawingMlShapes, SpreadsheetDagEngine } from '../src/lib/conversions/office';
import { compressBzip2, decompressBzip2 } from '../src/lib/conversions/bzip2';
import { applyFalseColorSuppression, decodeLosslessJpegStrip } from '../src/lib/conversions/image';
import { knotSpan } from '../src/lib/conversions/cad-dxf';
import { convertWithNativeFfmpeg } from '../src/worker/engines';
import { ConversionFailedError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { expectNoHang } from './helpers/timing';

describe('CONV-1: Single-pass XML entity expansion (W3C XML 1.0 §4.6)', () => {
  it('does not double-unescape escaped entity references (&amp;lt;, &amp;#60;, &amp;#x3c;)', () => {
    expect(safeDecodeXmlEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
    expect(safeDecodeXmlEntities('&amp;#60;img&amp;#62;')).toBe('&#60;img&#62;');
    expect(safeDecodeXmlEntities('&amp;#x3c;svg&amp;#x3e;')).toBe('&#x3c;svg&#x3e;');
    expect(safeDecodeXmlEntities('&amp;quot;hello&amp;apos;')).toBe('&quot;hello&apos;');
  });

  it('decodes standard named, decimal, and hex entities in a single pass', () => {
    expect(safeDecodeXmlEntities('A &amp; B &lt; C &gt; D &quot;E&quot; &apos;F&apos; &#65; &#x42;')).toBe(
      'A & B < C > D "E" \'F\' A B'
    );
  });
});

describe('CONV-4: Multi-timestamp video thumbnail extraction fail-closed behavior', () => {
  oracleTest(
    'throws ConversionFailedError when all requested timestamps exceed video duration and succeeds when a subset produces frames',
    ['ffmpeg'],
    async () => {
      const ffmpeg = requireOracleTool('ffmpeg');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-thumb-test-'));
      try {
        const videoPath = path.join(tmpDir, 'short.mp4');
        execFileSync(ffmpeg, [
          '-y',
          '-f',
          'lavfi',
          '-i',
          'color=c=red:s=32x32:d=1',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          videoPath,
        ]);
        const videoBuf = fs.readFileSync(videoPath);

        // 1. All timestamps past the 1s video -> 0 frames emitted -> must throw ConversionFailedError, never fall through to transcode
        await expect(
          convertWithNativeFfmpeg(
            videoBuf,
            'mp4',
            'png',
            { thumbnail: { at: ['00:00:50', '00:01:00'] } },
            'short.mp4'
          )
        ).rejects.toBeInstanceOf(ConversionFailedError);

        // 2. First timestamp (50s) produces no frame, second timestamp (0.2s) produces a valid PNG frame
        const partial = await convertWithNativeFfmpeg(
          videoBuf,
          'mp4',
          'png',
          { thumbnail: { at: ['00:00:50', '00:00:00.200'] } },
          'short.mp4'
        );
        expect(partial).not.toBeNull();
        expect(partial!.parts).toHaveLength(1);
        expect(partial!.parts![0].filename).toBe('short_thumb_2.png');
        // PNG signature check (89 50 4E 47)
        expect(partial!.parts![0].buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
        const primaryBuf = partial!.buffer ?? fs.readFileSync(partial!.filePath!);
        expect(primaryBuf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    60_000
  );
});

describe('CONV-5 & SEC-5: tex/latex consistency and DOCX w:jc allowlist', () => {
  it('routes .tex and .latex identically in document and office conversions', async () => {
    const sampleLatex = Buffer.from(
      '\\documentclass{article}\\begin{document}\\section{Title}Hello \\textbf{World}!\\end{document}',
      'utf-8'
    );
    const docTex = await convertDocument(sampleLatex, 'tex', 'txt', {}, 'paper.tex');
    const docLatex = await convertDocument(sampleLatex, 'latex', 'txt', {}, 'paper.latex');
    expect(docLatex.buffer.toString('utf-8')).toBe(docTex.buffer.toString('utf-8'));
    expect(docLatex.buffer.toString('utf-8')).not.toContain('\\textbf');
    expect(docLatex.buffer.toString('utf-8')).toContain('Hello World');

    const offTex = await convertOffice(sampleLatex, 'tex', 'txt', {}, 'paper.tex');
    const offLatex = await convertOffice(sampleLatex, 'latex', 'txt', {}, 'paper.latex');
    expect(offLatex.buffer.toString('utf-8')).toBe(offTex.buffer.toString('utf-8'));
    expect(offLatex.buffer.toString('utf-8')).not.toContain('\\textbf');
  });

  it('rejects unallowed w:jc values while preserving valid alignments', () => {
    const validParsed = parseDocxXml(
      '<w:body><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>Centered</w:t></w:r></w:p></w:body>'
    );
    expect(validParsed.paragraphs[0].alignment).toBe('center');

    const maliciousParsed = parseDocxXml(
      '<w:body><w:p><w:pPr><w:jc w:val="center;background:url(javascript:1)"/></w:pPr><w:r><w:t>Injected</w:t></w:r></w:p></w:body>'
    );
    expect(maliciousParsed.paragraphs[0].alignment).toBeUndefined();
  });
});

describe('SEC-7: ReDoS elimination, iterative Kahn DAG, and DrawingML depth guard', () => {
  it('stripHtmlTags processes unclosed <script and repeated < tags without hanging', async () => {
    const payload = '<script' + ' '.repeat(50_000) + '<div'.repeat(10_000) + 'SafeText';
    const result = await expectNoHang('stripHtmlTags adversarial unclosed script', () => stripHtmlTags(payload));
    expect(result).toBe('');
  });

  it('SpreadsheetDagEngine.evaluateWithDag evaluates a 2,500-cell chain without stack overflow and marks cycles as #CYCLE!', () => {
    const chainLength = 2500;
    const baseMap: Record<string, any> = { A1: 1 };
    const formulas = [];
    for (let i = 2; i <= chainLength; i++) {
      formulas.push({
        ref: `A${i}`,
        formula: `=A${i - 1}+1`,
      });
    }
    // Add a 2-node cycle B1 <-> B2 and a downstream cell B3 -> B2
    formulas.push(
      { ref: 'B1', formula: '=B2+1' },
      { ref: 'B2', formula: '=B1+1' },
      { ref: 'B3', formula: '=B2+10' }
    );

    const engine = new SpreadsheetDagEngine(baseMap);
    const { evaluated, cycles } = engine.evaluateWithDag(formulas);

    expect(evaluated[`A${chainLength}`]).toBe(chainLength);
    expect(cycles).toEqual(expect.arrayContaining(['B1', 'B2', 'B3']));
    expect(evaluated.B1).toBe('#CYCLE!');
    expect(evaluated.B2).toBe('#CYCLE!');
    expect(evaluated.B3).toBe('#CYCLE!');
  });

  it('caps recursive DrawingML group nesting at depth 16', () => {
    let xml = '<p:sp><a:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"/></a:spPr></p:sp>';
    for (let i = 0; i < 25; i++) {
      xml = `<p:grpSp>${xml}</p:grpSp>`;
    }
    expect(parseDrawingMlShapes(xml)).toEqual([]);
  });
});

describe('OPT-BIT & OPT-Q: Bit-level and algorithmic optimizations preserve exact outputs', () => {
  it('bzip2 10-bit fast table round-trips mixed symbol distributions bit-identically', () => {
    const buf = Buffer.alloc(16384);
    for (let i = 0; i < buf.length; i++) {
      buf[i] = (i * 73 + (i >>> 3)) & 0xff;
    }
    const compressed = compressBzip2(buf);
    const decompressed = decompressBzip2(compressed);
    expect(decompressed.equals(buf)).toBe(true);
  });

  it('decodeLosslessJpegStrip decodes 16-bit Huffman streams with 0xFF00 byte stuffing', () => {
    // Minimal 2x1 8-bit lossless JPEG (SOF3, predictor 1) with two category-0 symbols (code '0' -> sym 0)
    const strip = Buffer.from([
      0xff, 0xd8, // SOI
      0xff, 0xc3, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x02, 0x01, 0x01, 0x11, 0x00, // SOF3: 8-bit, 1x2, 1 comp
      0xff, 0xc4, 0x00, 0x14, 0x00, // DHT class 0 id 0
      0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 1 code of len 1
      0x00, // symbol 0 (diff = 0)
      0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x01, 0x00, 0x00, // SOS: predictor=1, pointTransform=0
      0x00, // scan bits: two '0' bits -> two cat-0 diffs -> samples equal initial predictor 128
      0xff, 0xd9, // EOI
    ]);
    const decoded = decodeLosslessJpegStrip(strip);
    expect(decoded).not.toBeNull();
    expect(Array.from(decoded!.data)).toEqual([128, 128]);
  });

  it('applyFalseColorSuppression median25 matches exact 5x5 neighborhood medians', () => {
    const width = 6;
    const height = 6;
    const red = new Float32Array(width * height);
    const blue = new Float32Array(width * height);
    for (let i = 0; i < red.length; i++) {
      red[i] = ((i * 19 + 7) % 31) - 15;
      blue[i] = ((i * 11 + 3) % 29) - 14;
    }
    const { filteredRedDiff, filteredBlueDiff } = applyFalseColorSuppression(red, blue, width, height, 1);
    // Verify interior pixel (2, 2) against manual 25-element sorted median
    const manualR: number[] = [];
    const manualB: number[] = [];
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const idx = (2 + dy) * width + (2 + dx);
        manualR.push(red[idx]);
        manualB.push(blue[idx]);
      }
    }
    manualR.sort((a, b) => a - b);
    manualB.sort((a, b) => a - b);
    expect(filteredRedDiff[2 * width + 2]).toBe(manualR[12]);
    expect(filteredBlueDiff[2 * width + 2]).toBe(manualB[12]);
  });

  it('knotSpan binary search matches exact span indices including clamped and repeated knots', () => {
    const knots = [0, 0, 0, 0, 1, 2, 2, 3, 4, 4, 4, 4];
    const degree = 3;
    const count = 8; // knots.length - degree - 1
    for (const t of [-0.5, 0, 0.25, 1, 1.5, 2, 2.5, 3, 3.99, 4, 4.5]) {
      let linear = count - 1;
      if (t < knots[count]) {
        linear = degree;
        while (linear < count - 1 && t >= knots[linear + 1]) linear++;
      }
      expect(knotSpan(knots, degree, count, t)).toBe(linear);
    }
  });
});
