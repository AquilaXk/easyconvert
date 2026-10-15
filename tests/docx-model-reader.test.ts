import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { readDocxModel, DOCX_MAX_TABLE_DEPTH } from '../src/lib/conversions/docx-model';
import { XML_TREE_MAX_DEPTH } from '../src/lib/conversions/xml-tree';
import { DocumentFormatError, type Block, type DocumentModel, type HeadingBlock, type ListBlock, type ParagraphBlock, type TableBlock } from '../src/lib/conversions/document-model/model';
import { bodyBlocks, cellBlocks } from '../src/lib/conversions/document-model/support';
import { inlineText, listMarkers } from '../src/lib/conversions/document-model/text';
import { ConversionFailedError, DataParseError, PayloadLimitError } from '../src/lib/types';
import { craftDocx, paragraph } from './helpers/docx-craft';
import { expectNoHang } from './helpers/timing';
import { RICH_LIST_MARKERS, fixtureBytes, richStructureImageHashes, sha256 } from './helpers/document-fixtures';

/**
 * The WordprocessingML reader against the golden documents (authored independently, see
 * tests/fixtures/document/PROVENANCE.md) and against malformed and hostile packages.
 */

async function read(bytes: Buffer): Promise<{ model: DocumentModel; drawsShapes: boolean }> {
  return readDocxModel(await JSZip.loadAsync(bytes));
}

function failureOf(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => undefined,
    (err: unknown) => err
  );
}

const listsOf = (model: DocumentModel): ListBlock[] => bodyBlocks(model).filter((block): block is ListBlock => block.type === 'list');
const tableOf = (model: DocumentModel): TableBlock => bodyBlocks(model).find((block): block is TableBlock => block.type === 'table') as TableBlock;
const firstParagraphText = (blocks: readonly Block[]): string => inlineText((blocks[0] as ParagraphBlock).runs);

/** The table on its grid: the text of each cell where it starts, "." where a merged cell covers the position. */
function gridOf(table: TableBlock): string[][] {
  return table.rows.map((row) =>
    row.flatMap((cell) => (cell.continuation ? Array.from({ length: cell.colSpan }, () => '.') : [firstParagraphText(cellBlocks(cell)), ...Array.from({ length: cell.colSpan - 1 }, () => '.')]))
  );
}

