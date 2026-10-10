import { describe, it, expect } from 'vitest';
import { MAX_SVG_INPUT_CHARS, parseCssColor, parseSvgGeometries, parseSvgTransform } from '../src/lib/conversions/svg-geometry';
import { encodeEmf } from '../src/lib/conversions/vector-metafile';
import { emfOraclePlayback } from './helpers/metafile-oracle';
import { CadGeometryUnavailableError, UnsupportedOptionError } from '../src/lib/types';
import { expectNoHangOnInput, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS, settle, type Settled } from './helpers/timing';

// The adversarial shapes below must terminate (tests/helpers/timing.ts hang guard). That the time grows linearly with
// the size is measured, against a quarter-size run of the same shape, by svg-geometry-redos.perf.test.ts.
const REPS = 20_000;
/** Digits in the numeric arguments that used to backtrack. */
const DIGIT_RUN = 600_000;
/** 16 characters each: four times this stays under the 5 MiB SVG input cap. */
const STYLE_LOOKALIKES = 70_000 / SCALING_FACTOR;

/**
 * Runs `parse` on `build(4 * units)` under the hang guard and returns the outcome (value or typed error). The growth
 * ratio against the smaller input is measured by svg-geometry-redos.perf.test.ts.
 */
async function expectTerminatingParse<T>(label: string, build: (units: number) => string, parse: (input: string) => T, units: number) {
  const { largeResult } = await expectNoHangOnInput(label, (input: string) => settle(() => parse(input)), build(units * SCALING_FACTOR));
  return largeResult;
}

function thrownBy(outcome: Settled<unknown>): unknown {
  if (outcome.ok) throw new Error('the adversarial input was accepted instead of rejected');
  return outcome.error;
}

describe('SVG parser terminates on adversarial input', () => {
  it('rejects an unterminated tag with many attributes without hanging', async () => {
    const outcome = await expectTerminatingParse(
      'unterminated tag',
      (n) => `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${'<rect width="5" height="5" '.repeat(n)}`,
      parseSvgGeometries,
      REPS
    );
    expect(thrownBy(outcome)).toBeInstanceOf(CadGeometryUnavailableError);
    expect((thrownBy(outcome) as Error).message).toBe('Malformed SVG: unterminated tag.');
  }, SCALING_TEST_TIMEOUT_MS);

  it('rejects repeated unterminated comments with a typed error without hanging', async () => {
    const outcome = await expectTerminatingParse(
      'unterminated comments',
      (n) => `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${'<!--'.repeat(n)}`,
      parseSvgGeometries,
      REPS * 5
    );
    const error = thrownBy(outcome);
    expect(error).toBeInstanceOf(CadGeometryUnavailableError);
    expect((error as Error).message).toMatch(/comment/i);
  }, SCALING_TEST_TIMEOUT_MS);

  it('refuses a style declaration with a long whitespace run without hanging', async () => {
    const outcome = await expectTerminatingParse(
      'style whitespace run',
      (n) =>
        `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="5" height="5" style="fill:red${' '.repeat(n)}!x"/></svg>`,
      parseSvgGeometries,
      DIGIT_RUN
    );
    expect(thrownBy(outcome)).toBeInstanceOf(UnsupportedOptionError);
    expect((thrownBy(outcome) as Error).message).toMatch(/^SVG fill value "red {100,}!x" is not a valid colour or paint\.$/);
  }, SCALING_TEST_TIMEOUT_MS);

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

  it('rejects a long digit run in a transform argument without hanging', async () => {
    const outcome = await expectTerminatingParse('transform digits', (n) => `translate(${'1'.repeat(n)}x)`, parseSvgTransform, DIGIT_RUN);
    expect(thrownBy(outcome)).toBeInstanceOf(CadGeometryUnavailableError);
    expect((thrownBy(outcome) as Error).message).toMatch(/^Unsupported or malformed SVG transform "translate\(1+x\)"\.$/);
  }, SCALING_TEST_TIMEOUT_MS);

  it('rejects a long digit run in stroke-miterlimit without hanging', async () => {
    const outcome = await expectTerminatingParse(
      'miterlimit digits',
      (n) =>
        `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="1" height="1" stroke="#000" stroke-miterlimit="${'1'.repeat(n)}x"/></svg>`,
      parseSvgGeometries,
      DIGIT_RUN
    );
    expect(thrownBy(outcome)).toBeInstanceOf(UnsupportedOptionError);
    expect((thrownBy(outcome) as Error).message).toMatch(/^SVG stroke-miterlimit "1+x" is not supported by metafile encod/);
  }, SCALING_TEST_TIMEOUT_MS);

  it('rejects a colour function padded with whitespace without hanging', async () => {
    const outcome = await expectTerminatingParse('padded colour function', (n) => `rgb(${' '.repeat(n)}x`, parseCssColor, DIGIT_RUN);
    expect(outcome.ok && outcome.value, 'an unterminated colour function is not a colour').toBeNull();
  }, SCALING_TEST_TIMEOUT_MS);

  it('still parses colour functions with inner padding', () => {
    expect(parseCssColor('rgb(  10 , 20,30 )')).toEqual({ r: 10, g: 20, b: 30 });
  });

  it('scans <style> look-alikes inside attribute values without hanging', async () => {
    const outcome = await expectTerminatingParse(
      'style look-alikes',
      (n) =>
        `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="1" height="1" a="${'<style><![CDATA['.repeat(n)}"/></svg>`,
      parseSvgGeometries,
      STYLE_LOOKALIKES
    );
    expect(thrownBy(outcome)).toBeInstanceOf(CadGeometryUnavailableError);
    expect((thrownBy(outcome) as Error).message).toBe('Malformed SVG: unterminated CDATA section.');
  }, SCALING_TEST_TIMEOUT_MS);

  it('applies <style> rules from CDATA and ignores commented-out styles', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><!-- <style>rect{fill:#00ff00}</style> --><style><![CDATA[rect{fill:#ff0000}]]></style><rect width="5" height="5"/></svg>';
    const filled = emfOraclePlayback(encodeEmf(Buffer.from(svg, 'utf-8'))).filter((shape) => shape.kind === 'polygon' && shape.brush !== null);
    expect(filled.map((shape) => shape.brush)).toEqual([0xff0000]);
  });
});
