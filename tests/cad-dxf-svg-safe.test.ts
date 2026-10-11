import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { dxfDrawingToSvg, parseDxfDrawing, type DxfDrawing, type DxfStroke, type DxfText } from '../src/lib/conversions/cad-dxf';
import { convertFile } from '../src/lib/conversions';
import { sanitizeSvgDocument } from '../src/lib/security/svg-sanitizer';

/**
 * The SVG written for a DXF is not passed through the general sanitizer (it is safe by construction: a fixed set of elements
 * and attributes, numbers the writer printed, and two escaped free texts). This file is the proof the exemption rests on:
 * for hostile titles and texts and for random drawings the sanitizer must change nothing, an independent XML parser
 * (libxml2 inside the SVG renderer of the image library) must read the document, and the element and attribute names
 * must come from the fixed set. A SVG that comes from a user never skips the sanitizer.
 */

const ELEMENTS = new Set(['svg', 'title', 'g', 'line', 'circle', 'path', 'polyline', 'polygon', 'text']);
const ATTRIBUTES = new Set([
  'xmlns', 'viewBox', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'd', 'points', 'x', 'y', 'font-family', 'font-size', 'text-anchor', 'transform',
]);

const HOSTILE = [
  '</text><script>alert(1)</script>',
  '<script>alert(1)</script>',
  '"/><circle r="1" onload="alert(1)"/>',
  '" onload="alert(1)',
  'javascript:alert(1)',
  '<a href="javascript:alert(1)">x</a>',
  '<!-- comment -->',
  '<![CDATA[ x ]]>',
  ']]>',
  '<?xml-stylesheet href="http://example.test/x.css"?>',
  '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>&x;',
  '&amp;&lt;&#60;&#x3C;&xxe;',
  'url(http://example.test/a)',
  '<style>@import url(http://example.test/a.css);</style>',
  '<foreignObject><iframe src="http://example.test"/></foreignObject>',
  '<use href="http://example.test/a.svg#x"/>',
  '\u0000\u0001\u0008\u000b\u000c\u001f￾￿',
  '\ud800 lone high \udc00 lone low 😀 pair',
  'tab\tnewline\ncarriage\rreturn',
  'Ünïcödé 日本語 ✓',
  '',
  ' ',
];

const strokeSamples: DxfStroke[] = [
  { kind: 'line', a: [0, 0], b: [10, 5] },
  { kind: 'circle', centre: [5, 5], radius: 2 },
  { kind: 'arc', centre: [5, 5], radius: 3, start: 0, end: Math.PI },
  { kind: 'poly', points: [[0, 0], [3, 4], [6, 0]], closed: false },
  { kind: 'poly', points: [[0, 0], [3, 4], [6, 0]], closed: true },
];

function drawingWith(texts: DxfText[], strokes: DxfStroke[] = strokeSamples): DxfDrawing {
  return { strokes, texts, extents: { minX: -10, minY: -10, maxX: 20, maxY: 20 } };
}

function text(line: string, rotation = 0, anchor: DxfText['anchor'] = 'start'): DxfText {
  return { at: [1, 2], height: 1.5, rotation, lines: [line, `${line} second`], anchor, hangsFromTop: false };
}

