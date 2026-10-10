import { describe, expect, it } from 'vitest';
import { hwpEquationToLaTeX, hwpEquationToMathML } from '../src/lib/conversions/hwp';
import { CorruptStreamError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { xmlWellFormed, xpathCount, xpathString } from './helpers/xml-oracle';

/**
 * Equation scripts of the Hangul word processor, transpiled to MathML and LaTeX. The expectations are written from
 * the meaning of each script (what a reader of the equation sees), not copied from the transpiler's output:
 * MathML is read with XPath through xmllint (the reference XML tool), and checked against the child counts that
 * MathML 3 section 3 prescribes for each element; LaTeX is compared with the expression a person would write.
 */

/** Children each MathML element must have (MathML 3, sections 3.3 and 3.4); other elements take any number. */
const MATHML_CHILD_COUNTS: Readonly<Record<string, number>> = {
  mfrac: 2,
  mroot: 2,
  msub: 2,
  msup: 2,
  msubsup: 3,
  munder: 2,
  mover: 2,
  munderover: 3,
};

function expectValidMathml(mathml: string): void {
  expect(xmlWellFormed(mathml).ok).toBe(true);
  for (const [element, count] of Object.entries(MATHML_CHILD_COUNTS)) {
    expect(xpathCount(mathml, `//${element}[count(*) != ${count}]`), `${element} children`).toBe(0);
  }
  expect(xpathCount(mathml, '//mo[normalize-space(.) = ""]'), 'empty operators').toBe(0);
  expect(xpathCount(mathml, '//*[(self::msup or self::msub or self::msubsup)][*[1][self::mrow][not(*)]]'), 'scripts without a base').toBe(0);
}

/** The element names under `/math`, in order. */
function topLevel(mathml: string): string[] {
  const count = Number(xpathString(mathml, 'count(/math/*)'));
  return Array.from({ length: count }, (_, index) => xpathString(mathml, `name(/math/*[${index + 1}])`));
}

describe('equation scripts to MathML and LaTeX', () => {
  oracleTest('E = m c^2: the exponent belongs to c', ['xmllint'], () => {
    const mathml = hwpEquationToMathML('E = m c^2');
    expectValidMathml(mathml);
    expect(topLevel(mathml)).toEqual(['mi', 'mo', 'mi', 'msup']);
    expect(xpathString(mathml, 'string(/math/msup/*[1])')).toBe('c');
    expect(xpathString(mathml, 'string(/math/msup/*[2])')).toBe('2');
    expect(hwpEquationToLaTeX('E = m c^2')).toBe('E = m c^2');
  });

  oracleTest('{d y} over {d x}: a fraction of two groups', ['xmllint'], () => {
    const mathml = hwpEquationToMathML('{d y} over {d x}');
    expectValidMathml(mathml);
    expect(topLevel(mathml)).toEqual(['mfrac']);
    expect(xpathString(mathml, 'string(/math/mfrac/*[1])')).toBe('dy');
    expect(xpathString(mathml, 'string(/math/mfrac/*[2])')).toBe('dx');
    expect(hwpEquationToLaTeX('{d y} over {d x}')).toBe('\\frac{d y}{d x}');
  });

  oracleTest('1 over 2: a fraction of two numbers', ['xmllint'], () => {
    const mathml = hwpEquationToMathML('1 over 2');
    expectValidMathml(mathml);
    expect(xpathString(mathml, 'name(/math/mfrac/*[1])')).toBe('mn');
    expect(xpathString(mathml, 'string(/math/mfrac/*[2])')).toBe('2');
    expect(hwpEquationToLaTeX('1 over 2')).toBe('\\frac{1}{2}');
  });

  oracleTest('sum with limits, then an equation with a fraction', ['xmllint'], () => {
    const script = 'sum_{i=1}^{n} i = {n(n+1)} over {2}';
    const mathml = hwpEquationToMathML(script);
    expectValidMathml(mathml);
    expect(topLevel(mathml)).toEqual(['munderover', 'mi', 'mo', 'mfrac']);
    expect(xpathString(mathml, 'string(/math/munderover/*[1])')).toBe('∑');
    expect(xpathString(mathml, 'string(/math/munderover/*[2])')).toBe('i=1');
    expect(xpathString(mathml, 'string(/math/munderover/*[3])')).toBe('n');
    expect(xpathString(mathml, 'string(/math/mfrac/*[1])')).toBe('n(n+1)');
    expect(xpathString(mathml, 'string(/math/mfrac/*[2])')).toBe('2');
    expect(hwpEquationToLaTeX(script)).toBe('\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}');
  });

  oracleTest('the normal distribution density: nested fractions, a root and an exponent with a fraction', ['xmllint'], () => {
    const script = 'f(x) = {1} over {sqrt{2 pi}} e^{-{x^2} over {2}}';
    const mathml = hwpEquationToMathML(script);
    expectValidMathml(mathml);
    expect(topLevel(mathml)).toEqual(['mi', 'mo', 'mi', 'mo', 'mo', 'mfrac', 'msup']);
    expect(xpathString(mathml, 'string(/math/mfrac/*[2]/self::msqrt)')).toBe('2π');
    expect(xpathString(mathml, 'string(/math/msup/*[1])')).toBe('e');
    expect(xpathString(mathml, 'name(/math/msup/*[2]/*[2])')).toBe('mfrac');
    expect(xpathString(mathml, 'name(/math/msup/*[2]/*[2]/*[1])')).toBe('msup');
    expect(hwpEquationToLaTeX(script)).toBe('f(x) = \\frac{1}{\\sqrt{2 \\pi}} e^{-\\frac{x^2}{2}}');
  });

  oracleTest('square roots and nth roots', ['xmllint'], () => {
    const sqrt = hwpEquationToMathML('sqrt {x + 1}');
    expectValidMathml(sqrt);
    expect(topLevel(sqrt)).toEqual(['msqrt']);
    expect(xpathString(sqrt, 'string(/math/msqrt)')).toBe('x+1');
    expect(hwpEquationToLaTeX('sqrt {x + 1}')).toBe('\\sqrt{x + 1}');

    const root = hwpEquationToMathML('root {3} of {x^2}');
    expectValidMathml(root);
    expect(xpathString(root, 'name(/math/mroot/*[1])')).toBe('msup');
    expect(xpathString(root, 'string(/math/mroot/*[2])')).toBe('3');
    expect(hwpEquationToLaTeX('root {3} of {x^2}')).toBe('\\sqrt[3]{x^2}');
  });

  oracleTest('Greek letters, comparison and arrow operators', ['xmllint'], () => {
    const greek = hwpEquationToMathML('alpha + beta');
    expectValidMathml(greek);
    expect([1, 2, 3].map((position) => xpathString(greek, `string(/math/*[${position}])`))).toEqual(['α', '+', 'β']);
    expect(hwpEquationToLaTeX('alpha + beta')).toBe('\\alpha + \\beta');

    const operators = hwpEquationToMathML('x <= y -> z != 0');
    expectValidMathml(operators);
    expect(xpathString(operators, 'string(/math)')).toBe('x≤y→z≠0');
    expect(hwpEquationToLaTeX('x <= y -> z != 0')).toBe('x \\le y \\to z \\ne 0');
  });

  oracleTest('subscripts, superscripts and both together', ['xmllint'], () => {
    const sub = hwpEquationToMathML('a_1');
    expectValidMathml(sub);
    expect(topLevel(sub)).toEqual(['msub']);
    expect(hwpEquationToLaTeX('a_1')).toBe('a_1');

    const both = hwpEquationToMathML('a_{ij}^2');
    expectValidMathml(both);
    expect(topLevel(both)).toEqual(['msubsup']);
    expect(xpathString(both, 'string(/math/msubsup/*[2])')).toBe('ij');
    expect(xpathString(both, 'string(/math/msubsup/*[3])')).toBe('2');
    expect(hwpEquationToLaTeX('a_{ij}^2')).toBe('a_{ij}^2');
  });

  oracleTest('integral with limits uses side scripts; lim puts its limit underneath', ['xmllint'], () => {
    const integral = hwpEquationToMathML('int_0^1 f(x)');
    expectValidMathml(integral);
    expect(xpathString(integral, 'name(/math/*[1])')).toBe('msubsup');
    expect(xpathString(integral, 'string(/math/msubsup/*[1])')).toBe('∫');
    expect(hwpEquationToLaTeX('int_0^1 f(x)')).toBe('\\int_0^1 f(x)');

    const limit = hwpEquationToMathML('lim_{n -> infty} a_n');
    expectValidMathml(limit);
    expect(xpathString(limit, 'name(/math/*[1])')).toBe('munder');
    expect(xpathString(limit, 'string(/math/munder/*[2])')).toBe('n→∞');
    expect(hwpEquationToLaTeX('lim_{n -> infty} a_n')).toBe('\\lim_{n \\to \\infty} a_n');
  });

  oracleTest('left and right fences wrap their content', ['xmllint'], () => {
    const mathml = hwpEquationToMathML('left ( a over b right )');
    expectValidMathml(mathml);
    expect(xpathString(mathml, 'string(/math/mrow/mo[1])')).toBe('(');
    expect(xpathString(mathml, 'string(/math/mrow/mo[2])')).toBe(')');
    expect(xpathString(mathml, 'name(/math/mrow/mfrac)')).toBe('mfrac');
    expect(hwpEquationToLaTeX('left ( a over b right )')).toBe('\\left( \\frac{a}{b} \\right)');
  });

  oracleTest('a matrix is a table with one row per # and one cell per &', ['xmllint'], () => {
    const mathml = hwpEquationToMathML('matrix{a & b # c & d}');
    expectValidMathml(mathml);
    expect(xpathCount(mathml, '/math/mtable/mtr')).toBe(2);
    expect(xpathCount(mathml, '/math/mtable/mtr/mtd')).toBe(4);
    expect([1, 2].map((row) => [1, 2].map((col) => xpathString(mathml, `string(/math/mtable/mtr[${row}]/mtd[${col}])`)))).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(hwpEquationToLaTeX('matrix{a & b # c & d}')).toBe('\\begin{matrix} a & b \\\\ c & d \\end{matrix}');
  });

  oracleTest('a word that is not a keyword is a run of variables; function names stay upright; quoted text is text', ['xmllint'], () => {
    const variables = hwpEquationToMathML('abc');
    expect(topLevel(variables)).toEqual(['mi', 'mi', 'mi']);

    const functions = hwpEquationToMathML('sin x');
    expectValidMathml(functions);
    expect(xpathString(functions, 'string(/math/mi[1]/@mathvariant)')).toBe('normal');
    expect(hwpEquationToLaTeX('sin x')).toBe('\\sin x');

    const text = hwpEquationToMathML('"if" x < 1');
    expectValidMathml(text);
    expect(xpathString(text, 'string(/math/mtext)')).toBe('if');
    expect(xpathString(text, 'string(/math/mo)')).toBe('<');
  });

  it('an empty script is an empty equation', () => {
    expect(hwpEquationToMathML('')).toBe('<math></math>');
    expect(hwpEquationToLaTeX('   ')).toBe('');
  });

  it.each([
    ['{ { { unclosed', "a '{' is not closed"],
    ['x }', "unexpected '}'"],
    ['over 2', "'over' has no numerator"],
    ['1 over', "'over' has no denominator"],
    ['sqrt', "'sqrt' has no operand"],
    ['root {3} x', "'root' needs 'of' after its index"],
    ['left ( x', "'left' has no matching 'right'"],
    ['x # y', "'#' is only valid inside a matrix"],
    ['"unterminated', 'a quoted text is not closed'],
    ['matrix{a & b', "the { } body of 'matrix' is not closed"],
  ])('%j does not parse and is refused', (script, detail) => {
    for (const transpile of [hwpEquationToMathML, hwpEquationToLaTeX]) {
      let failure: unknown;
      try {
        transpile(script);
      } catch (err) {
        failure = err;
      }
      expect(failure).toBeInstanceOf(CorruptStreamError);
      expect((failure as Error).message).toBe(`Invalid HWP equation "${script}": ${detail}`);
    }
  });

  it('refuses a script nested deeper than the limit and one longer than the limit', () => {
    const deep = `${'{'.repeat(65)}x${'}'.repeat(65)}`;
    expect(() => hwpEquationToMathML(deep)).toThrow(/nesting deeper than 64 levels/);
    expect(() => hwpEquationToMathML('x'.repeat(100_001))).toThrow(/longer than 100000 characters/);
  });

  it('markup characters in operators are escaped in MathML', () => {
    expect(hwpEquationToMathML('a < b')).toBe('<math><mi>a</mi><mo>&lt;</mo><mi>b</mi></math>');
    expect(hwpEquationToMathML('"a & b"')).toBe('<math><mtext>a &amp; b</mtext></math>');
  });
});
