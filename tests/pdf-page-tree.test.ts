import { describe, expect, it, vi } from 'vitest';
import { compressPdf } from '../src/lib/conversions/pdf-postprocess';
import { mendPageTree, repairPageTree, type PdfJsonObject } from '../src/lib/conversions/pdf-postprocess/page-tree';
import { buildPdf, type CraftObject } from './helpers/pdf-craft';
import { pdfinfoPages, pdftotext, qpdfCheckPasses } from './helpers/encrypted-pdf-fixtures';
import { getGhostscriptBinaryPath } from '../src/lib/conversions/pdf-postprocess/gs-path';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';

/**
 * Mending a page tree that reaches one of its nodes a second time (#783). The walk is checked on object lists written by
 * hand, with the result worked out on paper, and the mended documents by qpdf --check and Poppler, which share no code
 * with the product.
 */

const ref = (id: number): string => `${id} 0 R`;
const CATALOG = 1;
const ROOT = 2;

/** The objects `qpdf --json` would list for a catalog, a trailer and the given page-tree nodes and pages. */
function objectList(nodes: Record<number, { kids: unknown[]; count: number }>, pages: readonly number[]): Record<string, PdfJsonObject> {
  const objects: Record<string, PdfJsonObject> = {
    trailer: { value: { '/Root': ref(CATALOG), '/Size': 1 } },
    [`obj:${ref(CATALOG)}`]: { value: { '/Type': '/Catalog', '/Pages': ref(ROOT) } },
  };
  for (const [id, node] of Object.entries(nodes)) {
    objects[`obj:${ref(Number(id))}`] = { value: { '/Type': '/Pages', '/Kids': node.kids, '/Count': node.count } };
  }
  for (const id of pages) objects[`obj:${ref(id)}`] = { value: { '/Type': '/Page', '/Parent': ref(ROOT) } };
  return objects;
}

const kidsAndCount = (mended: Map<string, Record<string, unknown>>, id: number): unknown => {
  const dictionary = mended.get(`obj:${ref(id)}`);
  return dictionary === undefined ? undefined : { kids: dictionary['/Kids'], count: dictionary['/Count'] };
};

