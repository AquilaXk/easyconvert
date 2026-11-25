import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFDict, PDFDocument, PDFName, PDFNumber, StandardFonts } from 'pdf-lib';
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, describe, expect, it } from 'vitest';
import { documentToDocx } from '../src/lib/conversions/document-model/docx';
import { shapeProperties, extentOf } from '../src/lib/conversions/document-model/shape-xml';
import { pdfToPptx, writePackage, type SlidePage } from '../src/lib/conversions/office/pdf-pptx';
import type { LayoutLine, Paragraph, TableCell } from '../src/lib/conversions/pdf-layout/types';
import { FontTable, readPageContent } from '../src/lib/conversions/pdf-text-content';
import { readPdfDocument } from '../src/lib/conversions/pdf-text-document';
import { analyzePdfPagesInProcess } from '../src/lib/conversions/pdf-text-geometry';
import { axialShadingGradient, clipBoxOfSubpaths, subpathHullBox } from '../src/lib/conversions/pdf-text-shading';
import { PDF_CONTENT_MAX_GRADIENT_STOPS, PDF_CONTENT_MAX_STATE_DEPTH } from '../src/lib/conversions/pdf-text-types';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function validateXmlZip(buffer: Buffer, prefix: string): Promise<void> {
  const zip = await JSZip.loadAsync(buffer);
  const xmlEntries = Object.keys(zip.files).filter((name) => !zip.files[name].dir && name.endsWith('.xml'));
  expect(xmlEntries.length).toBeGreaterThan(0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  for (const entry of xmlEntries) {
    const filePath = path.join(dir, entry.replace(/\//g, '_'));
    fs.writeFileSync(filePath, await zip.file(entry)!.async('nodebuffer'));
    execFileSync(requireOracleTool('xmllint'), ['--noout', filePath]);
  }
}

async function pdfFromContentStream(
  build: (ctx: PDFDocument['context'], resources: PDFDict) => string,
  width = 600,
  height = 800
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([width, height]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const resources = doc.context.obj({
    Font: doc.context.obj({ F0: font.ref }),
  });
  page.node.set(PDFName.of('Resources'), resources);
  const contentText = `BT /F0 12 Tf 50 770 Td (Vector fixture label) Tj ET\n${build(doc.context, resources)}`;
  const stream = doc.context.stream(Buffer.from(contentText, 'ascii'));
  page.node.set(PDFName.of('Contents'), doc.context.register(stream));
  return Buffer.from(await doc.save());
}

describe('PDF vector operator fidelity in PPTX and DOCX', () => {
  it('carries dashed strokes, GState dash/CA opacity, and explicit transparent fills into rules, shapes, PPTX, and DOCX', async () => {
    const pdf = await pdfFromContentStream((ctx, resources) => {
      const gsDashAlpha = ctx.obj({ Type: 'ExtGState', CA: 0.4, ca: 0.75, D: ctx.obj([ctx.obj([4, 2]), 0]) });
    const gsHidden = ctx.obj({ Type: 'ExtGState', CA: 0, ca: 0 });
    const gsStrokeWidth = ctx.obj({ Type: 'ExtGState', CA: 0.5, LW: 3, D: ctx.obj([ctx.obj([3, 3]), 0]) });
    resources.set(
      PDFName.of('ExtGState'),
      ctx.obj({
        GS1: ctx.register(gsDashAlpha),
        GS2: ctx.register(gsHidden),
        GS3: ctx.register(gsStrokeWidth),
      })
    );
    return [
      'q',
      '0.8 0.1 0.2 RG 2 w [6 3] 0 d',
      '50 700 m 250 700 l S',
      '[] 0 d',
      '50 660 m 250 660 l S',
      '/GS1 gs',
      '0.1 0.4 0.7 RG 1 0.9 0.2 rg 1.5 w',
      '60 560 m 160 610 l 210 560 l h B',
      // Separate fill then dashed semi-transparent stroke on the same triangle -> exercises mergeInto strokeAlpha/dashed
      '0.2 0.8 0.4 rg 300 560 m 380 610 l 430 560 l h f',
      '/GS3 gs 0.2 0.2 0.8 RG 300 560 m 380 610 l 430 560 l h S',
      '/GS2 gs',
      '0.2 0.2 0.2 RG 0.3 0.3 0.3 rg 2 w',
      '50 500 100 40 re B',
      'Q',
    ].join('\n');
    });

    const extracted = await analyzePdfPagesInProcess(pdf, { geometry: 'none', content: true, images: false, colour: true });
    const page = extracted.content[0];

    const dashedRule = page.rules.find((r) => Math.abs(r.y0 - 100) < 2 && r.x1 - r.x0 > 150);
    expect(dashedRule?.dashed).toBe(true);
    expect(dashedRule?.strokeAlpha).toBeUndefined();

    const solidRule = page.rules.find((r) => Math.abs(r.y0 - 140) < 2 && r.x1 - r.x0 > 150);
    expect(solidRule?.dashed).toBeUndefined();

    // Only visible triangles should exist; the GS2 (/CA 0 /ca 0) box must be suppressed, and merged fill+stroke triangle keeps dashed & strokeAlpha & LW=3.
    const dashedTriangles = page.shapes?.filter((s) => s.kind === 'path' && s.dashed) ?? [];
    expect(dashedTriangles).toHaveLength(2);
    const triangle = dashedTriangles[0];
    expect(triangle.strokeAlpha).toBeCloseTo(0.4, 3);
    expect(triangle.alpha).toBeCloseTo(0.75, 3);
    const mergedTriangle = dashedTriangles[1];
    expect(mergedTriangle.strokeAlpha).toBeCloseTo(0.5, 3);
    expect(mergedTriangle.strokeWidth).toBeCloseTo(3, 1);
    expect(page.shapes?.some((s) => s.kind === 'rect' && Math.abs(s.y0 - 260) < 5)).toBe(false);

    const pptx = await pdfToPptx(pdf, {}, 'dash-alpha');
    const slideXml = await (await JSZip.loadAsync(pptx)).file('ppt/slides/slide1.xml')!.async('string');
    expect(slideXml).toContain('<a:prstDash val="dash"/>');
    expect(slideXml).toContain('<a:alpha val="40000"/>');
    expect(slideXml).toContain('<a:alpha val="75000"/>');

    const { extracted: docExtracted } = await readPdfDocument(pdf, { images: false, colour: true, pages: true });
    const docx = await documentToDocx(docExtracted.model);
    const docXml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(docXml).toContain('<a:prstDash val="dash"/>');
    expect(docXml).toContain('<a:alpha val="40000"/>');
  });

  oracleTest('validates generated dashed/gradient PPTX and DOCX parts with xmllint', ['xmllint'], async () => {
    const pdf = await pdfFromContentStream((ctx, resources) => {
      const fn = ctx.obj({
        FunctionType: 2,
        Domain: ctx.obj([0, 1]),
        C0: ctx.obj([0.145, 0.133, 0.133]),
        C1: ctx.obj([0.988, 0.988, 0.988]),
        N: PDFNumber.of(1),
      });
      const sh1 = ctx.obj({
        ShadingType: 2,
        ColorSpace: PDFName.of('DeviceRGB'),
        Coords: ctx.obj([100, 700, 320, 700]),
        Domain: ctx.obj([0, 1]),
        Extend: ctx.obj([false, false]),
        Function: ctx.register(fn),
      });
      const shRef = ctx.register(sh1);
      const pat = ctx.obj({
        Type: PDFName.of('Pattern'),
        PatternType: PDFNumber.of(2),
        Shading: shRef,
        Matrix: ctx.obj([0, 1, 1, 0, -250, 300]),
      });
      resources.set(PDFName.of('Shading'), ctx.obj({ SH1: shRef }));
      resources.set(PDFName.of('Pattern'), ctx.obj({ P1: ctx.register(pat) }));
      return [
        'q 100 660 220 40 re W n /SH1 sh Q',
        'q /Pattern cs /P1 scn 100 300 m 220 300 l 160 400 l h f Q',
        'q [5 3] 0 d 0.5 0.2 0.1 RG 100 200 m 300 200 l S Q',
      ].join('\n');
    });

    const pptx = await pdfToPptx(pdf, {}, 'grad-clip');
    const slideXml = await (await JSZip.loadAsync(pptx)).file('ppt/slides/slide1.xml')!.async('string');
    expect(slideXml).toContain('<a:gradFill flip="none" rotWithShape="1">');
    expect(slideXml).toContain('<a:lin ang="0" scaled="0"/>');
    expect(slideXml).toContain('<a:prstDash val="dash"/>');
    // Custom geometry gradient shapes must not stamp fill="none" on <a:path>.
    expect(slideXml).not.toMatch(/<a:path[^>]*fill="none"[^>]*>.*?<\/a:custGeom><a:gradFill/);
    await validateXmlZip(pptx, 'vec-pptx-xml-');

    const { extracted } = await readPdfDocument(pdf, { images: false, colour: true, pages: true });
    const docx = await documentToDocx(extracted.model);
    const docXml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(docXml).toContain('<a:gradFill flip="none" rotWithShape="1">');
    await validateXmlZip(docx, 'vec-docx-xml-');
  });

  it('culls out-of-clip objects, clamps partial rules/rects to clip, and keeps hairlines just inside the clip border', async () => {
    const pdf = await pdfFromContentStream(() =>
      [
        'q',
        // Viewport clip box: x=[100, 300], y=[500, 700] in page space (bottom-up 100..300 => top-down 500..700)
        '100 100 200 200 re W n',
        // Wholly outside clip -> culled
        '0.9 0.1 0.1 RG 0.9 0.1 0.1 rg 1 w',
        '20 20 50 50 re B',
        '10 200 m 80 200 l S',
        // Crossing horizontal rule -> clamped to [100..300]
        '0.1 0.5 0.1 RG 1.5 w',
        '50 180 m 350 180 l S',
        // Thin vertical line 0.3pt inside clip right edge (x = 299.7) -> must NOT be culled
        '299.7 120 m 299.7 280 l S',
        // Pure filled rectangle crossing clip left edge -> clamped to [100..220] (exact 0x3366CC)
        '0.2 0.4 0.8 rg 60 120 160 60 re f',
        'Q',
      ].join('\n')
    );

    const extracted = await analyzePdfPagesInProcess(pdf, { geometry: 'none', content: true, images: false, colour: true });
    const page = extracted.content[0];

    expect(page.shapes?.some((s) => s.x1 <= 90)).toBe(false);
    expect(page.rules.some((r) => r.x1 <= 90)).toBe(false);

    const clampedRule = page.rules.find((r) => Math.abs(r.y0 - 620) < 2 && r.x1 - r.x0 > 100);
    expect(clampedRule?.x0).toBeCloseTo(100, 1);
    expect(clampedRule?.x1).toBeCloseTo(300, 1);

    const nearEdgeRule = page.rules.find((r) => Math.abs(r.x0 - 299.7) < 0.2 && r.y1 - r.y0 > 100);
    expect(nearEdgeRule?.y0).toBeCloseTo(520, 1);
    expect(nearEdgeRule?.y1).toBeCloseTo(680, 1);

    const clampedRect = page.shapes?.find((s) => s.kind === 'rect' && s.fill === 0x3366cc);
    expect(clampedRect?.x0).toBeCloseTo(100, 1);
    expect(clampedRect?.x1).toBeCloseTo(220, 1);
  });

  it('applies Form XObject matrix/bbox clip and suppresses soft-mask group bitmaps while keeping page images', async () => {
    const formPdf = await pdfFromContentStream((ctx, resources) => {
      const formStream = ctx.stream(
        Buffer.from('0.2 0.6 0.4 rg 10 10 40 40 re f 120 10 40 40 re f', 'ascii'),
        {
          Type: PDFName.of('XObject'),
          Subtype: PDFName.of('Form'),
          BBox: ctx.obj([0, 0, 100, 100]),
          Matrix: ctx.obj([1, 0, 0, 1, 50, 50]),
          Resources: ctx.obj({}),
        }
      );
      resources.set(PDFName.of('XObject'), ctx.obj({ F1: ctx.register(formStream) }));
      return 'q /F1 Do Q 0 0 0 rg 10 700 30 30 re f';
    });

    const formExtracted = await analyzePdfPagesInProcess(formPdf, { geometry: 'none', content: true, images: false, colour: true });
    const formShapes = formExtracted.content[0].shapes ?? [];
    // Only the [10,10,50,50] inner rect (shifted +50,+50 -> [60, 700, 100, 740] top-down -> [60, 60..100]) + outer [10, 70, 40, 100] should survive; [120, 10] outside Form BBox [0,0,100,100] is clipped!
    const innerRects = formShapes.filter((s) => s.fill === 0x339966);
    expect(innerRects).toHaveLength(1);
    expect(innerRects[0].x0).toBeCloseTo(60, 1);
    expect(innerRects[0].x1).toBeCloseTo(100, 1);

    // Direct operator scan of beginGroup(smask) -> paintImageXObject -> endGroup -> visible paintImageXObject
    const pageContent = await readPageContent(
      OPS,
      {
        getViewport: () => ({ width: 400, height: 400, convertToViewportPoint: (x: number, y: number) => [x, 400 - y] as [number, number] }),
        commonObjs: { has: () => false, get: () => undefined },
        objs: { has: () => false, get: () => undefined },
        getOperatorList: async () => ({
          fnArray: [
            OPS.save,
            OPS.beginGroup,
            OPS.transform,
            OPS.paintImageXObject,
            OPS.endGroup,
            OPS.restore,
            OPS.save,
            OPS.transform,
            OPS.paintImageXObject,
            OPS.restore,
          ],
          argsArray: [
            [],
            [{ matrix: [1, 0, 0, 1, 0, 0], bbox: [0, 0, 100, 100], smask: { subtype: 'Luminosity', backdrop: '#000000' } }],
            [80, 0, 0, 80, 10, 10],
            ['mask_img_1', 64, 64],
            [],
            [],
            [],
            [120, 0, 0, 90, 50, 50],
            ['visible_img_2', 120, 90],
            [],
          ],
        }),
      },
      { items: [], styles: {} },
      1,
      new FontTable(),
      { readOperators: true, imageExtractor: null, unmappedMark: '', colour: true }
    );
    expect(pageContent.images).toHaveLength(1);
    expect(pageContent.images[0].pixelWidth).toBe(120);

    // Real pdf-lib ExtGState /SMask Form XObject containing both a mask bitmap and a mask fill shape.
    const realSmaskPdf = await pdfFromContentStream((ctx, resources) => {
      const imVisible = ctx.stream(Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]), {
        Type: PDFName.of('XObject'),
        Subtype: PDFName.of('Image'),
        Width: PDFNumber.of(2),
        Height: PDFNumber.of(2),
        BitsPerComponent: PDFNumber.of(8),
        ColorSpace: PDFName.of('DeviceRGB'),
      });
      const imMask = ctx.stream(Buffer.from([128, 255, 64, 192]), {
        Type: PDFName.of('XObject'),
        Subtype: PDFName.of('Image'),
        Width: PDFNumber.of(2),
        Height: PDFNumber.of(2),
        BitsPerComponent: PDFNumber.of(8),
        ColorSpace: PDFName.of('DeviceGray'),
      });
      const maskForm = ctx.stream(Buffer.from('0.5 g 10 10 80 80 re f q 100 0 0 100 50 50 cm /IM_M Do Q', 'ascii'), {
        Type: PDFName.of('XObject'),
        Subtype: PDFName.of('Form'),
        BBox: ctx.obj([0, 0, 200, 200]),
        Group: ctx.obj({ Type: PDFName.of('Group'), S: PDFName.of('Transparency'), CS: PDFName.of('DeviceGray') }),
        Resources: ctx.obj({ XObject: ctx.obj({ IM_M: ctx.register(imMask) }) }),
      });
      const gs = ctx.obj({
        Type: PDFName.of('ExtGState'),
        SMask: ctx.obj({ Type: PDFName.of('Mask'), S: PDFName.of('Luminosity'), G: ctx.register(maskForm) }),
      });
      resources.set(PDFName.of('ExtGState'), ctx.obj({ GS_M: ctx.register(gs) }));
      resources.set(PDFName.of('XObject'), ctx.obj({ IM_V: ctx.register(imVisible) }));
      return 'q /GS_M gs 120 0 0 90 50 100 cm /IM_V Do Q';
    });
    const smaskExtracted = await analyzePdfPagesInProcess(realSmaskPdf, { geometry: 'none', content: true, images: true, colour: true });
    expect(smaskExtracted.content[0].images).toHaveLength(1);
    expect(smaskExtracted.content[0].images[0].width).toBeCloseTo(120, 1);
    expect(smaskExtracted.content[0].shapes ?? []).toHaveLength(0);
  });

  it('keeps ragged stream cells and sparse 3x3 schematic box labels out of <a:tbl> in slides', async () => {
    const fonts = new Map();
    const mkLine = (text: string, x0: number, y0: number): LayoutLine => ({
      text,
      box: { x0, y0, x1: x0 + 60, y1: y0 + 10 },
      baseline: y0 + 8,
      runs: [{ text, bold: false, italic: false, monospace: false, color: '000000' }],
      size: 9,
      bold: false,
      italic: false,
      monospace: false,
      rtl: false,
      fontKey: 'f1',
      vertical: false,
    });
    const mkPara = (text: string, x0: number, y0: number): Paragraph => {
      const line = mkLine(text, x0, y0);
      return {
        runs: line.runs,
        text,
        lines: [line],
        box: line.box,
        size: 9,
        bold: false,
        italic: false,
        monospace: false,
        rtl: false,
        fontKey: 'f1',
        firstLineX: x0,
        leftX: x0,
        flow: 0,
        pageNumber: 1,
        full: false,
      };
    };
    const mkCell = (text: string | null, x0: number, y0: number, colSpan = 1, rowSpan = 1, continuation = false): TableCell => ({
      paragraphs: text ? [mkPara(text, x0, y0)] : [],
      colSpan,
      rowSpan,
      continuation,
      header: false,
    });
    const sparsePage: SlidePage = {
      width: 600,
      height: 800,
      images: [],
      rules: [
        { x0: 50, y0: 100, x1: 200, y1: 100, thickness: 1, color: 0x0000ff, z: 1 },
        { x0: 50, y0: 200, x1: 200, y1: 200, thickness: 1, color: 0x0000ff, z: 2 },
      ],
      shapes: [],
      blocks: [
        // 3x3 sparse lattice (2/9 = 22% filled)
        {
          kind: 'table',
          columns: 1,
          band: 0,
          table: {
            kind: 'lattice',
            pageNumber: 1,
            box: { x0: 50, y0: 100, x1: 200, y1: 200 },
            columnWidths: [50, 50, 50],
            rowEdges: [100, 130, 160, 200],
            rows: [
              [mkCell('SchematicBox', 60, 105, 3, 1), mkCell(null, 0, 0, 1, 1, true), mkCell(null, 0, 0, 1, 1, true)],
              [mkCell(null, 0, 0), mkCell('30 A', 105, 145, 1, 2), mkCell(null, 0, 0)],
              [mkCell(null, 0, 0), mkCell(null, 0, 0, 1, 1, true), mkCell(null, 0, 0)],
            ],
          },
        },
        // Ragged 2-column stream grid with 4 cells in row 1 (spanErr > 0)
        {
          kind: 'table',
          columns: 1,
          band: 0,
          table: {
            kind: 'stream',
            pageNumber: 1,
            box: { x0: 50, y0: 250, x1: 450, y1: 310 },
            columnWidths: [200, 200],
            rowEdges: [250, 270, 310],
            rows: [
              [mkCell('75 V', 60, 255), mkCell('40 A', 260, 255)],
              [mkCell('LabelA', 60, 285), mkCell('LabelB', 160, 285), mkCell('LabelC', 260, 285), mkCell('LabelD', 360, 285)],
            ],
          },
        },
      ],
    };

    const pptx = await writePackage([sparsePage], fonts, 'schematic-labels');
    const slideXml = await (await JSZip.loadAsync(pptx)).file('ppt/slides/slide1.xml')!.async('string');
    expect(slideXml).not.toContain('<a:tbl>');
    for (const label of ['SchematicBox', '30 A', '75 V', '40 A', 'LabelA', 'LabelB', 'LabelC', 'LabelD']) {
      expect(slideXml).toContain(label);
    }
  });

  it('bounds gradient stop counts, rejects malformed shadings, and guards save/group stack depth beyond PDF_CONTENT_MAX_STATE_DEPTH', async () => {
    const hugeStops = Array.from({ length: 50_000 }, (_, i) => [i / 49_999, i % 2 === 0 ? '#112233' : '#aabbcc']);
    const bounded = axialShadingGradient(
      ['RadialAxial', 'axial', null, hugeStops, [0, 0], [100, 0], null, null],
      { x0: 0, y0: 0, x1: 100, y1: 40 },
      (p) => p,
      1
    );
    expect(bounded?.kind).toBe('gradient');
    if (bounded?.kind === 'gradient') {
      expect(bounded.gradient.stops.length).toBeLessThanOrEqual(PDF_CONTENT_MAX_GRADIENT_STOPS);
    }

    expect(
      axialShadingGradient(
        ['RadialAxial', 'axial', null, [[0, 'transparent'], [1, 'transparent']], [0, 0], [100, 0], null, null],
        { x0: 0, y0: 0, x1: 100, y1: 40 },
        (p) => p,
        1
      )
    ).toBeNull();
    expect(
      axialShadingGradient(
        ['RadialAxial', 'axial', null, [[0, '#000000'], [1, '#ffffff']], [Number.NaN, 0], [100, 0], null, null],
        { x0: 0, y0: 0, x1: 100, y1: 40 },
        (p) => p,
        1
      )
    ).toBeNull();
    expect(
      axialShadingGradient(
        ['RadialAxial', 'radial', null, [[0, '#000000'], [1, '#ffffff']], [0, 0], [100, 0], 0, 50],
        { x0: 0, y0: 0, x1: 100, y1: 40 },
        (p) => p,
        1
      )
    ).toBeNull();

    // 0x0 degenerate clip hides subsequent draws, and NaN clip fails closed (returns null).
    expect(clipBoxOfSubpaths([{ points: [{ x: Number.NaN, y: 0 }, { x: 10, y: 10 }], closed: true }], (p) => p)).toBeNull();
    const zeroClip = clipBoxOfSubpaths(
      [{ points: [{ x: 10, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 10 }], closed: true }],
      (p) => p
    );
    expect(zeroClip?.x1).toBe(10);

    // 350 nested saves inside an active smask group must NOT pop smaskDepth early on matching restores.
    const deepSaves = Array.from({ length: PDF_CONTENT_MAX_STATE_DEPTH + 100 }, () => OPS.save);
    const deepRestores = Array.from({ length: PDF_CONTENT_MAX_STATE_DEPTH + 100 }, () => OPS.restore);
    const fnArray = [
      OPS.beginGroup,
      ...deepSaves,
      ...deepRestores,
      OPS.paintImageXObject,
      OPS.endGroup,
      OPS.paintImageXObject,
    ];
    const argsArray = [
      [{ smask: { subtype: 'Alpha' } }],
      ...deepSaves.map(() => []),
      ...deepRestores.map(() => []),
      ['still_inside_smask', 50, 50],
      [],
      ['outside_smask', 77, 77],
    ];
    const deepPage = await readPageContent(
      OPS,
      {
        getViewport: () => ({ width: 200, height: 200, convertToViewportPoint: (x: number, y: number) => [x, 200 - y] as [number, number] }),
        commonObjs: { has: () => false, get: () => undefined },
        objs: { has: () => false, get: () => undefined },
        getOperatorList: async () => ({ fnArray, argsArray }),
      },
      { items: [], styles: {} },
      1,
      new FontTable(),
      { readOperators: true, imageExtractor: null, unmappedMark: '', colour: true }
    );
    expect(deepPage.images).toHaveLength(1);
    expect(deepPage.images[0].pixelWidth).toBe(77);

    // Custom path gradient omits fill="none" from <a:path>.
    const props = shapeProperties(
      {
        kind: 'path',
        x0: 0,
        y0: 0,
        x1: 50,
        y1: 50,
        path: [0, 0, 0, 1, 50, 0, 1, 25, 50, 4],
        gradient: { kind: 'linear', angleDeg: 90, stops: [{ pos: 0, color: 0xff0000 }, { pos: 1, color: 0x0000ff }] },
        z: 1,
      },
      { x: (v) => v * 12700, y: (v) => v * 12700, length: (v) => v * 12700 }
    );
    expect(props).not.toContain('fill="none"');
    expect(props).toContain('<a:gradFill flip="none" rotWithShape="1">');
    expect(props).toContain('<a:lin ang="5400000" scaled="0"/>');
  });

  it('interpolates cropped and non-uniformly scaled axial gradients cleanly and collapses out-of-range shadings to solid fills', () => {
    const cropped = axialShadingGradient(
      ['RadialAxial', 'axial', null, [[0, '#ff0000'], [1, '#0000ff']], [0, 0], [200, 0], null, null],
      { x0: 50, y0: 0, x1: 150, y1: 50 },
      (p) => p,
      1
    );
    expect(cropped).toEqual({
      kind: 'gradient',
      gradient: {
        kind: 'linear',
        angleDeg: 0,
        stops: [
          { pos: 0, color: 0xbf0040 },
          { pos: 1, color: 0x4000bf },
        ],
      },
    });

    expect(
      axialShadingGradient(
        ['RadialAxial', 'axial', null, [[0, '#ff0000'], [1, '#0000ff']], [0, 0], [100, 0], null, null],
        { x0: 150, y0: 0, x1: 250, y1: 50 },
        (p) => p,
        1
      )
    ).toEqual({ kind: 'solid', color: 0x0000ff, alpha: 1 });

    expect(
      axialShadingGradient(
        ['RadialAxial', 'axial', null, [[0, '#ff0000'], [1, '#0000ff']], [100, 0], [200, 0], null, null],
        { x0: -100, y0: 0, x1: 50, y1: 50 },
        (p) => p,
        1
      )
    ).toEqual({ kind: 'solid', color: 0xff0000, alpha: 1 });

    const stretched = axialShadingGradient(
      ['RadialAxial', 'axial', null, [[0, '#ff0000'], [1, '#0000ff']], [0, 0], [100, 100], null, null],
      { x0: 0, y0: 0, x1: 200, y1: 100 },
      (p) => ({ x: p.x * 2, y: p.y }),
      1
    );
    expect(stretched?.kind).toBe('gradient');
    if (stretched?.kind === 'gradient') {
      expect(stretched.gradient.angleDeg).toBeCloseTo(63.435, 2);
      expect(stretched.gradient.stops).toEqual([
        { pos: 0, color: 0xff0000 },
        { pos: 1, color: 0x0000ff },
      ]);
    }
  });

  it('preserves curved Bezier clip hulls, clamps merged rects to clip, skips radial black placeholders, and forwards thick rule strokeAlpha to DOCX', async () => {
    const pdf = await pdfFromContentStream((ctx, resources) => {
      const fnRadial = ctx.obj({ FunctionType: 2, Domain: ctx.obj([0, 1]), C0: ctx.obj([1, 0, 0]), C1: ctx.obj([0, 0, 1]), N: PDFNumber.of(1) });
      const shRadial = ctx.obj({
        ShadingType: 3,
        ColorSpace: PDFName.of('DeviceRGB'),
        Coords: ctx.obj([100, 100, 10, 100, 100, 80]),
        Domain: ctx.obj([0, 1]),
        Extend: ctx.obj([true, true]),
        Function: ctx.register(fnRadial),
      });
      const patRadial = ctx.obj({ Type: PDFName.of('Pattern'), PatternType: PDFNumber.of(2), Shading: ctx.register(shRadial) });

      const fnConst = ctx.obj({ FunctionType: 2, Domain: ctx.obj([0, 1]), C0: ctx.obj([0.2, 0.4, 0.6]), C1: ctx.obj([0.2, 0.4, 0.6]), N: PDFNumber.of(1) });
      const shConst = ctx.obj({
        ShadingType: 2,
        ColorSpace: PDFName.of('DeviceRGB'),
        Coords: ctx.obj([0, 0, 100, 0]),
        Domain: ctx.obj([0, 1]),
        Extend: ctx.obj([true, true]),
        Function: ctx.register(fnConst),
      });
      const patConst = ctx.obj({ Type: PDFName.of('Pattern'), PatternType: PDFNumber.of(2), Shading: ctx.register(shConst) });

      const fnGrad = ctx.obj({ FunctionType: 2, Domain: ctx.obj([0, 1]), C0: ctx.obj([1, 0, 0]), C1: ctx.obj([0, 0, 1]), N: PDFNumber.of(1) });
      const shGrad = ctx.obj({
        ShadingType: 2,
        ColorSpace: PDFName.of('DeviceRGB'),
        Coords: ctx.obj([100, 0, 200, 0]),
        Domain: ctx.obj([0, 1]),
        Extend: ctx.obj([true, true]),
        Function: ctx.register(fnGrad),
      });
      const patGrad = ctx.obj({ Type: PDFName.of('Pattern'), PatternType: PDFNumber.of(2), Shading: ctx.register(shGrad) });

      const gsHalfStroke = ctx.obj({ Type: PDFName.of('ExtGState'), CA: 0.45 });
      resources.set(PDFName.of('ExtGState'), ctx.obj({ GSH: ctx.register(gsHalfStroke) }));
      resources.set(
        PDFName.of('Pattern'),
        ctx.obj({ PR: ctx.register(patRadial), PC: ctx.register(patConst), PG: ctx.register(patGrad) })
      );

      return [
        // 1. Curved 2-arc Bezier clip whose endpoints share y=500 while control points bulge y=[420..580].
        'q 100 500 m 100 580 200 580 200 500 c 200 420 100 420 100 500 c h W n 0.8 0.2 0.2 rg 110 450 80 100 re f Q',
        // 2. Adjacent rects inside clip [100..200] must clamp before merge (must not escape to x=250).
        'q 100 100 100 100 re W n 0.2 0.8 0.4 rg 100 150 50 20 re f 150 150 100 20 re f Q',
        // 3. Radial shading via Pattern cs/scn must NOT leave a solid black rect behind.
        'q /Pattern cs /PR scn 260 440 80 80 re f Q',
        // 4. Stroked path + constant axial shading fill merge resolves to solid 0x336699 (not 0x000000).
        'q 0 0 1 RG 1.5 w 300 100 m 400 100 l 350 200 l h S /Pattern cs /PC scn 300 100 m 400 100 l 350 200 l h f Q',
        // 5. Adjacent black solid rect + axial gradient rect must NOT merge into one black rect.
        'q 0 0 0 rg 50 620 50 40 re f /Pattern cs /PG scn 100 620 100 40 re f Q',
        // 6. Thick semi-transparent bar rule (>3pt) carries strokeAlpha -> DOCX bar rect alpha.
        'q /GSH gs 0.5 0.1 0.1 RG 6 w 50 700 m 220 700 l S Q',
      ].join('\n');
    });

    const extracted = await analyzePdfPagesInProcess(pdf, { geometry: 'none', content: true, images: false, colour: true });
    const shapes = extracted.content[0].shapes ?? [];

    const ovalClipRect = shapes.find((s) => s.kind === 'rect' && s.fill === 0xcc3333);
    expect(ovalClipRect?.x0).toBeCloseTo(110, 1);
    expect(ovalClipRect?.x1).toBeCloseTo(190, 1);

    const clippedMerged = shapes.find((s) => s.kind === 'rect' && s.fill === 0x33cc66);
    expect(clippedMerged?.x0).toBeCloseTo(100, 1);
    expect(clippedMerged?.x1).toBeCloseTo(200, 1);

    // Only the explicit [50..100] black rect should exist, never a radial placeholder at x0=260.
    const blackRects = shapes.filter((s) => s.kind === 'rect' && s.fill === 0);
    expect(blackRects).toHaveLength(1);
    expect(blackRects[0].x0).toBeCloseTo(50, 1);
    expect(shapes.some((s) => s.kind === 'rect' && s.gradient !== undefined && Math.abs(s.x0 - 100) < 1)).toBe(true);

    const mergedConstTriangle = shapes.find((s) => s.kind === 'path' && s.stroke === 0x0000ff);
    expect(mergedConstTriangle?.fill).toBe(0x336699);

    const { extracted: docExtracted } = await readPdfDocument(pdf, { images: false, colour: true, pages: true });
    const docx = await documentToDocx(docExtracted.model);
    const docXml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(docXml).toContain('<a:alpha val="45000"/>');
  });

  it('retains clipped Bezier curves whose control-point hull crosses the clip while culling disjoint curves and malformed hulls', async () => {
    const pdf = await pdfFromContentStream((ctx, resources) => {
      const fn = ctx.obj({ FunctionType: 2, Domain: ctx.obj([0, 1]), C0: ctx.obj([0.1, 0.7, 0.2]), C1: ctx.obj([0.9, 0.9, 0.1]), N: PDFNumber.of(1) });
      const sh = ctx.obj({
        ShadingType: 2,
        ColorSpace: PDFName.of('DeviceRGB'),
        Coords: ctx.obj([100, 0, 300, 0]),
        Domain: ctx.obj([0, 1]),
        Extend: ctx.obj([true, true]),
        Function: ctx.register(fn),
      });
      const pat = ctx.obj({ Type: PDFName.of('Pattern'), PatternType: PDFNumber.of(2), Shading: ctx.register(sh) });
      resources.set(PDFName.of('Pattern'), ctx.obj({ PG: ctx.register(pat) }));
      return [
        'q',
        // Viewport clip x=[100..300], y=[200..360] (bottom-up 440..600)
        '100 440 200 160 re W n',
        // Curve 1: endpoints at x=20 (outside clip), control points at x=220 (bulges into clip) -> MUST BE KEPT
        '0.2 0.4 0.8 RG 2 w 20 480 m 220 480 220 560 20 560 c S',
        // Curve 2: endpoints at x=10 and control points at x=60 (entire hull left of clip) -> MUST BE CULLED
        '0.8 0.2 0.2 RG 2 w 10 480 m 60 480 60 560 10 560 c S',
        // Clipped solid rect [80..140] -> clamped [100..140], and clipped axial gradient [160..340] -> clamped [160..300]
        '0.2 0.6 0.8 rg 80 460 60 40 re f',
        '/Pattern cs /PG scn 160 520 180 40 re f',
        'Q',
      ].join('\n');
    });

    const extracted = await analyzePdfPagesInProcess(pdf, { geometry: 'none', content: true, images: false, colour: true });
    const shapes = extracted.content[0].shapes ?? [];

    expect(shapes.some((s) => s.kind === 'path' && s.stroke === 0x3366cc)).toBe(true);
    expect(shapes.some((s) => s.kind === 'path' && s.stroke === 0xcc3333)).toBe(false);

    const solidClamped = shapes.find((s) => s.kind === 'rect' && s.fill === 0x3399cc);
    expect(solidClamped?.x0).toBeCloseTo(100, 1);
    expect(solidClamped?.x1).toBeCloseTo(140, 1);

    const gradClamped = shapes.find((s) => s.kind === 'rect' && s.gradient !== undefined);
    expect(gradClamped?.x0).toBeCloseTo(160, 1);
    expect(gradClamped?.x1).toBeCloseTo(300, 1);

    // Fail-closed hull checks on empty, unknown opcode, truncated operands, and non-finite coordinates
    expect(subpathHullBox({ points: [], closed: false }, (p) => p)).toBeNull();
    expect(subpathHullBox({ points: [{ x: 0, y: 0 }], closed: false, curved: true, segments: [99, 0, 0] }, (p) => p)).toBeNull();
    expect(subpathHullBox({ points: [{ x: 0, y: 0 }], closed: false, curved: true, segments: [2, 0, 0, 10] }, (p) => p)).toBeNull();
    expect(subpathHullBox({ points: [{ x: Number.NaN, y: 0 }], closed: false }, (p) => p)).toBeNull();
    expect(clipBoxOfSubpaths([{ points: [{ x: 0, y: 0 }], closed: false, curved: true, segments: [2, 0, 0, 10] }], (p) => p)).toBeNull();
  });

  it('preserves curved axial gradients across control-point hulls, keeps closed single-Bezier loops, drops thin radial/pattern black rules, and restores overflow smask depth', async () => {
    const pdf = await pdfFromContentStream((ctx, resources) => {
      const fnAxial = ctx.obj({ FunctionType: 2, Domain: ctx.obj([0, 1]), C0: ctx.obj([1, 0, 0]), C1: ctx.obj([0, 0, 1]), N: PDFNumber.of(1) });
      const shAxial = ctx.obj({
        ShadingType: 2,
        ColorSpace: PDFName.of('DeviceRGB'),
        Coords: ctx.obj([100, 420, 100, 580]),
        Domain: ctx.obj([0, 1]),
        Extend: ctx.obj([true, true]),
        Function: ctx.register(fnAxial),
      });
      const patAxial = ctx.obj({ Type: PDFName.of('Pattern'), PatternType: PDFNumber.of(2), Shading: ctx.register(shAxial) });

      const fnRadial = ctx.obj({ FunctionType: 2, Domain: ctx.obj([0, 1]), C0: ctx.obj([0, 1, 0]), C1: ctx.obj([1, 1, 0]), N: PDFNumber.of(1) });
      const shRadial = ctx.obj({
        ShadingType: 3,
        ColorSpace: PDFName.of('DeviceRGB'),
        Coords: ctx.obj([200, 300, 5, 200, 300, 90]),
        Domain: ctx.obj([0, 1]),
        Extend: ctx.obj([true, true]),
        Function: ctx.register(fnRadial),
      });
      const patRadial = ctx.obj({ Type: PDFName.of('Pattern'), PatternType: PDFNumber.of(2), Shading: ctx.register(shRadial) });

      resources.set(PDFName.of('Pattern'), ctx.obj({ PA: ctx.register(patAxial), PR: ctx.register(patRadial) }));
      return [
        // 1. 2-arc Bezier oval with horizontal endpoints (y=500) filled with vertical axial gradient [y=420..580]
        'q /Pattern cs /PA scn 100 500 m 100 580 200 580 200 500 c 200 420 100 420 100 500 c h f Q',
        // 2. Single-cubic closed Bezier loop whose start and end points coincide at (350, 500)
        'q 0.2 0.5 0.8 rg 350 500 m 470 620 470 380 350 500 c h f Q',
        // 3. Thin 2pt bar filled with radial shading must NOT emit a black rule placeholder
        'q /Pattern cs /PR scn 100 300 200 2 re f Q',
      ].join('\n');
    });

    const extracted = await analyzePdfPagesInProcess(pdf, { geometry: 'none', content: true, images: false, colour: true });
    const page = extracted.content[0];
    const shapes = page.shapes ?? [];

    const gradOval = shapes.find((s) => s.kind === 'path' && s.gradient !== undefined);
    expect(gradOval).toBeDefined();
    expect(gradOval?.y0).toBeCloseTo(220, 1);
    expect(gradOval?.y1).toBeCloseTo(380, 1);
    expect(gradOval?.gradient?.angleDeg).toBeCloseTo(270, 1);
    expect(gradOval?.gradient?.stops[0].color).toBe(0xff0000);
    expect(gradOval?.gradient?.stops.at(-1)?.color).toBe(0x0000ff);

    const loopShape = shapes.find((s) => s.kind === 'path' && s.fill === 0x3380cc);
    expect(loopShape).toBeDefined();
    expect(loopShape?.x1).toBeCloseTo(470, 1);

    // Only the solid/gradient shapes exist; radial thin bar emitted zero black rules.
    expect(page.rules).toHaveLength(0);

    // 256 saves + nested >256 smask groups in overflow + matching endGroups -> visible image after endGroup survives.
    const saves = Array.from({ length: PDF_CONTENT_MAX_STATE_DEPTH }, () => OPS.save);
    const restores = Array.from({ length: PDF_CONTENT_MAX_STATE_DEPTH }, () => OPS.restore);
    const nestedSmasks = Array.from({ length: PDF_CONTENT_MAX_STATE_DEPTH + 10 }, () => OPS.beginGroup);
    const nestedEnds = Array.from({ length: PDF_CONTENT_MAX_STATE_DEPTH + 10 }, () => OPS.endGroup);
    const overflowPage = await readPageContent(
      OPS,
      {
        getViewport: () => ({ width: 200, height: 200, convertToViewportPoint: (x: number, y: number) => [x, 200 - y] as [number, number] }),
        commonObjs: { has: () => false, get: () => undefined },
        objs: { has: () => false, get: () => undefined },
        getOperatorList: async () => ({
          fnArray: [
            ...saves,
            ...nestedSmasks,
            OPS.paintImageXObject,
            OPS.constructPath,
            ...nestedEnds,
            OPS.paintImageXObject,
            ...restores,
          ],
          argsArray: [
            ...saves.map(() => []),
            ...nestedSmasks.map(() => [{ smask: { subtype: 'Alpha' } }]),
            ['mask_img', 10, 10],
            [OPS.fill, [new Float32Array([0, 10, 10, 2, 20, 30])], null],
            ...nestedEnds.map(() => []),
            ['visible_after_overflow_smask', 88, 88],
            ...restores.map(() => []),
          ],
        }),
      },
      { items: [], styles: {} },
      1,
      new FontTable(),
      { readOperators: true, imageExtractor: null, unmappedMark: '', colour: true }
    );
    expect(overflowPage.images).toHaveLength(1);
    expect(overflowPage.images[0].pixelWidth).toBe(88);

    // Fail-closed extentOf on truncated/unknown/NaN paths.
    expect(Number.isFinite(extentOf([2, 0, 0, 10]).x0)).toBe(false);
    expect(Number.isFinite(extentOf([99, 0, 0]).x0)).toBe(false);
    expect(Number.isFinite(extentOf([0, Number.NaN, 0]).x0)).toBe(false);
  });

  it('preserves thin rules under TilingPattern (PatternType 1) fills and strokes while suppressing Shading (PatternType 2) bars', async () => {
    const pdf = await pdfFromContentStream((ctx, resources) => {
      const tilingPattern = ctx.stream(Buffer.from('0 0 0 rg 0 0 2 2 re f', 'ascii'), {
        Type: PDFName.of('Pattern'),
        PatternType: PDFNumber.of(1),
        PaintType: PDFNumber.of(1),
        TilingType: PDFNumber.of(1),
        BBox: ctx.obj([0, 0, 4, 4]),
        XStep: PDFNumber.of(4),
        YStep: PDFNumber.of(4),
        Resources: ctx.obj({}),
      });
      const fnRadial = ctx.obj({ FunctionType: 2, Domain: ctx.obj([0, 1]), C0: ctx.obj([0, 1, 0]), C1: ctx.obj([1, 1, 0]), N: PDFNumber.of(1) });
      const shRadial = ctx.obj({
        ShadingType: 3,
        ColorSpace: PDFName.of('DeviceRGB'),
        Coords: ctx.obj([200, 300, 5, 200, 300, 90]),
        Domain: ctx.obj([0, 1]),
        Extend: ctx.obj([true, true]),
        Function: ctx.register(fnRadial),
      });
      const patRadial = ctx.obj({ Type: PDFName.of('Pattern'), PatternType: PDFNumber.of(2), Shading: ctx.register(shRadial) });

      resources.set(PDFName.of('Pattern'), ctx.obj({ PT1: ctx.register(tilingPattern), PR: ctx.register(patRadial) }));
      return [
        // 1. Filled thin bar under PatternType 1 (TilingPattern) -> MUST preserve rule (y0=800-600.75=199.25)
        'q /Pattern cs /PT1 scn 50 600 200 1.5 re f Q',
        // 2. Filled thin bar under PatternType 2 radial Shading -> MUST emit zero rules
        'q /Pattern cs /PR scn 50 500 200 2 re f Q',
        // 3. Stroked thin line under PatternType 1 (TilingPattern) -> MUST preserve rule (y0=800-400=400)
        'q /Pattern CS /PT1 SCN 1.2 w 50 400 m 250 400 l S Q',
        // 4. Stroked thin line under PatternType 2 radial Shading -> MUST emit zero rules
        'q /Pattern CS /PR SCN 1.2 w 50 300 m 250 300 l S Q',
        // 5. Shading state cleared by subsequent solid colour -> solid rule at y=200 (fill) and y=150 (stroke) kept
        'q /Pattern cs /PR scn 50 250 200 1.5 re f 0 0 0 rg 50 200 200 1.5 re f Q',
        'q /Pattern CS /PR SCN 1 w 50 180 m 250 180 l S 0 0 0 RG 50 150 m 250 150 l S Q',
      ].join('\n');
    });

    const extracted = await analyzePdfPagesInProcess(pdf, { geometry: 'none', content: true, images: false, colour: true });
    const page = extracted.content[0];

    expect(page.rules).toHaveLength(4);
    expect(page.rules.some((r) => Math.abs(r.y0 - 199.25) < 1 && r.x1 - r.x0 > 190)).toBe(true);
    expect(page.rules.some((r) => Math.abs(r.y0 - 400) < 1 && r.x1 - r.x0 > 190)).toBe(true);
    expect(page.rules.some((r) => Math.abs(r.y0 - 599.25) < 1 && r.x1 - r.x0 > 190)).toBe(true);
    expect(page.rules.some((r) => Math.abs(r.y0 - 650) < 1 && r.x1 - r.x0 > 190)).toBe(true);
    // Neither radial filled (y=299) nor radial stroked (y=500, y=620) bars produced rules.
    expect(page.rules.some((r) => Math.abs(r.y0 - 299) < 2 || Math.abs(r.y0 - 500) < 2 || Math.abs(r.y0 - 620) < 2)).toBe(false);

    // Isolated PatternType 2 radial fill emits zero rules and zero placeholder shapes.
    const radialOnlyPdf = await pdfFromContentStream((ctx, resources) => {
      const fnRadial = ctx.obj({ FunctionType: 2, Domain: ctx.obj([0, 1]), C0: ctx.obj([0, 1, 0]), C1: ctx.obj([1, 1, 0]), N: PDFNumber.of(1) });
      const shRadial = ctx.obj({
        ShadingType: 3,
        ColorSpace: PDFName.of('DeviceRGB'),
        Coords: ctx.obj([150, 400, 5, 150, 400, 90]),
        Domain: ctx.obj([0, 1]),
        Extend: ctx.obj([true, true]),
        Function: ctx.register(fnRadial),
      });
      const patRadial = ctx.obj({ Type: PDFName.of('Pattern'), PatternType: PDFNumber.of(2), Shading: ctx.register(shRadial) });
      resources.set(PDFName.of('Pattern'), ctx.obj({ PR: ctx.register(patRadial) }));
      return 'q /Pattern cs /PR scn 50 400 200 2 re f Q';
    });
    const radialOnly = await analyzePdfPagesInProcess(radialOnlyPdf, { geometry: 'none', content: true, images: false, colour: true });
    expect(radialOnly.content[0].rules).toHaveLength(0);
    expect(radialOnly.content[0].shapes ?? []).toHaveLength(0);

    // PaintType 1 under [/Pattern /DeviceRGB] ignores args[1] (1 1 1), while PaintType 2 uses base colour on both fill (scn) and stroke (SCN) without turning large pattern rects into solid shapes.
    const paintTypePdf = await pdfFromContentStream((ctx, resources) => {
      const coloured = ctx.stream(Buffer.from('0 0 0 rg 0 0 2 2 re f', 'ascii'), {
        Type: PDFName.of('Pattern'),
        PatternType: PDFNumber.of(1),
        PaintType: PDFNumber.of(1),
        TilingType: PDFNumber.of(1),
        BBox: ctx.obj([0, 0, 4, 4]),
        XStep: PDFNumber.of(4),
        YStep: PDFNumber.of(4),
        Resources: ctx.obj({}),
      });
      const uncoloured = ctx.stream(Buffer.from('0 0 2 2 re f', 'ascii'), {
        Type: PDFName.of('Pattern'),
        PatternType: PDFNumber.of(1),
        PaintType: PDFNumber.of(2),
        TilingType: PDFNumber.of(1),
        BBox: ctx.obj([0, 0, 4, 4]),
        XStep: PDFNumber.of(4),
        YStep: PDFNumber.of(4),
        Resources: ctx.obj({}),
      });
      resources.set(PDFName.of('Pattern'), ctx.obj({ PT1: ctx.register(coloured), PT2: ctx.register(uncoloured) }));
      resources.set(PDFName.of('ColorSpace'), ctx.obj({ PSpace: ctx.obj([PDFName.of('Pattern'), PDFName.of('DeviceRGB')]) }));
      return [
        // PaintType 1 with [/Pattern /DeviceRGB] and 1 1 1 /PT1 scn -> ignores #ffffff args[1], preserves rule at y0=99.25
        'q /PSpace cs 1 1 1 /PT1 scn 50 700 200 1.5 re f Q',
        // PaintType 2 light fill (#ffffff) -> suppressed (0 rules)
        'q /PSpace cs 1 1 1 /PT2 scn 50 600 200 1.5 re f Q',
        // PaintType 2 coloured fill (#3366cc) -> 1 rule with color=0x3366cc at y0=299.25
        'q /PSpace cs 0.2 0.4 0.8 /PT2 scn 50 500 200 1.5 re f Q',
        // PaintType 2 large hatched fill rect -> 0 rules and 0 solid shapes
        'q /PSpace cs 0.2 0.4 0.8 /PT2 scn 50 380 200 80 re f Q',
        // PaintType 1 stroke with [/Pattern /DeviceRGB] and 1 1 1 /PT1 SCN -> ignores #ffffff args[1], preserves rule with undefined colour
        'q /PSpace CS 1 1 1 /PT1 SCN 1.5 w 50 340 m 250 340 l S Q',
        // PaintType 2 white stroke (#ffffff) -> color=0xffffff matching 1 1 1 RG, plus #3366cc stroke -> color=0x3366cc
        'q /PSpace CS 1 1 1 /PT2 SCN 1.5 w 50 300 m 250 300 l S Q',
        'q 1 1 1 RG 1.5 w 50 260 m 250 260 l S Q',
        'q /PSpace CS 0.2 0.4 0.8 /PT2 SCN 1.5 w 50 220 m 250 220 l S Q',
        // PaintType 2 diagonal curved stroke -> 0 rules and 0 solid shapes
        'q /PSpace CS 0.2 0.4 0.8 /PT2 SCN 1.5 w 50 100 m 120 150 200 130 250 140 c S Q',
      ].join('\n');
    });
    const paintTypePage = (await analyzePdfPagesInProcess(paintTypePdf, { geometry: 'none', content: true, images: false, colour: true })).content[0];
    expect(paintTypePage.shapes ?? []).toHaveLength(0);
    expect(paintTypePage.rules).toHaveLength(6);
    const pt1Rule = paintTypePage.rules.find((r) => Math.abs(r.y0 - 99.25) < 1);
    expect(pt1Rule?.color).toBeUndefined();
    expect(paintTypePage.rules.some((r) => Math.abs(r.y0 - 199.25) < 1)).toBe(false);
    const pt2BlueFill = paintTypePage.rules.find((r) => Math.abs(r.y0 - 299.25) < 1);
    expect(pt2BlueFill?.color).toBe(0x3366cc);
    const pt1Stroke = paintTypePage.rules.find((r) => Math.abs(r.y0 - 460) < 1);
    expect(pt1Stroke?.color).toBeUndefined();
    const pt2WhiteStroke = paintTypePage.rules.find((r) => Math.abs(r.y0 - 500) < 1);
    const rgbWhiteStroke = paintTypePage.rules.find((r) => Math.abs(r.y0 - 540) < 1);
    expect(pt2WhiteStroke?.color).toBe(0xffffff);
    expect(rgbWhiteStroke?.color).toBe(0xffffff);
    const pt2BlueStroke = paintTypePage.rules.find((r) => Math.abs(r.y0 - 580) < 1);
    expect(pt2BlueStroke?.color).toBe(0x3366cc);

    // Malformed synthetic setFillColorN(['Shading']) lacking an objId must still suppress placeholder rules.
    const malformedShadingPage = await readPageContent(
      OPS,
      {
        getViewport: () => ({ width: 300, height: 200, convertToViewportPoint: (x: number, y: number) => [x, 200 - y] as [number, number] }),
        commonObjs: { has: () => false, get: () => undefined },
        objs: { has: () => false, get: () => undefined },
        getOperatorList: async () => ({
          fnArray: [OPS.setFillColorN, OPS.constructPath],
          argsArray: [['Shading'], [OPS.fill, [new Float32Array([0, 10, 50, 1, 210, 50, 1, 210, 51.5, 1, 10, 51.5, 4])], null]],
        }),
      },
      { items: [], styles: {} },
      1,
      new FontTable(),
      { readOperators: true, imageExtractor: null, unmappedMark: '', colour: true }
    );
    expect(malformedShadingPage.rules).toHaveLength(0);
  });

  it('matches rule geometry between colour: false and colour: true across patterns, shadings, zero-alpha GState, and explicit transparency', async () => {
    const pdf = await pdfFromContentStream((ctx, resources) => {
      const coloured = ctx.stream(Buffer.from('0 0 0 rg 0 0 2 2 re f', 'ascii'), {
        Type: PDFName.of('Pattern'),
        PatternType: PDFNumber.of(1),
        PaintType: PDFNumber.of(1),
        TilingType: PDFNumber.of(1),
        BBox: ctx.obj([0, 0, 4, 4]),
        XStep: PDFNumber.of(4),
        YStep: PDFNumber.of(4),
        Resources: ctx.obj({}),
      });
      const uncoloured = ctx.stream(Buffer.from('0 0 2 2 re f', 'ascii'), {
        Type: PDFName.of('Pattern'),
        PatternType: PDFNumber.of(1),
        PaintType: PDFNumber.of(2),
        TilingType: PDFNumber.of(1),
        BBox: ctx.obj([0, 0, 4, 4]),
        XStep: PDFNumber.of(4),
        YStep: PDFNumber.of(4),
        Resources: ctx.obj({}),
      });
      const fnAxial = ctx.obj({ FunctionType: 2, Domain: ctx.obj([0, 1]), C0: ctx.obj([0, 0, 0]), C1: ctx.obj([1, 1, 1]), N: PDFNumber.of(1) });
      const shAxial = ctx.obj({
        ShadingType: 2,
        ColorSpace: PDFName.of('DeviceRGB'),
        Coords: ctx.obj([50, 500, 250, 500]),
        Domain: ctx.obj([0, 1]),
        Extend: ctx.obj([true, true]),
        Function: ctx.register(fnAxial),
      });
      const patAxial = ctx.obj({ Type: PDFName.of('Pattern'), PatternType: PDFNumber.of(2), Shading: ctx.register(shAxial) });
      const fnRadial = ctx.obj({ FunctionType: 2, Domain: ctx.obj([0, 1]), C0: ctx.obj([0, 1, 0]), C1: ctx.obj([0, 0, 1]), N: PDFNumber.of(1) });
      const shRadial = ctx.obj({
        ShadingType: 3,
        ColorSpace: PDFName.of('DeviceRGB'),
        Coords: ctx.obj([150, 400, 5, 150, 400, 90]),
        Domain: ctx.obj([0, 1]),
        Extend: ctx.obj([true, true]),
        Function: ctx.register(fnRadial),
      });
      const patRadial = ctx.obj({ Type: PDFName.of('Pattern'), PatternType: PDFNumber.of(2), Shading: ctx.register(shRadial) });
      const gsFillZero = ctx.obj({ Type: PDFName.of('ExtGState'), ca: 0 });
      const gsStrokeZero = ctx.obj({ Type: PDFName.of('ExtGState'), CA: 0 });
      const gsThickDash = ctx.obj({ Type: PDFName.of('ExtGState'), LW: 2.5, D: ctx.obj([ctx.obj([4, 2]), 0]) });

      resources.set(
        PDFName.of('Pattern'),
        ctx.obj({ PT1: ctx.register(coloured), PT2: ctx.register(uncoloured), PA: ctx.register(patAxial), PR: ctx.register(patRadial) })
      );
      resources.set(PDFName.of('ColorSpace'), ctx.obj({ PSpace: ctx.obj([PDFName.of('Pattern'), PDFName.of('DeviceRGB')]) }));
      resources.set(
        PDFName.of('ExtGState'),
        ctx.obj({ GSCa0: ctx.register(gsFillZero), GSCA0: ctx.register(gsStrokeZero), GSLW: ctx.register(gsThickDash) })
      );
      return [
        // 1. 1 1 1 rg followed by PT1 fill under [/Pattern /DeviceRGB] (preserved) and dark PT2 fill (preserved)
        'q 1 1 1 rg /PSpace cs 1 1 1 /PT1 scn 50 700 200 1.5 re f Q',
        'q 1 1 1 rg /PSpace cs 0.2 0.4 0.8 /PT2 scn 50 650 200 1.5 re f Q',
        // 2. Light PT2 fill -> suppressed in both modes
        'q /PSpace cs 1 1 1 /PT2 scn 50 600 200 1.5 re f Q',
        // 3. Axial & radial Shading fills and strokes -> suppressed in both modes
        'q /Pattern cs /PA scn 50 520 200 1.5 re f Q',
        'q /Pattern CS /PA SCN 1.5 w 50 480 m 250 480 l S Q',
        'q /Pattern cs /PR scn 50 440 200 1.5 re f Q',
        'q /Pattern CS /PR SCN 1.5 w 50 400 m 250 400 l S Q',
        // 4. ca=0 / CA=0 via setGState -> suppressed in both modes
        'q /GSCa0 gs 0 0 0 rg 50 360 200 1.5 re f Q',
        'q /GSCA0 gs 0 0 0 RG 1.5 w 50 320 m 250 320 l S Q',
        // 5. GState LW & D -> geometry identical, colour: false omits colour/dashed/z
        'q /GSLW gs 0.2 0.4 0.8 RG 50 280 m 250 280 l S Q',
      ].join('\n');
    });

    const withColour = (await analyzePdfPagesInProcess(pdf, { geometry: 'none', content: true, images: false, colour: true })).content[0].rules;
    const withoutColour = (await analyzePdfPagesInProcess(pdf, { geometry: 'none', content: true, images: false, colour: false })).content[0].rules;

    expect(withColour).toHaveLength(3);
    expect(withoutColour).toEqual(withColour.map(({ x0, y0, x1, y1, thickness }) => ({ x0, y0, x1, y1, thickness })));
    expect(withoutColour[0].y0).toBeCloseTo(99.25, 1);
    expect(withoutColour[1].y0).toBeCloseTo(149.25, 1);
    expect(withoutColour[2].y0).toBeCloseTo(520, 1);
    expect(withoutColour[2].thickness).toBeCloseTo(2.5, 2);

    // Direct OPS verification of setFillTransparent / setStrokeTransparent parity between colour: false and colour: true.
    const transparentList = {
      fnArray: [
        OPS.setFillRGBColor,
        OPS.setFillTransparent,
        OPS.constructPath,
        OPS.setStrokeRGBColor,
        OPS.setStrokeTransparent,
        OPS.constructPath,
        OPS.setFillRGBColor,
        OPS.constructPath,
      ],
      argsArray: [
        ['#000000'],
        [],
        [OPS.fill, [new Float32Array([0, 20, 100, 1, 220, 100, 1, 220, 101.5, 1, 20, 101.5, 4])], null],
        ['#000000'],
        [],
        [OPS.stroke, [new Float32Array([0, 20, 140, 1, 220, 140])], null],
        ['#3366cc'],
        [OPS.fill, [new Float32Array([0, 20, 170, 1, 220, 170, 1, 220, 171.5, 1, 20, 171.5, 4])], null],
      ],
    };
    const mkPage = () => ({
      getViewport: () => ({ width: 300, height: 200, convertToViewportPoint: (x: number, y: number) => [x, 200 - y] as [number, number] }),
      commonObjs: { has: () => false, get: () => undefined },
      objs: { has: () => false, get: () => undefined },
      getOperatorList: async () => transparentList,
    });
    const tColour = (await readPageContent(OPS, mkPage(), { items: [], styles: {} }, 1, new FontTable(), { readOperators: true, imageExtractor: null, unmappedMark: '', colour: true })).rules;
    const tNoColour = (await readPageContent(OPS, mkPage(), { items: [], styles: {} }, 1, new FontTable(), { readOperators: true, imageExtractor: null, unmappedMark: '', colour: false })).rules;
    expect(tColour).toHaveLength(1);
    expect(tNoColour).toEqual(tColour.map(({ x0, y0, x1, y1, thickness }) => ({ x0, y0, x1, y1, thickness })));
  });
});
