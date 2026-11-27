import { describe, expect, it } from 'vitest';
import { texToMarkdown, texToPlainText } from '../src/lib/conversions/office/markup-text';
import { expectNoHangOnInput } from './helpers/timing';

/**
 * An unclosed `{` or `[` after a command used to be searched to the end of the input every time, so a megabyte of
 * `\a{` took minutes on the worker thread. The closing bracket of every opener is now found by one stack pass per text
 * (the way TeX reads a group: each token once), and a failed search is never repeated. The growth ratio is measured in
 * tests/markup-tex-scan-bounds.perf.test.ts; these cases run each hostile shape at one megabyte under the hang guard.
 */
const MEGABYTE = 1 << 20;

const HOSTILE_SHAPES: ReadonlyArray<readonly [string, string]> = [
  ['unclosed brace after a command', '\\a{'],
  ['unclosed bracket after a command', '\\a['],
  ['unclosed brace after a known command', '\\textbf{'],
  ['unclosed bracket after a line break', '\\\\['],
  ['unclosed environment name', '\\begin{'],
  ['unclosed verbatim environment', '\\begin{verbatim}\n'],
  ['unclosed macro definition', '\\newcommand{\\f}['],
];

describe('TeX conversion of unclosed brackets', () => {
  it.each(HOSTILE_SHAPES)('finishes 1 MB of %s within the hang guard', async (_label, unit) => {
    const input = unit.repeat(Math.ceil(MEGABYTE / unit.length));
    const { largeResult } = await expectNoHangOnInput('texToMarkdown', (tex: string) => texToMarkdown(tex), input);
    expect(typeof largeResult).toBe('string');
  });

  it('still converts a closed argument that follows an unclosed one', () => {
    expect(texToMarkdown('\\a{ \\textbf{x} tail')).toBe('**x** tail');
    expect(texToMarkdown('\\a[ \\textbf{x} tail')).toBe('[ **x** tail');
  });

  it('reads an argument whose closing brace comes after nested and escaped braces', () => {
    expect(texToPlainText('\\textbf{a \\{ b {c} d}')).toBe('a { b c d');
    expect(texToPlainText('\\section{One \\} two}')).toBe('One } two');
  });
});
