import { CadGeometryUnavailableError, ConversionFailedError, UnsupportedOptionError } from '../types';
import { parseSvgGeometries } from './svg-geometry';

/**
 * DXF writer for vector pages: the page drawn as SVG geometry (flattened curves in device coordinates, every
 * transform and glyph instance already applied) becomes AutoCAD R12 LINE and POLYLINE entities. R12 needs no
 * handles or subclass markers, so every DXF reader opens it. One DXF unit is one SVG user unit, which for a
 * page rendered from PDF or PostScript is one PostScript point; the Y axis points up as in PostScript.
 */

const DXF_VERSION = 'AC1009';
const DXF_COORDINATE_DECIMALS = 6;
const DXF_LAYER = '0';
const DXF_LINETYPE = 'CONTINUOUS';
/** AutoCAD Color Index 7: white on a dark background, black on a light one. */
const DXF_ACI_WHITE = 7;
/** Bit 1 of the POLYLINE flags (group 70): the polyline is closed. */
const DXF_POLYLINE_CLOSED = 1;
/** Group codes are right-aligned in three columns. */
const DXF_CODE_WIDTH = 3;
/** Two points closer than this are the same point, so a repeated first vertex marks a closed outline. */
const CLOSURE_EPSILON = 1e-9;
const SVG_ROOT_PATTERN = /<svg\b/i;

interface Point {
  x: number;
  y: number;
}

/** Writes one group-code and value pair per line, the code right-aligned as DXF readers expect. */
function pair(code: number, value: string | number): string {
  return `${String(code).padStart(DXF_CODE_WIDTH, ' ')}\n${value}`;
}

function coordinate(value: number): string {
  return value.toFixed(DXF_COORDINATE_DECIMALS);
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) <= CLOSURE_EPSILON && Math.abs(a.y - b.y) <= CLOSURE_EPSILON;
}

function lineEntity(a: Point, b: Point): string {
  return [
    pair(0, 'LINE'),
    pair(8, DXF_LAYER),
    pair(10, coordinate(a.x)),
    pair(20, coordinate(a.y)),
    pair(30, coordinate(0)),
    pair(11, coordinate(b.x)),
    pair(21, coordinate(b.y)),
    pair(31, coordinate(0)),
  ].join('\n');
}

function polylineEntity(points: Point[], closed: boolean): string {
  const lines = [
    pair(0, 'POLYLINE'),
    pair(8, DXF_LAYER),
    pair(66, 1),
    pair(10, coordinate(0)),
    pair(20, coordinate(0)),
    pair(30, coordinate(0)),
    pair(70, closed ? DXF_POLYLINE_CLOSED : 0),
  ];
  for (const p of points) {
    lines.push(pair(0, 'VERTEX'), pair(8, DXF_LAYER), pair(10, coordinate(p.x)), pair(20, coordinate(p.y)), pair(30, coordinate(0)));
  }
  lines.push(pair(0, 'SEQEND'), pair(8, DXF_LAYER));
  return lines.join('\n');
}

/** The page geometry of an SVG document as DXF text; fails closed when the page draws no vector geometry. */
export function encodeSvgPageToDxf(svg: Buffer): Buffer {
  const text = svg.toString('utf-8');
  if (!SVG_ROOT_PATTERN.test(text)) {
    throw new CadGeometryUnavailableError('DXF encoding failed: input is not an SVG document.');
  }
  let parsed: ReturnType<typeof parseSvgGeometries>;
  try {
    parsed = parseSvgGeometries(text);
  } catch (error) {
    if (error instanceof UnsupportedOptionError) {
      throw new ConversionFailedError(`The page cannot be written as DXF: ${error.message.replace(' by metafile encoders', '')}`);
    }
    throw error;
  }

  const entities: string[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const element of parsed.elements) {
    for (const subpath of element.subpaths) {
      // Device space has Y pointing down; DXF has it pointing up.
      const points = subpath.map((p) => ({ x: p.x, y: parsed.height - p.y }));
      if (points.length < 2) continue;
      const closed = points.length > 2 && samePoint(points[0], points[points.length - 1]);
      const vertices = closed ? points.slice(0, -1) : points;
      for (const p of vertices) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      entities.push(vertices.length === 2 && !closed ? lineEntity(vertices[0], vertices[1]) : polylineEntity(vertices, closed));
    }
  }
  if (entities.length === 0) {
    throw new ConversionFailedError('The page draws no vector geometry, so there is nothing to write as DXF.');
  }

  const sections = [
    [
      pair(0, 'SECTION'),
      pair(2, 'HEADER'),
      pair(9, '$ACADVER'),
      pair(1, DXF_VERSION),
      pair(9, '$EXTMIN'),
      pair(10, coordinate(minX)),
      pair(20, coordinate(minY)),
      pair(30, coordinate(0)),
      pair(9, '$EXTMAX'),
      pair(10, coordinate(maxX)),
      pair(20, coordinate(maxY)),
      pair(30, coordinate(0)),
      pair(0, 'ENDSEC'),
    ],
    [
      pair(0, 'SECTION'),
      pair(2, 'TABLES'),
      pair(0, 'TABLE'),
      pair(2, 'LTYPE'),
      pair(70, 1),
      pair(0, 'LTYPE'),
      pair(2, DXF_LINETYPE),
      pair(70, 0),
      pair(3, 'Solid line'),
      pair(72, 65),
      pair(73, 0),
      pair(40, coordinate(0)),
      pair(0, 'ENDTAB'),
      pair(0, 'TABLE'),
      pair(2, 'LAYER'),
      pair(70, 1),
      pair(0, 'LAYER'),
      pair(2, DXF_LAYER),
      pair(70, 0),
      pair(62, DXF_ACI_WHITE),
      pair(6, DXF_LINETYPE),
      pair(0, 'ENDTAB'),
      pair(0, 'ENDSEC'),
    ],
    [pair(0, 'SECTION'), pair(2, 'ENTITIES'), ...entities, pair(0, 'ENDSEC')],
    [pair(0, 'EOF')],
  ];
  return Buffer.from(`${sections.map((section) => section.join('\n')).join('\n')}\n`, 'utf-8');
}
