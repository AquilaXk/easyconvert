import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { parseHwpxDocument } from '../src/lib/conversions/hwpx';
import { convertGenericEbookSource } from '../src/lib/conversions/office/convert-generic';
import { readOdtText } from '../src/lib/conversions/office/odt-text';
import { normalizeSvgForRendering } from '../src/lib/conversions/svg-render-normalize';
import { parseSvgGeometries } from '../src/lib/conversions/svg-geometry';
import { SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS, expectLinearOnInputs } from './helpers/timing';

/**
 * Self-closing and never-closed tags used to make the paired-tag scans of these readers quadratic: each `<x/>` started a lazy
 * `[\s\S]*?</x>` that ran to the end of the text before it failed, and the readers run on the web process for inputs of up to 10 MiB.
 * A part of 1.2 KB made of `<hp:p/>` took 5.7 s. Each reader now makes one linear pass, so four times the tags take about four times as long.
 */

const SMALL = 1_000;

async function zipOf(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', files.mimetype, { compression: 'STORE' });
  for (const [name, text] of Object.entries(files)) if (name !== 'mimetype') zip.file(name, text);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const hwpxWith = (section: string, extra: Record<string, string> = {}): Promise<Buffer> =>
  zipOf({
    mimetype: 'application/hwp+zip',
    'Contents/section0.xml': `<?xml version="1.0"?><hs:sec xmlns:hs="x" xmlns:hp="y">${section}</hs:sec>`,
    ...extra,
  });

const odtWith = (paragraph: string): Promise<Buffer> =>
  zipOf({
    mimetype: 'application/vnd.oasis.opendocument.text',
    'content.xml': `<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:text="t"><office:body><office:text>${paragraph}</office:text></office:body></office:document-content>`,
  });

describe('HWPX sections', () => {
  const shapes: Array<[string, (count: number) => string]> = [
    ['self-closing paragraphs', (count) => '<hp:p/>'.repeat(count)],
    ['self-closing tables', (count) => '<hp:tbl/>'.repeat(count)],
    ['self-closing rows and cells in a table', (count) => `<hp:tbl>${'<hp:tr/>'.repeat(count)}<hp:tr>${'<hp:tc/>'.repeat(count)}</hp:tr></hp:tbl>`],
    ['self-closing runs', (count) => `<hp:p><hp:run>${'<hp:t/>'.repeat(count)}</hp:run></hp:p>`],
  ];
  for (const [shape, build] of shapes) {
    it(`are read in time linear in the tags when they hold ${shape}`, async () => {
      const [small, large] = await Promise.all([hwpxWith(build(SMALL)), hwpxWith(build(SMALL * SCALING_FACTOR))]);
      await expectLinearOnInputs(shape, (buffer: Buffer) => parseHwpxDocument(buffer), { small, large });
    }, SCALING_TEST_TIMEOUT_MS);
  }

  it('decode the XML entities of the text, the title and the author', async () => {
    const buffer = await hwpxWith(
      '<hp:p><hp:run><hp:t>A &amp; B &lt;c&gt; &#x41;&#66;</hp:t></hp:run></hp:p>' +
        '<hp:tbl><hp:tr><hp:tc><hp:p><hp:run><hp:t>x &quot;y&quot; &apos;z&apos;</hp:t></hp:run></hp:p></hp:tc></hp:tr></hp:tbl>',
      {
        'Contents/content.hpf': '<package><metadata><dc:title>Q &amp; A</dc:title><dc:creator>R &amp; D</dc:creator></metadata></package>',
      }
    );
    const document = await parseHwpxDocument(buffer);
    expect(document.paragraphs.map((p) => p.text)).toEqual(['A & B <c> AB']);
    expect(document.tables[0].rows).toEqual([['x "y" \'z\'']]);
    expect(document.metadata.title).toBe('Q & A');
    expect(document.metadata.creator).toBe('R & D');
  });

  it('keep a paragraph, a table and a heading attribute apart from the self-closing tags around them', async () => {
    const buffer = await hwpxWith(
      '<hp:p/><hp:p id="1"><hp:run><hp:t>first</hp:t></hp:run></hp:p><hp:p/><hp:p styleID="1"><hp:run><hp:t>second</hp:t></hp:run></hp:p>' +
        '<hp:tbl/><hp:tbl><hp:tr/><hp:tr><hp:tc/><hp:tc><hp:p><hp:run><hp:t>cell</hp:t></hp:run></hp:p></hp:tc></hp:tr></hp:tbl>'
    );
    const document = await parseHwpxDocument(buffer);
    expect(document.paragraphs.map((p) => [p.text, p.isHeading])).toEqual([
      ['first', true],
      ['second', true],
    ]);
    expect(document.tables.map((t) => t.rows)).toEqual([[['', 'cell']]]);
  });
});

describe('ODT notes', () => {
  it('are cut out of a paragraph in time linear in the notes, self-closing ones included', async () => {
    const build = (count: number) => odtWith(`<text:p>${'<text:note/>'.repeat(count)}kept</text:p>`);
    const [small, large] = await Promise.all([build(SMALL), build(SMALL * SCALING_FACTOR)]);
    const { largeResult } = await expectLinearOnInputs('odt notes', (buffer: Buffer) => readOdtText(buffer), { small, large });
    expect(largeResult).toBe('kept');
  }, SCALING_TEST_TIMEOUT_MS);

  it('drop the text of a note and keep the text around it', async () => {
    const buffer = await odtWith('<text:p>one<text:note><text:note-body><text:p>footnote</text:p></text:note-body></text:note> two<text:note/> three</text:p>');
    expect(await readOdtText(buffer)).toBe('one two three');
  });
});

describe('SVG clip paths', () => {
  const svgWith = (clipPaths: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${clipPaths}<clipPath id="a"><rect clip-path="url(#b)" width="1" height="1"/></clipPath><g clip-path="url(#a)"/></svg>`;

  it('are lowered to masks in time linear in the self-closing clip paths before them', async () => {
    const [small, large] = [svgWith('<clipPath/>'.repeat(SMALL)), svgWith('<clipPath/>'.repeat(SMALL * SCALING_FACTOR))];
    const { largeResult } = await expectLinearOnInputs('clipPath', (svg: string) => normalizeSvgForRendering(svg), { small, large });
    expect(largeResult.slice(largeResult.lastIndexOf('<clipPath/>') + '<clipPath/>'.length)).toBe(
      '<mask id="a" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="-100%" y="-100%" width="300%" height="300%">' +
        '<rect clip-path="url(#b)" width="1" height="1" fill="#ffffff" fill-opacity="1" opacity="1" stroke="none" fill-rule="nonzero"/></mask><g mask="url(#a)"/></svg>'
    );
  }, SCALING_TEST_TIMEOUT_MS);
});

describe('SVG clip paths with no closing tag anywhere', () => {
  it('are scanned in time linear in the self-closing clip paths', async () => {
    const build = (count: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${'<clipPath/>'.repeat(count)}<g clip-path="url(#a)"/></svg>`;
    await expectLinearOnInputs('clipPath', (svg: string) => normalizeSvgForRendering(svg), { small: build(SMALL), large: build(SMALL * SCALING_FACTOR) });
  }, SCALING_TEST_TIMEOUT_MS);
});

