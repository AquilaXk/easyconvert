import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { readDocxModel, DOCX_MAX_TABLE_DEPTH } from '../src/lib/conversions/docx-model';
import { XML_TREE_MAX_DEPTH } from '../src/lib/conversions/xml-tree';
import { expandTableGrid, type DocBlock, type DocInline, type DocModel } from '../src/lib/conversions/document-model';
import { ConversionFailedError, DataParseError, PayloadLimitError } from '../src/lib/types';
import { DocumentFormatError } from '../src/lib/conversions/document-model';
import { craftDocx, paragraph } from './helpers/docx-craft';
import { expectNoHang } from './helpers/timing';
import { RICH_LIST_MARKERS, fixtureBytes, richStructureImageHashes, sha256 } from './helpers/document-fixtures';

/**
 * The WordprocessingML reader against the golden documents (authored independently, see
 * tests/fixtures/document/PROVENANCE.md) and against malformed and hostile packages.
 */

async function read(bytes: Buffer): Promise<{ model: DocModel; drawsShapes: boolean }> {
  return readDocxModel(await JSZip.loadAsync(bytes));
}

function failureOf(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => undefined,
    (err: unknown) => err
  );
}

const textOf = (inlines: readonly DocInline[]): string => inlines.map((inline) => (inline.kind === 'text' ? inline.text : '')).join('');

function kinds(blocks: readonly DocBlock[]): string[] {
  return blocks.map((block) => block.kind);
}

