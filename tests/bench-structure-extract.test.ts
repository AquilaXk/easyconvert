import { describe, expect, it } from 'vitest';
import { structureOfHtml } from '../bench/structure-metrics';
import { structureOfDocx, structureOfEpub, structureOfOdt } from '../bench/structure-extract';
import { convertFile } from '../src/lib/conversions';
import { fixtureBytes, richStructureTruth } from './helpers/document-fixtures';

/**
 * The benchmark's structure readers are checked against a document written independently of the converters
 * (tests/fixtures/document/rich-structure.docx, authored by build_docx_fixtures.py) and the hand-written structure
 * it holds, so a score the benchmark reports means what it says.
 */

describe('benchmark structure readers', () => {
  it('read the hand-written structure from the independently authored DOCX', async () => {
    expect(await structureOfDocx(fixtureBytes('rich-structure.docx'))).toEqual(await richStructureTruth());
  });

  it('read the same structure from the ODT the converter writes', async () => {
    const odt = (await convertFile(fixtureBytes('rich-structure.docx'), 'docx', 'odt', {}, 'x.docx')).buffer;
    expect(await structureOfOdt(odt)).toEqual(await richStructureTruth());
  });

  it('read the same structure from the EPUB the converter writes (notes sit in the chapter that cites them)', async () => {
    const epub = (await convertFile(fixtureBytes('rich-structure.docx'), 'docx', 'epub', {}, 'x.docx')).buffer;
    const found = await structureOfEpub(epub);
    const truth = await richStructureTruth();
    expect(found.headings).toEqual(truth.headings);
    expect(found.listItems).toEqual(truth.listItems);
    expect(found.tableCells).toEqual(truth.tableCells);
    expect(found.images).toEqual(truth.images);
    expect(found.notes).toEqual(truth.notes);
  });

  it('read the DOCX the converter writes', async () => {
    const docx = (await convertFile(Buffer.from('# A\n\n1. x\n2. y\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'), 'md', 'docx', {}, 'd.md')).buffer;
    expect(await structureOfDocx(docx)).toEqual({
      headings: ['1|A'],
      listItems: ['0|ol|x', '0|ol|y'],
      tableCells: ['a|1|1', 'b|1|1', '1|1|1', '2|1|1'],
      images: [],
      notes: [],
    });
  });
});

describe('benchmark note reader', () => {
  it('finds note bodies by their EPUB structural type as well as by id, and drops the numeral and back-link', () => {
    const html =
      '<p>Body<sup id="c1"><a epub:type="noteref" href="#n1">1</a></sup></p>' +
      '<aside epub:type="footnote" id="n1"><p><sup><a href="#c1">1</a></sup> Flow figures are monthly means.</p></aside>' +
      '<aside epub:type="endnote" id="n2"><p><sup><a href="#c2">i</a></sup> Certificates are on file.</p></aside>' +
      '<ol><li id="fn-3">Third note text <a href="#c3">↩</a></li></ol>';
    expect(structureOfHtml(html).notes).toEqual(['Flow figures are monthly means.', 'Certificates are on file.', 'Third note text']);
  });
});
