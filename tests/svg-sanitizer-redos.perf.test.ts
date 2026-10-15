import { describe, expect, it } from 'vitest';
import { isSvg, sanitizeSvgString } from '../src/lib/security/svg-sanitizer';
import { SvgSanitizationError } from '../src/lib/types';
import { expectLinearOnInputs, expectSizeIndependentOnInputs, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS, settle } from './helpers/timing';

/**
 * Timing-ratio checks moved out of svg-sanitizer-redos.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in svg-sanitizer-redos.test.ts.
 */

// Every input below took more than 2 s on the regex-based sanitizer. The linear scanner is checked by growth:
// the same shape at a quarter of the size must take about a quarter of the time (tests/helpers/timing.ts), so
// the verdict does not depend on how busy the runner is. Sizes are in bytes so that every shape runs long
// enough to time (the linear scanner needs about a megabyte to take more than a millisecond).
const BASE_BYTES = 512 * 1024;
/** Shapes the scanner discards in one pass run too fast at BASE_BYTES to time; they use this larger base. */
const FAST_SHAPE_BASE_BYTES = 4 * 1024 * 1024;
/** Twice the isSvg sniff window, so the modest input already exceeds what isSvg reads. */
const ISVG_MODEST_BYTES = 512 * 1024;

/** A document built from `units` repetitions of one adversarial unit. */
type Shape = { unit: string; wrap: (units: string) => string; baseBytes?: number };

/**
 * Sanitizes the shape at BASE_BYTES and LARGE_BYTES, asserts that the time grows linearly, and returns the
 * large input with its output so the caller can assert the exact result.
 */
async function expectLinearShape(shape: Shape): Promise<{ input: string; output: string; units: number }> {
  const unitsAt = (bytes: number) => Math.floor(bytes / shape.unit.length);
  const build = (bytes: number) => shape.wrap(shape.unit.repeat(unitsAt(bytes)));
  const baseBytes = shape.baseBytes ?? BASE_BYTES;
  const largeBytes = baseBytes * SCALING_FACTOR;
  const input = build(largeBytes);
  const { largeResult } = await expectLinearOnInputs('sanitizeSvgString', (svg: string) => sanitizeSvgString(svg), {
    small: build(baseBytes),
    large: input,
  });
  return { input, output: largeResult, units: unitsAt(largeBytes) };
}

describe('SVG sanitizer linear-time guarantees (issue #399)', () => {
  const unterminatedOpeners: Array<[string, string]> = [
    ['script', '<script>'],
    ['foreignObject', '<foreignObject>'],
    ['iframe', '<iframe>'],
    ['object', '<object>'],
    ['embed', '<embed>'],
    ['meta', '<meta '],
    ['link', '<link '],
  ];

  for (const [name, opener] of unterminatedOpeners) {
    it(`strips unterminated <${name}> openers in linear time`, async () => {
      const { output } = await expectLinearShape({ unit: opener, wrap: (units) => `<svg><circle r="1"/>${units}` });
      expect(output).toBe('<svg><circle r="1"/>');
    }, SCALING_TEST_TIMEOUT_MS);
  }

  it('neutralizes many unterminated <style> openers in linear time', async () => {
    const { output, units } = await expectLinearShape({ unit: '<style>', wrap: (u) => `<svg>${u}</svg>` });
    expect(output).toBe(`<svg><style>${'<style>'.repeat(units - 1)}</svg></style>`);
  }, SCALING_TEST_TIMEOUT_MS);

  it('strips many unterminated DOCTYPE openers in linear time', async () => {
    const { output } = await expectLinearShape({ unit: '<!DOCTYPE ', wrap: (u) => `<svg>${u}` });
    expect(output).toBe('<svg>');
  }, SCALING_TEST_TIMEOUT_MS);

  it('strips many unterminated DOCTYPE internal subsets in linear time', async () => {
    const { output } = await expectLinearShape({ unit: '<!DOCTYPE a [', wrap: (u) => `<svg>${u}</svg>`, baseBytes: FAST_SHAPE_BASE_BYTES });
    expect(output).toBe('<svg>');
  }, SCALING_TEST_TIMEOUT_MS);

  it('strips many unterminated ENTITY declarations in linear time', async () => {
    const { output } = await expectLinearShape({ unit: '<!ENTITY ', wrap: (u) => `<svg>${u}` });
    expect(output).toBe('<svg>');
  }, SCALING_TEST_TIMEOUT_MS);

  it('handles a long whitespace run before attributes in linear time', async () => {
    const { input, output } = await expectLinearShape({ unit: ' ', wrap: (u) => `<svg>${u}<circle r="1"/></svg>` });
    expect(output).toBe(input);
  }, SCALING_TEST_TIMEOUT_MS);

  it('neutralizes many unterminated CSS url() externals in linear time', async () => {
    const { output } = await expectLinearShape({ unit: 'url(http:', wrap: (u) => `<svg><style>${u}</style></svg>` });
    expect(output).toBe('<svg><style>none</style></svg>');
  }, SCALING_TEST_TIMEOUT_MS);

  it('neutralizes many quote-mismatched CSS url() externals in linear time', async () => {
    const { output } = await expectLinearShape({ unit: "url('http:", wrap: (u) => `<svg><style>${u}")</style></svg>` });
    expect(output).toBe('<svg><style>none</style></svg>');
  }, SCALING_TEST_TIMEOUT_MS);

  it('rejects deeply nested split-opener payloads with a typed error in linear time', async () => {
    const SPLIT_PAIR_BYTES = '<scr'.length + 'ipt>'.length;
    const nested = (bytes: number) => {
      const depth = Math.floor(bytes / SPLIT_PAIR_BYTES);
      return `<svg>${'<scr'.repeat(depth)}<script>${'ipt>'.repeat(depth)}</svg>`;
    };
    const { largeResult } = await expectLinearOnInputs(
      'nested split openers',
      (payload: string) => settle(() => sanitizeSvgString(payload)),
      { small: nested(BASE_BYTES), large: nested(BASE_BYTES * SCALING_FACTOR) }
    );
    if (largeResult.ok) throw new Error('the nested split-opener payload was sanitized instead of rejected');
    expect(largeResult.error).toBeInstanceOf(SvgSanitizationError);
    expect((largeResult.error as Error).message).toMatch(/cannot be sanitized safely/);
  }, SCALING_TEST_TIMEOUT_MS);

  it('isSvg reads a bounded prefix of many unterminated comments, however long the input', async () => {
    // isSvg decides from the first SVG_SNIFF_BYTES (256 KiB), where the unterminated comments are scanned once;
    // a quadratic scan of that prefix would take minutes, so a generous absolute guard catches it.
    const SNIFF_PREFIX_HANG_GUARD_MS = 5_000;
    const withComments = (bytes: number) => `${'<!--'.repeat(Math.floor(bytes / '<!--'.length))}<svg/>`;
    const { largeResult, largeMs } = await expectSizeIndependentOnInputs('isSvg', (input: string) => isSvg(input), {
      modest: withComments(ISVG_MODEST_BYTES),
      huge: withComments(ISVG_MODEST_BYTES * SCALING_FACTOR),
    });
    expect(largeMs).toBeLessThan(SNIFF_PREFIX_HANG_GUARD_MS);
    expect(largeResult).toBe(false);
    expect(isSvg('<!-- note --><svg/>')).toBe(true);
  }, SCALING_TEST_TIMEOUT_MS);
});
