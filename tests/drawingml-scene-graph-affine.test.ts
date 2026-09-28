import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  identityMatrix,
  translationMatrix,
  scaleMatrix,
  rotationMatrix,
  multiplyMatrix,
  transformPoint,
  computeGroupTransformMatrix,
  parseDrawingMlShapes,
  parsePptxSlideSceneGraph,
  convertOffice,
  type Matrix2D,
} from '../src/lib/conversions/office';

describe('DrawingML 2D Scene Graph & Affine Transform Matrix (ISO/IEC 29500-1 §20.1.7.6)', () => {
  describe('1. Homogeneous 2D Affine Matrix Math', () => {
    it('produces standard 3x2 identity affine matrix', () => {
      const id = identityMatrix();
      expect(id).toEqual([1, 0, 0, 1, 0, 0]);
      const pt = transformPoint(id, 123.45, 678.9);
      expect(pt.x).toBeCloseTo(123.45, 5);
      expect(pt.y).toBeCloseTo(678.9, 5);
    });

    it('correctly composes translation and scale matrices', () => {
      // T(50, 100) * S(2, 3)
      const t = translationMatrix(50, 100);
      const s = scaleMatrix(2, 3);
      const m = multiplyMatrix(t, s);

      // (x, y) = (10, 10) -> S(2, 3) -> (20, 30) -> T(50, 100) -> (70, 130)
      const pt = transformPoint(m, 10, 10);
      expect(pt.x).toBeCloseTo(70, 5);
      expect(pt.y).toBeCloseTo(130, 5);
    });

    it('correctly transforms points under 90-degree clockwise rotation', () => {
      // R(90 deg) around origin
      const r = rotationMatrix(90);
      const pt = transformPoint(r, 10, 0);
      expect(pt.x).toBeCloseTo(0, 5);
      expect(pt.y).toBeCloseTo(10, 5);
    });

    it('computes ISO/IEC 29500-1 group transform matrix mapping child coordinates to parent box', () => {
      // Parent: off=(100, 100), ext=(200, 100) -> center=(200, 150)
      // Child: chOff=(0, 0), chExt=(1000, 500) -> center=(500, 250)
      // Expected scale: sx = 200/1000 = 0.2, sy = 100/500 = 0.2
      const m = computeGroupTransformMatrix(
        { x: 100, y: 100 },
        { cx: 200, cy: 100 },
        { x: 0, y: 0 },
        { cx: 1000, cy: 500 }
      );

      // Child center (500, 250) should map exactly to parent center (200, 150)
      const centerPt = transformPoint(m, 500, 250);
      expect(centerPt.x).toBeCloseTo(200, 4);
      expect(centerPt.y).toBeCloseTo(150, 4);

      // Child origin (0, 0) should map to parent top-left (100, 100)
      const originPt = transformPoint(m, 0, 0);
      expect(originPt.x).toBeCloseTo(100, 4);
      expect(originPt.y).toBeCloseTo(100, 4);

      // Child bottom-right (1000, 500) should map to parent bottom-right (300, 200)
      const brPt = transformPoint(m, 1000, 500);
      expect(brPt.x).toBeCloseTo(300, 4);
      expect(brPt.y).toBeCloseTo(200, 4);
    });

    it('correctly applies flipH and flipV in group transform matrix', () => {
      // Parent: off=(100, 100), ext=(200, 100)
      // Child: chOff=(0, 0), chExt=(1000, 500) with flipH=true
      const m = computeGroupTransformMatrix(
        { x: 100, y: 100 },
        { cx: 200, cy: 100 },
        { x: 0, y: 0 },
        { cx: 1000, cy: 500 },
        0,
        true,
        false
      );

      // Under flipH, child left (0, 250) should map to parent right (300, 150)
      const leftPt = transformPoint(m, 0, 250);
      expect(leftPt.x).toBeCloseTo(300, 4);
      expect(leftPt.y).toBeCloseTo(150, 4);

      // Under flipH, child right (1000, 250) should map to parent left (100, 150)
      const rightPt = transformPoint(m, 1000, 250);
      expect(rightPt.x).toBeCloseTo(100, 4);
      expect(rightPt.y).toBeCloseTo(150, 4);
    });
  });

  describe('2. DrawingML Parser Scene Graph & Transform Accumulation', () => {
    it('recursively accumulates transforms for nested <p:grpSp> group shapes in parseDrawingMlShapes', () => {
      const xml = `
        <p:spTree xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <!-- Outer Group: parent off=(100, 100), ext=(400, 400), child box chOff=(0, 0), chExt=(2000, 2000) -> scale 0.2 -->
          <p:grpSp>
            <p:grpSpPr>
              <a:xfrm>
                <a:off x="1270000" y="1270000"/>
                <a:ext cx="5080000" cy="5080000"/>
                <a:chOff x="0" y="0"/>
                <a:chExt cx="25400000" cy="25400000"/>
              </a:xfrm>
            </p:grpSpPr>
            
            <!-- Shape inside outer group: child coord (500, 500), size (500, 500) -->
            <!-- In world coords: off = 100 + 500*0.2 = 200, size = 500*0.2 = 100 -->
            <p:sp>
              <p:spPr>
                <a:xfrm>
                  <a:off x="6350000" y="6350000"/>
                  <a:ext cx="6350000" cy="6350000"/>
                </a:xfrm>
                <a:prstGeom prst="roundRect"/>
                <a:solidFill><a:srgbClr val="5C6BC0"/></a:solidFill>
              </p:spPr>
            </p:sp>

            <!-- Nested Inner Group: off=(1000, 1000), ext=(1000, 1000), chOff=(0, 0), chExt=(100, 100) -->
            <!-- In outer coords: off=(1000, 1000), ext=(1000, 1000). Child scale inside = 1000/100 = 10 -->
            <p:grpSp>
              <p:grpSpPr>
                <a:xfrm>
                  <a:off x="12700000" y="12700000"/>
                  <a:ext cx="12700000" cy="12700000"/>
                  <a:chOff x="0" y="0"/>
                  <a:chExt cx="1270000" cy="1270000"/>
                </a:xfrm>
              </p:grpSpPr>
              <!-- Shape inside inner group: off=(10, 10), ext=(20, 20) in inner coords -->
              <!-- Inner coord (10, 10) -> maps to outer coord (1000 + 10*10, 1000 + 10*10) = (1100, 1100) -->
              <!-- Outer coord (1100, 1100) -> maps to world coord 100 + 1100*0.2 = 320 -->
              <!-- Inner size (20, 20) -> outer size 200 -> world size 200*0.2 = 40 -->
              <p:sp>
                <p:spPr>
                  <a:xfrm>
                    <a:off x="127000" y="127000"/>
                    <a:ext cx="254000" cy="254000"/>
                  </a:xfrm>
                  <a:prstGeom prst="ellipse"/>
                  <a:solidFill><a:srgbClr val="FF5722"/></a:solidFill>
                </p:spPr>
              </p:sp>
            </p:grpSp>
          </p:grpSp>
        </p:spTree>
      `;

      const shapes = parseDrawingMlShapes(xml);
      expect(shapes.length).toBe(2);

      // Shape 1 (direct child of outer group)
      const s1 = shapes[0];
      expect(s1.presetGeom).toBe('roundrect');
      expect(s1.fillColor).toBe('#5C6BC0');
      expect(s1.x).toBeCloseTo(200, 0);
      expect(s1.y).toBeCloseTo(200, 0);
      expect(s1.width).toBeCloseTo(100, 0);
      expect(s1.height).toBeCloseTo(100, 0);
      expect(s1.transformMatrix).toBeDefined();

      // Shape 2 (nested child of inner group)
      const s2 = shapes[1];
      expect(s2.presetGeom).toBe('ellipse');
      expect(s2.fillColor).toBe('#FF5722');
      expect(s2.x).toBeCloseTo(320, 0);
      expect(s2.y).toBeCloseTo(320, 0);
      expect(s2.width).toBeCloseTo(40, 0);
      expect(s2.height).toBeCloseTo(40, 0);
      expect(s2.transformMatrix).toBeDefined();
    });

    it('transforms custom geometry <a:custGeom> paths using accumulated parent matrix', () => {
      const xml = `
        <p:grpSp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <p:grpSpPr>
            <a:xfrm>
              <a:off x="1270000" y="1270000"/> <!-- 100, 100 -->
              <a:ext cx="2540000" cy="2540000"/> <!-- 200, 200 -->
              <a:chOff x="0" y="0"/>
              <a:chExt cx="12700000" cy="12700000"/> <!-- 1000, 1000 -> scale 0.2 -->
            </a:xfrm>
          </p:grpSpPr>
          <p:sp>
            <p:spPr>
              <a:xfrm>
                <a:off x="0" y="0"/>
                <a:ext cx="12700000" cy="12700000"/>
              </a:xfrm>
              <a:custGeom>
                <a:path w="1000" h="1000">
                  <a:moveTo><a:pt x="0" y="0"/></a:moveTo>
                  <a:lnTo><a:pt x="500" y="0"/></a:lnTo>
                  <a:lnTo><a:pt x="500" y="500"/></a:lnTo>
                  <a:close/>
                </a:path>
              </a:custGeom>
            </p:spPr>
          </p:sp>
        </p:grpSp>
      `;

      const shapes = parseDrawingMlShapes(xml);
      expect(shapes.length).toBe(1);
      const s = shapes[0];
      expect(s.geomType).toBe('custom');
      expect(s.svgPath).toBeDefined();
      // Original (0, 0) -> World (100, 100)
      // Original (500, 0) -> World (200, 100)
      // Original (500, 500) -> World (200, 200)
      expect(s.svgPath).toContain('M 100 100');
      expect(s.svgPath).toContain('L 200 100');
      expect(s.svgPath).toContain('L 200 200');
      expect(s.svgPath).toContain('Z');
    });
  });

  describe('3. SmartArt Diagram (<dgm:relIds>) Layout Reconstruction', () => {
    it('extracts diagram nodes from ppt/diagrams/data*.xml and arranges them into visual shapes with connectors', async () => {
      const slideXml = `
        <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
               xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
               xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
               xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram">
          <p:cSld>
            <p:spTree>
              <p:graphicFrame>
                <a:xfrm>
                  <a:off x="1270000" y="1270000"/> <!-- x=100, y=100 -->
                  <a:ext cx="7620000" cy="2540000"/> <!-- w=600, h=200 -->
                </a:xfrm>
                <a:graphic>
                  <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">
                    <dgm:relIds r:dm="rIdSmartArtData"/>
                  </a:graphicData>
                </a:graphic>
              </p:graphicFrame>
            </p:spTree>
          </p:cSld>
        </p:sld>
      `;

      const diagramDataXml = `
        <dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"
                       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <dgm:ptLst>
            <dgm:pt type="node">
              <dgm:t>
                <a:bodyPr/>
                <a:p>
                  <a:r><a:t>Step 1: Input Analysis</a:t></a:r>
                </a:p>
              </dgm:t>
            </dgm:pt>
            <dgm:pt type="node">
              <dgm:t>
                <a:bodyPr/>
                <a:p>
                  <a:r><a:t>Step 2: Transform Engine</a:t></a:r>
                </a:p>
              </dgm:t>
            </dgm:pt>
            <dgm:pt type="node">
              <dgm:t>
                <a:bodyPr/>
                <a:p>
                  <a:r><a:t>Step 3: Output Delivery</a:t></a:r>
                </a:p>
              </dgm:t>
            </dgm:pt>
          </dgm:ptLst>
        </dgm:dataModel>
      `;

      const zip = new JSZip();
      zip.file('ppt/diagrams/data1.xml', diagramDataXml);
      const relsMap = new Map<string, string>();
      relsMap.set('rIdSmartArtData', '../diagrams/data1.xml');

      const extractedTexts: string[] = [];
      const shapes = await parsePptxSlideSceneGraph(
        slideXml,
        identityMatrix(),
        960,
        540,
        relsMap,
        zip,
        extractedTexts
      );

      // Expect 3 step node boxes + 2 connectors = 5 shapes total
      expect(shapes.length).toBe(5);

      const nodeShapes = shapes.filter((s) => s.shapeType === 'roundrect');
      const arrowShapes = shapes.filter((s) => s.shapeType === 'rightarrow');

      expect(nodeShapes.length).toBe(3);
      expect(arrowShapes.length).toBe(2);

      // Verify node labels
      expect(nodeShapes[0].text).toContain('Step 1: Input Analysis');
      expect(nodeShapes[1].text).toContain('Step 2: Transform Engine');
      expect(nodeShapes[2].text).toContain('Step 3: Output Delivery');

      // Verify node ordering from left to right inside the graphicFrame bounding box [100, 700]
      expect(nodeShapes[0].x).toBeLessThan(nodeShapes[1].x);
      expect(nodeShapes[1].x).toBeLessThan(nodeShapes[2].x);

      // Verify extracted texts includes diagram nodes
      expect(extractedTexts).toContain('Step 1: Input Analysis');
      expect(extractedTexts).toContain('Step 2: Transform Engine');
      expect(extractedTexts).toContain('Step 3: Output Delivery');
    });
  });

  describe('4. End-to-End PPTX to HTML & PDF Conversion with 2D Scene Graph', () => {
    it('converts PPTX containing nested group shapes and SmartArt to HTML and PDF with valid layout and zero errors', async () => {
      const zip = new JSZip();

      // Content Types
      zip.file(
        '[Content_Types].xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
          <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
          <Default Extension="xml" ContentType="application/xml"/>
          <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
          <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
          <Override PartName="/ppt/diagrams/data1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml"/>
        </Types>`
      );

      // Package relationships
      zip.file(
        '_rels/.rels',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
        </Relationships>`
      );

      // Presentation
      zip.file(
        'ppt/presentation.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <p:sldIdLst>
            <p:sldId id="256" r:id="rId2"/>
          </p:sldIdLst>
          <p:sldSz cx="9144000" cy="5143500"/> <!-- 720 x 405 pt -->
        </p:presentation>`
      );

      zip.file(
        'ppt/_rels/presentation.xml.rels',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
        </Relationships>`
      );

      // Slide 1 with nested <p:grpSp> and SmartArt <dgm:relIds>
      const slide1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
               xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
               xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
               xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram">
          <p:cSld>
            <p:spTree>
              <p:nvGrpSpPr>
                <p:cNvPr id="1" name=""/>
                <p:cNvGrpSpPr/>
                <p:nvPr/>
              </p:nvGrpSpPr>
              <p:grpSpPr>
                <a:xfrm>
                  <a:off x="0" y="0"/>
                  <a:ext cx="0" cy="0"/>
                  <a:chOff x="0" y="0"/>
                  <a:chExt cx="0" cy="0"/>
                </a:xfrm>
              </p:grpSpPr>

              <!-- Group Shape with 2 nested shapes -->
              <p:grpSp>
                <p:grpSpPr>
                  <a:xfrm rot="5400000"> <!-- 90 degrees rotation -->
                    <a:off x="635000" y="635000"/> <!-- 50, 50 -->
                    <a:ext cx="2540000" cy="2540000"/> <!-- 200, 200 -->
                    <a:chOff x="0" y="0"/>
                    <a:chExt cx="2540000" cy="2540000"/>
                  </a:xfrm>
                </p:grpSpPr>
                <p:sp>
                  <p:spPr>
                    <a:xfrm>
                      <a:off x="0" y="0"/>
                      <a:ext cx="1270000" cy="1270000"/>
                    </a:xfrm>
                    <a:prstGeom prst="rect"/>
                    <a:solidFill><a:srgbClr val="4CAF50"/></a:solidFill>
                  </p:spPr>
                  <p:txBody>
                    <a:bodyPr/>
                    <a:p><a:r><a:t>Group Box 1</a:t></a:r></p>
                  </p:txBody>
                </p:sp>
              </p:grpSp>

              <!-- SmartArt Graphic Frame -->
              <p:graphicFrame>
                <a:xfrm>
                  <a:off x="3810000" y="635000"/> <!-- 300, 50 -->
                  <a:ext cx="4445000" cy="1905000"/> <!-- 350, 150 -->
                </a:xfrm>
                <a:graphic>
                  <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">
                    <dgm:relIds r:dm="rIdSmartArt"/>
                  </a:graphicData>
                </a:graphic>
              </p:graphicFrame>
            </p:spTree>
          </p:cSld>
        </p:sld>`;

      zip.file('ppt/slides/slide1.xml', slide1Xml);

      zip.file(
        'ppt/slides/_rels/slide1.xml.rels',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rIdSmartArt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData" Target="../diagrams/data1.xml"/>
        </Relationships>`
      );

      const diagramDataXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"
                       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <dgm:ptLst>
            <dgm:pt type="node">
              <dgm:t><a:bodyPr/><a:p><a:r><a:t>Initiate</a:t></a:r></p></dgm:t>
            </dgm:pt>
            <dgm:pt type="node">
              <dgm:t><a:bodyPr/><a:p><a:r><a:t>Process</a:t></a:r></p></dgm:t>
            </dgm:pt>
          </dgm:ptLst>
        </dgm:dataModel>`;

      zip.file('ppt/diagrams/data1.xml', diagramDataXml);

      const pptxBuffer = await zip.generateAsync({ type: 'nodebuffer' });

      // Convert PPTX to HTML
      const htmlResult = await convertOffice(pptxBuffer, 'pptx', 'html', {}, 'test-slide');
      expect(htmlResult.mimeType).toBe('text/html');
      const htmlStr = htmlResult.buffer.toString('utf-8');
      expect(htmlStr).toContain('Group Box 1');
      expect(htmlStr).toContain('Initiate');
      expect(htmlStr).toContain('Process');
      expect(htmlStr).toContain('<svg');

      // Convert PPTX to PDF
      const pdfResult = await convertOffice(pptxBuffer, 'pptx', 'pdf', {}, 'test-slide');
      expect(pdfResult.mimeType).toBe('application/pdf');
      expect(pdfResult.buffer.length).toBeGreaterThan(1000);
      expect(pdfResult.buffer.subarray(0, 4).toString('utf-8')).toBe('%PDF');
    });
  });
});