describe('mendPageTree', () => {
  it('changes nothing in a tree that has no node twice', () => {
    const objects = objectList({ [ROOT]: { kids: [ref(3), ref(4)], count: 2 }, 4: { kids: [ref(5)], count: 1 } }, [3, 5]);
    expect(mendPageTree(objects).size).toBe(0);
  });

  it('drops the entry that makes a node its own kid and keeps the page', () => {
    const objects = objectList({ [ROOT]: { kids: [ref(3), ref(ROOT)], count: 1 } }, [3]);
    expect(kidsAndCount(mendPageTree(objects), ROOT)).toEqual({ kids: [ref(3)], count: 1 });
  });

  it('drops the entry that closes a ring of nodes, drops the nodes left without a page, and counts the pages that remain', () => {
    // Root lists page 6 and node 3; node 3 lists 4, 4 lists 5, and 5 lists 3 again (the PDF.js page-tree sample).
    const objects = objectList(
      { [ROOT]: { kids: [ref(6), ref(3)], count: 2 }, 3: { kids: [ref(4)], count: 1 }, 4: { kids: [ref(5)], count: 1 }, 5: { kids: [ref(3)], count: 1 } },
      [6]
    );
    const mended = mendPageTree(objects);
    expect(kidsAndCount(mended, ROOT)).toEqual({ kids: [ref(6)], count: 1 });
    expect(kidsAndCount(mended, 5)).toEqual({ kids: [], count: 0 });
  });

  it('keeps a page below the node that closes the loop', () => {
    const objects = objectList({ [ROOT]: { kids: [ref(3)], count: 1 }, 3: { kids: [ref(4)], count: 1 }, 4: { kids: [ref(3), ref(5)], count: 1 } }, [5]);
    const mended = mendPageTree(objects);
    expect(kidsAndCount(mended, 4)).toEqual({ kids: [ref(5)], count: 1 });
    expect(mended.has(`obj:${ref(ROOT)}`)).toBe(false);
    expect(mended.has(`obj:${ref(3)}`)).toBe(false);
  });

  it('places a node that two parents list under the first parent only', () => {
    const objects = objectList(
      { [ROOT]: { kids: [ref(3), ref(4)], count: 2 }, 3: { kids: [ref(5)], count: 1 }, 4: { kids: [ref(5)], count: 1 }, 5: { kids: [ref(6)], count: 1 } },
      [6]
    );
    const mended = mendPageTree(objects);
    expect(kidsAndCount(mended, ROOT)).toEqual({ kids: [ref(3)], count: 1 });
    expect(kidsAndCount(mended, 4)).toEqual({ kids: [], count: 0 });
  });

  it('leaves a root without a page when the loop was all it had', () => {
    expect(kidsAndCount(mendPageTree(objectList({ [ROOT]: { kids: [ref(ROOT)], count: 1 } }, [])), ROOT)).toEqual({ kids: [], count: 0 });
  });

  it('takes a text that looks like a reference for no node', () => {
    const objects = objectList({ [ROOT]: { kids: [ref(3), 'u:2 0 R'], count: 2 } }, [3]);
    expect(mendPageTree(objects).size).toBe(0);
  });

  it('lists 200,000 kids of one node without exhausting the call stack, and keeps them in the order listed', () => {
    const KIDS_OF_ROOT = 200_000;
    const FIRST = 3;
    const FIRST_PAGE = FIRST + KIDS_OF_ROOT;
    const nodes: Record<number, { kids: unknown[]; count: number }> = {};
    const rootKids: string[] = [];
    for (let index = 0; index < KIDS_OF_ROOT; index += 1) {
      nodes[FIRST + index] = { kids: [ref(FIRST_PAGE + index)], count: 1 };
      rootKids.push(ref(FIRST + index));
    }
    // The root also lists itself, so it is the one node that changes.
    nodes[ROOT] = { kids: [...rootKids, ref(ROOT)], count: KIDS_OF_ROOT };
    const mended = mendPageTree(objectList(nodes, Array.from({ length: KIDS_OF_ROOT }, (_, index) => FIRST_PAGE + index)));
    expect([...mended.keys()]).toEqual([`obj:${ref(ROOT)}`]);
    expect(mended.get(`obj:${ref(ROOT)}`)).toMatchObject({ '/Kids': rootKids, '/Count': KIDS_OF_ROOT });
  });

  it('visits a chain of 50,000 nodes that loops back once, without recursion, and changes only the node that closes it', () => {
    const LENGTH = 50_000;
    const FIRST = 3;
    const LAST = FIRST + LENGTH - 1;
    const PAGE = LAST + 1;
    const nodes: Record<number, { kids: unknown[]; count: number }> = { [ROOT]: { kids: [ref(FIRST)], count: 1 } };
    for (let id = FIRST; id < LAST; id += 1) nodes[id] = { kids: [ref(id + 1)], count: 1 };
    nodes[LAST] = { kids: [ref(FIRST), ref(PAGE)], count: 1 };
    const mended = mendPageTree(objectList(nodes, [PAGE]));
    expect([...mended.keys()]).toEqual([`obj:${ref(LAST)}`]);
    expect(kidsAndCount(mended, LAST)).toEqual({ kids: [ref(PAGE)], count: 1 });
  });

  it('visits each node of a layered tree once, not once per path: every node lists all the nodes of the level below it', () => {
    // 10 levels of 20 nodes, 20^10 paths from the root and 200 nodes; each node of the last level holds a page.
    const LEVELS = 10;
    const WIDTH = 20;
    const FIRST_PAGE = 3 + LEVELS * WIDTH;
    const idOf = (level: number, index: number): number => 3 + level * WIDTH + index;
    const level = (number: number): string[] => Array.from({ length: WIDTH }, (_, index) => ref(idOf(number, index)));
    const nodes: Record<number, { kids: unknown[]; count: number }> = { [ROOT]: { kids: level(0), count: WIDTH } };
    for (let number = 0; number < LEVELS; number += 1) {
      for (let index = 0; index < WIDTH; index += 1) {
        const last = number + 1 === LEVELS;
        nodes[idOf(number, index)] = { kids: last ? [ref(FIRST_PAGE + index)] : level(number + 1), count: last ? 1 : WIDTH };
      }
    }
    const mended = mendPageTree(objectList(nodes, Array.from({ length: WIDTH }, (_, index) => FIRST_PAGE + index)));
    // The first node of each level keeps the whole level below it; the others find it taken and go.
    expect(kidsAndCount(mended, ROOT)).toEqual({ kids: [ref(idOf(0, 0))], count: WIDTH });
    expect(kidsAndCount(mended, idOf(LEVELS - 3, 0))).toEqual({ kids: [ref(idOf(LEVELS - 2, 0))], count: WIDTH });
    expect(kidsAndCount(mended, idOf(LEVELS - 3, 7))).toEqual({ kids: [], count: 0 });
    // The last two levels are as they were: the first node of the one above lists the whole last level, each node of which holds its page.
    expect(mended.has(`obj:${ref(idOf(LEVELS - 2, 0))}`)).toBe(false);
    expect(mended.has(`obj:${ref(idOf(LEVELS - 1, 3))}`)).toBe(false);
  });
});