describe('rich-structure.docx', () => {
  it('reads headings through style names, outline levels and basedOn inheritance', async () => {
    const { model } = await read(fixtureBytes('rich-structure.docx'));
    const headings = bodyBlocks(model)
      .filter((block): block is HeadingBlock => block.type === 'heading')
      .map((block) => `${block.level}|${inlineText(block.runs)}`);
    expect(headings).toEqual(['1|Pump Station Handbook', '1|1 Overview', '2|Scope', '2|Readings', '1|2 Images', '2|Sub heading by inheritance']);
  });

  it('renders list markers from numbering.xml with levels, restarts, start values and bullets', async () => {
    const { model } = await read(fixtureBytes('rich-structure.docx'));
    const lists = listsOf(model);
    const items = lists.flatMap((list) => list.items);
    expect(lists.flatMap(listMarkers)).toEqual([...RICH_LIST_MARKERS]);
    expect(items.map((item) => item.level)).toEqual([0, 0, 1, 1, 2, 0, 0, 0, 0, 1, 0, 0, 0]);
    const ordered = lists.flatMap((list) => list.items.map((item) => list.levels[item.level].kind !== 'bullet'));
    expect(ordered).toEqual([true, true, true, true, true, true, true, true, false, false, false, true, true]);
    // A new numbering instance starts a new list; consecutive items of one instance stay in one.
    expect(lists.map((list) => list.items.length)).toEqual([6, 2, 3, 2]);
    expect(lists[3].items[0].value).toBe(3);
    expect(lists[3].levels[0].kind).toBe('upperRoman');
  });

  it('reads merged table cells and header rows', async () => {
    const { model } = await read(fixtureBytes('rich-structure.docx'));
    const table = tableOf(model);
    expect(table.columnWidths).toHaveLength(3);
    expect(table.rows.map((row) => row.some((cell) => cell.header))).toEqual([true, false, false, false]);
    expect(table.rows.map((row) => row.filter((cell) => !cell.continuation).map((cell) => `${firstParagraphText(cellBlocks(cell))}:${cell.colSpan}x${cell.rowSpan}`))).toEqual([
      ['Station:1x1', 'Flow rate:2x1'],
      ['East:1x1', '12.5:1x1', '13.1:1x1'],
      ['North:1x2', '9.8:1x1', '10.2:1x1'],
      ['11.0:1x1', '11.4:1x1'],
    ]);
    expect(gridOf(table).map((row) => row.map((cell) => (cell === '.' ? '.' : 'c')).join(''))).toEqual(['cc.', 'ccc', 'ccc', '.cc']);
    // Every position of the grid holds a cell: the covered ones are continuation slots of the same row count.
    expect(table.rows.map((row) => row.reduce((sum, cell) => sum + cell.colSpan, 0))).toEqual([3, 3, 3, 3]);
  });

  it('reads hyperlinks, character formatting, footnotes and endnotes', async () => {
    const { model } = await read(fixtureBytes('rich-structure.docx'));
    const intro = bodyBlocks(model).find((block): block is ParagraphBlock => block.type === 'paragraph') as ParagraphBlock;
    const text = intro.runs.filter((run) => run.image === undefined && run.note === undefined && run.anchor === undefined);
    expect(text.find((run) => run.text === 'inspected')?.bold).toBe(true);
    expect(text.find((run) => run.text === 'logged')?.italic).toBe(true);
    expect(text.find((run) => run.text === 'signed off')?.underline).toBe(true);
    const link = text.find((run) => run.text === 'the maintenance portal');
    expect(link?.href).toBe('https://example.org/portal');
    // The hyperlink character style adds underline and colour; a link is shown by its anchor, not by those.
    expect(link?.underline).toBeUndefined();
    expect(intro.runs.some((run) => run.note?.kind === 'footnote' && run.note.label === '1')).toBe(true);
    expect((model.footnotes ?? []).map((note) => firstParagraphText(note.blocks))).toEqual(['Flow figures are monthly means.']);
    expect((model.endnotes ?? []).map((note) => firstParagraphText(note.blocks))).toEqual(['Calibration certificates are on file.']);
  });

  it('reads pictures with their original bytes, alternative text and displayed size', async () => {
    const { model } = await read(fixtureBytes('rich-structure.docx'));
    const hashes = await richStructureImageHashes();
    const holder = bodyBlocks(model).find((block): block is ParagraphBlock => block.type === 'paragraph' && block.runs.some((run) => run.image !== undefined)) as ParagraphBlock;
    const pictures = holder.runs.flatMap((run) => (run.image ? [run.image] : []));
    const stored = pictures.map((picture) => model.images.find((image) => image.id === picture.imageId));
    expect(stored.map((image) => sha256(Buffer.from((image as { data: Uint8Array }).data)))).toEqual([hashes.jpeg, hashes.png]);
    expect(stored.map((image) => image?.format)).toEqual(['jpeg', 'png']);
    expect(pictures.map((picture) => picture.alt)).toEqual(['Green checker photo', 'Red and blue bars']);
    expect(pictures[0].widthPt).toBeCloseTo(100, 5);
    expect(pictures[0].heightPt).toBeCloseTo(75, 5);
  });

  it('reads page and section breaks, metadata and page geometry', async () => {
    const { model } = await read(fixtureBytes('rich-structure.docx'));
    expect(bodyBlocks(model).map((block) => block.type)).toContain('pageBreak');
    expect(model.sections.map((section) => section.breakType)).toEqual([undefined, 'nextPage']);
    expect(model.sections.map((section) => section.columns)).toEqual([1, 1]);
    expect(model.title).toBe('Pump Station Handbook');
    expect(model.author).toBe('Fixture Author');
    expect(model.language).toBe('en-US');
    expect(model.pageStated).toBe(true);
    expect({ width: model.pageWidthPt, height: model.pageHeightPt, margins: model.margins }).toEqual({ width: 612, height: 792, margins: { top: 72, right: 72, bottom: 72, left: 72 } });
    expect(model.bodySize).toBe(11);
  });
});

describe('merged-tables.docx', () => {
  it('places horizontally and vertically merged cells on the grid', async () => {
    const { model } = await read(fixtureBytes('merged-tables.docx'));
    expect(gridOf(tableOf(model))).toEqual([
      ['A1', '.', 'C1'],
      ['A2', 'B2', '.'],
      ['A3', 'B3', '.'],
      ['.', 'B4', 'C4'],
    ]);
  });
});

