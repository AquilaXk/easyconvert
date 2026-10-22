import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { pageLinkTargets } from './helpers/anchor-positions';
import { oracleTest } from './helpers/oracle-test';
import { pdfPagesOfWord } from './helpers/pdf-link-targets';
import { pdfLinks, pdfNamedDestinations, pdfWordBoxes, qpdfCheck, type PdfLink } from './helpers/pdf-named-links';

/**
 * Links inside the document in the PDFs the in-process renderer writes (HTML with a page orientation, and Word
 * documents), and the links to web addresses next to them. ISO 32000-1: a destination is a name in the catalog's name
 * tree (12.3.2.3: /XYZ left top null, where the viewer scrolls to the top of the target), a link is a /Link annotation
 * (12.5.6.5) with a rectangle and a /GoTo action (12.6.4.2) or a /URI action (12.6.4.7). qpdf reads the objects and
 * pdftotext the words, so a rectangle is judged by the words under it and a destination by the words of the line it is at
 * (a viewer scrolls to the top of that line, whatever the position of the target inside it). The expected links come from parse5 reading the page with the rule of the HTML Living Standard, "the indicated part
 * of the document" (see helpers/anchor-positions.ts); none of it shares code with the converter.
 */

const TOOLS: Array<'qpdf' | 'pdftotext'> = ['qpdf', 'pdftotext'];
const FILLER_PARAGRAPHS = 70;
const filler = Array.from({ length: FILLER_PARAGRAPHS }, (_, index) => `<p>Filler line ${index + 1}</p>`).join('');

const toPdf = async (html: string): Promise<Buffer> => (await convertFile(Buffer.from(html, 'utf-8'), 'html', 'pdf', { orientation: 'portrait' }, 'page.html')).buffer;

/** `links` (in order) followed by `content`. */
function page(links: readonly string[], content: string): string {
  return `<body><p>${links.map((name) => `<a href="#${name}">to ${name}</a>`).join(' ')}</p>${content}</body>`;
}

interface FollowedLink {
  text: string;
  /** The words of the line the destination is at. */
  line: string[];
  page: number;
  /** Annotations the link was written as: one for each line it covers. */
  rectangles: number;
}

/** The internal links of the PDF in reading order, a link that wraps over lines or pages being one entry made of its annotations. */
function followedLinks(links: readonly PdfLink[]): FollowedLink[] {
  const followed: Array<FollowedLink & { name: string; top: number; annotationPage: number }> = [];
  for (const link of links) {
    if (link.name === undefined) continue;
    const last = followed[followed.length - 1];
    const continuesLast = last !== undefined && last.name === link.name && (link.page > last.annotationPage || link.rect.top > last.top + 1);
    if (continuesLast) {
      last.text = `${last.text} ${link.text}`;
      last.rectangles += 1;
      last.top = link.rect.top;
      last.annotationPage = link.page;
      continue;
    }
    followed.push({ name: link.name, text: link.text, line: link.line ?? [], page: link.destination?.page ?? 0, rectangles: 1, top: link.rect.top, annotationPage: link.page });
  }
  return followed.map(({ text, line, page: targetPage, rectangles }) => ({ text, line, page: targetPage, rectangles }));
}

/** Expects the links of the page converted to PDF to be those the browser rule gives: the text of each, and its target on the line of the word after the target, on the page that shows that word. */
function expectLinksToTargets(pdf: Buffer, html: string): FollowedLink[] {
  const found = followedLinks(pdfLinks(pdf));
  const expected = pageLinkTargets(html);
  expect(found.map((link) => link.text)).toEqual(expected.map((link) => link.link));
  found.forEach((link, index) => {
    expect(link.line).toContain(expected[index].after);
    expect([link.page]).toEqual(pdfPagesOfWord(pdf, expected[index].after));
  });
  return found;
}

interface Case {
  label: string;
  html: string;
  /** Whether every target is past the first page (the filler pushes it), or on it; absent when the targets are on both. */
  onLaterPage?: boolean;
}