describe('HTML to Markdown', () => {
  const toMarkdown = async (html: string): Promise<string> => (await convertFile(Buffer.from(html), 'html', 'md', {}, 'page.html')).buffer.toString('utf8');

  it.each([
    ['openings that are never closed', (count: number) => '<b>x'.repeat(count)],
    ['openings that never end', (count: number) => '<p'.repeat(count) + 'x'],
  ])('is made in time linear in the tags for %s', async (_name, build) => {
    const run = (html: string) => toMarkdown(html).catch(() => '');
    await expectLinearOnInputs('html to md', run, { small: build(SMALL), large: build(SMALL * SCALING_FACTOR) });
  }, SCALING_TEST_TIMEOUT_MS);

  it('writes headings, emphasis and code, whatever the case of the tags', async () => {
    const html = '<H1 class="t">Title</H1><h2>Sub</h2><p>a <STRONG>bold</STRONG> and <b>bold</b>, <em>it</em> and <I>it</I>, <code>c</code></p><h3>S3</h3>';
    expect(await toMarkdown(html)).toBe('# Title\n\n## Sub\n\na **bold** and **bold**, *it* and *it*, `c`\n\n### S3');
  });

  it('does not take <br>, <img> or <body> for <b> or <i>', async () => {
    expect(await toMarkdown('<body>a<br>b <img src="x"> c <i>it</i> d <b>bo</b></body>')).toBe('a\nb  c *it* d **bo**');
  });

  it('leaves an opening with no closing tag as text', async () => {
    expect(await toMarkdown('<b>one <b>two')).toBe('one two');
  });
});

