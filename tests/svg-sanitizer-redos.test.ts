import { describe, expect, it } from 'vitest';
import { MAX_SVG_INPUT_CHARS } from '../src/lib/conversions/svg-geometry';
import { convertVectorCad } from '../src/lib/conversions/vector-cad';
import { simpleXmlToJson } from '../src/lib/conversions/data';
import { isSvg, sanitizeSvgBuffer, sanitizeSvgDocument, sanitizeSvgString } from '../src/lib/security/svg-sanitizer';
import { ConversionFailedError, SvgSanitizationError } from '../src/lib/types';

// Every input below took more than 2 s on the regex-based sanitizer; the linear scanner must stay far below that.
const LINEAR_BUDGET_MS = 1000;
const NESTED_OPENER_DEPTH = 5000;

function timed<T>(run: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
}

function expectLinear(input: string): string {
  const { value, ms } = timed(() => sanitizeSvgString(input));
  expect(ms).toBeLessThan(LINEAR_BUDGET_MS);
  return value;
}

describe('SVG sanitizer linear-time guarantees (issue #399)', () => {
  const unterminatedOpeners: Array<[string, string, number]> = [
    ['script', '<script>', 40000],
    ['foreignObject', '<foreignObject>', 28000],
    ['iframe', '<iframe>', 120000],
    ['object', '<object>', 120000],
    ['embed', '<embed>', 40000],
    ['meta', '<meta ', 30000],
    ['link', '<link ', 30000],
  ];

  for (const [name, opener, count] of unterminatedOpeners) {
    it(`strips ${count} unterminated <${name}> openers in linear time`, () => {
      const out = expectLinear(`<svg><circle r="1"/>${opener.repeat(count)}`);
      expect(out).toBe('<svg><circle r="1"/>');
    });
  }

  it('neutralizes many unterminated <style> openers in linear time', () => {
    const out = expectLinear(`<svg>${'<style>'.repeat(40000)}</svg>`);
    expect(out).toBe(`<svg><style>${'<style>'.repeat(39999)}</svg></style>`);
  });

  it('strips many unterminated DOCTYPE openers in linear time', () => {
    const out = expectLinear(`<svg>${'<!DOCTYPE '.repeat(25000)}`);
    expect(out).toBe('<svg>');
  });

  it('strips many unterminated DOCTYPE internal subsets in linear time', () => {
    const out = expectLinear(`<svg>${'<!DOCTYPE a ['.repeat(45000)}</svg>`);
    expect(out).toBe('<svg>');
  });

  it('strips many unterminated ENTITY declarations in linear time', () => {
    const out = expectLinear(`<svg>${'<!ENTITY '.repeat(30000)}`);
    expect(out).toBe('<svg>');
  });

  it('handles a long whitespace run before attributes in linear time', () => {
    const out = expectLinear(`<svg>${' '.repeat(80000)}<circle r="1"/></svg>`);
    expect(out).toBe(`<svg>${' '.repeat(80000)}<circle r="1"/></svg>`);
  });

  it('neutralizes many unterminated CSS url() externals in linear time', () => {
    const out = expectLinear(`<svg><style>${'url(http:'.repeat(15000)}</style></svg>`);
    expect(out).toBe('<svg><style>none</style></svg>');
  });

  it('neutralizes many quote-mismatched CSS url() externals in linear time', () => {
    const out = expectLinear(`<svg><style>${"url('http:".repeat(15000)}")</style></svg>`);
    expect(out).toBe('<svg><style>none</style></svg>');
  });

  it('rejects deeply nested split-opener payloads with a typed error in linear time', () => {
    const payload = `<svg>${'<scr'.repeat(NESTED_OPENER_DEPTH)}<script>${'ipt>'.repeat(NESTED_OPENER_DEPTH)}</svg>`;
    const { ms } = timed(() => {
      expect(() => sanitizeSvgString(payload)).toThrow(SvgSanitizationError);
      expect(() => sanitizeSvgString(payload)).toThrow(/cannot be sanitized safely/);
    });
    expect(ms).toBeLessThan(LINEAR_BUDGET_MS);
  });

  it('isSvg handles many unterminated comments in linear time', () => {
    const { value, ms } = timed(() => isSvg(`${'<!--'.repeat(150000)}<svg/>`));
    expect(ms).toBeLessThan(LINEAR_BUDGET_MS);
    expect(value).toBe(false);
    expect(isSvg('<!-- note --><svg/>')).toBe(true);
  });
});