const cases: Case[] = [
  { label: 'a heading', html: page(['h'], `${filler}<h2 id="h">Alpha beta</h2><p>gamma</p>`), onLaterPage: true },
  { label: 'a heading on the first page', html: page(['h'], '<h2 id="h">Alpha beta</h2><p>gamma</p>'), onLaterPage: false },
  { label: 'a paragraph', html: page(['p'], `${filler}<p id="p">Alpha beta</p>`), onLaterPage: true },
  {
    label: 'a division, a section and an article holding a paragraph, on the first page and after the filler',
    html: page(['d', 's', 'a'], `<div id="d"><p>Alpha</p></div>${filler}<section id="s"><p>Beta</p></section><article id="a"><p>Gamma</p></article>`),
  },
  { label: 'a division after the filler', html: page(['d'], `${filler}<div id="d"><p>Alpha beta</p></div>`), onLaterPage: true },
  {
    label: 'a division and a section that start at the same paragraph',
    html: page(['outer', 'inner'], `${filler}<div id="outer"><section id="inner"><p>Alpha</p></section></div>`),
    onLaterPage: true,
  },
  { label: 'an empty division, which waits for the next paragraph', html: page(['gap'], `${filler}<div id="gap"></div><p>Alpha</p>`), onLaterPage: true },
  {
    label: 'a span in the middle of a paragraph',
    html: page(['mid'], `${filler}<p>Intro words and <span id="mid">Alpha</span> beta</p>`),
    onLaterPage: true,
  },
  {
    label: 'an anchor named by an `a` element',
    html: page(['named'], `${filler}<p>Intro <a name="named"></a>Alpha beta</p>`),
    onLaterPage: true,
  },
  {
    label: 'a table, a row and a cell',
    html: page(['t', 'r', 'c'], `${filler}<table id="t"><tr id="r"><td>Alpha</td><td id="c">beta</td></tr></table>`),
    onLaterPage: true,
  },
  {
    label: 'an empty cell, which waits for the text of the cell after it',
    html: page(['e'], `${filler}<table><tr><td id="e"></td><td>Alpha</td></tr></table>`),
    onLaterPage: true,
  },
  {
    label: 'a row with no cell, which waits for the next row',
    html: page(['r'], `${filler}<table><tr id="r"></tr><tr><td>Alpha</td></tr></table>`),
    onLaterPage: true,
  },
  { label: 'a list item', html: page(['i'], `${filler}<ul><li>Beta</li><li id="i">Alpha</li></ul>`), onLaterPage: true },
  {
    label: 'a preformatted block, a rule and an element inside the preformatted text',
    html: page(['code', 'rule', 'mid'], `${filler}<pre id="code">Alpha one</pre><hr id="rule"><pre>Beta one\nBeta two\n<span id="mid">Gamma</span> three\nDelta four</pre>`),
    onLaterPage: true,
  },
  {
    label: 'a cell that holds a paragraph, on the first page',
    html: page(['c'], '<table><tr><td>Alpha</td><td id="c"><p>Beta</p></td></tr></table>'),
    onLaterPage: false,
  },
  {
    label: 'two equal ids, where the first is the target',
    html: page(['same'], `<div id="same"><p>Alpha</p></div>${filler}<div id="same"><p>Beta</p></div>`),
    onLaterPage: false,
  },
  {
    label: 'ids with a space and with letters outside ASCII, linked as written and percent-escaped',
    html: page(['my part', 'my%20part', 'café', 'caf%C3%A9'], `${filler}<div id="my part"><p>Alpha</p></div><section id="café"><p>Beta</p></section>`),
    onLaterPage: true,
  },
];