describe('rich-structure.docx', () => {
  it('reads headings through style names, outline levels and basedOn inheritance', async () => {
    const { model } = await read(fixtureBytes('rich-structure.docx'));
    const headings = model.blocks.filter((block) => block.kind === 'heading').map((block) => (block.kind === 'heading' ? `${block.level}|${textOf(block.inlines)}` : ''));
    expect(headings).toEqual(['1|Pump Station Handbook', '1|1 Overview', '2|Scope', '2|Readings', '1|2 Images', '2|Sub heading by inheritance']);
  });

  it('renders list markers from numbering.xml with levels, restarts, start values and bullets', async () => {
    const { model } = await read(fixtureBytes('rich-structure.docx'));
    const items = model.blocks.filter((block): block is Extract<DocBlock, { kind: 'listItem' }> => block.kind === 'listItem');
    expect(items.map((item) => item.marker)).toEqual([...RICH_LIST_MARKERS]);
    expect(items.map((item) => item.level)).toEqual([0, 0, 1, 1, 2, 0, 0, 0, 0, 1, 0, 0, 0]);
    expect(items.map((item) => item.ordered)).toEqual([true, true, true, true, true, true, true, true, false, false, false, true, true]);
    // A new numbering instance starts a new list; consecutive items of one instance stay in one.
    const listIds = items.map((item) => item.listId);
    expect(new Set(listIds.slice(0, 6)).size).toBe(1);
    expect(listIds[6]).not.toBe(listIds[5]);
    expect(items[11].number).toBe(3);
    expect(items[11].format).toBe('upperRoman');
  });

  it('reads merged table cells and header rows', async () => {
    const { model } = await read(fixtureBytes('rich-structure.docx'));
    const table = model.blocks.find((block) => block.kind === 'table') as Extract<DocBlock, { kind: 'table' }>;
    expect(table.columnCount).toBe(3);
    expect(table.rows.map((row) => row.header)).toEqual([true, false, false, false]);
    expect(table.rows.map((row) => row.cells.map((cell) => `${textOf((cell.blocks[0] as { inlines: DocInline[] }).inlines)}:${cell.colSpan}x${cell.rowSpan}`))).toEqual([
      ['Station:1x1', 'Flow rate:2x1'],
      ['East:1x1', '12.5:1x1', '13.1:1x1'],
      ['North:1x2', '9.8:1x1', '10.2:1x1'],
      ['11.0:1x1', '11.4:1x1'],
    ]);
    const grid = expandTableGrid(table);
    expect(grid.map((row) => row.map((cell) => (cell ? 'c' : '.')).join(''))).toEqual(['cc.', 'ccc', 'ccc', '.cc']);
  });

  it('reads hyperlinks, character formatting, footnotes and endnotes', async () => {
    const { model } = await read(fixtureBytes('rich-structure.docx'));
    const intro = model.blocks.find((block) => block.kind === 'paragraph') as Extract<DocBlock, { kind: 'paragraph' }>;
    const text = intro.inlines.filter((inline) => inline.kind === 'text') as Extract<DocInline, { kind: 'text' }>[];
    expect(text.find((inline) => inline.text === 'inspected')?.bold).toBe(true);
    expect(text.find((inline) => inline.text === 'logged')?.italic).toBe(true);
    expect(text.find((inline) => inline.text === 'signed off')?.underline).toBe(true);
    const link = text.find((inline) => inline.text === 'the maintenance portal');
    expect(link?.href).toBe('https://example.org/portal');
    // The hyperlink character style adds underline and colour; a link is shown by its anchor, not by those.
    expect(link?.underline).toBeUndefined();
    expect(intro.inlines.some((inline) => inline.kind === 'noteRef' && inline.noteKind === 'footnote' && inline.label === '1')).toBe(true);
    expect(model.footnotes.map((note) => textOf((note.blocks[0] as { inlines: DocInline[] }).inlines))).toEqual(['Flow figures are monthly means.']);
    expect(model.endnotes.map((note) => textOf((note.blocks[0] as { inlines: DocInline[] }).inlines))).toEqual(['Calibration certificates are on file.']);
  });

  it('reads pictures with their original bytes, alternative text and displayed size', async () => {
    const { model } = await read(fixtureBytes('rich-structure.docx'));
    const hashes = await richStructureImageHashes();
    const holder = model.blocks.find((block) => block.kind === 'paragraph' && block.inlines.some((inline) => inline.kind === 'image')) as Extract<DocBlock, { kind: 'paragraph' }>;
    const images = holder.inlines.filter((inline): inline is Extract<DocInline, { kind: 'image' }> => inline.kind === 'image');
    expect(images.map((inline) => sha256(inline.image.data))).toEqual([hashes.jpeg, hashes.png]);
    expect(images.map((inline) => inline.image.mime)).toEqual(['image/jpeg', 'image/png']);
    expect(images.map((inline) => inline.image.alt)).toEqual(['Green checker photo', 'Red and blue bars']);
    expect(images[0].image.widthPt).toBeCloseTo(100, 5);
    expect(images[0].image.heightPt).toBeCloseTo(75, 5);
  });

  it('reads page and section breaks, metadata and page geometry', async () => {
    const { model } = await read(fixtureBytes('rich-structure.docx'));
    expect(kinds(model.blocks)).toContain('pageBreak');
    const section = model.blocks.find((block) => block.kind === 'sectionBreak') as Extract<DocBlock, { kind: 'sectionBreak' }>;
    expect(section.sectionType).toBe('nextPage');
    expect(model.title).toBe('Pump Station Handbook');
    expect(model.author).toBe('Fixture Author');
    expect(model.language).toBe('en-US');
    expect(model.page).toEqual({ widthPt: 612, heightPt: 792, marginTopPt: 72, marginRightPt: 72, marginBottomPt: 72, marginLeftPt: 72 });
    expect(model.bodySizePt).toBe(11);
  });
});

describe('merged-tables.docx', () => {
  it('places horizontally and vertically merged cells on the grid', async () => {
    const { model } = await read(fixtureBytes('merged-tables.docx'));
    const table = model.blocks.find((block) => block.kind === 'table') as Extract<DocBlock, { kind: 'table' }>;
    const grid = expandTableGrid(table).map((row) => row.map((cell) => (cell ? textOf((cell.blocks[0] as { inlines: DocInline[] }).inlines) : '.')));
    expect(grid).toEqual([
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
    const visit = (blocks: readonly DocBlock[]): void => {
      for (const block of blocks) {
        if (block.kind === 'table') {
          depth += 1;
          for (const row of block.rows) for (const cell of row.cells) visit(cell.blocks);
        } else if (block.kind === 'paragraph') {
          texts += textOf(block.inlines);
        }
      }
    };
    visit(model.blocks);
    expect(depth).toBe(DOCX_MAX_TABLE_DEPTH);
    expect(texts).toBe('core text');
    expect(model.warnings.join(' ')).toMatch(/flattened to text/);
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
    expect(model.blocks).toHaveLength(100_000);
  });
});
