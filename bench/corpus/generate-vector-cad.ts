/**
 * Writes the vector-graphics and CAD part of the benchmark corpus (`bench/corpus/vector/`, `bench/corpus/cad/`)
 * together with the independent ground truth each file is judged by, then refreshes the entries of those two folders
 * in `manifest.json`. Everything is a pure function of the constants below, so a re-run yields byte-identical files.
 * Run with `npx tsx bench/corpus/generate-vector-cad.ts`.
 *
 * - `vector/shapes.svg` and `vector/shapes.eps` draw one list of solid shapes. `vector/shapes.truth.png` is that list
 *   rasterised analytically (a 8 x 8 point grid per pixel, painter's order, no renderer involved), so a renderer is
 *   scored against the geometry and not against another renderer.
 * - `vector/label.svg` carries text whose words are listed in `vector/label.gt.txt`.
 * - `cad/plate-basic.dxf` uses only the entities an ordinary 2D viewer must read (LINE, ARC, CIRCLE, LWPOLYLINE, TEXT).
 *   `cad/plate-full.dxf` adds what drawings from the field contain (ELLIPSE, SPLINE, POLYLINE, INSERT of a block,
 *   MTEXT). `cad/*.truth.json` lists the stroke geometry of each drawing as polylines in drawing units, written from the
 *   same entity list the DXF is written from.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { refreshManifest } from './manifest';

const CORPUS_DIR = __dirname;
const WIDTH = 400;
const HEIGHT = 300;
const SUBSAMPLES = 8;
const BYTE_MAX = 255;
const ARC_STEP_DEGREES = 2;
const SPLINE_SAMPLES = 120;

type Rgb = readonly [number, number, number];
type Point = readonly [number, number];

type Shape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; fill: Rgb }
  | { kind: 'circle'; cx: number; cy: number; r: number; fill: Rgb }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; fill: Rgb }
  | { kind: 'polygon'; points: readonly Point[]; fill: Rgb };

const WHITE: Rgb = [255, 255, 255];
const round2 = (value: number): number => Math.round(value * 100) / 100;

function regularPolygon(cx: number, cy: number, radius: number, sides: number, phaseDegrees: number): Point[] {
  return Array.from({ length: sides }, (_, i) => {
    const angle = ((phaseDegrees + (360 * i) / sides) * Math.PI) / 180;
    return [round2(cx + radius * Math.cos(angle)), round2(cy + radius * Math.sin(angle))] as Point;
  });
}

function rotatedRect(cx: number, cy: number, w: number, h: number, degrees: number): Point[] {
  const angle = (degrees * Math.PI) / 180;
  return ([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] as const).map(
    ([x, y]) => [round2(cx + x * Math.cos(angle) - y * Math.sin(angle)), round2(cy + x * Math.sin(angle) + y * Math.cos(angle))] as Point
  );
}

/** Solid opaque shapes in painter's order, in a 400 x 300 canvas whose y axis points down. */
const SHAPES: readonly Shape[] = [
  { kind: 'rect', x: 0, y: 0, w: WIDTH, h: HEIGHT, fill: WHITE },
  { kind: 'rect', x: 20, y: 20, w: 160, h: 120, fill: [214, 39, 40] },
  { kind: 'circle', cx: 200, cy: 150, r: 90, fill: [31, 119, 180] },
  { kind: 'ellipse', cx: 300, cy: 90, rx: 80, ry: 40, fill: [44, 160, 44] },
  { kind: 'polygon', points: [[60, 260], [140, 180], [220, 260]], fill: [255, 127, 14] },
  { kind: 'polygon', points: regularPolygon(330, 230, 50, 5, -90), fill: [148, 103, 189] },
  { kind: 'polygon', points: rotatedRect(120, 100, 60, 30, 30), fill: [0, 0, 0] },
  { kind: 'circle', cx: 200, cy: 150, r: 12, fill: WHITE },
];

function covers(shape: Shape, x: number, y: number): boolean {
  switch (shape.kind) {
    case 'rect':
      return x >= shape.x && x < shape.x + shape.w && y >= shape.y && y < shape.y + shape.h;
    case 'circle':
      return (x - shape.cx) ** 2 + (y - shape.cy) ** 2 <= shape.r ** 2;
    case 'ellipse':
      return ((x - shape.cx) / shape.rx) ** 2 + ((y - shape.cy) / shape.ry) ** 2 <= 1;
    case 'polygon': {
      let inside = false;
      const { points } = shape;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }
  }
}

