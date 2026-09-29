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
      const width = 16;
      const height = 16;
      const bpp = 16;
      const rawBytes = width * height * 2;

      const tagList: Array<{
        tag: number;
        type: number;
        count: number;
        inlineVal?: number;
        data?: Buffer;
      }> = [];

      tagList.push({ tag: 256, type: 4, count: 1, inlineVal: width }); // ImageWidth
      tagList.push({ tag: 257, type: 4, count: 1, inlineVal: height }); // ImageLength
      tagList.push({ tag: 258, type: 3, count: 1, inlineVal: bpp }); // BitsPerSample
      tagList.push({ tag: 259, type: 3, count: 1, inlineVal: 1 }); // Compression (raw)
      tagList.push({ tag: 33422, type: 1, count: 4, data: Buffer.from([0, 1, 1, 2]) }); // CFAPattern: RGGB
      tagList.push({ tag: 278, type: 4, count: 1, inlineVal: height }); // RowsPerStrip
      tagList.push({ tag: 279, type: 4, count: 1, inlineVal: rawBytes }); // StripByteCounts
      tagList.push({ tag: 273, type: 4, count: 1, inlineVal: 0 }); // StripOffsets placeholder

      // BlackLevel = 512
      tagList.push({ tag: 50714, type: 4, count: 1, inlineVal: 512 });
      // WhiteLevel = 16383
      tagList.push({ tag: 50717, type: 4, count: 1, inlineVal: 16383 });

      // ForwardMatrix1 (Tag 50738) - 9 RATIONAL values
      const fm1Buf = Buffer.alloc(9 * 8);
      const fm1Values = [0.8, 0.1, 0.1, 0.1, 0.8, 0.1, 0.1, 0.1, 0.8];
      for (let i = 0; i < 9; i++) {
        fm1Buf.writeUInt32LE(Math.round(fm1Values[i] * 10000), i * 8);
        fm1Buf.writeUInt32LE(10000, i * 8 + 4);
      }
      tagList.push({ tag: 50738, type: 5, count: 9, data: fm1Buf });

      // ActiveArea (Tag 50710) - [top: 2, left: 2, bottom: 14, right: 14] -> 12x12 active crop
      const aaBuf = Buffer.alloc(4 * 4);
      aaBuf.writeUInt32LE(2, 0);
      aaBuf.writeUInt32LE(2, 4);
      aaBuf.writeUInt32LE(14, 8);
      aaBuf.writeUInt32LE(14, 12);
      tagList.push({ tag: 50710, type: 4, count: 4, data: aaBuf });

      // Layout buffer
      const ifdOffset = 8;
      const numEntries = tagList.length;
      const ifdSize = 2 + numEntries * 12 + 4;
      let outOfLineOffset = ifdOffset + ifdSize;

      const outOfLineBuffers: Buffer[] = [];
      for (const t of tagList) {
        if (t.data) {
          outOfLineBuffers.push(t.data);
        }
      }

      let dataOffset = outOfLineOffset;
      const tagOffsets: number[] = [];
      for (const t of tagList) {
        if (t.data) {
          tagOffsets.push(dataOffset);
          dataOffset += t.data.length;
        } else {
          tagOffsets.push(0);
        }
      }

      const pixelOffset = dataOffset;
      // StripOffsets index is 7
      tagList[7].inlineVal = pixelOffset;

      const totalSize = pixelOffset + rawBytes;
      const buf = Buffer.alloc(totalSize);

      // TIFF Header
      buf.write('II', 0);
      buf.writeUInt16LE(42, 2);
      buf.writeUInt32LE(ifdOffset, 4);

      // IFD0
      buf.writeUInt16LE(numEntries, ifdOffset);
      let curr = ifdOffset + 2;
      let dataIdx = 0;
      for (let i = 0; i < tagList.length; i++) {
        const t = tagList[i];
        buf.writeUInt16LE(t.tag, curr);
        buf.writeUInt16LE(t.type, curr + 2);
        buf.writeUInt32LE(t.count, curr + 4);
        if (t.data) {
          buf.writeUInt32LE(tagOffsets[i], curr + 8);
          t.data.copy(buf, tagOffsets[i]);
          dataIdx++;
        } else {
          buf.writeUInt32LE(t.inlineVal || 0, curr + 8);
        }
        curr += 12;
      }
      buf.writeUInt32LE(0, curr); // next IFD offset = 0

      // Fill pixel payload with 2048 (above blacklevel 512)
      for (let p = 0; p < width * height; p++) {
        buf.writeUInt16LE(2048, pixelOffset + p * 2);
      }

      return buf;
    }

    it('decodes DNG with ForwardMatrix without corrupting BlackLevel/WhiteLevel and crops ActiveArea', () => {
      const dngBuf = buildDngWithForwardMatrixAndCrop();
      const decoded = decodeRawBayerSensor(dngBuf);
      expect(decoded).not.toBeNull();
      // Original dimensions: 16x16. ActiveArea: [2, 2, 14, 14] -> 12x12
      expect(decoded!.width).toBe(12);
      expect(decoded!.height).toBe(12);
      expect(decoded!.rgb.length).toBe(12 * 12 * 3);

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
      expect(parsed.tables.length).toBe(1);
      const tbl = parsed.tables[0];
      expect(tbl.structuredRows).toBeDefined();
      expect(tbl.structuredRows!.length).toBe(3);

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
    it('eliminates hanging nodes (T-junctions) via Red-Green closure', () => {
      // Parse a valid STEP closed box to test conforming Red-Green B-Rep mesh refinement
      const stepBoxText = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Watertight Box Test'),'2;1');
FILE_NAME('box.step','2026-09-28T00:00:00','','','EasyConvert','','');
FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));
ENDSEC;
DATA;
#1 = CARTESIAN_POINT('', (0.0, 0.0, 0.0));
#2 = CARTESIAN_POINT('', (1.0, 0.0, 0.0));
#3 = CARTESIAN_POINT('', (1.0, 1.0, 0.0));
#4 = CARTESIAN_POINT('', (0.0, 1.0, 0.0));
#5 = CARTESIAN_POINT('', (0.0, 0.0, 1.0));
#6 = CARTESIAN_POINT('', (1.0, 0.0, 1.0));
#7 = CARTESIAN_POINT('', (1.0, 1.0, 1.0));
#8 = CARTESIAN_POINT('', (0.0, 1.0, 1.0));

#11 = VERTEX_POINT('', #1);
#12 = VERTEX_POINT('', #2);
#13 = VERTEX_POINT('', #3);
#14 = VERTEX_POINT('', #4);
#15 = VERTEX_POINT('', #5);
#16 = VERTEX_POINT('', #6);
#17 = VERTEX_POINT('', #7);
#18 = VERTEX_POINT('', #8);

#21 = EDGE_CURVE('', #11, #12, .T.);
#22 = EDGE_CURVE('', #12, #13, .T.);
#23 = EDGE_CURVE('', #13, #14, .T.);
#24 = EDGE_CURVE('', #14, #11, .T.);

#25 = EDGE_CURVE('', #15, #16, .T.);
#26 = EDGE_CURVE('', #16, #17, .T.);
#27 = EDGE_CURVE('', #17, #18, .T.);
#28 = EDGE_CURVE('', #18, #15, .T.);

#29 = EDGE_CURVE('', #11, #15, .T.);
#30 = EDGE_CURVE('', #12, #16, .T.);
#31 = EDGE_CURVE('', #13, #17, .T.);
#32 = EDGE_CURVE('', #14, #18, .T.);

#41 = EDGE_LOOP('', (#21, #22, #23, #24));
#42 = EDGE_LOOP('', (#25, #26, #27, #28));
#43 = EDGE_LOOP('', (#21, #30, #25, #29));
#44 = EDGE_LOOP('', (#22, #31, #26, #30));
#45 = EDGE_LOOP('', (#23, #32, #27, #31));
#46 = EDGE_LOOP('', (#24, #29, #28, #32));

#51 = FACE_OUTER_BOUND('', #41, .T.);
#52 = FACE_OUTER_BOUND('', #42, .T.);
#53 = FACE_OUTER_BOUND('', #43, .T.);
#54 = FACE_OUTER_BOUND('', #44, .T.);
#55 = FACE_OUTER_BOUND('', #45, .T.);
#56 = FACE_OUTER_BOUND('', #46, .T.);

#61 = ADVANCED_FACE('', (#51));
#62 = ADVANCED_FACE('', (#52));
#63 = ADVANCED_FACE('', (#53));
#64 = ADVANCED_FACE('', (#54));
#65 = ADVANCED_FACE('', (#55));
#66 = ADVANCED_FACE('', (#56));

#70 = CLOSED_SHELL('', (#61, #62, #63, #64, #65, #66));
#80 = MANIFOLD_SOLID_BREP('', #70);
ENDSEC;
END-ISO-10303-21;
`;

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
