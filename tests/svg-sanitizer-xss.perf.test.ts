import { describe, expect, it } from 'vitest';
import { sanitizeSvgString } from '../src/lib/security/svg-sanitizer';
import { expectLinearOnInputs, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

/**
 * Timing-ratio checks moved out of svg-sanitizer-xss.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in svg-sanitizer-xss.test.ts.
 */

const GROWTH_FACTOR = 16;
const MAX_GROWTH_RATIO = GROWTH_FACTOR * 4;
const BASE_BYTES = 128 * 1024;
/** Element counts for the tests that scale the number of tags rather than the number of bytes. */
const BASE_COUNT = 2_500;

/** A test that compares two input sizes needs more than the 5 s default on a loaded runner. */
const linearIt = (name: string, body: () => Promise<void>) => it(name, body, SCALING_TEST_TIMEOUT_MS);

/** Builds the adversarial document at both sizes, checks linear scaling, then lets `check` inspect the large output. */
async function expectLinearSanitization(
  label: string,
  build: (bytes: number) => string,
  check?: (out: string) => void,
  baseSize: number = BASE_BYTES
): Promise<void> {
  const small = build(baseSize);
  const large = build(baseSize * GROWTH_FACTOR);
  await expectLinearOnInputs(label, (svg: string) => sanitizeSvgString(svg), { small, large, factor: GROWTH_FACTOR, maxRatio: MAX_GROWTH_RATIO });
  check?.(sanitizeSvgString(large));
}

/** Independent CSS reader for the oracle: strips comments, then decodes escapes (CSS Syntax 4.3.7). */
function cssAsParsed(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '')
    .replace(/\\(?:[0-9a-fA-F]{1,6}[ \t\n\r\f]?|\r\n|[\n\r\f]|([\s\S]))/g, (whole: string, literal: string | undefined) => {
      if (literal !== undefined) return literal;
      const hex = /^\\([0-9a-fA-F]{1,6})/.exec(whole);
      return hex === null ? '' : String.fromCodePoint(parseInt(hex[1], 16));
    });
}

const XML_NAMED = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"]]);

/** XML character and predefined entity references, as an XML parser resolves them in text or attribute values. */
function xmlEntitiesDecoded(text: string): string {
  return text.replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g, (_, hex?: string, dec?: string, name?: string) =>
    name === undefined ? String.fromCodePoint(hex === undefined ? Number(dec) : parseInt(hex, 16)) : (XML_NAMED.get(name) as string)
  );
}

/** Text of a <style> element as a parser sees it: CDATA content is literal, everything else has entities resolved. */
function elementTextAsParsed(body: string): string {
  return body
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
    .map((segment) => (segment.startsWith('<![CDATA[') ? segment.slice('<![CDATA['.length, -']]>'.length) : xmlEntitiesDecoded(segment)))
    .join('');
}