describe('ASCII STL', () => {
  const FACET = 'facet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\n';
  const toObj = async (stl: string): Promise<string> => (await convertFile(Buffer.from(stl), 'stl', 'obj', {}, 'm.stl')).buffer.toString('utf8');

  it.each([
    ['normals that never get their vertices', (count: number) => 'facet normal 0 0 1 '.repeat(count) + 'x'],
    ['vertices that never complete a facet', (count: number) => `facet normal 0 0 1 ${'vertex 1 2 3 '.repeat(2)}${'facet normal 0 0 1 '.repeat(count)}`],
  ])('is read in time linear in the text for %s', async (_name, build) => {
    const run = (stl: string) => convertFile(Buffer.from(stl), 'stl', 'dxf', {}, 'm.stl').catch(() => undefined);
    await expectLinearOnInputs('stl', run, { small: build(SMALL), large: build(SMALL * SCALING_FACTOR) });
  }, SCALING_TEST_TIMEOUT_MS);

  it('reads the facets of a file in either layout, and in either line end', async () => {
    const lines = `solid m\n${FACET}${FACET.replace('0 0 1', '0 0 -1')}endsolid m\n`;
    const reference = await toObj(lines);
    expect(reference.split('\nv ').length - 1).toBe(6);
    expect(await toObj(lines.replace(/\n/g, '\r\n'))).toBe(reference);
    expect(await toObj(lines.replace(/\n/g, ' '))).toBe(reference);
  });

  it('takes the next vertices for a facet that is cut short: a facet is a normal and the next three vertices', async () => {
    const cut = 'facet normal 0 0 1 vertex 9 9 9 vertex 8 8 8 ';
    const text = `solid m\n${cut}${FACET}endsolid m\n`;
    const obj = await toObj(text);
    expect(obj.split('\nv ').length - 1).toBe(3);
    expect(obj).toContain('9 9 9');
  });

  it('refuses a word that is not a number where a coordinate stands, and goes on with the next facet', async () => {
    const obj = await toObj(`solid m\nfacet normal 0 0 z\nouter loop\nvertex 7 7 7\n${FACET}endsolid m\n`);
    expect(obj.split('\nv ').length - 1).toBe(3);
  });
});

describe('other paired delimiters over input of the web process', () => {
  it('an OEB package finds its text in time linear in the openings that are never closed', async () => {
    const run = (xml: string) => convertGenericEbookSource(Buffer.from(xml), 'oeb', 'txt', {}, 'book').catch((error: Error) => error.message);
    const build = (count: number) => `<package>${'<text><![CDATA['.repeat(count)}</package>`;
    await expectLinearOnInputs('oeb', run, { small: build(SMALL), large: build(SMALL * SCALING_FACTOR) });
  }, SCALING_TEST_TIMEOUT_MS);

  it('an OEB package gives the text of its first CDATA section up to the first closing that ends the element', async () => {
    const xml = '<package><text> <![CDATA[ one ]]> two ]]> </text></package>';
    expect((await convertGenericEbookSource(Buffer.from(xml), 'oeb', 'txt', {}, 'book')).buffer.toString('utf8').trim()).toBe('one ]]> two');
  });

  it('an SVG style sheet drops its comments in time linear in the comments that are never closed', async () => {
    const build = (count: number) => `<svg xmlns="http://www.w3.org/2000/svg"><style>${'/*a'.repeat(count)}</style><rect width="1" height="1"/></svg>`;
    const run = (svg: string) => {
      try {
        return parseSvgGeometries(svg);
      } catch {
        return undefined;
      }
    };
    await expectLinearOnInputs('css comments', run, { small: build(SMALL), large: build(SMALL * SCALING_FACTOR) });
  }, SCALING_TEST_TIMEOUT_MS);

  it('an SVG style sheet still reads the rules between its comments', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><style>/* a */ .c { fill: #ff0000 } /* b */</style><rect class="c" width="1" height="1"/></svg>';
    expect(parseSvgGeometries(svg).elements.map((element) => element.fill)).toEqual([{ r: 255, g: 0, b: 0 }]);
  });
});