describe('links to a target in the same document, in an HTML page converted with a page orientation', () => {
  for (const { label, html, onLaterPage } of cases) {
    oracleTest(`link to ${label}`, TOOLS, async () => {
      const found = expectLinksToTargets(await toPdf(html), html);
      expect(found.length).toBeGreaterThan(0);
      if (onLaterPage !== undefined) expect(found.every((link) => (link.page > 1) === onLaterPage)).toBe(true);
    });
  }

  oracleTest('writes a destination for every id, each at the line where its element starts and on the page that shows its words', TOOLS, async () => {
    const html = page(['one', 'two'], `<h2 id="one">Alpha</h2><p>beta</p>${filler}<div id="two"><p>Gamma</p></div>`);
    const pdf = await toPdf(html);
    const destinations = pdfNamedDestinations(pdf);
    expect(destinations.map(({ name }) => name)).toEqual(['one', 'two']);
    expect(destinations.map(({ line }) => line[0])).toEqual(['Alpha', 'Gamma']);
    expect(destinations.map(({ point }) => [point?.page])).toEqual([pdfPagesOfWord(pdf, 'Alpha'), pdfPagesOfWord(pdf, 'Gamma')]);
    expect(destinations[1].point?.page).toBeGreaterThan(1);
  });

  oracleTest('writes the name tree in the byte order of its names and without a warning from qpdf', TOOLS, async () => {
    const ids = ['intro', 'Section1', 'a', 'B', 'Zeta', 'alpha', '_b', 'x-y', '9lives'];
    const html = page(
      ids.map((id) => id),
      ids.map((id) => `<p id="${id}">Word${id.replace(/\W/g, '')}</p>`).join('')
    );
    const pdf = await toPdf(html);
    const names = pdfNamedDestinations(pdf).map(({ name }) => name);
    const expected = ids.map((id) => (/^[A-Za-z_]/.test(id) ? id : `_${id}`));
    expect(names).toEqual([...expected].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    expect(qpdfCheck(pdf)).toEqual({ status: 0, messages: '' });
    expect(followedLinks(pdfLinks(pdf)).map((link) => link.line[0])).toEqual(ids.map((id) => `Word${id.replace(/\W/g, '')}`));
  });

  oracleTest('puts the destination of a paragraph that wraps over many lines at its first line', TOOLS, async () => {
    const words = Array.from({ length: 150 }, (_, index) => `word${index + 1}`).join(' ');
    const html = `<body><p><a href="#t">go</a></p><h2 id="h">Heading ${words}</h2><p id="t">${words}</p><p><span id="s">Tail</span> ${words}</p></body>`;
    const pdf = await toPdf(html);
    const destinations = pdfNamedDestinations(pdf);
    expect(destinations.map(({ name, line }) => [name, line[0]])).toEqual([
      ['h', 'Heading'],
      ['s', 'Tail'],
      ['t', 'word1'],
    ]);
  });

  oracleTest('writes one annotation for each line a link wraps over, all to the same destination', TOOLS, async () => {
    const words = Array.from({ length: 60 }, (_, index) => `word${index + 1}`).join(' ');
    const html = `<body><p>Start <a href="#t">${words}</a> end.</p><p id="t">Target text</p></body>`;
    const found = followedLinks(pdfLinks(await toPdf(html)));
    expect(found).toHaveLength(1);
    expect(found[0].text).toBe(words);
    expect(found[0].rectangles).toBeGreaterThanOrEqual(3);
    expect(found[0].line[0]).toBe('Target');
  });

  oracleTest('writes the annotations of a link that continues on the next page on the page of each of its lines', TOOLS, async () => {
    const words = Array.from({ length: 1500 }, (_, index) => `word${index + 1}`).join(' ');
    const html = `<body><p>Start <a href="#t">${words}</a> end.</p><p id="t">Target text</p></body>`;
    const pdf = await toPdf(html);
    const links = pdfLinks(pdf);
    const found = followedLinks(links);
    expect(found).toHaveLength(1);
    expect(found[0].text).toBe(words);
    expect(new Set(links.map((link) => link.page)).size).toBeGreaterThanOrEqual(3);
    expect(found[0].rectangles).toBe(links.length);
    expect(found[0].line[0]).toBe('Target');
    expect(links.every((link) => link.destination?.page === found[0].page)).toBe(true);
  });

  oracleTest('places the destination in a table row taller than a page on the page where its text is drawn', TOOLS, async () => {
    const column = Array.from({ length: 120 }, (_, index) => `<p>Row ${index + 1}</p>`).join('').replace('<p>Row 100</p>', '<p><span id="late">Late</span> row 100</p>');
    const html = page(['late'], `<table><tr><td>Side</td><td>${column}</td></tr></table>`);
    const pdf = await toPdf(html);
    const found = expectLinksToTargets(pdf, html);
    expect(found).toHaveLength(1);
    expect(found[0].page).toBeGreaterThan(1);
    expect(pdfPagesOfWord(pdf, 'Row')).toEqual(expect.arrayContaining([1, found[0].page]));
  });

  oracleTest('puts the destinations of divisions that follow one another in a cell cut across pages at the line each starts', TOOLS, async () => {
    const entries = Array.from({ length: 150 }, (_, index) => `<div id="B${index + 1}"><div>${index + 1}.</div><div>Entry text ${index + 1}</div></div>`).join('');
    const targets = [11, 22, 77, 110, 150];
    const html = `<body><p>${targets.map((number) => `<a href="#B${number}">go ${number}</a>`).join(' ')}</p><table><tr><td><h2>Entries</h2>${entries}</td></tr></table></body>`;
    const pdf = await toPdf(html);
    const found = followedLinks(pdfLinks(pdf));
    expect(found.map((link) => link.line[0])).toEqual(targets.map((number) => `${number}.`));
    expect(found.map((link) => [link.page])).toEqual(targets.map((number) => pdfPagesOfWord(pdf, `${number}.`)));
    expect(found[found.length - 1].page).toBeGreaterThan(2);
  });

  oracleTest('writes the annotation of a link in a table row taller than a page on the page where its text is drawn', TOOLS, async () => {
    const column = Array.from({ length: 120 }, (_, index) => `<p>Row ${index + 1}</p>`).join('').replace('<p>Row 100</p>', '<p>Row <a href="#t">jump here</a> 100</p>');
    const html = `<body><p id="t">Target</p><table><tr><td>Side</td><td>${column}</td></tr></table></body>`;
    const pdf = await toPdf(html);
    const links = pdfLinks(pdf);
    expect(links.map((link) => link.text)).toEqual(['jump here']);
    expect(links[0].page).toBeGreaterThan(1);
    expect([links[0].page]).toEqual(pdfPagesOfWord(pdf, 'jump'));
    expect(links[0].line).toContain('Target');
  });

  oracleTest('gives no number to a list item with no content, and leads the next item with its destination', TOOLS, async () => {
    const html = page(['a'], '<ol><li id="a"></li><li>Alpha</li><li>Beta</li></ol>');
    const links = followedLinks(pdfLinks(await toPdf(html)));
    expect(links).toHaveLength(1);
    expect(links[0].line).toEqual(['1.', 'Alpha']);
  });

  oracleTest('puts a destination at the end of the document when nothing follows it, on the last page', TOOLS, async () => {
    const html = page(['end'], `${filler}<p>Last words</p><div id="end"></div>`);
    const pdf = await toPdf(html);
    const found = followedLinks(pdfLinks(pdf));
    expect(found).toHaveLength(1);
    expect(found[0].page).toBe(pdfPagesOfWord(pdf, 'words')[0]);
    expect(found[0].page).toBeGreaterThan(1);
  });

  oracleTest('writes the links and destinations of text that needs shaping at the line they stand on', TOOLS, async () => {
    const arabic = 'مرحبا بالعالم';
    const html = `<body><p>${arabic} <a href="#t">رابط الهدف</a> ${arabic}</p>${filler}<p>${arabic} <span id="t">هدف</span> ${arabic}</p></body>`;
    const pdf = await toPdf(html);
    const found = followedLinks(pdfLinks(pdf));
    // pdftotext lists the letters of a right-to-left word in the order they are drawn.
    const displayed = (word: string): string => Array.from(word).reverse().join('');
    expect(found).toHaveLength(1);
    expect(found[0].text.split(' ').sort()).toEqual([displayed('رابط'), displayed('الهدف')].sort());
    expect(found[0].line).toContain(displayed('هدف'));
    expect([found[0].page]).toEqual(pdfPagesOfWord(pdf, displayed('هدف')));
    expect(found[0].page).toBeGreaterThan(1);
  });

  oracleTest('writes no annotation for a link whose fragment no element has', TOOLS, async () => {
    const html = page(['gone', 'there'], '<p id="there">Alpha</p>');
    const links = pdfLinks(await toPdf(html));
    expect(links.map((link) => link.text)).toEqual(['to there']);
  });

  oracleTest('writes a URI action for a link to a web address and to a mail address', TOOLS, async () => {
    const html = '<body><p><a href="https://example.org/a?b=1">site</a> and <a href="mailto:a@example.org">mail</a> and <a href="ftp://example.org/f">file</a></p></body>';
    const links = pdfLinks(await toPdf(html));
    expect(links.map((link) => ({ text: link.text, uri: link.uri, name: link.name }))).toEqual([
      { text: 'site', uri: 'https://example.org/a?b=1', name: undefined },
      { text: 'mail', uri: 'mailto:a@example.org', name: undefined },
    ]);
  });

  oracleTest('writes the links to the web and to the document side by side, in the order of the text', TOOLS, async () => {
    const html = '<body><p><a href="https://example.org/a">site</a> and <a href="#t">inside</a></p><p id="t">Target</p></body>';
    const links = pdfLinks(await toPdf(html));
    expect(links.map((link) => ({ text: link.text, uri: link.uri, name: link.name }))).toEqual([
      { text: 'site', uri: 'https://example.org/a', name: undefined },
      { text: 'inside', uri: undefined, name: 't' },
    ]);
  });
});

describe('a page with thousands of links', () => {
  const LINKS = 10_000;
  const TIME_LIMIT_MS = 60_000;

  oracleTest('keeps every link and destination, as a name tree qpdf accepts, in a time that grows with the page', TOOLS, async () => {
    const html = `<body>${Array.from({ length: LINKS }, (_, index) => `<p id="t${index}">Item ${index} <a href="#t${(index * 7) % LINKS}">go ${index}</a></p>`).join('')}</body>`;
    const started = Date.now();
    const pdf = await toPdf(html);
    expect(Date.now() - started).toBeLessThan(TIME_LIMIT_MS);
    expect(pdfNamedDestinations(pdf)).toHaveLength(LINKS);
    expect(followedLinks(pdfLinks(pdf))).toHaveLength(LINKS);
    expect(qpdfCheck(pdf)).toEqual({ status: 0, messages: '' });
  }, 5 * TIME_LIMIT_MS);

  oracleTest('names thousands of equal ids once each', TOOLS, async () => {
    const html = `<body><p><a href="#same">first</a></p>${Array.from({ length: LINKS }, (_, index) => `<p id="same">Item ${index}</p>`).join('')}</body>`;
    const started = Date.now();
    const pdf = await toPdf(html);
    expect(Date.now() - started).toBeLessThan(TIME_LIMIT_MS);
    const destinations = pdfNamedDestinations(pdf);
    expect(destinations).toHaveLength(LINKS);
    expect(new Set(destinations.map(({ name }) => name)).size).toBe(LINKS);
    expect(destinations.find(({ name }) => name === 'same')?.line[0]).toBe('Item');
    expect(followedLinks(pdfLinks(pdf))[0].line.slice(0, 2)).toEqual(['Item', '0']);
  }, 5 * TIME_LIMIT_MS);
});

describe('the page the ids and links are written into', () => {
  const words = Array.from({ length: 90 }, (_, index) => `word${index + 1}`).join(' ');
  const sections = [
    `<h2 id="h1">Heading one</h2><p id="p1">${words}</p>`,
    `<p>First line<br><span id="s1">second line</span> and ${words} <a name="n1"></a>tail</p>`,
    `<p>Mid<span id="s2">word</span>split and <span id="s3"></span><br><br><span id="s4">after breaks</span> end</p>`,
    `<p><a href="#h1">go one</a> text <a href="#s4" style="color:red">go four</a><br><a href="#n1">go n</a> text</p>`,
    `<pre id="pre1">alpha\n<span id="s5">beta</span>\n\ngamma</pre>`,
    `<table><tr id="r1"><td id="c1">${words}</td><td><p id="c2">Cell <span id="s6">two</span></p><p>more</p></td></tr></table>`,
    `<ul><li id="l1">Item one ${words}</li><li id="l2"></li><li>Item three</li></ul>`,
    `<div id="d1"></div><div id="d2"><div id="d3"><p>Nested</p></div></div>`,
  ].join('');
  const withIds = `<body>${sections}</body>`;
  const withoutIds = withIds.replace(/ id="[^"]*"/g, '').replace(/<a name="[^"]*"><\/a>/g, '').replace(/<a href="#[^"]*"[^>]*>/g, '<a>');

  oracleTest('leaves every word where the same page without ids and links inside it puts it', TOOLS, async () => {
    const boxes = async (html: string): Promise<string[]> => pdfWordBoxes(await toPdf(html)).map((word) => `${word.page} ${word.text} ${word.xMin.toFixed(2)} ${word.yMin.toFixed(2)}`);
    const plain = await boxes(withoutIds);
    expect(plain.length).toBeGreaterThan(300);
    const withLinks = await boxes(withIds);
    expect(withLinks.filter((box, index) => box !== plain[index]).slice(0, 8).map((box) => `${box} <> ${plain[withLinks.indexOf(box)]}`)).toEqual([]);
    expect(withLinks).toEqual(plain);
  });
});

describe('links to a target in the same document, in a Word document converted to PDF', () => {
  const html = page(['one', 'two', 'gone'], `<h2 id="one">Alpha beta</h2><p>gamma</p>${filler}<div id="two"><p>Delta</p></div>`);

  oracleTest('follows each hyperlink to the paragraph its bookmark stands at, and writes none for a bookmark that is not there', TOOLS, async () => {
    const docx = (await convertFile(Buffer.from(html, 'utf-8'), 'html', 'docx', {}, 'page.html')).buffer;
    const pdf = (await convertFile(docx, 'docx', 'pdf', {}, 'page.docx')).buffer;
    const found = expectLinksToTargets(pdf, html);
    expect(found.map((link) => link.page)).toEqual([1, pdfPagesOfWord(pdf, 'Delta')[0]]);
    expect(found[1].page).toBeGreaterThan(1);
    expect(pdfNamedDestinations(pdf)).toHaveLength(2);
  });
});

describe('a PDF reader that is not the one that checks the file structure', () => {
  oracleTest('finds every destination by its name, those of mixed case and those outside ASCII too', ['pdftotext'], async () => {
    const ids = ['intro', 'Section1', 'a', 'B', 'Zeta', 'alpha', 'café', 'my part'];
    const pdf = await toPdf(page(ids, ids.map((id) => `<p id="${id}">Word${id.replace(/\W/g, '')}</p>`).join('')));
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = pdfjs.getDocument({ data: new Uint8Array(pdf) });
    const document = await loading.promise;
    const names = ['intro', 'Section1', 'a', 'B', 'Zeta', 'alpha', 'café', 'my_part'];
    for (const name of names) expect(await document.getDestination(name), name).not.toBeNull();
    expect(await document.getDestination('absent')).toBeNull();
    await loading.destroy();
  });
});

describe('the name of a destination', () => {
  oracleTest('is the anchor name the other writers use, in the byte order of the stored name (a name outside ASCII is UTF-16BE with a byte order mark, after the ASCII ones)', TOOLS, async () => {
    const source = page(['my part', 'café'], '<div id="my part"><p>Alpha</p></div><section id="café"><p>Beta</p></section>');
    expect(pdfNamedDestinations(await toPdf(source)).map(({ name }) => name)).toEqual(['my_part', 'café']);
  });
});
