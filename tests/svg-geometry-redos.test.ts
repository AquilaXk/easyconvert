import { describe, it, expect } from 'vitest';
import { MAX_SVG_INPUT_CHARS, parseCssColor, parseSvgGeometries, parseSvgTransform } from '../src/lib/conversions/svg-geometry';
import { encodeEmf } from '../src/lib/conversions/vector-metafile';
import { emfOraclePlayback } from './helpers/metafile-oracle';
import { CadGeometryUnavailableError, UnsupportedOptionError } from '../src/lib/types';

const TIME_BOUND_MS = 1000;
const REPS = 20_000;

function timed(fn: () => void): { ms: number; error: unknown } {
  const start = performance.now();
  let error: unknown = null;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  return { ms: performance.now() - start, error };
}

describe('SVG parser stays linear on adversarial input', () => {
  it('rejects an unterminated tag with many attributes quickly', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${'<rect width="5" height="5" '.repeat(REPS)}`;
    const { ms, error } = timed(() => parseSvgGeometries(svg));
    expect(error).toBeInstanceOf(CadGeometryUnavailableError);
    expect(ms).toBeLessThan(TIME_BOUND_MS);
  });

  it('rejects repeated unterminated comments quickly with a typed error', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${'<!--'.repeat(REPS * 5)}`;
    const { ms, error } = timed(() => parseSvgGeometries(svg));
    expect(error).toBeInstanceOf(CadGeometryUnavailableError);
    expect((error as Error).message).toMatch(/comment/i);
    expect(ms).toBeLessThan(TIME_BOUND_MS);
  });

  it('parses a style declaration with a long whitespace run quickly', () => {
    const style = `fill:red${" ".repeat(60_000)}!x`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="5" height="5" style="${style}"/></svg>`;
    const { ms } = timed(() => parseSvgGeometries(svg));
    expect(ms).toBeLessThan(TIME_BOUND_MS);
  });

  it('still honours !important with surrounding whitespace', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="5" height="5" fill="blue" style="fill : red  !  IMPORTANT  "/></svg>';
    const filled = emfOraclePlayback(encodeEmf(Buffer.from(svg, 'utf-8'))).filter((shape) => shape.kind === 'polygon' && shape.brush !== null);
    expect(filled.map((shape) => shape.brush)).toEqual([0xff0000]);
  });

  it('rejects SVG text above the size cap before parsing', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><!--${' '.repeat(MAX_SVG_INPUT_CHARS + 1)}--></svg>`;
    expect(() => parseSvgGeometries(svg)).toThrow(CadGeometryUnavailableError);
    expect(() => parseSvgGeometries(svg)).toThrow(/exceeds/);
  });

  it('rejects a long digit run in a transform argument quickly', () => {
    const { ms, error } = timed(() => parseSvgTransform(`translate(${'1'.repeat(60_000)}x)`));
    expect(error).toBeInstanceOf(CadGeometryUnavailableError);
    expect(ms).toBeLessThan(TIME_BOUND_MS);
  });

  it('rejects a long digit run in stroke-miterlimit quickly', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="1" height="1" stroke="#000" stroke-miterlimit="${'1'.repeat(60_000)}x"/></svg>`;
    const { ms, error } = timed(() => parseSvgGeometries(svg));
    expect(error).toBeInstanceOf(UnsupportedOptionError);
    expect(ms).toBeLessThan(TIME_BOUND_MS);
  });

  it('rejects a colour function padded with whitespace quickly', () => {
    const { ms } = timed(() => parseCssColor(`rgb(${' '.repeat(60_000)}x`));
    expect(ms).toBeLessThan(TIME_BOUND_MS);
  });

  it('still parses colour functions with inner padding', () => {
    expect(parseCssColor('rgb(  10 , 20,30 )')).toEqual({ r: 10, g: 20, b: 30 });
  });

  it('scans <style> look-alikes inside attribute values in linear time', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="1" height="1" a="${'<style><![CDATA['.repeat(3000)}"/></svg>`;
    const { ms, error } = timed(() => parseSvgGeometries(svg));
    expect(error).toBeInstanceOf(CadGeometryUnavailableError);
    expect(ms).toBeLessThan(TIME_BOUND_MS);
  });

  it('applies <style> rules from CDATA and ignores commented-out styles', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><!-- <style>rect{fill:#00ff00}</style> --><style><![CDATA[rect{fill:#ff0000}]]></style><rect width="5" height="5"/></svg>';
    const filled = emfOraclePlayback(encodeEmf(Buffer.from(svg, 'utf-8'))).filter((shape) => shape.kind === 'polygon' && shape.brush !== null);
    expect(filled.map((shape) => shape.brush)).toEqual([0xff0000]);
  });
});
