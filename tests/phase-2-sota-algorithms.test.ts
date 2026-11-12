import { describe, it, expect } from 'vitest';
import { oracleTest } from './helpers/oracle-test';
import { xmlWellFormed, xpathString } from './helpers/xml-oracle';

import {
  hwpEquationToMathML,
  hwpEquationToLaTeX,
  buildHwpCompoundFile,
  parseHwpDocument,
} from '../src/lib/conversions/hwp';

describe('Phase 2: Core Engine SOTA Algorithms & High-Fidelity Domain Engines (#66)', () => {

  // =========================================================================
  // 5. HWP 5.0 CFBF EqEdit MathML / LaTeX Transpilation
  // =========================================================================
  describe('5. HWP 5.0 CFBF EqEdit MathML / LaTeX Transpilation', () => {
    it('transpiles HWP fraction syntax {A} over {B} to MathML and LaTeX', () => {
      const script = '{d y} over {d x}';
      const mathml = hwpEquationToMathML(script);
      const latex = hwpEquationToLaTeX(script);

      expect(mathml).toContain('<mfrac>');
      expect(mathml).toContain('<mrow>');
      expect(mathml).toContain('d');
      expect(mathml).toContain('y');
      expect(mathml).toContain('x');
      expect(latex).toBe('\\frac{d y}{d x}');
    });

    it('transpiles HWP square roots and nth roots', () => {
      const sqrtScript = 'sqrt {x + 1}';
      expect(hwpEquationToMathML(sqrtScript)).toContain('<msqrt>');
      expect(hwpEquationToLaTeX(sqrtScript)).toBe('\\sqrt{x + 1}');

      const rootScript = 'root {3} of {x^2}';
      expect(hwpEquationToMathML(rootScript)).toContain('<mroot>');
      expect(hwpEquationToLaTeX(rootScript)).toBe('\\sqrt[3]{x^2}');
    });

    oracleTest('transpiles HWP big operators and Greek symbols', ['xmllint'], () => {
      const sumScript = 'sum_{i=1}^{n} {alpha + beta}';
      const mathml = hwpEquationToMathML(sumScript);
      const latex = hwpEquationToLaTeX(sumScript);

      // LaTeX: the summation with its limits, then the Greek letters as control sequences.
      expect(latex).toBe('\\sum_{i=1}^{n} {\\alpha + \\beta}');

      // MathML, read with XPath: well-formed, and the structure of a sum with limits (MathML 3, 3.4.5 munderover:
      // base, underscript, overscript) followed by the braced group alpha + beta (one row of three, no stray
      // spacing operators between them).
      expect(xmlWellFormed(mathml).ok).toBe(true);
      expect(xpathString(mathml, 'name(/math/*[1])')).toBe('munderover');
      expect(xpathString(mathml, 'string(/math/munderover/*[1])')).toBe('∑');
      expect(xpathString(mathml, 'string(/math/munderover/*[2])')).toBe('i=1');
      expect(xpathString(mathml, 'string(/math/munderover/*[3])')).toBe('n');
      expect(xpathString(mathml, 'count(/math/*)')).toBe('2');
      expect(xpathString(mathml, 'name(/math/*[2])')).toBe('mrow');
      expect([1, 2, 3].map((position) => xpathString(mathml, `string(/math/mrow/*[${position}])`))).toEqual(['α', '+', 'β']);
    });

    it('serializes and parses HWP 5.0 CFBF document with embedded EQEDIT records', () => {
      const eqScript = '{a} over {b} + sqrt {c}';
      const hwpBuf = buildHwpCompoundFile({
        paragraphs: [{ text: 'Calculus and Analysis Section' }],
        equations: [eqScript],
        compressed: true,
      });

      const parsed = parseHwpDocument(hwpBuf);
      expect(parsed.paragraphs.length).toBeGreaterThanOrEqual(1);
      expect(parsed.equations).toBeDefined();
      expect(parsed.equations?.length).toBe(1);
      expect(parsed.equations![0].script).toBe(eqScript);
      expect(parsed.equations![0].mathml).toContain('<mfrac>');
      expect(parsed.equations![0].latex).toContain('\\frac{a}{b}');
    });
  });
});
