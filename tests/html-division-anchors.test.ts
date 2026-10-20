import { parse } from 'parse5';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { stageHtmlForNativeEngine } from '../src/lib/conversions/html-native-staging';
import { executeWorkerConversion, libreOfficePool } from '../src/worker/engines';
import { docxLinkTargets, epubLinkTargets, odtLinkTargets, pageLinkTargets, type LinkTarget } from './helpers/anchor-positions';
import { oracleTest } from './helpers/oracle-test';
import { pdfInternalLinkTargets, pdfPagesOfWord } from './helpers/pdf-link-targets';

/**
 * An `id` on any element is a link target, not only on the elements the reader turns into blocks. The HTML Living
 * Standard ("the indicated part of the document") names the element whose `id` matches the fragment, then the first
 * `a` whose `name` matches; a browser scrolls to the start of that element. In the documents made from a page the
 * target is the start of the first paragraph the element produces, the next paragraph for an element with no text, and
 * the end of the document when nothing follows.
 *
 * The expected `after` comes from parse5 reading the page with that rule (see helpers/anchor-positions.ts), and the
 * documents are read back by an XML parser (Word, ODF) or parse5 (EPUB): each link is followed to its bookmark or id
 * and the word after it is read. `before` is the text of the target's paragraph that comes before the bookmark, written
 * out per case.
 */

const TARGETS = ['docx', 'odt', 'epub'] as const;
type Target = (typeof TARGETS)[number];

const LINK_TARGETS = { docx: docxLinkTargets, odt: odtLinkTargets, epub: epubLinkTargets } as const;

async function linkTargetsOf(html: string, target: Target): Promise<LinkTarget[]> {
  return LINK_TARGETS[target]((await convertFile(Buffer.from(html), 'html', target, {}, 'page.html')).buffer);
}

/** A page of `links` (in order) followed by `content`. */
function page(links: readonly string[], content: string): string {
  return `<body><p>${links.map((name) => `<a href="#${name}">to ${name}</a>`).join(' ')}</p>${content}</body>`;
}

interface Case {
  label: string;
  html: string;
  /** For each link that has a target, in order: the text of the target's paragraph before it. */
  before: string[];
  /** The word after each target when it is not the one a browser scrolls to (see the label of the case). */
  after?: string[];
}

const CONTAINER_TAGS = ['div', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'figure', 'form', 'fieldset', 'center', 'details', 'dl', 'blockquote'] as const;