/** The picture the shapes describe, as 8-bit sRGB: each pixel is the mean of an exact point grid, topmost shape per point. */
function truthPixels(): Buffer {
  const out = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let py = 0; py < HEIGHT; py++) {
    for (let px = 0; px < WIDTH; px++) {
      const sum = [0, 0, 0];
      for (let sy = 0; sy < SUBSAMPLES; sy++) {
        for (let sx = 0; sx < SUBSAMPLES; sx++) {
          const x = px + (sx + 0.5) / SUBSAMPLES;
          const y = py + (sy + 0.5) / SUBSAMPLES;
          let colour = WHITE;
          for (let i = SHAPES.length - 1; i >= 0; i--) {
            if (covers(SHAPES[i], x, y)) {
              colour = SHAPES[i].fill;
              break;
            }
          }
          for (let c = 0; c < 3; c++) sum[c] += colour[c];
        }
      }
      for (let c = 0; c < 3; c++) out[(py * WIDTH + px) * 3 + c] = Math.round(sum[c] / (SUBSAMPLES * SUBSAMPLES));
    }
  }
  return out;
}

const hex = (rgb: Rgb): string => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

function shapesSvg(): string {
  const body = SHAPES.map((shape) => {
    const fill = hex(shape.fill);
    switch (shape.kind) {
      case 'rect':
        return `  <rect x="${shape.x}" y="${shape.y}" width="${shape.w}" height="${shape.h}" fill="${fill}"/>`;
      case 'circle':
        return `  <circle cx="${shape.cx}" cy="${shape.cy}" r="${shape.r}" fill="${fill}"/>`;
      case 'ellipse':
        return `  <ellipse cx="${shape.cx}" cy="${shape.cy}" rx="${shape.rx}" ry="${shape.ry}" fill="${fill}"/>`;
      case 'polygon':
        return `  <polygon points="${shape.points.map(([x, y]) => `${x},${y}`).join(' ')}" fill="${fill}"/>`;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">\n${body.join('\n')}\n</svg>\n`;
}

/** The same shapes as an Encapsulated PostScript figure: PostScript's y axis points up. */
function shapesEps(): string {
  const unit = (value: number): string => String(round2(value / BYTE_MAX));
  const colour = (rgb: Rgb): string => `${unit(rgb[0])} ${unit(rgb[1])} ${unit(rgb[2])} setrgbcolor`;
  const flip = (y: number): number => round2(HEIGHT - y);
  const body = SHAPES.map((shape) => {
    switch (shape.kind) {
      case 'rect':
        return `${colour(shape.fill)} ${shape.x} ${flip(shape.y + shape.h)} ${shape.w} ${shape.h} rectfill`;
      case 'circle':
        return `${colour(shape.fill)} newpath ${shape.cx} ${flip(shape.cy)} ${shape.r} 0 360 arc fill`;
      case 'ellipse':
        return `${colour(shape.fill)} gsave ${shape.cx} ${flip(shape.cy)} translate ${shape.rx} ${shape.ry} scale newpath 0 0 1 0 360 arc fill grestore`;
      case 'polygon': {
        const [first, ...rest] = shape.points;
        const path = [`${first[0]} ${flip(first[1])} moveto`, ...rest.map(([x, y]) => `${x} ${flip(y)} lineto`), 'closepath'];
        return `${colour(shape.fill)} newpath ${path.join(' ')} fill`;
      }
    }
  });
  return ['%!PS-Adobe-3.0 EPSF-3.0', `%%BoundingBox: 0 0 ${WIDTH} ${HEIGHT}`, '%%EndComments', ...body, 'showpage', '%%EOF', ''].join('\n');
}

const LABEL_LINES = ['Harbour survey', 'Northern shore 2026', 'Eleven jetties mapped'];

function labelSvg(): string {
  const texts = LABEL_LINES.map(
    (line, i) => `  <text x="12" y="${42 + i * 40}" font-family="DejaVu Sans, sans-serif" font-size="26" fill="#111111">${line}</text>`
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="140" viewBox="0 0 ${WIDTH} 140">\n  <rect width="${WIDTH}" height="140" fill="#ffffff"/>\n${texts.join('\n')}\n</svg>\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// CAD

type Stroke = Point[];

interface DxfDrawing {
  /** DXF text. */
  dxf: string;
  /** Stroke geometry in drawing units: every drawn outline as a polyline. */
  strokes: Stroke[];
  /** Boxes of text, which the geometry score ignores: [minX, minY, maxX, maxY]. */
  textBoxes: Array<[number, number, number, number]>;
  /** Words of the text entities, for the text score. */
  words: string[];
}

class DxfWriter {
  private readonly body: string[] = [];
  readonly strokes: Stroke[] = [];
  readonly textBoxes: Array<[number, number, number, number]> = [];
  readonly words: string[] = [];
  private handle = 0x100;

  private pair(code: number, value: string | number): void {
    this.body.push(String(code).padStart(3, ' '), String(value));
  }

  private start(type: string, layer: string): void {
    this.pair(0, type);
    this.pair(5, (this.handle++).toString(16).toUpperCase());
    this.pair(100, 'AcDbEntity');
    this.pair(8, layer);
  }

  line(layer: string, a: Point, b: Point): void {
    this.start('LINE', layer);
    this.pair(100, 'AcDbLine');
    [10, 20, 30].forEach((code, i) => this.pair(code, [a[0], a[1], 0][i]));
    [11, 21, 31].forEach((code, i) => this.pair(code, [b[0], b[1], 0][i]));
    this.strokes.push([a, b]);
  }

  circle(layer: string, c: Point, r: number): void {
    this.start('CIRCLE', layer);
    this.pair(100, 'AcDbCircle');
    this.pair(10, c[0]);
    this.pair(20, c[1]);
    this.pair(30, 0);
    this.pair(40, r);
    this.strokes.push(arcPoints(c, r, 0, 360));
  }

  arc(layer: string, c: Point, r: number, start: number, end: number): void {
    this.start('ARC', layer);
    this.pair(100, 'AcDbCircle');
    this.pair(10, c[0]);
    this.pair(20, c[1]);
    this.pair(30, 0);
    this.pair(40, r);
    this.pair(100, 'AcDbArc');
    this.pair(50, start);
    this.pair(51, end);
    this.strokes.push(arcPoints(c, r, start, end));
  }

  lwpolyline(layer: string, points: Point[], closed: boolean): void {
    this.start('LWPOLYLINE', layer);
    this.pair(100, 'AcDbPolyline');
    this.pair(90, points.length);
    this.pair(70, closed ? 1 : 0);
    for (const [x, y] of points) {
      this.pair(10, x);
      this.pair(20, y);
    }
    this.strokes.push(closed ? [...points, points[0]] : [...points]);
  }

  /** The R12 form: a POLYLINE header, one VERTEX per point and SEQEND. */
  polyline(layer: string, points: Point[], closed: boolean): void {
    this.start('POLYLINE', layer);
    this.pair(100, 'AcDb2dPolyline');
    this.pair(66, 1);
    this.pair(10, 0);
    this.pair(20, 0);
    this.pair(30, 0);
    this.pair(70, closed ? 1 : 0);
    for (const [x, y] of points) {
      this.start('VERTEX', layer);
      this.pair(100, 'AcDbVertex');
      this.pair(100, 'AcDb2dVertex');
      this.pair(10, x);
      this.pair(20, y);
      this.pair(30, 0);
    }
    this.pair(0, 'SEQEND');
    this.pair(5, (this.handle++).toString(16).toUpperCase());
    this.pair(8, layer);
    this.strokes.push(closed ? [...points, points[0]] : [...points]);
  }

  /** Full ellipse: centre, major axis end point relative to the centre, minor-to-major ratio. */
  ellipse(layer: string, c: Point, major: Point, ratio: number): void {
    this.start('ELLIPSE', layer);
    this.pair(100, 'AcDbEllipse');
    this.pair(10, c[0]);
    this.pair(20, c[1]);
    this.pair(30, 0);
    this.pair(11, major[0]);
    this.pair(21, major[1]);
    this.pair(31, 0);
    this.pair(210, 0);
    this.pair(220, 0);
    this.pair(230, 1);
    this.pair(40, ratio);
    this.pair(41, 0);
    this.pair(42, 2 * Math.PI);
    const a = Math.hypot(major[0], major[1]);
    const rotation = Math.atan2(major[1], major[0]);
    const points: Point[] = [];
    for (let i = 0; i <= 360 / ARC_STEP_DEGREES; i++) {
      const t = (i * ARC_STEP_DEGREES * Math.PI) / 180;
      const x = a * Math.cos(t);
      const y = a * ratio * Math.sin(t);
      points.push([c[0] + x * Math.cos(rotation) - y * Math.sin(rotation), c[1] + x * Math.sin(rotation) + y * Math.cos(rotation)]);
    }
    this.strokes.push(points);
  }

  /** Clamped uniform cubic B-spline through the given control points. */
  spline(layer: string, control: Point[]): void {
    const degree = 3;
    const interior = control.length - degree - 1;
    const knots = [0, 0, 0, 0, ...Array.from({ length: interior }, (_, i) => (i + 1) / (interior + 1)), 1, 1, 1, 1];
    this.start('SPLINE', layer);
    this.pair(100, 'AcDbSpline');
    this.pair(210, 0);
    this.pair(220, 0);
    this.pair(230, 1);
    this.pair(70, 8);
    this.pair(71, degree);
    this.pair(72, knots.length);
    this.pair(73, control.length);
    this.pair(74, 0);
    for (const knot of knots) this.pair(40, knot);
    for (const [x, y] of control) {
      this.pair(10, x);
      this.pair(20, y);
      this.pair(30, 0);
    }
    const points: Point[] = [];
    for (let i = 0; i <= SPLINE_SAMPLES; i++) points.push(deBoor(degree, knots, control, Math.min(i / SPLINE_SAMPLES, 1 - 1e-9)));
    this.strokes.push(points);
  }

  text(layer: string, at: Point, height: number, value: string): void {
    this.start('TEXT', layer);
    this.pair(100, 'AcDbText');
    this.pair(10, at[0]);
    this.pair(20, at[1]);
    this.pair(30, 0);
    this.pair(40, height);
    this.pair(1, value);
    this.pair(100, 'AcDbText');
    this.addText(at, height, value);
  }

  mtext(layer: string, at: Point, height: number, value: string): void {
    this.start('MTEXT', layer);
    this.pair(100, 'AcDbMText');
    this.pair(10, at[0]);
    this.pair(20, at[1]);
    this.pair(30, 0);
    this.pair(40, height);
    this.pair(41, value.length * height);
    this.pair(71, 1);
    this.pair(1, value);
    this.addText(at, height, value);
  }

  private addText(at: Point, height: number, value: string): void {
    const width = value.length * height * 0.85;
    this.textBoxes.push([at[0] - height * 0.2, at[1] - height * 0.4, at[0] + width, at[1] + height * 1.4]);
    this.words.push(...value.split(/\s+/).filter(Boolean));
  }

  /** A block reference; the block geometry is placed through the same transform for the truth. */
  insert(layer: string, name: string, at: Point, scale: number, rotationDegrees: number, block: Stroke[]): void {
    this.start('INSERT', layer);
    this.pair(100, 'AcDbBlockReference');
    this.pair(2, name);
    this.pair(10, at[0]);
    this.pair(20, at[1]);
    this.pair(30, 0);
    this.pair(41, scale);
    this.pair(42, scale);
    this.pair(43, scale);
    this.pair(50, rotationDegrees);
    const angle = (rotationDegrees * Math.PI) / 180;
    for (const stroke of block) {
      this.strokes.push(stroke.map(([x, y]) => [at[0] + scale * (x * Math.cos(angle) - y * Math.sin(angle)), at[1] + scale * (x * Math.sin(angle) + y * Math.cos(angle))] as Point));
    }
  }

  entities(): string[] {
    return this.body;
  }
}

function arcPoints(c: Point, r: number, startDegrees: number, endDegrees: number): Stroke {
  const end = endDegrees > startDegrees ? endDegrees : endDegrees + 360;
  const points: Point[] = [];
  const steps = Math.max(2, Math.ceil((end - startDegrees) / ARC_STEP_DEGREES));
  for (let i = 0; i <= steps; i++) {
    const angle = ((startDegrees + ((end - startDegrees) * i) / steps) * Math.PI) / 180;
    points.push([c[0] + r * Math.cos(angle), c[1] + r * Math.sin(angle)]);
  }
  return points;
}

function deBoor(degree: number, knots: number[], control: Point[], t: number): Point {
  let k = degree;
  while (k < knots.length - degree - 2 && t >= knots[k + 1]) k++;
  const d = control.slice(k - degree, k + 1).map((p) => [p[0], p[1]] as [number, number]);
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const alpha = (t - knots[j + k - degree]) / (knots[j + 1 + k - r] - knots[j + k - degree]);
      d[j] = [(1 - alpha) * d[j - 1][0] + alpha * d[j][0], (1 - alpha) * d[j - 1][1] + alpha * d[j][1]];
    }
  }
  return d[degree];
}

const LAYERS: ReadonlyArray<readonly [string, number, string]> = [
  ['0', 7, 'CONTINUOUS'],
  ['OUTLINE', 7, 'CONTINUOUS'],
  ['HOLES', 1, 'CONTINUOUS'],
  ['CENTER', 5, 'CENTER'],
  ['DETAIL', 3, 'CONTINUOUS'],
  ['ANNOTATION', 2, 'CONTINUOUS'],
];

/** Section pairs of the file around the entities. */
function dxfDocument(entities: string[], blocks: string[], extent: [number, number, number, number]): string {
  const p = (code: number, value: string | number): string[] => [String(code).padStart(3, ' '), String(value)];
  const out: string[] = [];
  out.push(...p(0, 'SECTION'), ...p(2, 'HEADER'));
  out.push(...p(9, '$ACADVER'), ...p(1, 'AC1015'));
  out.push(...p(9, '$INSUNITS'), ...p(70, 4));
  out.push(...p(9, '$EXTMIN'), ...p(10, extent[0]), ...p(20, extent[1]), ...p(30, 0));
  out.push(...p(9, '$EXTMAX'), ...p(10, extent[2]), ...p(20, extent[3]), ...p(30, 0));
  out.push(...p(0, 'ENDSEC'));
  out.push(...p(0, 'SECTION'), ...p(2, 'TABLES'));
  out.push(...p(0, 'TABLE'), ...p(2, 'LTYPE'), ...p(70, 2));
  out.push(...p(0, 'LTYPE'), ...p(2, 'CONTINUOUS'), ...p(70, 0), ...p(3, 'Solid line'), ...p(72, 65), ...p(73, 0), ...p(40, 0));
  out.push(...p(0, 'LTYPE'), ...p(2, 'CENTER'), ...p(70, 0), ...p(3, 'Center ____ _ ____ _ ____'), ...p(72, 65), ...p(73, 4), ...p(40, 10), ...p(49, 6), ...p(49, -1.5), ...p(49, 1), ...p(49, -1.5));
  out.push(...p(0, 'ENDTAB'));
  out.push(...p(0, 'TABLE'), ...p(2, 'LAYER'), ...p(70, LAYERS.length));
  for (const [name, colour, linetype] of LAYERS) out.push(...p(0, 'LAYER'), ...p(2, name), ...p(70, 0), ...p(62, colour), ...p(6, linetype));
  out.push(...p(0, 'ENDTAB'));
  out.push(...p(0, 'TABLE'), ...p(2, 'STYLE'), ...p(70, 1));
  out.push(...p(0, 'STYLE'), ...p(2, 'STANDARD'), ...p(70, 0), ...p(40, 0), ...p(41, 1), ...p(50, 0), ...p(71, 0), ...p(42, 2.5), ...p(3, 'txt'), ...p(4, ''));
  out.push(...p(0, 'ENDTAB'));
  out.push(...p(0, 'ENDSEC'));
  out.push(...p(0, 'SECTION'), ...p(2, 'BLOCKS'), ...blocks, ...p(0, 'ENDSEC'));
  out.push(...p(0, 'SECTION'), ...p(2, 'ENTITIES'), ...entities, ...p(0, 'ENDSEC'));
  out.push(...p(0, 'EOF'));
  return `${out.join('\n')}\n`;
}

const BOLT_HEXAGON: Stroke = [...regularPolygon(0, 0, 5, 6, 0), regularPolygon(0, 0, 5, 6, 0)[0]];

function boltBlock(): string[] {
  const p = (code: number, value: string | number): string[] => [String(code).padStart(3, ' '), String(value)];
  const out: string[] = [];
  out.push(...p(0, 'BLOCK'), ...p(8, '0'), ...p(2, 'BOLT'), ...p(70, 0), ...p(10, 0), ...p(20, 0), ...p(30, 0), ...p(3, 'BOLT'));
  out.push(...p(0, 'CIRCLE'), ...p(8, 'DETAIL'), ...p(10, 0), ...p(20, 0), ...p(30, 0), ...p(40, 3));
  out.push(...p(0, 'LWPOLYLINE'), ...p(8, 'DETAIL'), ...p(90, 6), ...p(70, 1));
  for (const [x, y] of BOLT_HEXAGON.slice(0, 6)) out.push(...p(10, x), ...p(20, y));
  out.push(...p(0, 'ENDBLK'), ...p(8, '0'));
  return out;
}

function roundedPlate(w: DxfWriter): void {
  w.line('OUTLINE', [15, 0], [185, 0]);
  w.arc('OUTLINE', [185, 15], 15, 270, 360);
  w.line('OUTLINE', [200, 15], [200, 105]);
  w.arc('OUTLINE', [185, 105], 15, 0, 90);
  w.line('OUTLINE', [185, 120], [15, 120]);
  w.arc('OUTLINE', [15, 105], 15, 90, 180);
  w.line('OUTLINE', [0, 105], [0, 15]);
  w.arc('OUTLINE', [15, 15], 15, 180, 270);
  for (const c of [[30, 30], [170, 30], [30, 90], [170, 90]] as Point[]) w.circle('HOLES', c, 6);
  w.line('HOLES', [76, 54], [124, 54]);
  w.arc('HOLES', [124, 60], 6, 270, 90);
  w.line('HOLES', [124, 66], [76, 66]);
  w.arc('HOLES', [76, 60], 6, 90, 270);
  w.line('CENTER', [100, 5], [100, 115]);
  w.line('CENTER', [5, 60], [195, 60]);
  w.lwpolyline('DETAIL', [[20, 102], [30, 112], [40, 102], [50, 112], [60, 102]], false);
  w.lwpolyline('DETAIL', [[140, 20], [180, 20], [180, 45], [140, 45]], true);
}

function plateBasic(): DxfDrawing {
  const w = new DxfWriter();
  roundedPlate(w);
  w.text('ANNOTATION', [105, 108], 5, 'PLATE A-100');
  w.text('ANNOTATION', [105, 98], 4, 'SCALE 1:2');
  return { dxf: dxfDocument(w.entities(), [], [0, 0, 200, 120]), strokes: w.strokes, textBoxes: w.textBoxes, words: w.words };
}

function plateFull(): DxfDrawing {
  const w = new DxfWriter();
  roundedPlate(w);
  w.ellipse('DETAIL', [100, 60], [38, 0], 0.5);
  w.polyline('DETAIL', [[20, 72], [46, 72], [58, 84], [46, 96], [20, 96]], true);
  w.spline('DETAIL', [[20, 70], [35, 95], [55, 40], [75, 75], [90, 30], [110, 35]]);
  const bolt: Stroke[] = [arcPoints([0, 0], 3, 0, 360), BOLT_HEXAGON];
  w.insert('DETAIL', 'BOLT', [50, 60], 1, 0, bolt);
  w.insert('DETAIL', 'BOLT', [150, 60], 1.5, 30, bolt);
  w.text('ANNOTATION', [105, 108], 5, 'PLATE A-100');
  w.mtext('ANNOTATION', [105, 98], 4, 'NOTES ALL DIMENSIONS IN MM');
  return { dxf: dxfDocument(w.entities(), boltBlock(), [0, 0, 200, 120]), strokes: w.strokes, textBoxes: w.textBoxes, words: w.words };
}

// ---------------------------------------------------------------------------------------------------------------

function truthJson(drawing: DxfDrawing): string {
  const rounded = (value: number): number => Math.round(value * 1000) / 1000;
  return `${JSON.stringify({ strokes: drawing.strokes.map((s) => s.map(([x, y]) => [rounded(x), rounded(y)])), textBoxes: drawing.textBoxes.map((b) => b.map(rounded)), words: drawing.words })}\n`;
}

/** Every file of the vector and CAD parts of the corpus by its path below the corpus folder. */
export async function vectorCadFiles(): Promise<Map<string, string | Buffer>> {
  const basic = plateBasic();
  const full = plateFull();
  return new Map<string, string | Buffer>([
    ['vector/shapes.svg', shapesSvg()],
    ['vector/shapes.eps', shapesEps()],
    ['vector/shapes.truth.png', await sharp(truthPixels(), { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer()],
    ['vector/label.svg', labelSvg()],
    ['vector/label.gt.txt', `${LABEL_LINES.join('\n')}\n`],
    ['cad/plate-basic.dxf', basic.dxf],
    ['cad/plate-basic.truth.json', truthJson(basic)],
    ['cad/plate-full.dxf', full.dxf],
    ['cad/plate-full.truth.json', truthJson(full)],
  ]);
}

async function main(): Promise<void> {
  for (const [relative, data] of await vectorCadFiles()) {
    const target = path.join(CORPUS_DIR, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
  refreshManifest(CORPUS_DIR, ['vector', 'cad']);
}

if (path.basename(process.argv[1] ?? '') === path.basename(__filename)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