/** Names of the elements and attributes in the document, read with a tokenizer written here (quoted values skipped). */
function names(svg: string): { elements: Set<string>; attributes: Set<string> } {
  const elements = new Set<string>();
  const attributes = new Set<string>();
  const tag = /<([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*\/?>/g;
  for (const match of svg.matchAll(tag)) {
    elements.add(match[1]);
    for (const attribute of match[2].matchAll(/\s([\w:-]+)="/g)) attributes.add(attribute[1]);
  }
  return { elements, attributes };
}

async function expectSafe(svg: string): Promise<void> {
  // The general sanitizer finds nothing to remove or rewrite.
  expect(sanitizeSvgDocument(svg)).toBe(svg);
  // An independent XML parser reads the whole document: it is well-formed and carries a drawing.
  const meta = await sharp(Buffer.from(svg, 'utf-8')).metadata();
  expect(meta.width).toBeGreaterThan(0);
  // Only the fixed set of names appears, and no tag was smuggled into a text: the number of `<` equals the number of tags
  // the tokenizer read plus the end tags and the declaration.
  const { elements, attributes } = names(svg);
  for (const element of elements) expect(ELEMENTS.has(element), `element ${element}`).toBe(true);
  for (const attribute of attributes) expect(ATTRIBUTES.has(attribute), `attribute ${attribute}`).toBe(true);
  const opened = (svg.match(/</g) ?? []).length;
  const tokens = (svg.match(/<[A-Za-z][^<>]*>/g) ?? []).length + (svg.match(/<\/[A-Za-z]+>/g) ?? []).length + 1;
  expect(opened).toBe(tokens);
}

describe('the SVG of a DXF drawing', () => {
  for (const [index, hostile] of HOSTILE.entries()) {
    it(`passes the sanitizer unchanged with the hostile text #${index} in a title and in drawing texts`, async () => {
      const svg = dxfDrawingToSvg(drawingWith([text(hostile), text(hostile, 0.5, 'middle'), text(hostile, 2, 'end')]), hostile);
      await expectSafe(svg);
    });
  }

  it('carries the visible characters of a text through, escaped, and leaves out the characters XML cannot hold', () => {
    // The expectation is written from XML 1.0 (section 2.2, Char; section 2.4, markup characters), not from the writer.
    const expected = (value: string): string =>
      [...value]
        .filter((character) => /^[\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]$/u.test(character))
        .map((character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character] ?? character)
        .join('');
    const title = 'T & <U>';
    const line = 'a<b>&"c\u0001d\ud83d\ude00\ud800';
    const svg = dxfDrawingToSvg(drawingWith([text(line)]), title);
    const titles = [...svg.matchAll(/<title>(.*)<\/title>/g)].map((match) => match[1]);
    const texts = [...svg.matchAll(/<text [^>]*>(.*?)<\/text>/g)].map((match) => match[1]);
    expect(titles).toEqual([expected(title)]);
    expect(texts).toEqual([expected(line), expected(`${line} second`)]);
    expect(texts[0]).toBe('a&lt;b&gt;&amp;&quot;cd\ud83d\ude00');
  });

  it('passes the sanitizer unchanged for random drawings with random texts', async () => {
    let state = 20_251_011;
    const random = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return (state >>> 8) / 0x1000000;
    };
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    const point = (): [number, number] => [(random() - 0.5) * 1000 ** (random() * 2), (random() - 0.5) * 1000 ** (random() * 2)];
    const alphabet = [...'abcXYZ019 .,;:/\\<>&"\'=()[]{}!?#%*+-_|~`^'].concat(['\u0001', 'é', '日', '😀', '￾', '\ud800']);
    const randomText = (): string => Array.from({ length: Math.floor(random() * 30) }, () => pick(alphabet)).join('') + (random() < 0.3 ? pick(HOSTILE) : '');
    for (let round = 0; round < 150; round++) {
      const strokes: DxfStroke[] = [];
      for (let i = Math.floor(random() * 12) + 1; i > 0; i--) {
        const kind = Math.floor(random() * 4);
        if (kind === 0) strokes.push({ kind: 'line', a: point(), b: point() });
        else if (kind === 1) strokes.push({ kind: 'circle', centre: point(), radius: random() * 100 + 1e-6 });
        else if (kind === 2) strokes.push({ kind: 'arc', centre: point(), radius: random() * 100 + 1e-6, start: random() * 3, end: 3 + random() * 3 });
        else strokes.push({ kind: 'poly', points: Array.from({ length: 2 + Math.floor(random() * 6) }, point), closed: random() < 0.5 });
      }
      const texts = Array.from({ length: Math.floor(random() * 4) }, () => text(randomText(), (random() - 0.5) * 7, pick(['start', 'middle', 'end'] as const)));
      const xs = strokes.flatMap((s) => (s.kind === 'line' ? [s.a[0], s.b[0]] : s.kind === 'poly' ? s.points.map((p) => p[0]) : [s.centre[0] - 100, s.centre[0] + 100]));
      const ys = strokes.flatMap((s) => (s.kind === 'line' ? [s.a[1], s.b[1]] : s.kind === 'poly' ? s.points.map((p) => p[1]) : [s.centre[1] - 100, s.centre[1] + 100]));
      const drawing: DxfDrawing = { strokes, texts, extents: { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) } };
      await expectSafe(dxfDrawingToSvg(drawing, randomText()));
    }
  }, 120_000);

  it('is the document a DXF file with hostile texts converts to, end to end', async () => {
    const entry = (value: string): string => `  0\nTEXT\n 10\n1\n 20\n2\n 40\n3\n  1\n${value.replace(/\r?\n/g, ' ')}\n`;
    const dxf = `  0\nSECTION\n  2\nENTITIES\n  0\nLINE\n 10\n0\n 20\n0\n 11\n10\n 21\n10\n${HOSTILE.map(entry).join('')}  0\nENDSEC\n  0\nEOF\n`;
    const result = await convertFile(Buffer.from(dxf, 'utf-8'), 'dxf', 'svg', {}, '"><script>alert(1)</script>.dxf');
    const svg = result.buffer.toString('utf-8');
    await expectSafe(svg);
    expect(parseDxfDrawing(dxf).texts.length).toBeGreaterThan(5);
  });
});
