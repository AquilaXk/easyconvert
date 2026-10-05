import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { renderMarkdownFragment } from '../src/lib/conversions/markdown';
import { findDangerousConstructs, normalizeHtmlFragment } from './helpers/html-dom-oracle';

/**
 * Oracle: the official CommonMark 0.31.2 spec examples (tests/fixtures/commonmark/spec-0.31.2.json,
 * provenance in spec-0.31.2.provenance.txt). The expected HTML comes from the specification, not from
 * the renderer. Both sides are parsed with parse5 and compared structurally.
 *
 * The converter intentionally diverges from the spec in exactly two security-driven ways:
 *  - raw HTML is escaped instead of passed through (spec expects the raw tags to be emitted);
 *  - autolinks with schemes outside the http/https/mailto/tel allowlist are left as text.
 * Every divergent example is listed below and must still fail to match the spec (so the list cannot
 * go stale) while satisfying the justification predicate for its category.
 */

interface SpecExample {
  markdown: string;
  html: string;
  example: number;
  section: string;
}

const spec: SpecExample[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'commonmark', 'spec-0.31.2.json'), 'utf-8')
);

const SPEC_EXAMPLE_COUNT = 652;
const RAW_HTML_SIGNAL = /<[A-Za-z/!?]/;
const BARE_AUTOLINK = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}):[^\s<>]*>\n?$/;
const ALLOWED_AUTOLINK_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

const RAW_HTML_PASSTHROUGH = new Set([
  21, 31, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 169,
  170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 201,
  308, 309, 344, 475, 476, 477, 491, 494, 524, 536, 613, 614, 615, 616, 617, 623, 625, 626, 627, 628, 629, 630, 631,
  642, 643,
]);
const NON_ALLOWLISTED_AUTOLINK = new Set([596, 598, 599, 601]);

function render(example: SpecExample): string {
  return renderMarkdownFragment(example.markdown);
}

function matchesSpec(example: SpecExample): boolean {
  return normalizeHtmlFragment(render(example)) === normalizeHtmlFragment(example.html);
}

function divergenceCategory(example: SpecExample): 'raw-html' | 'autolink-scheme' | null {
  if (NON_ALLOWLISTED_AUTOLINK.has(example.example)) return 'autolink-scheme';
  if (RAW_HTML_PASSTHROUGH.has(example.example)) return 'raw-html';
  return null;
}

describe('CommonMark 0.31.2 conformance (spec.json oracle)', () => {
  it('loads the complete official example set', () => {
    expect(spec).toHaveLength(SPEC_EXAMPLE_COUNT);
    expect(spec.map((e) => e.example)).toEqual(Array.from({ length: SPEC_EXAMPLE_COUNT }, (_, i) => i + 1));
    expect(spec[0]).toMatchObject({ example: 1, section: 'Tabs', markdown: '\tfoo\tbaz\t\tbim\n' });
  });

  it('normalizer distinguishes structurally different HTML (oracle self-check)', () => {
    expect(normalizeHtmlFragment('<ul>\n<li>a</li>\n</ul>')).toBe(normalizeHtmlFragment('<ul><li>a</li></ul>'));
    expect(normalizeHtmlFragment('<p><em>a</em> b</p>')).not.toBe(normalizeHtmlFragment('<p><em>a b</em></p>'));
    expect(normalizeHtmlFragment('<pre><code>a  b</code></pre>')).not.toBe(
      normalizeHtmlFragment('<pre><code>a b</code></pre>')
    );
  });

  const sections = [...new Set(spec.map((e) => e.section))];
  describe.each(sections)('%s', (section) => {
    const examples = spec.filter((e) => e.section === section);

    it('matches the spec HTML for every example not covered by a documented policy divergence', () => {
      const mismatches = examples
        .filter((e) => divergenceCategory(e) === null && !matchesSpec(e))
        .map((e) => ({ example: e.example, markdown: e.markdown, got: render(e), want: e.html }));
      expect(mismatches).toEqual([]);
    });

    it('keeps every documented divergence genuine, justified and free of active content', () => {
      for (const e of examples) {
        const category = divergenceCategory(e);
        if (category === null) continue;
        // The entry must still differ from the spec; otherwise it is stale and must be removed.
        expect(matchesSpec(e), `example ${e.example} now matches the spec`).toBe(false);
        if (category === 'raw-html') {
          expect(RAW_HTML_SIGNAL.test(e.markdown), `example ${e.example} has no raw HTML signal`).toBe(true);
          // Raw HTML must be neutralised as text rather than dropped.
          expect(render(e), `example ${e.example}`).toContain('&lt;');
        } else {
          const scheme = BARE_AUTOLINK.exec(e.markdown)?.[1]?.toLowerCase();
          expect(scheme, `example ${e.example} is not a bare autolink`).toBeDefined();
          expect(ALLOWED_AUTOLINK_SCHEMES.has(scheme as string)).toBe(false);
          expect(render(e)).not.toContain('<a ');
        }
        expect(findDangerousConstructs(render(e)), `example ${e.example}`).toEqual([]);
      }
    });
  });

  it('keeps the divergence list small relative to the spec', () => {
    const divergent = spec.filter((e) => divergenceCategory(e) !== null);
    expect(divergent).toHaveLength(RAW_HTML_PASSTHROUGH.size + NON_ALLOWLISTED_AUTOLINK.size);
    const headline = ['Lists', 'List items', 'Links', 'Images', 'Fenced code blocks', 'Indented code blocks', 'Block quotes', 'Emphasis and strong emphasis'];
    for (const section of headline) {
      const inSection = spec.filter((e) => e.section === section);
      const diverging = inSection.filter((e) => divergenceCategory(e) !== null);
      // Raw HTML divergences in these sections are limited to examples that embed literal tags in text.
      expect(diverging.length / inSection.length, section).toBeLessThan(0.1);
    }
  });
});
