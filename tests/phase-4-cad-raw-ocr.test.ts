import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import sharp from 'sharp';
import {
  buildTrianglesFromPoints,
  tessellateCurvesToMesh,
  Point3D,
  BSplineCurve,
} from '../src/lib/conversions/cad-nurbs';
import {
  buildMinimalTrueTypeFont,
  ensureUnicodeFont,
} from '../src/lib/conversions/ocr-pdf-combiner';
import { convertImage } from '../src/lib/conversions/image';

describe('Phase 4: 3D CAD, Camera RAW & OCR Parity', () => {
  describe('1. 3D CAD Triangulation & Normal Computation', () => {
    it('triangulates coplanar 3D points via Delaunay and computes exact plane normals', () => {
      // 5 points forming a pentagon on plane z = 5
      const points: Point3D[] = [
        { x: 0, y: 0, z: 5 },
        { x: 2, y: 0, z: 5 },
        { x: 2, y: 2, z: 5 },
        { x: 1, y: 3, z: 5 },
        { x: 0, y: 2, z: 5 },
      ];

      const mesh = buildTrianglesFromPoints(points, 'test-polygon');
      expect(mesh.vertices.length).toBe(5);
      expect(mesh.faces.length).toBeGreaterThanOrEqual(3);

      // Verify every face references valid vertex indices
      for (const face of mesh.faces) {
        expect(face.length).toBe(3);
        expect(face[0]).toBeGreaterThanOrEqual(0);
        expect(face[0]).toBeLessThan(5);
        expect(face[1]).toBeGreaterThanOrEqual(0);
        expect(face[1]).toBeLessThan(5);
        expect(face[2]).toBeGreaterThanOrEqual(0);
        expect(face[2]).toBeLessThan(5);
      }

      // Verify normals are unit length and point strictly in +Z or -Z
      expect(mesh.normals.length).toBe(5);
      for (const normal of mesh.normals) {
        const len = Math.hypot(normal[0], normal[1], normal[2]);
        expect(Math.abs(len - 1.0)).toBeLessThan(1e-4);
        expect(Math.abs(normal[0])).toBeLessThan(1e-4);
        expect(Math.abs(normal[1])).toBeLessThan(1e-4);
        expect(Math.abs(Math.abs(normal[2]) - 1.0)).toBeLessThan(1e-4);
      }
    });

    it('tessellates a single 3D curve with adaptive tangent-orthogonal ribbon extrusion', () => {
      const curve: BSplineCurve = {
        degree: 1,
        controlPoints: [
          { x: 0, y: 0, z: 0 },
          { x: 10, y: 0, z: 0 },
        ],
        knots: [0, 0, 1, 1],
      };

      const mesh = tessellateCurvesToMesh([curve], 'single-curve');
      expect(mesh.vertices.length).toBeGreaterThan(0);
      expect(mesh.faces.length).toBeGreaterThan(0);
      expect(mesh.normals.length).toBe(mesh.vertices.length);

      for (const normal of mesh.normals) {
        const len = Math.hypot(normal[0], normal[1], normal[2]);
        expect(Math.abs(len - 1.0)).toBeLessThan(1e-4);
      }
    });

    it('tessellates adjacent curves into ruled quad strips with non-zero face normals', () => {
      const curve1: BSplineCurve = {
        degree: 1,
        controlPoints: [
          { x: 0, y: 0, z: 0 },
          { x: 10, y: 0, z: 0 },
        ],
        knots: [0, 0, 1, 1],
      };
      const curve2: BSplineCurve = {
        degree: 1,
        controlPoints: [
          { x: 0, y: 5, z: 0 },
          { x: 10, y: 5, z: 0 },
        ],
        knots: [0, 0, 1, 1],
      };

      const mesh = tessellateCurvesToMesh([curve1, curve2], 'ruled-surface');
      expect(mesh.faces.length).toBeGreaterThanOrEqual(60);
      expect(mesh.normals.length).toBe(mesh.vertices.length);

      for (const normal of mesh.normals) {
        const len = Math.hypot(normal[0], normal[1], normal[2]);
        expect(Math.abs(len - 1.0)).toBeLessThan(1e-4);
        // Plane is in XY, normal should point along Z
        expect(Math.abs(normal[0])).toBeLessThan(1e-3);
        expect(Math.abs(normal[1])).toBeLessThan(1e-3);
        expect(Math.abs(Math.abs(normal[2]) - 1.0)).toBeLessThan(1e-3);
      }
    });
  });

  describe('2. Multi-strip and Tiled Camera RAW Assembly', () => {
    it('decodes multi-strip DNG/TIFF sensor buffer without truncating trailing strips', async () => {
      // Create a 8x8 image with 4 strips (each 8x2)
      // Total 64 pixels, 1 byte per pixel, CFA pattern RGGB
      const width = 8;
      const height = 8;
      const strips = 4;
      const rowsPerStrip = 2;
      const stripSize = width * rowsPerStrip; // 16 bytes

      const strip0 = Buffer.alloc(stripSize, 10);
      const strip1 = Buffer.alloc(stripSize, 20);
      const strip2 = Buffer.alloc(stripSize, 30);
      const strip3 = Buffer.alloc(stripSize, 40);

      // Construct TIFF buffer (Little-Endian)
      // Header: 8 bytes ('II', 42, offset to IFD0 = 8)
      // IFD0 entries (12 bytes each):
      // 1. Tag 256 (ImageWidth)
      // 2. Tag 257 (ImageLength)
      // 3. Tag 258 (BitsPerSample) = 8
      // 4. Tag 273 (StripOffsets) -> array of 4 LONGs
      // 5. Tag 278 (RowsPerStrip) = 2
      // 6. Tag 279 (StripByteCounts) -> array of 4 LONGs
      // 7. Tag 33422 (CFAPattern) = [0, 1, 1, 2] (RGGB)
      // Count = 7 entries (2 + 7*12 + 4 = 90 bytes)
      const ifdOffset = 8;
      const entryCount = 7;
      const nextIfdOffset = ifdOffset + 2 + entryCount * 12; // 8 + 2 + 84 = 94
      const offsetsArrayPos = nextIfdOffset + 4; // 98
      const byteCountsArrayPos = offsetsArrayPos + strips * 4; // 98 + 16 = 114
      const stripDataStart = byteCountsArrayPos + strips * 4; // 114 + 16 = 130

      const stripOffsets = [
        stripDataStart,
        stripDataStart + stripSize,
        stripDataStart + stripSize * 2,
        stripDataStart + stripSize * 3,
      ];
      const stripByteCounts = [stripSize, stripSize, stripSize, stripSize];

      const totalLen = stripDataStart + stripSize * strips;
      const buf = Buffer.alloc(totalLen);

      // TIFF Header
      buf.write('II', 0, 2, 'ascii');
      buf.writeUInt16LE(42, 2);
      buf.writeUInt32LE(ifdOffset, 4);

      // IFD
      buf.writeUInt16LE(entryCount, ifdOffset);
      let curr = ifdOffset + 2;

      const writeEntry = (tag: number, type: number, count: number, val: number) => {
        buf.writeUInt16LE(tag, curr);
        buf.writeUInt16LE(type, curr + 2);
        buf.writeUInt32LE(count, curr + 4);
        buf.writeUInt32LE(val, curr + 8);
        curr += 12;
      };

      writeEntry(256, 4, 1, width); // ImageWidth
      writeEntry(257, 4, 1, height); // ImageLength
      writeEntry(258, 3, 1, 8); // BitsPerSample
      writeEntry(273, 4, strips, offsetsArrayPos); // StripOffsets
      writeEntry(278, 4, 1, rowsPerStrip); // RowsPerStrip
      writeEntry(279, 4, strips, byteCountsArrayPos); // StripByteCounts
      writeEntry(33422, 1, 4, 0x02010100); // CFAPattern: 0, 1, 1, 2 (RGGB)

      buf.writeUInt32LE(0, nextIfdOffset); // Next IFD = 0

      // Write StripOffsets array
      for (let i = 0; i < strips; i++) {
        buf.writeUInt32LE(stripOffsets[i], offsetsArrayPos + i * 4);
        buf.writeUInt32LE(stripByteCounts[i], byteCountsArrayPos + i * 4);
      }

      // Write strip payloads
      strip0.copy(buf, stripOffsets[0]);
      strip1.copy(buf, stripOffsets[1]);
      strip2.copy(buf, stripOffsets[2]);
      strip3.copy(buf, stripOffsets[3]);

      const result = await convertImage(buf, 'png', {}, 'sensor.dng', 'dng');
      expect(result.buffer).toBeDefined();
      expect(result.buffer.length).toBeGreaterThan(0);
      const meta = await sharp(result.buffer).metadata();
      expect(meta.width).toBe(width);
      expect(meta.height).toBe(height);
    });

    it('decodes tiled DNG/TIFF sensor buffer across multiple tiles', async () => {
      // 8x8 image with 4 tiles of 4x4
      const width = 8;
      const height = 8;
      const tileWidth = 4;
      const tileLength = 4;
      const tiles = 4;
      const tileSize = tileWidth * tileLength; // 16 bytes

      const ifdOffset = 8;
      const entryCount = 7;
      const nextIfdOffset = ifdOffset + 2 + entryCount * 12; // 94
      const offsetsArrayPos = nextIfdOffset + 4; // 98
      const byteCountsArrayPos = offsetsArrayPos + tiles * 4; // 114
      const tileDataStart = byteCountsArrayPos + tiles * 4; // 130

      const tileOffsets = [
        tileDataStart,
        tileDataStart + tileSize,
        tileDataStart + tileSize * 2,
        tileDataStart + tileSize * 3,
      ];
      const tileByteCounts = [tileSize, tileSize, tileSize, tileSize];

      const totalLen = tileDataStart + tileSize * tiles;
      const buf = Buffer.alloc(totalLen);

      // Header
      buf.write('II', 0, 2, 'ascii');
      buf.writeUInt16LE(42, 2);
      buf.writeUInt32LE(ifdOffset, 4);

      buf.writeUInt16LE(entryCount, ifdOffset);
      let curr = ifdOffset + 2;

      const writeEntry = (tag: number, type: number, count: number, val: number) => {
        buf.writeUInt16LE(tag, curr);
        buf.writeUInt16LE(type, curr + 2);
        buf.writeUInt32LE(count, curr + 4);
        buf.writeUInt32LE(val, curr + 8);
        curr += 12;
      };

      writeEntry(256, 4, 1, width); // ImageWidth
      writeEntry(257, 4, 1, height); // ImageLength
      writeEntry(258, 3, 1, 8); // BitsPerSample
      writeEntry(322, 4, 1, tileWidth); // TileWidth
      writeEntry(323, 4, 1, tileLength); // TileLength
      writeEntry(324, 4, tiles, offsetsArrayPos); // TileOffsets
      writeEntry(325, 4, tiles, byteCountsArrayPos); // TileByteCounts

      buf.writeUInt32LE(0, nextIfdOffset);

      for (let i = 0; i < tiles; i++) {
        buf.writeUInt32LE(tileOffsets[i], offsetsArrayPos + i * 4);
        buf.writeUInt32LE(tileByteCounts[i], byteCountsArrayPos + i * 4);
        buf.fill(15 * (i + 1), tileOffsets[i], tileOffsets[i] + tileSize);
      }

      const result = await convertImage(buf, 'png', {}, 'sensor.dng', 'dng');
      expect(result.buffer).toBeDefined();
      expect(result.buffer.length).toBeGreaterThan(0);
      const meta = await sharp(result.buffer).metadata();
      expect(meta.width).toBe(width);
      expect(meta.height).toBe(height);
    });
  });

  describe('3. OCR FontFile2 TrueType Font Embedding', () => {
    it('builds an authentic TrueType SFNT container with all 10 standard tables', () => {
      const ttf = buildMinimalTrueTypeFont();
      expect(ttf.length).toBeGreaterThan(100);

      // Check TrueType magic sfntVersion
      expect(ttf.readUInt32BE(0)).toBe(0x00010000);

      const numTables = ttf.readUInt16BE(4);
      expect(numTables).toBe(10);

      // Verify table directory tags are strictly sorted
      const expectedTags = [
        'OS/2',
        'cmap',
        'glyf',
        'head',
        'hhea',
        'hmtx',
        'loca',
        'maxp',
        'name',
        'post',
      ];

      for (let i = 0; i < numTables; i++) {
        const tag = ttf.toString('ascii', 12 + i * 16, 12 + i * 16 + 4);
        expect(tag).toBe(expectedTags[i]);
      }

      // Verify 'head' table magic number
      const headDir = 12 + 3 * 16; // 'head' is at index 3
      const headOffset = ttf.readUInt32BE(headDir + 8);
      const headMagic = ttf.readUInt32BE(headOffset + 12);
      expect(headMagic).toBe(0x5f0f3cf5);
    });

    it('embeds /FontFile2 with correct Length1 into PDF FontDescriptor', async () => {
      const doc = await PDFDocument.create();
      const fontInfo = ensureUnicodeFont(doc);

      expect(fontInfo.fontName).toBe('ECToUnicodeFont');
      expect(fontInfo.fontRef).toBeDefined();

      // Lookup Type0 font dict
      const type0Dict: any = doc.context.lookup(fontInfo.fontRef);
      expect(type0Dict.get(PDFName.of('Subtype')).asString()).toBe('/Type0');

      const descendants = type0Dict.get(PDFName.of('DescendantFonts'));
      const cidFontRef = descendants.asArray()[0];
      const cidFontDict: any = doc.context.lookup(cidFontRef);

      const fontDescRef = cidFontDict.get(PDFName.of('FontDescriptor'));
      const fontDescDict: any = doc.context.lookup(fontDescRef);
      expect(fontDescDict).toBeDefined();

      const fontFile2Ref = fontDescDict.get(PDFName.of('FontFile2'));
      expect(fontFile2Ref).toBeDefined();

      const fontFile2Stream: any = doc.context.lookup(fontFile2Ref);
      expect(fontFile2Stream).toBeDefined();

      const length1 = fontFile2Stream.dict.get(PDFName.of('Length1')) as PDFNumber;
      expect(length1).toBeDefined();
      expect(length1.asNumber()).toBeGreaterThan(100);

      // Verify saving produces a valid PDF
      const pdfBytes = await doc.save();
      expect(pdfBytes.length).toBeGreaterThan(0);
      expect(Buffer.from(pdfBytes.subarray(0, 5)).toString('ascii')).toBe('%PDF-');
    });
  });
});
