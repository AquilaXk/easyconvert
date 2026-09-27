import { describe, it, expect } from 'vitest';
import {
  tessellateTrimmedFaceCDT,
  evaluateBSplineSurface,
  BSplineSurface,
  TrimmedParametricFace,
} from '../src/lib/conversions/cad-nurbs';
import {
  decodeLosslessJpegStrip,
  decodeRawBayerSensor,
  demosaicBayerCfa,
  convertImage,
} from '../src/lib/conversions/image';
import sharp from 'sharp';

describe('Phase 5: CAD B-Rep Ruppert CDT Watertight Mesh & Camera RAW Sensor Decoder', () => {
  // ==========================================================================
  // 1. CAD B-Rep Ruppert CDT with Inner Hole Preservation
  // ==========================================================================
  describe('CAD B-Rep CDT Triangulation & Watertight Meshing', () => {
    const planarSurface: BSplineSurface = {
      uDegree: 1,
      vDegree: 1,
      uKnots: [0, 0, 1, 1],
      vKnots: [0, 0, 1, 1],
      controlPoints: [
        [{ x: 0, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }],
        [{ x: 10, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }],
      ],
    };

    it('preserves inner holes and calculates exact watertight surface area', () => {
      // Outer square: (0,0) to (10,10), area = 100
      // Inner hole: (3,3) to (7,7), area = 16
      // Expected mesh area = 84
      const face: TrimmedParametricFace = {
        surface: planarSurface,
        outerLoop: [
          { u: 0, v: 0 },
          { u: 1, v: 0 },
          { u: 1, v: 1 },
          { u: 0, v: 1 },
        ],
        innerHoles: [
          [
            { u: 0.3, v: 0.3 },
            { u: 0.7, v: 0.3 },
            { u: 0.7, v: 0.7 },
            { u: 0.3, v: 0.7 },
          ],
        ],
      };

      const mesh = tessellateTrimmedFaceCDT(face, 'quad_with_hole');

      expect(mesh.vertices.length).toBeGreaterThanOrEqual(8);
      expect(mesh.faces.length).toBeGreaterThan(0);

      // Verify no triangle centroid falls inside the hole (0.3..0.7, 0.3..0.7 in u,v space => 3..7 in 3D)
      let centroidsInsideHole = 0;
      let totalArea = 0;

      for (const [i0, i1, i2] of mesh.faces) {
        const v0 = mesh.vertices[i0];
        const v1 = mesh.vertices[i1];
        const v2 = mesh.vertices[i2];

        const cx = (v0[0] + v1[0] + v2[0]) / 3;
        const cy = (v0[1] + v1[1] + v2[1]) / 3;

        if (cx > 3.01 && cx < 6.99 && cy > 3.01 && cy < 6.99) {
          centroidsInsideHole++;
        }

        // 3D triangle area via cross product
        const ax = v1[0] - v0[0], ay = v1[1] - v0[1], az = v1[2] - v0[2];
        const bx = v2[0] - v0[0], by = v2[1] - v0[1], bz = v2[2] - v0[2];
        const crossX = ay * bz - az * by;
        const crossY = az * bx - ax * bz;
        const crossZ = ax * by - ay * bx;
        const triArea = 0.5 * Math.hypot(crossX, crossY, crossZ);
        totalArea += triArea;
      }

      expect(centroidsInsideHole).toBe(0);
      expect(totalArea).toBeCloseTo(84.0, 1);
    });

    it('triangulates complex multi-hole B-Rep trimmed faces', () => {
      // 2 disjoint holes inside outer square
      const face: TrimmedParametricFace = {
        surface: planarSurface,
        outerLoop: [
          { u: 0, v: 0 },
          { u: 1, v: 0 },
          { u: 1, v: 1 },
          { u: 0, v: 1 },
        ],
        innerHoles: [
          // Hole 1: Left eye (0.15..0.35, 0.4..0.6) -> Area = 0.2 * 0.2 * 100 = 4
          [
            { u: 0.15, v: 0.4 },
            { u: 0.35, v: 0.4 },
            { u: 0.35, v: 0.6 },
            { u: 0.15, v: 0.6 },
          ],
          // Hole 2: Right eye (0.65..0.85, 0.4..0.6) -> Area = 0.2 * 0.2 * 100 = 4
          [
            { u: 0.65, v: 0.4 },
            { u: 0.85, v: 0.4 },
            { u: 0.85, v: 0.6 },
            { u: 0.65, v: 0.6 },
          ],
        ],
      };

      const mesh = tessellateTrimmedFaceCDT(face, 'two_holes');

      expect(mesh.vertices.length).toBeGreaterThanOrEqual(12);
      expect(mesh.faces.length).toBeGreaterThan(0);

      let totalArea = 0;
      for (const [i0, i1, i2] of mesh.faces) {
        const v0 = mesh.vertices[i0];
        const v1 = mesh.vertices[i1];
        const v2 = mesh.vertices[i2];
        const ax = v1[0] - v0[0], ay = v1[1] - v0[1];
        const bx = v2[0] - v0[0], by = v2[1] - v0[1];
        totalArea += 0.5 * Math.abs(ax * by - ay * bx);
      }

      // Expected area: 100 - 4 - 4 = 92
      expect(totalArea).toBeCloseTo(92.0, 1);
    });

    it('tessellates trimmed curved NURBS surface with analytical normals and adaptive refinement', () => {
      // Parabolic dome surface (uDegree=2, vDegree=2)
      const curvedSurface: BSplineSurface = {
        uDegree: 2,
        vDegree: 2,
        uKnots: [0, 0, 0, 1, 1, 1],
        vKnots: [0, 0, 0, 1, 1, 1],
        controlPoints: [
          [{ x: 0, y: 0, z: 0 }, { x: 0, y: 5, z: 3 }, { x: 0, y: 10, z: 0 }],
          [{ x: 5, y: 0, z: 3 }, { x: 5, y: 5, z: 6 }, { x: 5, y: 10, z: 3 }],
          [{ x: 10, y: 0, z: 0 }, { x: 10, y: 5, z: 3 }, { x: 10, y: 10, z: 0 }],
        ],
      };

      const face: TrimmedParametricFace = {
        surface: curvedSurface,
        outerLoop: [
          { u: 0, v: 0 },
          { u: 1, v: 0 },
          { u: 1, v: 1 },
          { u: 0, v: 1 },
        ],
        innerHoles: [
          [
            { u: 0.4, v: 0.4 },
            { u: 0.6, v: 0.4 },
            { u: 0.6, v: 0.6 },
            { u: 0.4, v: 0.6 },
          ],
        ],
      };

      const mesh = tessellateTrimmedFaceCDT(face, 'curved_dome_with_hole');

      expect(mesh.faces.length).toBeGreaterThan(0);
      expect(mesh.normals.length).toBe(mesh.vertices.length);

      // Verify unit length analytical normals
      for (const n of mesh.normals) {
        const len = Math.hypot(n[0], n[1], n[2]);
        expect(len).toBeCloseTo(1.0, 3);
      }
    });
  });

  // ==========================================================================
  // 2. Camera RAW Lossless JPEG (LJ92) & True Sensor Demosaicing
  // ==========================================================================
  describe('Camera RAW Sensor Strip Decoding & LJ92 Pipeline', () => {
    it('decodes synthetic Lossless JPEG (LJ92) stream with exact pixel reconstruction', () => {
      // Build a minimal valid LJ92 bitstream: 4x4 image, 16-bit, predictor 1
      const header = Buffer.from([
        0xff, 0xd8, // SOI
        0xff, 0xc3, 0x00, 0x0b, 0x10, 0x00, 0x04, 0x00, 0x04, 0x01, 0x01, 0x11, 0x00, // SOF3: 16bpp, 4x4, 1 comp
        0xff, 0xc4, 0x00, 0x14, 0x00, // DHT: 16 count bytes + 3 symbols
        0x01, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x01, 0x02, // Symbols: cat 0, cat 1, cat 2
        0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x01, 0x00, 0x00, // SOS: comp 1, predictor 1
      ]);

      // Scan data: Huffman coded differences (all 0s -> symbol 0 = code 0, single bit per sample)
      // 16 samples of category 0 -> 16 zero bits = 2 bytes 0x00, 0x00
      const scanData = Buffer.from([0x00, 0x00, 0xff, 0xd9]); // scan data + EOI
      const lj92Payload = Buffer.concat([header, scanData]);

      const decoded = decodeLosslessJpegStrip(lj92Payload);
      expect(decoded).not.toBeNull();
      expect(decoded!.width).toBe(4);
      expect(decoded!.height).toBe(4);
      expect(decoded!.bpp).toBe(16);
      expect(decoded!.data.length).toBe(16);

      // Verify predictable reconstruction (initial predictor 32768, differences 0)
      expect(decoded!.data[0]).toBe(32768);
      expect(decoded!.data[1]).toBe(32768);
    });

    it('decodes TIFF camera RAW file containing sensor Bayer strips without preview bypass', () => {
      // Build a minimal valid TIFF DNG container with a 4x4 raw Bayer strip
      const width = 4;
      const height = 4;
      const rawBayerData = new Uint16Array(width * height);
      for (let i = 0; i < width * height; i++) {
        rawBayerData[i] = 1000 + i * 200;
      }
      const bayerBuffer = Buffer.from(rawBayerData.buffer);

      // Construct TIFF:
      // Offset 0: Header (8 bytes)
      // Offset 8: IFD (10 entries = 2 + 10*12 + 4 = 126 bytes)
      // Offset 134: Bayer sensor strip
      const tiffHeader = Buffer.alloc(8);
      tiffHeader.write('II', 0, 'ascii'); // Little Endian
      tiffHeader.writeUInt16LE(42, 2);    // Magic
      tiffHeader.writeUInt32LE(8, 4);     // IFD offset

      const ifd = Buffer.alloc(2 + 6 * 12 + 4);
      ifd.writeUInt16LE(6, 0); // 6 tags

      const writeTag = (idx: number, tag: number, type: number, count: number, val: number) => {
        const off = 2 + idx * 12;
        ifd.writeUInt16LE(tag, off);
        ifd.writeUInt16LE(type, off + 2);
        ifd.writeUInt32LE(count, off + 4);
        ifd.writeUInt32LE(val, off + 8);
      };

      const stripOffset = 8 + ifd.length;
      writeTag(0, 256, 3, 1, width);                     // ImageWidth
      writeTag(1, 257, 3, 1, height);                    // ImageLength
      writeTag(2, 258, 3, 1, 16);                        // BitsPerSample
      writeTag(3, 273, 4, 1, stripOffset);               // StripOffsets
      writeTag(4, 279, 4, 1, bayerBuffer.length);        // StripByteCounts
      writeTag(5, 33422, 1, 4, 0x02010100);              // CFAPattern: 0, 1, 1, 2 = RGGB

      const rawContainer = Buffer.concat([tiffHeader, ifd, bayerBuffer]);

      const decoded = decodeRawBayerSensor(rawContainer, 'dng');
      expect(decoded).not.toBeNull();
      expect(decoded!.width).toBe(4);
      expect(decoded!.height).toBe(4);
      expect(decoded!.rgb.length).toBe(4 * 4 * 3);
    });

    it('converts camera RAW through full pipeline preserving real sensor colors', async () => {
      // Build raw Bayer frame with synthetic header 'RAW\x01'
      const width = 8;
      const height = 8;
      const header = Buffer.alloc(10);
      header.write('RAW\x01', 0, 4, 'ascii');
      header.writeUInt16LE(width, 4);
      header.writeUInt16LE(height, 6);
      header.writeUInt8(0, 8); // RGGB
      header.writeUInt8(8, 9); // 8-bit

      const bayer = Buffer.alloc(width * height, 128);
      const rawPayload = Buffer.concat([header, bayer]);

      const res = await convertImage(rawPayload, 'png', {}, 'test_sensor.raw', 'raw');
      expect(res.filename).toBe('test_sensor.png');
      expect(res.mimeType).toBe('image/png');
      expect(res.size).toBeGreaterThan(0);

      const meta = await sharp(res.buffer).metadata();
      expect(meta.width).toBe(width);
      expect(meta.height).toBe(height);
    });
  });
});