function cssLeaks(out: string): string[] {
  const found: string[] = [];
  const bodies = [
    ...[...out.matchAll(/<(?:[\w.-]+:)?style[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?style\s*>/gi)].map((m) => cssAsParsed(elementTextAsParsed(m[1]))),
    ...[...out.matchAll(/\sstyle="([^"]*)"/g)].map((m) => cssAsParsed(xmlEntitiesDecoded(m[1]))),
  ];
  for (const parsed of bodies) {
    if (/@import/i.test(parsed)) found.push(`@import in ${parsed}`);
    // URL parsers drop ASCII tab and newlines anywhere in the value, and treat '\\' like '/' before the host.
    const flat = parsed.replace(/[\t\n\r]/g, '');
    if (/(?:url|src)\(\s*['"]?\s*(?:https?:|file:|ftp:|\/\/|\\\\|\/\\)/i.test(flat)) found.push(`external url in ${parsed}`);
    if (/image-set\([^)]*?['"(\s,](?:https?:|file:|ftp:|\/\/)/i.test(flat)) found.push(`external image-set in ${parsed}`);
  }
  return found;
}

describe('on* attribute stripping without leading whitespace (item 4)', () => {
  linearIt('strips handlers on a large tag in linear time', async () => {
    await expectLinearSanitization(
      'handlers on one tag',
      (count) => `<svg${' a="1"onload=x'.repeat(count)}>`,
      (out) => {
        expect(out.startsWith('<svg a="1" a="1"')).toBe(true);
        expect(out).not.toContain('onload');
      },
      BASE_COUNT
    );
  });
});

describe('@import, namespaced elements and animation targets (item 5)', () => {
  linearIt('strips many distinct prefixed openers in linear time', async () => {
    await expectLinearSanitization(
      'distinct prefixed script openers',
      (count) => `<svg>${Array.from({ length: count }, (_, i) => `<p${i}:script>`).join('')}</svg>`,
      (out) => expect(out).toBe('<svg></svg>'),
      BASE_COUNT
    );
  });
});

describe('CSS escape and comment obfuscation (issue #401 item 1)', () => {
  describe('linear time on adversarial CSS', () => {
    const adversarial: Array<[string, (n: number) => string]> = [
      ['backslashes', (n) => '\\'.repeat(n / 2)],
      ['escape digits', (n) => '\\6'.repeat(n / 3)],
      ['comment openers', (n) => '/*'.repeat(n / 2)],
      ['closed empty comments', (n) => '/**/'.repeat(n / 4)],
      ['obfuscated imports', (n) => '@\\69mport a;'.repeat(Math.floor(n / 13))],
      ['obfuscated urls', (n) => 'u\\72l(http://e/x)'.repeat(Math.floor(n / 18))],
      ['unterminated urls', (n) => 'ur/**/l(http://'.repeat(Math.floor(n / 15))],
    ];

    for (const [label, css] of adversarial) {
      linearIt(`handles ${label}`, async () => {
        await expectLinearSanitization(
          label,
          (n) => `<svg><style>${css(n)}</style></svg>`,
          (out) => expect(cssLeaks(out)).toEqual([])
        );
      });
    }
  });
});

describe('namespace-prefixed <style> elements (issue #401 item 4)', () => {
  linearIt('handles many prefixed style openers in linear time', async () => {
    await expectLinearSanitization(
      'distinct prefixed style openers',
      (count) => `<svg>${Array.from({ length: count }, (_, i) => `<p${i}:style>`).join('')}</svg>`,
      undefined,
      BASE_COUNT
    );
  });
});

describe('XML entity layer before CSS matching (issue #401 entity follow-up)', () => {
  describe('linear time on adversarial entity input', () => {
    const adversarial: Array<[string, (n: number) => string]> = [
      ['bare reference openers', (n) => '&#'.repeat(n / 2)],
      ['unterminated hex run', (n) => `&#x${'0'.repeat(n)}`],
      ['unterminated decimal runs', (n) => '&#1'.repeat(n / 3)],
      ['ampersands', (n) => '&'.repeat(n)],
      ['encoded imports', (n) => '&#x40;import a;'.repeat(Math.floor(n / 15))],
      ['encoded backslash imports', (n) => '@&#92;69mport a;'.repeat(Math.floor(n / 16))],
      ['encoded urls', (n) => 'u&#114;l(http://e/x)'.repeat(Math.floor(n / 20))],
      ['CDATA openers', (n) => '<![CDATA['.repeat(n / 9)],
      ['CDATA pairs', (n) => '<![CDATA[&#]]>'.repeat(Math.floor(n / 14))],
    ];

    for (const [label, css] of adversarial) {
      for (const [place, wrap] of [
        ['a <style> body', (c: string) => `<svg><style>${c}</style></svg>`],
        ['a style attribute', (c: string) => `<svg><rect style='${c.replace(/'/g, '&apos;')}'/></svg>`],
      ] as Array<[string, (c: string) => string]>) {
        linearIt(`handles ${label} in ${place}`, async () => {
          await expectLinearSanitization(
            label,
            (n) => wrap(css(n)),
            (out) => {
              // The oracle's own CDATA splitter is not linear, so the output scan skips the CDATA-heavy inputs.
              if (!label.startsWith('CDATA')) expect(cssLeaks(out)).toEqual([]);
            }
          );
        });
      }
    }
  });
});

describe('comments, CDATA and processing instructions are not tokenized as tags (PR #402 review item 1)', () => {
  describe('linear time on adversarial input', () => {
    const adversarial: Array<[string, (n: number) => string]> = [
      ['unterminated comment openers', (n) => '<!--'.repeat(n / 4)],
      ['unterminated PI openers', (n) => '<?'.repeat(n / 2)],
      ['unterminated CDATA openers', (n) => '<![CDATA['.repeat(n / 9)],
      ['terminated decoy comments', (n) => '<!-- <a x=" -->'.repeat(n / 15)],
      ['terminated decoy PIs', (n) => '<?p <a x=" ?>'.repeat(Math.floor(n / 13))],
      ['terminated decoy CDATA', (n) => '<![CDATA[ <a x=" ]]>'.repeat(n / 20)],
      ['decoys followed by real tags', (n) => '<!-- <a x=" --><a href="javascript:1" y=""/>'.repeat(Math.floor(n / 46))],
    ];

    for (const [label, body] of adversarial) {
      linearIt(`handles ${label}`, async () => {
        await expectLinearSanitization(
          label,
          (n) => `<svg>${body(n)}</svg>`,
          (out) => {
            expect(out.startsWith('<svg>')).toBe(true);
            expect(out).not.toContain('javascript:1');
          }
        );
      });
    }
  });
});

describe('</style> inside CDATA does not end the style element (PR #402 review item 2)', () => {
  linearIt('finds the close tag in linear time past many CDATA sections', async () => {
    await expectLinearSanitization(
      'CDATA sections holding close tags',
      (n) => `<svg><style>${'<![CDATA[</style>]]>'.repeat(n / 20)}@import "http://e";</style></svg>`,
      (out) => {
        expect(out).not.toContain('@import');
        expect(out.endsWith('</style></svg>')).toBe(true);
      }
    );
  });
});

describe('external CSS reference forms (PR #402 review item 3)', () => {
  describe('linear time on adversarial CSS', () => {
    const adversarial: Array<[string, (n: number) => string]> = [
      ['unterminated image-set openers', (n) => 'image-set('.repeat(n / 10)],
      ['nested benign image-sets', (n) => `${'image-set('.repeat(n / 20)}${')'.repeat(n / 20)}`],
      ['nested image-sets with an external tail', (n) => `${'image-set('.repeat(n / 20)}"http://e/x"${')'.repeat(n / 20)}`],
      ['url openers', (n) => 'url('.repeat(n / 4)],
      ['whitespace after url(', (n) => `url(${' '.repeat(n)}`],
      ['tab runs inside schemes', (n) => 'url(h\t\t\t\t\t\t\t\tt\t\t\t\t'.repeat(n / 28)],
      ['src openers', (n) => 'src("'.repeat(n / 5)],
      ['backslash authorities', (n) => 'url(\\\\'.repeat(n / 6)],
    ];

    for (const [label, css] of adversarial) {
      linearIt(`handles ${label}`, async () => {
        await expectLinearSanitization(label, (n) => `<svg><style>${css(n)}</style></svg>`);
      });
    }
  });
});

describe('external references in presentation attributes (issue #403 item 1)', () => {
  describe('linear time on adversarial attributes', () => {
    const adversarial: Array<[string, (bytes: number) => string]> = [
      ['url openers', (bytes) => `<rect fill="${'url('.repeat(bytes / 4)}"/>`],
      ['many attributes', (bytes) => `<rect ${'fill="url(http://e/x)" '.repeat(Math.floor(bytes / 24))}/>`],
      ['many elements', (bytes) => '<rect fill="url(http://e/x)"/>'.repeat(Math.floor(bytes / 30))],
    ];
    for (const [label, build] of adversarial) {
      linearIt(`handles ${label}`, async () => {
        await expectLinearSanitization(label, (bytes) => `<svg>${build(bytes)}</svg>`);
      });
    }
  });
});

describe('animations writing external references into presentation attributes (issue #403 item 2)', () => {
  linearIt('removes many hostile animations in linear time', async () => {
    const unit = '<set attributeName="fill" to="url(http://e/x)"/>';
    await expectLinearSanitization(
      'hostile animations',
      (bytes) => `<svg>${unit.repeat(bytes / unit.length)}</svg>`,
      (out) => expect(out).toBe('<svg></svg>')
    );
  });
});

describe('animations writing dangerous URIs into any attribute (issue #403 item 3)', () => {
  linearIt('removes many hostile animations in linear time', async () => {
    const unit = '<set attributeName="x" to="javascript:alert(1)"/>';
    await expectLinearSanitization(
      'hostile animations writing URIs',
      (bytes) => `<svg>${unit.repeat(bytes / unit.length)}</svg>`,
      (out) => expect(out).toBe('<svg></svg>')
    );
  });
});
