import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { requireOracleTool } from './differential-oracle';
import { readSvgShapes } from './svg-dom-audit';

/**
 * The vector content of a PDF page as Poppler's cairo backend draws it: `pdftocairo -svg` renders the page to SVG,
 * and the stroked paths of that SVG are read back as line segments. Poppler shares no code with the PDF writers
 * under test, so the segments are an independent account of what the PDF draws.
 */

const POPPLER_TIMEOUT_MS = 60_000;
/**
 * Decimal digits to which coordinates read from the SVG are compared: cairo keeps path coordinates in 24.8 fixed point
 * (steps of 1/256 unit), so equal geometry differs by up to a few thousandths. toBeCloseTo(_, 1) allows 0.05.
 */
export const CAIRO_COORDINATE_DIGITS = 1;
/** Segments whose run or rise is below this (in SVG user units) count as axis-aligned. */
const AXIS_TOLERANCE = 1e-6;
const PATH_COMMAND = /([MLZmlz])\s*([-+0-9.eE\s,]*)/g;

export interface PdfSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function pdfPageToSvg(pdf: Buffer, page = 1): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdftocairo-'));
  try {
    const input = path.join(dir, 'page.pdf');
    const output = path.join(dir, 'page.svg');
    fs.writeFileSync(input, pdf);
    execFileSync(requireOracleTool('pdftocairo'), ['-svg', '-f', String(page), '-l', String(page), input, output], { timeout: POPPLER_TIMEOUT_MS });
    return fs.readFileSync(output, 'utf-8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The straight segments of the `<path>` elements drawn on the page (M, L and Z commands in absolute or relative form),
 * in document order. Glyph outlines live in `<defs>` and are not page content, so they are left out.
 */
export function svgPathSegments(svg: string): PdfSegment[] {
  const segments: PdfSegment[] = [];
  for (const shape of readSvgShapes(svg.replace(/<defs>[\s\S]*?<\/defs>/g, ''), new Set(['path']))) {
    const d = shape.attributes.d;
    if (!d) continue;
    let current: [number, number] | null = null;
    let start: [number, number] | null = null;
    for (const match of d.matchAll(PATH_COMMAND)) {
      const command = match[1];
      const numbers = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
      const relative = command === command.toLowerCase();
      const upper = command.toUpperCase();
      if (upper === 'Z') {
        if (current && start && (current[0] !== start[0] || current[1] !== start[1])) {
          segments.push({ x1: current[0], y1: current[1], x2: start[0], y2: start[1] });
        }
        current = start;
        continue;
      }
      for (let at = 0; at + 1 < numbers.length; at += 2) {
        const point: [number, number] = relative && current ? [current[0] + numbers[at], current[1] + numbers[at + 1]] : [numbers[at], numbers[at + 1]];
        if (upper === 'M' && at === 0) {
          start = point;
        } else if (current) {
          segments.push({ x1: current[0], y1: current[1], x2: point[0], y2: point[1] });
        }
        current = point;
      }
    }
  }
  return segments;
}

/** Segments that are neither horizontal nor vertical: the drawing, as against the page frame. */
export function diagonalSegments(segments: PdfSegment[]): PdfSegment[] {
  return segments.filter((segment) => Math.abs(segment.x2 - segment.x1) > AXIS_TOLERANCE && Math.abs(segment.y2 - segment.y1) > AXIS_TOLERANCE);
}

/** The rectangle that the axis-aligned segments of the page enclose. */
export function pageFrame(segments: PdfSegment[]): { left: number; right: number; top: number; bottom: number } {
  const axisAligned = segments.filter((segment) => Math.abs(segment.x2 - segment.x1) <= AXIS_TOLERANCE || Math.abs(segment.y2 - segment.y1) <= AXIS_TOLERANCE);
  const xs = axisAligned.flatMap((segment) => [segment.x1, segment.x2]);
  const ys = axisAligned.flatMap((segment) => [segment.y1, segment.y2]);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

/** The number of pages of `pdf` as pdfinfo counts them. */
export function pdfPageCount(pdf: Buffer): number {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfinfo-'));
  try {
    const file = path.join(dir, 'doc.pdf');
    fs.writeFileSync(file, pdf);
    const report = execFileSync(requireOracleTool('pdfinfo'), [file], { encoding: 'utf-8', timeout: POPPLER_TIMEOUT_MS });
    const pages = /^Pages:\s+(\d+)$/m.exec(report);
    if (!pages) throw new Error('pdfinfo reported no page count');
    return Number(pages[1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