describe('SVG sanitizer scanner semantics', () => {
  it('strips paired dangerous elements case-insensitively with their content', () => {
    const out = sanitizeSvgString('<svg><SCRIPT type="x">alert(1)</Script ><rect/><foreignobject><p/></FOREIGNOBJECT></svg>');
    expect(out).toBe('<svg><rect/></svg>');
  });

  it('treats a quoted > inside an opening tag as attribute text', () => {
    const out = sanitizeSvgString('<svg><script title=">">alert(1)</script><rect/></svg>');
    expect(out).toBe('<svg><rect/></svg>');
  });

  it('drops an unterminated opening tag through the end of input', () => {
    const out = sanitizeSvgString('<svg><rect/><script src="x');
    expect(out).toBe('<svg><rect/>');
  });

  it('strips only the opener when no close tag exists', () => {
    const out = sanitizeSvgString('<svg><iframe src="x"><rect/></svg>');
    expect(out).toBe('<svg><rect/></svg>');
  });

  it('keeps similarly named elements that are not dangerous', () => {
    const out = sanitizeSvgString('<svg><scripted/><linearGradient id="g"/></svg>');
    expect(out).toBe('<svg><scripted/><linearGradient id="g"/></svg>');
  });

  it('rebuilds split openers until stable', () => {
    const out = sanitizeSvgString('<svg><scr<script>ipt>alert(1)</script><rect/></svg>');
    expect(out).toBe('<svg><scr<rect/></svg>');
  });

  it('removes an unterminated external CSS url() instead of leaving it', () => {
    const out = sanitizeSvgString('<svg><style>a{background:url(http://evil.test/x</style></svg>');
    expect(out).toBe('<svg><style>a{background:none</style></svg>');
  });

  it('removes an unterminated DOCTYPE', () => {
    const out = sanitizeSvgString('<!DOCTYPE svg [<!ENTITY x "y"><svg><rect/></svg>');
    expect(out).toBe('');
  });
});

describe('SVG sanitizer input size cap', () => {
  const oversizedSvg = `<svg>${' '.repeat(MAX_SVG_INPUT_CHARS)}</svg>`;
  const OVERSIZED_MESSAGE = `SVG input exceeds the ${MAX_SVG_INPUT_CHARS}-character limit.`;

  it('rejects SVG input above the limit through the capped SVG entry with a typed error', () => {
    expect(() => sanitizeSvgDocument(oversizedSvg)).toThrow(SvgSanitizationError);
    expect(() => sanitizeSvgDocument(oversizedSvg)).toThrow(OVERSIZED_MESSAGE);
  });

  it('rejects an oversized SVG buffer with the typed error', () => {
    expect(() => sanitizeSvgBuffer(Buffer.from(oversizedSvg, 'utf-8'))).toThrow(SvgSanitizationError);
  });

  it('rejects an oversized SVG at the SVG conversion entry', async () => {
    await expect(convertVectorCad(Buffer.from(oversizedSvg, 'utf-8'), 'svg', 'png')).rejects.toThrow(OVERSIZED_MESSAGE);
  });

  it('accepts SVG exactly at the limit', () => {
    const atLimit = `<svg>${'a'.repeat(MAX_SVG_INPUT_CHARS - '<svg></svg>'.length)}</svg>`;
    const out = sanitizeSvgDocument(atLimit);
    expect(out.length).toBe(MAX_SVG_INPUT_CHARS);
    expect(out.startsWith('<svg>aaa')).toBe(true);
  });

  it('does not cap the shared string sanitizer used for arbitrary XML', () => {
    const out = sanitizeSvgString(oversizedSvg);
    expect(out.length).toBe(oversizedSvg.length);
    expect(out.startsWith('<svg> ')).toBe(true);
  });

  it('converts XML larger than the SVG cap through the data path', () => {
    const payload = 'x'.repeat(MAX_SVG_INPUT_CHARS + 1024);
    const parsed = simpleXmlToJson(`<root><item>${payload}</item></root>`);
    const root = parsed.root as { item: string };
    expect(root.item.length).toBe(payload.length);
    expect(root.item.slice(0, 8)).toBe('xxxxxxxx');
  });
});