describe('malformed packages fail with typed errors', () => {
  it('a package without word/document.xml is refused', async () => {
    const zip = new JSZip();
    zip.file('hello.txt', 'x');
    const failure = await failureOf(read(await zip.generateAsync({ type: 'nodebuffer' })));
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toBe('Invalid DOCX format: word/document.xml not found.');
  });

  it('a document part that is not well-formed XML names the part and position', async () => {
    const bytes = await craftDocx({ body: '<w:p><w:r><w:t>unclosed</w:r></w:p>' });
    const failure = await failureOf(read(bytes));
    expect(failure).toBeInstanceOf(DataParseError);
    expect((failure as Error).message).toMatch(/word\/document\.xml is not well-formed XML/);
  });

  it('a style that is based on itself through a cycle is refused', async () => {
    const styles =
      '<w:style w:type="paragraph" w:styleId="A"><w:name w:val="A"/><w:basedOn w:val="B"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="B"><w:name w:val="B"/><w:basedOn w:val="A"/></w:style>';
    const failure = await failureOf(read(await craftDocx({ body: '<w:p><w:pPr><w:pStyle w:val="A"/></w:pPr><w:r><w:t>x</w:t></w:r></w:p>', styles })));
    expect(failure).toBeInstanceOf(DocumentFormatError);
    expect((failure as Error).message).toMatch(/cycle in the w:basedOn chain/);
  });

  it('a numbering level outside 0-8 is refused', async () => {
    const numbering = '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="12"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>';
    const failure = await failureOf(read(await craftDocx({ body: paragraph('x'), numbering })));
    expect(failure).toBeInstanceOf(DocumentFormatError);
    expect((failure as Error).message).toBe('word/numbering.xml has a numbering level outside 0-8.');
  });

  it('an image relationship that names a missing part is refused', async () => {
    const relationships = '<Relationship Id="rIdX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/gone.png"/>';
    const failure = await failureOf(read(await craftDocx({ body: paragraph('x'), relationships })));
    expect(failure).toBeInstanceOf(DocumentFormatError);
    expect((failure as Error).message).toMatch(/media\/gone\.png/);
  });

  it('a relationship that points above the package root is refused', async () => {
    const relationships = '<Relationship Id="rIdX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../../../etc/passwd"/>';
    const failure = await failureOf(read(await craftDocx({ body: paragraph('x'), relationships })));
    expect(failure).toBeInstanceOf(DocumentFormatError);
    expect((failure as Error).message).toMatch(/outside the package/);
  });
});

describe('hostile packages terminate within the named limits', () => {
  it('element nesting deeper than the limit is refused, not walked', async () => {
    const depth = XML_TREE_MAX_DEPTH + 50;
    const body = `${'<w:sdt><w:sdtContent>'.repeat(depth)}${paragraph('deep')}${'</w:sdtContent></w:sdt>'.repeat(depth)}`;
    const failure = await expectNoHang('deep nesting', async () => failureOf(read(await craftDocx({ body }))));
    expect(failure).toBeInstanceOf(PayloadLimitError);
    expect((failure as Error).message).toBe(`word/document.xml nests elements deeper than ${XML_TREE_MAX_DEPTH} levels.`);
  });

  it('tables nested deeper than the limit are flattened to their text, not dropped', async () => {
    let body = paragraph('core text');
    for (let level = 0; level <= DOCX_MAX_TABLE_DEPTH + 1; level += 1) body = `<w:tbl><w:tr><w:tc>${body}</w:tc></w:tr></w:tbl>`;
    const { model } = await expectNoHang('table nesting', async () => read(await craftDocx({ body })));
    let depth = 0;
    let texts = '';
    const visit = (blocks: readonly Block[]): void => {
      for (const block of blocks) {
        if (block.type === 'table') {
          depth += 1;
          for (const row of block.rows) for (const cell of row) visit(cellBlocks(cell));
        } else if (block.type === 'paragraph') {
          texts += inlineText(block.runs);
        }
      }
    };
    visit(bodyBlocks(model));
    expect(depth).toBe(DOCX_MAX_TABLE_DEPTH);
    expect(texts).toBe('core text');
    expect((model.warnings ?? []).join(' ')).toMatch(/flattened to text/);
  });

  it('a cell that spans more columns than the limit is refused', async () => {
    const body = '<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="100000"/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>';
    const failure = await failureOf(read(await craftDocx({ body })));
    expect(failure).toBeInstanceOf(PayloadLimitError);
    expect((failure as Error).message).toBe('A table spans more than 1000 columns.');
  });

  it('a hundred thousand paragraphs read in bounded time', async () => {
    const body = paragraph('line').repeat(100_000);
    const { model } = await expectNoHang('many paragraphs', async () => read(await craftDocx({ body })));
    expect(bodyBlocks(model)).toHaveLength(100_000);
  });
});