const cases: Case[] = [
  ...CONTAINER_TAGS.map((tag): Case => ({
    label: `an id on a ${tag} holding a paragraph`,
    html: page(['x'], `<${tag} id="x"><p>Alpha beta</p><p>gamma</p></${tag}>`),
    before: [''],
  })),
  { label: 'an id on a division that holds text and no paragraph', html: page(['x'], '<div id="x">Alpha <b>beta</b></div>'), before: [''] },
  { label: 'an id on the body', html: page(['top'], '<p>Alpha</p>').replace('<body>', '<body id="top">'), before: [''] },
  {
    label: 'an id on a division after other text',
    html: page(['x'], '<p>Intro words</p><div id="x"><p>Alpha</p></div>'),
    before: [''],
  },
  {
    label: 'a division and a section that start at the same paragraph',
    html: page(['outer', 'inner'], '<div id="outer"><section id="inner"><p>Alpha</p></section></div>'),
    before: ['', ''],
  },
  {
    label: 'a division, a heading and a paragraph that start at the same paragraph',
    html: page(['outer', 'title'], '<div id="outer"><h2 id="title">Alpha</h2><p id="para">beta</p></div>'),
    before: ['', ''],
  },
  {
    label: 'an empty division, which anchors at the next paragraph',
    html: page(['gap'], '<p>Alpha</p><div id="gap"></div><p>Beta</p>'),
    before: [''],
  },
  {
    label: 'empty divisions inside each other and an empty paragraph, which anchor at the next paragraph',
    html: page(['one', 'two', 'three'], '<p>Alpha</p><div id="one"><section id="two"></section></div><p id="three"></p><p>Beta</p>'),
    before: ['', '', ''],
  },
  {
    label: 'an empty division at the end, which anchors at the end of the document',
    html: page(['end'], '<p>Alpha beta</p><div id="end"></div>'),
    before: ['Alpha beta'],
  },
  {
    label: 'a division that holds only a span with an id',
    html: page(['wrap', 'mark'], '<p>Alpha</p><div id="wrap"><span id="mark"></span></div><p>Beta</p>'),
    before: ['', ''],
  },
  {
    label: 'an id on a table, a row and a cell',
    html: page(['tbl', 'row', 'cell'], '<table id="tbl"><tr id="row"><td id="cell">Alpha</td><td>beta</td></tr></table>'),
    before: ['', '', ''],
  },
  {
    label: 'an id on a row group, a header cell and a caption',
    html: page(['cap', 'head', 'body', 'th'], '<table><caption id="cap">Alpha caption</caption><thead id="head"><tr><th id="th">Beta</th></tr></thead><tbody id="body"><tr><td>gamma</td></tr></tbody></table>'),
    before: ['', '', '', ''],
  },
  {
    label: 'an id on a list and its items',
    html: page(['list', 'first', 'second'], '<ul id="list"><li id="first">Alpha</li><li id="second">beta</li></ul>'),
    before: ['', '', ''],
  },
  {
    label: 'an id on a division inside a list item',
    html: page(['inner'], '<ol><li><div id="inner">Alpha</div></li></ol>'),
    before: [''],
  },
  {
    label: 'an id on preformatted text and on a rule, which stand in a paragraph of their own in front of the block',
    html: page(['code', 'rule'], '<p>Intro</p><pre id="code">alpha beta</pre><hr id="rule"><p>Gamma</p>'),
    before: ['', ''],
  },
  {
    label: 'an id inside preformatted text, which anchors at the start of the text',
    html: page(['mid'], '<p>Intro</p><pre>alpha one\n<span id="mid">beta two</span></pre>'),
    before: [''],
    after: ['alpha'],
  },
  {
    label: 'an empty division after preformatted text at the end, which anchors in a paragraph of its own',
    html: page(['end'], '<p>Intro</p><pre>alpha beta</pre><div id="end"></div>'),
    before: [''],
  },
  {
    label: 'an id on a span, which anchors where the span starts',
    html: page(['mark'], '<p>Intro words <span id="mark">Alpha</span> beta</p>'),
    before: ['Intro words'],
  },
  {
    label: 'an id on an image, which anchors where the picture stands',
    html: page(['pic'], '<p>Intro words <img id="pic" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" alt="dot"> Alpha</p>'),
    before: ['Intro words'],
  },
  {
    label: 'two equal ids, where the first is the target',
    html: page(['same'], '<div id="same"><p>Alpha</p></div><div id="same"><p>Beta</p></div>'),
    before: [''],
  },
  {
    label: 'a named anchor before an element with the same id, where the id wins',
    html: page(['both'], '<a name="both"></a><p>Alpha</p><div id="both"><p>Beta</p></div>'),
    before: [''],
  },
  {
    label: 'an anchor with a name and an id of its own, which are both targets',
    html: page(['skipnav', 'MainContent'], '<p>Intro</p><a name="MainContent" id="skipnav"></a><p>Alpha</p>'),
    before: ['', ''],
  },
  {
    label: 'a named anchor between two paragraphs, which anchors at the next paragraph',
    html: page(['named'], '<p>Intro</p><a name="named"></a><p>Alpha</p>'),
    before: [''],
  },
  {
    label: 'ids with a space and with letters outside ASCII, linked as written and percent-escaped',
    html: page(['my part', 'my%20part', '한글 부분', '%ED%95%9C%EA%B8%80%20%EB%B6%80%EB%B6%84', 'café'], '<div id="my part"><p>Alpha</p></div><section id="한글 부분"><p>Beta</p></section><div id="café"><p>Gamma</p></div>'),
    before: ['', '', '', '', ''],
  },
];

