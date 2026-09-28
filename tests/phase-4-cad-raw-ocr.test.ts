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

function createLinearCurve(x0: number, y0: number, x1: number, y1: number, z = 0): BSplineCurve {
  return {
    degree: 1,
    controlPoints: [
      { x: x0, y: y0, z },
      { x: x1, y: y1, z },
    ],
    knots: [0, 0, 1, 1],
  };
}

function assembleTestTiff(config: {
  width: number;
  height: number;
  isTiled: boolean;
  dim: [number, number];
  chunks: Buffer[];
}): Buffer {
  const { width, height, isTiled, dim, chunks } = config;
  const count = chunks.length;
  const ifdOffset = 8;
  const entryCount = 7;
  const nextIfdOffset = ifdOffset + 2 + entryCount * 12;
  const offsetsPos = nextIfdOffset + 4;
  const countsPos = offsetsPos + count * 4;
  let curDataPos = countsPos + count * 4;

  const offsets: number[] = [];
  const byteCounts: number[] = [];
  for (const c of chunks) {
    offsets.push(curDataPos);
    byteCounts.push(c.length);
    curDataPos += c.length;
  }

  const buf = Buffer.alloc(curDataPos);
  buf.write('II', 0, 2, 'ascii');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(ifdOffset, 4);

  buf.writeUInt16LE(entryCount, ifdOffset);
  let curr = ifdOffset + 2;
  const writeEntry = (tag: number, type: number, cnt: number, val: number) => {
    buf.writeUInt16LE(tag, curr);
    buf.writeUInt16LE(type, curr + 2);
    buf.writeUInt32LE(cnt, curr + 4);
    buf.writeUInt32LE(val, curr + 8);
    curr += 12;
  };

  writeEntry(256, 4, 1, width);
  writeEntry(257, 4, 1, height);
  writeEntry(258, 3, 1, 8);
  if (isTiled) {
    writeEntry(322, 4, 1, dim[0]);
    writeEntry(323, 4, 1, dim[1]);
    writeEntry(324, 4, count, offsetsPos);
    writeEntry(325, 4, count, countsPos);
  } else {
    writeEntry(273, 4, count, offsetsPos);
    writeEntry(278, 4, 1, dim[0]);
    writeEntry(279, 4, count, countsPos);
    writeEntry(33422, 1, 4, 0x02010100);
  }
  buf.writeUInt32LE(0, nextIfdOffset);

  for (let i = 0; i < count; i++) {
    buf.writeUInt32LE(offsets[i], offsetsPos + i * 4);
    buf.writeUInt32LE(byteCounts[i], countsPos + i * 4);
    chunks[i].copy(buf, offsets[i]);
  }
  return buf;
}

describe('Phase 4: 3D CAD, Camera RAW & OCR Parity', () => {
  describe('1. 3D CAD Triangulation & Normal Computation', () => {
    it('triangulates coplanar 3D points via Delaunay and computes exact plane normals', () => {
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

      for (const face of mesh.faces) {
        expect(face.length).toBe(3);
        expect(face[0]).toBeGreaterThanOrEqual(0);
        expect(face[0]).toBeLessThan(5);
        expect(face[1]).toBeGreaterThanOrEqual(0);
        expect(face[1]).toBeLessThan(5);
        expect(face[2]).toBeGreaterThanOrEqual(0);
        expect(face[2]).toBeLessThan(5);
      }

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
      const curve = createLinearCurve(0, 0, 10, 0);
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
      const curve1 = createLinearCurve(0, 0, 10, 0);
      const curve2 = createLinearCurve(0, 5, 10, 5);

      const mesh = tessellateCurvesToMesh([curve1, curve2], 'ruled-surface');
      expect(mesh.faces.length).toBeGreaterThanOrEqual(60);
      expect(mesh.normals.length).toBe(mesh.vertices.length);

      for (const normal of mesh.normals) {
        const len = Math.hypot(normal[0], normal[1], normal[2]);
        expect(Math.abs(len - 1.0)).toBeLessThan(1e-4);
        expect(Math.abs(normal[0])).toBeLessThan(1e-3);
        expect(Math.abs(normal[1])).toBeLessThan(1e-3);
        expect(Math.abs(Math.abs(normal[2]) - 1.0)).toBeLessThan(1e-3);
      }
    });
  });

  describe('2. Multi-strip and Tiled Camera RAW Assembly', () => {
    it('decodes multi-strip DNG/TIFF sensor buffer without truncating trailing strips', async () => {
      const width = 8;
      const height = 8;
      const rowsPerStrip = 2;
      const stripSize = width * rowsPerStrip;

      const chunks = [
        Buffer.alloc(stripSize, 10),
        Buffer.alloc(stripSize, 20),
        Buffer.alloc(stripSize, 30),
        Buffer.alloc(stripSize, 40),
      ];

      const buf = assembleTestTiff({
        width,
        height,
        isTiled: false,
        dim: [rowsPerStrip, 1],
        chunks,
      });

      const result = await convertImage(buf, 'png', {}, 'sensor.dng', 'dng');
      expect(result.buffer).toBeDefined();
      expect(result.buffer.length).toBeGreaterThan(0);
      const meta = await sharp(result.buffer).metadata();
      expect(meta.width).toBe(width);
      expect(meta.height).toBe(height);
    });

    it('decodes tiled DNG/TIFF sensor buffer across multiple tiles', async () => {
      const width = 8;
      const height = 8;
      const tileWidth = 4;
      const tileLength = 4;
      const tileSize = tileWidth * tileLength;

      const chunks = [
        Buffer.alloc(tileSize, 15),
        Buffer.alloc(tileSize, 30),
        Buffer.alloc(tileSize, 45),
        Buffer.alloc(tileSize, 60),
      ];

      const buf = assembleTestTiff({
        width,
        height,
        isTiled: true,
        dim: [tileWidth, tileLength],
        chunks,
      });

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
      expect(ttf.readUInt32BE(0)).toBe(0x00010000);

      const numTables = ttf.readUInt16BE(4);
      expect(numTables).toBe(10);

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

      const headDir = 12 + 3 * 16;
      const headOffset = ttf.readUInt32BE(headDir + 8);
      const headMagic = ttf.readUInt32BE(headOffset + 12);
      expect(headMagic).toBe(0x5f0f3cf5);
    });

    it('embeds /FontFile2 with correct Length1 into PDF FontDescriptor', async () => {
      const doc = await PDFDocument.create();
      const fontInfo = ensureUnicodeFont(doc);

      expect(fontInfo.fontName).toBe('ECToUnicodeFont');
      expect(fontInfo.fontRef).toBeDefined();

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

      const pdfBytes = await doc.save();
      expect(pdfBytes.length).toBeGreaterThan(0);
      expect(Buffer.from(pdfBytes.subarray(0, 5)).toString('ascii')).toBe('%PDF-');
    });
  });
});
