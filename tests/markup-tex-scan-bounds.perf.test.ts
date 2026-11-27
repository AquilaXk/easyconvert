import { describe, it } from 'vitest';
import { texToMarkdown } from '../src/lib/conversions/office/markup-text';
import { expectLinearOnInputs, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

/**
 * Growth of the TeX reader on text whose brackets never close. A search to the end of the input for every opener
 * made 4 times the input cost 16 times as long (2.4 s at 120 KB, 21.6 s at 360 KB). The nightly performance suite runs
 * this file alone; the PR gate keeps a hang guard on the same shapes in markup-tex-scan-bounds.test.ts.
 */
const BASE_CHARS = 128 * 1024;

const SHAPES: ReadonlyArray<readonly [string, string]> = [
  ['\\a{', '\\a{'],
  ['\\a[', '\\a['],
  ['\\textbf{', '\\textbf{'],
  ['\\\\[', '\\\\['],
  ['\\begin{verbatim}', '\\begin{verbatim}\n'],
];

const build = (unit: string, chars: number): string => unit.repeat(Math.ceil(chars / unit.length));

describe('TeX reader growth on unclosed brackets', () => {
  it.each(SHAPES)('reads 4 times as much %s in linear time', async (_name, unit) => {
    await expectLinearOnInputs('texToMarkdown', (tex: string) => texToMarkdown(tex), {
      small: build(unit, BASE_CHARS),
      large: build(unit, BASE_CHARS * SCALING_FACTOR),
    });
  }, SCALING_TEST_TIMEOUT_MS);
});