describe('an id on any element is a link target', () => {
  for (const { label, html, before, after } of cases) {
    for (const target of TARGETS) {
      it(`links ${label}, as ${target}`, async () => {
        const expected = pageLinkTargets(html);
        expect(expected.length).toBe(before.length);
        const found = await linkTargetsOf(html, target);
        expect(found.map(({ link, after: word }) => ({ link, after: word }))).toEqual(after === undefined ? expected : expected.map((target, index) => ({ ...target, after: after[index] })));
        expect(found.map((link) => link.before)).toEqual(before);
      });
    }
  }
});

describe('a link to an element that is not read as a block', () => {
  it('does not link a fragment that no element of the page has', async () => {
    const html = page(['nowhere'], '<div id="somewhere"><p>Alpha</p></div>');
    expect(pageLinkTargets(html)).toEqual([]);
    for (const target of TARGETS) expect(await linkTargetsOf(html, target)).toEqual([]);
  });
});

/**
 * PDF: the office suite lays the page out. It makes the id of a paragraph, a heading, a list, an item, a table, a cell,
 * a rule, a picture or an inline element a link target, but not that of a division, section, article, aside, header,
 * footer, nav, main, figure, figcaption, caption, details, fieldset, legend, summary, center or label (24.2 and 26.8), so
 * the staged page gives those a named anchor where they start. qpdf reads the link annotations and their destinations,
 * pdftotext the words of the page the destination is on.
 */
describe('an id on a division in a PDF', () => {
  const LIBREOFFICE_TIMEOUT_MS = 180_000;
  const TOOLS: Array<'soffice' | 'qpdf' | 'pdftotext'> = ['soffice', 'qpdf', 'pdftotext'];
  const filler = Array.from({ length: 70 }, (_, index) => `<p>Filler line ${index + 1}</p>`).join('');
  let poolWasEnabled = false;

  beforeAll(() => {
    // The pool daemon cannot start in some sandboxes; one-shot LibreOffice runs the same filter.
    poolWasEnabled = libreOfficePool.isEnabled();
    libreOfficePool.disable();
  });

  afterAll(() => {
    if (poolWasEnabled) libreOfficePool.enable();
  });

  interface PdfCase {
    label: string;
    html: string;
    /** Whether the targets are past the first page, where the filler pushes them. */
    onLaterPage: boolean;
  }

  const pdfCases: PdfCase[] = [
    ...(['div', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'figure', 'fieldset', 'center', 'details', 'form'] as const).map(
      (tag): PdfCase => ({ label: `a ${tag} after the filler`, html: page(['x'], `${filler}<${tag} id="x"><p>Alpha beta</p></${tag}>`), onLaterPage: true })
    ),
    { label: 'the body', html: page(['top'], '<p>Alpha</p>').replace('<body>', '<body id="top">'), onLaterPage: false },
    { label: 'a division at the top of the first page', html: page(['x'], `<div id="x"><p>Alpha</p></div>${filler}`), onLaterPage: false },
    {
      label: 'a division and a section that start at the same paragraph',
      html: page(['outer', 'inner'], `${filler}<div id="outer"><section id="inner"><p>Alpha</p></section></div>`),
      onLaterPage: true,
    },
    { label: 'an empty division, which anchors at the next paragraph', html: page(['gap'], `${filler}<div id="gap"></div><p>Alpha</p>`), onLaterPage: true },
    { label: 'a figure and its caption', html: page(['fig', 'cap'], `${filler}<figure id="fig"><figcaption id="cap">Alpha</figcaption></figure>`), onLaterPage: true },
    {
      label: 'a table, an item, a span and a heading',
      html: page(['t', 'i', 's', 'h'], `${filler}<table id="t"><tr><td>Alpha</td></tr></table><ul><li id="i">beta</li></ul><p>x <span id="s">gamma</span></p><h2 id="h">delta</h2>`),
      onLaterPage: true,
    },
    { label: 'two equal ids, where the first is the target', html: page(['same'], `<div id="same"><p>Alpha</p></div>${filler}<div id="same"><p>Beta</p></div>`), onLaterPage: false },
    {
      label: 'ids with a space and with letters outside ASCII, linked as written and percent-escaped',
      html: page(['my part', 'my%20part', 'café', 'caf%C3%A9'], `${filler}<div id="my part"><p>Alpha</p></div><section id="café"><p>Beta</p></section>`),
      onLaterPage: true,
    },
  ];

  for (const { label, html, onLaterPage } of pdfCases) {
    oracleTest(
      `links ${label}`,
      TOOLS,
      async () => {
        const result = await executeWorkerConversion(Buffer.from(html, 'utf-8'), 'html', 'pdf', {}, 'page.html');
        expect(result.engineUsed).toMatch(/^native-soffice/);
        const found = pdfInternalLinkTargets(result.buffer);
        expect(found.map(({ link, after }) => ({ link, after }))).toEqual(pageLinkTargets(html));
        // Each destination is on the page that shows the word after the target (the words are unique on the page).
        expect(found.map((link) => [link.page])).toEqual(found.map((link) => pdfPagesOfWord(result.buffer, link.after)));
        expect(found.every((link) => (link.page > 1) === onLaterPage)).toBe(true);
      },
      LIBREOFFICE_TIMEOUT_MS
    );
  }
});