const toolsMissing = skipWithoutTools('qpdf', 'pdftotext', 'pdfinfo');
const ghostscriptMissing = skipUnless('Ghostscript (gs)', getGhostscriptBinaryPath() !== null);
const PAGE_TEXT = 'Ring page text';
const PAGE_ID = 4;

/** A one-page document whose page tree is a ring of `nodes` nodes that lists its own first node again below the page. */
function ringPdf(nodes: number): Buffer {
  const first = 10;
  const last = first + nodes - 1;
  const objects: CraftObject[] = [
    { id: CATALOG, dict: `/Type /Catalog /Pages ${ref(ROOT)}` },
    { id: ROOT, dict: `/Type /Pages /Kids [${ref(first)}] /Count 1` },
    { id: PAGE_ID, dict: `/Type /Page /Parent ${ref(last)} /MediaBox [0 0 200 200] /Contents ${ref(5)} /Resources << /Font << /F1 ${ref(6)} >> >>` },
    { id: 5, stream: Buffer.from(`BT /F1 12 Tf 20 100 Td (${PAGE_TEXT}) Tj ET`) },
    { id: 6, dict: '/Type /Font /Subtype /Type1 /BaseFont /Helvetica' },
  ];
  for (let id = first; id < last; id += 1) objects.push({ id, dict: `/Type /Pages /Parent ${ref(ROOT)} /Kids [${ref(id + 1)}] /Count 1` });
  objects.push({ id: last, dict: `/Type /Pages /Parent ${ref(ROOT)} /Kids [${ref(first)} ${ref(PAGE_ID)}] /Count 1` });
  return buildPdf(objects, CATALOG).buffer;
}

/** A document of `nodes` page-tree nodes that each list all of them and one page of their own ("Mesh page N"). */
function meshPdf(nodes: number): Buffer {
  const FIRST_NODE = 10;
  const FIRST_PAGE = FIRST_NODE + nodes;
  const nodeRefs = Array.from({ length: nodes }, (_, index) => ref(FIRST_NODE + index));
  const objects: CraftObject[] = [
    { id: CATALOG, dict: `/Type /Catalog /Pages ${ref(ROOT)}` },
    { id: ROOT, dict: `/Type /Pages /Kids [${nodeRefs.join(' ')}] /Count ${nodes}` },
    { id: 5, stream: Buffer.from('BT /F1 12 Tf 20 100 Td (x) Tj ET') },
    { id: 6, dict: '/Type /Font /Subtype /Type1 /BaseFont /Helvetica' },
  ];
  for (let index = 0; index < nodes; index += 1) {
    objects.push({ id: FIRST_NODE + index, dict: `/Type /Pages /Parent ${ref(ROOT)} /Kids [${nodeRefs.join(' ')} ${ref(FIRST_PAGE + index)}] /Count 1` });
    const contents = ref(FIRST_PAGE + nodes + index);
    objects.push({ id: FIRST_PAGE + index, dict: `/Type /Page /Parent ${ref(FIRST_NODE + index)} /MediaBox [0 0 200 200] /Contents ${contents} /Resources << /Font << /F1 ${ref(6)} >> >>` });
    objects.push({ id: FIRST_PAGE + nodes + index, stream: Buffer.from(`BT /F1 12 Tf 20 100 Td (Mesh page ${index + 1}) Tj ET`) });
  }
  return buildPdf(objects, CATALOG).buffer;
}

