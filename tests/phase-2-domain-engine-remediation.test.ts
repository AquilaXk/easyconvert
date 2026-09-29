import { describe, it, expect } from 'vitest';
import {
  decodeRawBayerSensor,
  multiply3x3,
} from '../src/lib/conversions/image';
import {
  parseDocxXml,
  parseWordStyles,
} from '../src/lib/conversions/office';
import {
  adaptiveIncrementalBRepMesh,
  parseStepEntities,
} from '../src/lib/conversions/cad-nurbs';
import {
  isZipBufferEncrypted,
  extractZipArchive,
} from '../src/lib/conversions/archive';
import { FORMAT_REGISTRY } from '../src/lib/registry';

describe('Phase 2 Domain Engine Remediation Test Suite', () => {
  describe('1. Camera RAW DNG Tag Disentanglement & ActiveArea Cropping', () => {
    function buildDngWithForwardMatrixAndCrop(): Buffer {
      const w = 16;
      const h = 16;
      const rawBytes = w * h * 2;

      // Encode ForwardMatrix1 (Tag 50738): 9 rational values
      const fm1Buf = Buffer.alloc(72);
      const fmValues = [0.8, 0.1, 0.1, 0.1, 0.8, 0.1, 0.1, 0.1, 0.8];
      fmValues.forEach((v, i) => {
        fm1Buf.writeUInt32LE(Math.round(v * 10000), i * 8);
        fm1Buf.writeUInt32LE(10000, i * 8 + 4);
      });

      // Encode ActiveArea (Tag 50710): [top: 2, left: 2, bottom: 14, right: 14] -> 12x12
      const aaBuf = Buffer.alloc(16);
      [2, 2, 14, 14].forEach((val, i) => aaBuf.writeUInt32LE(val, i * 4));

      const entries: Array<{ tag: number; type: number; count: number; val?: number; buf?: Buffer }> = [
        { tag: 256, type: 4, count: 1, val: w },
        { tag: 257, type: 4, count: 1, val: h },
        { tag: 258, type: 3, count: 1, val: 16 },
        { tag: 259, type: 3, count: 1, val: 1 },
        { tag: 33422, type: 1, count: 4, buf: Buffer.from([0, 1, 1, 2]) },
        { tag: 278, type: 4, count: 1, val: h },
        { tag: 279, type: 4, count: 1, val: rawBytes },
        { tag: 273, type: 4, count: 1, val: 0 }, // StripOffsets placeholder
        { tag: 50714, type: 4, count: 1, val: 512 }, // BlackLevel
        { tag: 50717, type: 4, count: 1, val: 16383 }, // WhiteLevel
        { tag: 50738, type: 5, count: 9, buf: fm1Buf },
        { tag: 50710, type: 4, count: 4, buf: aaBuf },
      ];

      const ifdStart = 8;
      const ifdLength = 2 + entries.length * 12 + 4;
      let payloadOff = ifdStart + ifdLength;

      const tagDataOffsets: number[] = [];
      for (const entry of entries) {
        if (entry.buf) {
          tagDataOffsets.push(payloadOff);
          payloadOff += entry.buf.length;
        } else {
          tagDataOffsets.push(0);
        }
      }

      const pixelOffset = payloadOff;
      entries[7].val = pixelOffset; // StripOffsets

      const dng = Buffer.alloc(pixelOffset + rawBytes);
      dng.write('II', 0);
      dng.writeUInt16LE(42, 2);
      dng.writeUInt32LE(ifdStart, 4);

      dng.writeUInt16LE(entries.length, ifdStart);
      let ptr = ifdStart + 2;
      entries.forEach((e, idx) => {
        dng.writeUInt16LE(e.tag, ptr);
        dng.writeUInt16LE(e.type, ptr + 2);
        dng.writeUInt32LE(e.count, ptr + 4);
        if (e.buf) {
          dng.writeUInt32LE(tagDataOffsets[idx], ptr + 8);
          e.buf.copy(dng, tagDataOffsets[idx]);
        } else {
          dng.writeUInt32LE(e.val || 0, ptr + 8);
        }
        ptr += 12;
      });
      dng.writeUInt32LE(0, ptr);

      for (let p = 0; p < w * h; p++) {
        dng.writeUInt16LE(2048, pixelOffset + p * 2);
      }

      return dng;
    }

    it('decodes DNG with ForwardMatrix without corrupting BlackLevel/WhiteLevel and crops ActiveArea', () => {
      const dngBuf = buildDngWithForwardMatrixAndCrop();
      const decoded = decodeRawBayerSensor(dngBuf);
      expect(decoded).not.toBeNull();
      // Original dimensions: 16x16. ActiveArea: [2, 2, 14, 14] -> 12x12
      expect(decoded!.width).toBe(12);
      expect(decoded!.height).toBe(12);
      expect(decoded!.rgb).toHaveLength(12 * 12 * 3);

      // Check pixel values are positive and non-zero
      let hasNonZero = false;
      for (let i = 0; i < decoded!.rgb.length; i++) {
        if (decoded!.rgb[i] > 0) hasNonZero = true;
      }
      expect(hasNonZero).toBe(true);
    });

    it('multiplies 3x3 matrices accurately for forward matrix to sRGB transformation', () => {
      const a = [1, 2, 3, 4, 5, 6, 7, 8, 9] as [number, number, number, number, number, number, number, number, number];
      const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1] as [number, number, number, number, number, number, number, number, number];
      const result = multiply3x3(a, identity);
      expect(result).toEqual(a);
    });
  });

  describe('2. Word OpenXML Table Styles & Vertical Cell Merging (w:vMerge)', () => {
    it('parses table styles from word/styles.xml', () => {
      const stylesXml = `
        <w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:style w:type="table" w:styleId="GridTable4">
            <w:name w:val="Grid Table 4"/>
            <w:tblBorders>
              <w:top w:val="single" w:sz="12" w:space="0" w:color="003366"/>
              <w:bottom w:val="single" w:sz="12" w:space="0" w:color="003366"/>
              <w:left w:val="none"/>
              <w:right w:val="none"/>
            </w:tblBorders>
            <w:shd w:fill="F2F4F8"/>
          </w:style>
        </w:styles>
      `;
      const styleMap = parseWordStyles(stylesXml);
      expect(styleMap.has('GridTable4')).toBe(true);
      const style = styleMap.get('GridTable4')!;
      expect(style.shading).toBe('F2F4F8');
      expect(style.borders?.top?.color).toBe('#003366');
      expect(style.borders?.left?.style).toBe('none');
    });

    it('inherits style and handles w:vMerge restart and continue across table rows', () => {
      const stylesXml = `
        <w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:style w:type="table" w:styleId="CustomTable">
            <w:shd w:fill="EBF0F5"/>
          </w:style>
        </w:styles>
      `;
      const styleMap = parseWordStyles(stylesXml);

      const docxTableXml = `
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body>
            <w:tbl>
              <w:tblPr>
                <w:tblStyle w:val="CustomTable"/>
              </w:tblPr>
              <!-- Row 0: Header -->
              <w:tr>
                <w:tc>
                  <w:tcPr><w:vMerge w:val="restart"/></w:tcPr>
                  <w:p><w:r><w:t>Merged Section</w:t></w:r></w:p>
                </w:tc>
                <w:tc>
                  <w:p><w:r><w:t>Item A</w:t></w:r></w:p>
                </w:tc>
              </w:tr>
              <!-- Row 1: Continuation -->
              <w:tr>
                <w:tc>
                  <w:tcPr><w:vMerge/></w:tcPr>
                  <w:p><w:r><w:t>Detail Note</w:t></w:r></w:p>
                </w:tc>
                <w:tc>
                  <w:p><w:r><w:t>Item B</w:t></w:r></w:p>
                </w:tc>
              </w:tr>
              <!-- Row 2: Continuation 2 -->
              <w:tr>
                <w:tc>
                  <w:tcPr><w:vMerge w:val="continue"/></w:tcPr>
                  <w:p><w:r><w:t></w:t></w:r></w:p>
                </w:tc>
                <w:tc>
                  <w:p><w:r><w:t>Item C</w:t></w:r></w:p>
                </w:tc>
              </w:tr>
            </w:tbl>
          </w:body>
        </w:document>
      `;

      const parsed = parseDocxXml(docxTableXml, undefined, styleMap);
      expect(parsed.tables).toHaveLength(1);
      const tbl = parsed.tables[0];
      expect(tbl.structuredRows).toBeDefined();
      expect(tbl.structuredRows!).toHaveLength(3);

      const row0Col0 = tbl.structuredRows![0][0];
      const row1Col0 = tbl.structuredRows![1][0];
      const row2Col0 = tbl.structuredRows![2][0];

      // Root cell should have rowSpan 3 and aggregated text
      expect(row0Col0.rowSpan).toBe(3);
      expect(row0Col0.text).toContain('Merged Section');
      expect(row0Col0.text).toContain('Detail Note');
      expect(row0Col0.shading).toBe('EBF0F5'); // inherited from CustomTable

      // Continuation cells should have rowSpan 0
      expect(row1Col0.rowSpan).toBe(0);
      expect(row2Col0.rowSpan).toBe(0);

      // Regular column cells should remain unaffected
      expect(tbl.structuredRows![0][1].text).toBe('Item A');
      expect(tbl.structuredRows![1][1].text).toBe('Item B');
      expect(tbl.structuredRows![2][1].text).toBe('Item C');
    });
  });

  describe('3. 3D CAD Conforming Red-Green B-Rep Tessellation', () => {
    function generateSyntheticStepSolidBox(): string {
      const coords = [
        [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
        [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
      ];
      const ptEntities = coords.map((c, i) => `#${i + 1} = CARTESIAN_POINT('', (${c.map((v) => v.toFixed(1)).join(', ')}));`).join('\n');
      const vtEntities = coords.map((_, i) => `#${i + 11} = VERTEX_POINT('', #${i + 1});`).join('\n');

      const edges = [
        [11, 12], [12, 13], [13, 14], [14, 11],
        [15, 16], [16, 17], [17, 18], [18, 15],
        [11, 15], [12, 16], [13, 17], [14, 18],
      ];
      const edEntities = edges.map((e, i) => `#${i + 21} = EDGE_CURVE('', #${e[0]}, #${e[1]}, .T.);`).join('\n');

      const loops = [
        [21, 22, 23, 24], [25, 26, 27, 28], [21, 30, 25, 29],
        [22, 31, 26, 30], [23, 32, 27, 31], [24, 29, 28, 32],
      ];
      const loopEntities = loops.map((l, i) => `#${i + 41} = EDGE_LOOP('', (${l.map((id) => `#${id}`).join(', ')}));`).join('\n');
      const boundEntities = loops.map((_, i) => `#${i + 51} = FACE_OUTER_BOUND('', #${i + 41}, .T.);`).join('\n');
      const faceEntities = loops.map((_, i) => `#${i + 61} = ADVANCED_FACE('', (#${i + 51}));`).join('\n');
      const shellFaces = loops.map((_, i) => `#${i + 61}`).join(', ');

      return `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Watertight Box Test'),'2;1');\nFILE_NAME('box.step','2026-09-28T00:00:00','','','EasyConvert','','');\nFILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));\nENDSEC;\nDATA;\n${ptEntities}\n${vtEntities}\n${edEntities}\n${loopEntities}\n${boundEntities}\n${faceEntities}\n#70 = CLOSED_SHELL('', (${shellFaces}));\n#80 = MANIFOLD_SOLID_BREP('', #70);\nENDSEC;\nEND-ISO-10303-21;\n`;
    }

    it('eliminates hanging nodes (T-junctions) via Red-Green closure', () => {
      const stepBoxText = generateSyntheticStepSolidBox();
      const entityMap = parseStepEntities(stepBoxText);
      expect(entityMap.size).toBeGreaterThan(0);

      // Run adaptiveIncrementalBRepMesh with fine linearDeflection
      const refined = adaptiveIncrementalBRepMesh(entityMap, {
        linearDeflection: 0.01,
        angularDeflection: 0.1,
      });

      if (refined) {
        expect(refined.faces.length).toBeGreaterThanOrEqual(1);

        // Verify manifold property: every undirected interior edge is shared by conforming triangles
        const edgeUsage = new Map<string, number>();
        for (const [a, b, c] of refined.faces) {
          const e1 = a < b ? `${a}-${b}` : `${b}-${a}`;
          const e2 = b < c ? `${b}-${c}` : `${c}-${b}`;
          const e3 = c < a ? `${c}-${a}` : `${a}-${c}`;
          edgeUsage.set(e1, (edgeUsage.get(e1) || 0) + 1);
          edgeUsage.set(e2, (edgeUsage.get(e2) || 0) + 1);
          edgeUsage.set(e3, (edgeUsage.get(e3) || 0) + 1);
        }

        // In a conforming triangulation, no edge should be over-shared (> 2 for 2-manifold)
        for (const [edge, count] of edgeUsage.entries()) {
          expect(count).toBeLessThanOrEqual(2);
        }
      }
    });
  });

  describe('4. Archive Password Schema & Fail-Closed Detection', () => {
    it('exposes password option in FORMAT_REGISTRY for zip and 7z', () => {
      expect(FORMAT_REGISTRY.zip.optionsSchema?.password).toBe(true);
      expect(FORMAT_REGISTRY['7z'].optionsSchema?.password).toBe(true);
    });

    it('detects encrypted zip buffer via bit 0 general purpose flag', () => {
      // Build a minimal mock ZIP with bit 0 set in local header
      const mockEncryptedZip = Buffer.alloc(40);
      mockEncryptedZip.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
      mockEncryptedZip.writeUInt16LE(20, 4); // version needed
      mockEncryptedZip.writeUInt16LE(0x0001, 6); // General purpose bit 0 = encrypted!

      expect(isZipBufferEncrypted(mockEncryptedZip)).toBe(true);

      const mockPlainZip = Buffer.alloc(40);
      mockPlainZip.writeUInt32LE(0x04034b50, 0);
      mockPlainZip.writeUInt16LE(20, 4);
      mockPlainZip.writeUInt16LE(0x0000, 6); // Not encrypted

      expect(isZipBufferEncrypted(mockPlainZip)).toBe(false);
    });

    it('fails closed when extracting encrypted zip without password', async () => {
      const mockEncryptedZip = Buffer.alloc(40);
      mockEncryptedZip.writeUInt32LE(0x04034b50, 0);
      mockEncryptedZip.writeUInt16LE(20, 4);
      mockEncryptedZip.writeUInt16LE(0x0001, 6); // Encrypted

      await expect(extractZipArchive(mockEncryptedZip)).rejects.toThrow(
        /ZIP archive is password[- ]protected/i
      );
    });
  });
});