describe('the page handed to the office suite', () => {
  /** The `name` of the first element child of each element with the given tag, as parse5 reads the staged page. */
  function firstChildAnchors(staged: string, tag: string): Array<string | undefined> {
    const found: Array<string | undefined> = [];
    const walk = (node: { nodeName: string; childNodes?: unknown[]; attrs?: Array<{ name: string; value: string }> }): void => {
      if (node.nodeName === tag) {
        const first = (node.childNodes as Array<typeof node> | undefined)?.find((child) => child.nodeName !== '#text');
        found.push(first?.nodeName === 'a' ? first.attrs?.find((attr) => attr.name === 'name')?.value : undefined);
      }
      for (const child of (node.childNodes ?? []) as Array<typeof node>) walk(child);
    };
    walk(parse(staged) as unknown as Parameters<typeof walk>[0]);
    return found;
  }

  it('starts each element whose id the office suite ignores with a named anchor of that id', async () => {
    const { html } = await stageHtmlForNativeEngine('<body><div id="a b"><p>One</p></div><section id="s"><p>Two</p></section><figure id="f"><figcaption id="c">Three</figcaption></figure></body>');
    expect(firstChildAnchors(html, 'div')).toEqual(['a b']);
    expect(firstChildAnchors(html, 'section')).toEqual(['s']);
    expect(firstChildAnchors(html, 'figure')).toEqual(['f']);
    expect(firstChildAnchors(html, 'figcaption')).toEqual(['c']);
  });

  it('writes the anchor of an element the page is rebuilt without, where the element started, and none for the body', async () => {
    const { html } = await stageHtmlForNativeEngine('<body id="top"><form id="f"><p>Alpha</p></form></body>');
    expect(html.match(/<a name="[^"]*"><\/a>/g)).toEqual(['<a name="f"></a>']);
    expect(html).toContain('<body id="top"><a name="f"></a><p>Alpha</p></body>');
  });

  it('adds no anchor to an element whose id the office suite already makes a target, or to a division with none', async () => {
    const { html } = await stageHtmlForNativeEngine('<body><p id="p">One</p><h2 id="h">Two</h2><table id="t"><tr><td id="d">Three</td></tr></table><div class="plain"><p>Four</p></div><div id="">Five</div></body>');
    expect(html).not.toContain('<a name=');
    expect(firstChildAnchors(html, 'div')).toEqual([undefined, undefined]);
  });
});