describe.skipIf(toolsMissing)('repairPageTree', () => {
  it('hands back the very bytes of a document qpdf reads', async () => {
    const clean = buildPdf(
      [
        { id: CATALOG, dict: `/Type /Catalog /Pages ${ref(ROOT)}` },
        { id: ROOT, dict: `/Type /Pages /Kids [${ref(3)}] /Count 1` },
        { id: 3, dict: `/Type /Page /Parent ${ref(ROOT)} /MediaBox [0 0 10 10] /Resources << >>` },
      ],
      CATALOG
    ).buffer;
    expect(qpdfCheckPasses(clean)).toBe(true);
    expect(await repairPageTree(clean)).toBe(clean);
  });

  for (const nodes of [1, 3, 50]) {
    it(`mends a ring of ${nodes} page-tree node(s): qpdf --check passes and Poppler reads the page`, async () => {
      const ring = ringPdf(nodes);
      expect(qpdfCheckPasses(ring), 'the fixture is damaged').toBe(false);
      const mended = await repairPageTree(ring);
      expect(qpdfCheckPasses(mended)).toBe(true);
      expect(pdfinfoPages(mended)).toBe(1);
      expect(pdftotext(mended).trim()).toBe(PAGE_TEXT);
    });
  }

  it('mends 300 nodes that each list all 300: one node of the tree per page, in the order the root lists them', async () => {
    const NODES = 300;
    const mesh = meshPdf(NODES);
    expect(qpdfCheckPasses(mesh), 'the fixture is damaged').toBe(false);
    const mended = await repairPageTree(mesh);
    expect(qpdfCheckPasses(mended)).toBe(true);
    expect(pdfinfoPages(mended)).toBe(NODES);
    const texts = pdftotext(mended).split('\f').slice(0, -1).map((page) => page.trim());
    expect(texts).toEqual(Array.from({ length: NODES }, (_, index) => `Mesh page ${index + 1}`));
  });

  it('reads the export of a document it mends: the JSON of the objects is parsed', async () => {
    const parse = vi.spyOn(JSON, 'parse');
    try {
      await repairPageTree(ringPdf(3));
      expect(parse.mock.calls.filter(([text]) => typeof text === 'string' && text.includes('"qpdf"'))).toHaveLength(1);
    } finally {
      parse.mockRestore();
    }
  });

  it('hands back the very bytes of a document whose object export passes the limit, and never parses the export', async () => {
    // 400 nodes that list each other export about 2 MB of JSON; the limit is read on top of the 1 MiB qpdf may print besides.
    const mesh = meshPdf(400);
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const result = await repairPageTree(mesh, { maxExportBytes: 0 });
      expect(Object.is(result, mesh), 'the very buffer comes back').toBe(true);
      expect(parse.mock.calls.filter(([text]) => typeof text === 'string' && text.includes('"qpdf"'))).toHaveLength(0);
    } finally {
      parse.mockRestore();
    }
  });

  it('lets compression of a ring return a document qpdf --check passes, on the lossless profile', async () => {
    const { buffer } = await compressPdf(ringPdf(3), { profile: 'archive' });
    expect(qpdfCheckPasses(buffer)).toBe(true);
    expect(pdftotext(buffer).trim()).toBe(PAGE_TEXT);
  });

  // Ghostscript walks the ring without reaching the page and writes a blank one: the text is the oracle that its first run was discarded for the mended tree.
  it.skipIf(ghostscriptMissing)('lets compression of a ring return the page and its text, on the Ghostscript profiles', async () => {
    for (const profile of ['web', 'print', 'max'] as const) {
      const { buffer } = await compressPdf(ringPdf(3), { profile });
      expect(qpdfCheckPasses(buffer), profile).toBe(true);
      expect(pdfinfoPages(buffer), profile).toBe(1);
      expect(pdftotext(buffer).trim(), profile).toBe(PAGE_TEXT);
    }
  });
});
