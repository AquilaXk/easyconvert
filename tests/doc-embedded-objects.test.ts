import { describe, expect, it } from 'vitest';
import { extractTextFromDoc } from '../src/lib/conversions/office';
import { buildCompoundFile } from './helpers/cfb-craft';
import { buildWordBinaryParts } from './helpers/word-binary-builder';
import { sofficeConvert } from './helpers/soffice-office';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * A Word document that holds embedded objects: an embedded Word document keeps its own `WordDocument` and `1Table` streams
 * in a storage under `ObjectPool` ([MS-DOC] 2.1.1, OLE embedding). The reader finds the streams of the document by name in
 * the root storage; the streams of a nested storage with the same names belong to the object and are never the document's.
 * Real files hit this in the regression corpus (a Word report with embedded Excel and Word objects was refused with "the CLX
 * holds an unknown entry type 0x0" because the embedded object's `WordDocument` stream replaced the document's).
 */

const MAIN_TEXT = 'Quarterly budget report with an embedded spreadsheet.\r';
const EMBEDDED_TEXT = 'Embedded object text that is not the document.\r';

function wordStreams(text: string): { word: Buffer; table: Buffer } {
  const { word, table } = buildWordBinaryParts({ pieces: [{ text, compressed: true }] });
  return { word, table };
}

function documentWithEmbeddedWord(): Buffer {
  const main = wordStreams(MAIN_TEXT);
  const embedded = wordStreams(EMBEDDED_TEXT);
  return buildCompoundFile([
    { name: 'WordDocument', data: main.word },
    { name: '1Table', data: main.table },
    { name: 'ObjectPool/_1126935839/WordDocument', data: embedded.word },
    { name: 'ObjectPool/_1126935839/1Table', data: embedded.table },
  ]);
}

describe('Word document with an embedded Word object', () => {
  it('reads the text of the document, not of the embedded object', () => {
    expect(extractTextFromDoc(documentWithEmbeddedWord())).toBe('Quarterly budget report with an embedded spreadsheet.');
  });

  it('reads the same text as the office suite', () => {
    // skip-ok: the oracle needs soffice; under ORACLE_STRICT_MODE=1 its absence fails the suite by name.
    if (skipWithoutTools('soffice')) return;
    const reference = sofficeConvert(documentWithEmbeddedWord(), 'doc', 'txt:Text (encoded):UTF8', 'txt').toString('utf-8');
    expect(reference.replace(/^\uFEFF/u, '').trim()).toBe('Quarterly budget report with an embedded spreadsheet.');
  });
});

describe('Word document whose last text piece also holds the footnote story', () => {
  it('reads the main story and stops at its end although the piece goes on', () => {
    // One piece holds the main story (11 characters) and the footnote story after it, as Word writes a document whose
    // first piece boundary lies past the end of the main story.
    const { word, table } = buildWordBinaryParts({ pieces: [{ text: 'Main body.\rFootnote text.\r', compressed: true }] });
    const FIB_CCP_TEXT_OFFSET = 76;
    word.writeUInt32LE('Main body.\r'.length, FIB_CCP_TEXT_OFFSET);
    const piecesAfterMainStory = buildCompoundFile([
      { name: 'WordDocument', data: word },
      { name: '1Table', data: table },
    ]);
    expect(extractTextFromDoc(piecesAfterMainStory)).toBe('Main body.');
  });

  it('reads a document with several pieces, the one that holds the end of the main story running on into the footnotes and more pieces after it', () => {
    const { word, table } = buildWordBinaryParts({
      pieces: [
        { text: 'First part of the body. ', compressed: true },
        { text: 'Second part.\rFootnote text.\r', compressed: false },
        { text: 'Header text.\r', compressed: true },
      ],
    });
    word.writeUInt32LE('First part of the body. Second part.\r'.length, 76);
    const doc = buildCompoundFile([
      { name: 'WordDocument', data: word },
      { name: '1Table', data: table },
    ]);
    expect(extractTextFromDoc(doc)).toBe('First part of the body. Second part.');
  });
});

describe('Word document whose piece table runs backwards', () => {
  it('is refused as not contiguous when a piece ends before it starts, although it starts where the last one ended', () => {
    const { word, table } = buildWordBinaryParts({
      pieces: [
        { text: 'First piece of text. ', compressed: true },
        { text: 'Second piece.\r', compressed: true },
      ],
    });
    // The PlcPcd of the CLX: a type byte (2), a 4-byte size, then the character positions 0, end of piece 1, end of piece 2.
    const FIB_FC_CLX_OFFSET = 154 + 33 * 8;
    const clx = word.readUInt32LE(FIB_FC_CLX_OFFSET);
    const positions = clx + 5;
    const firstEnd = table.readUInt32LE(positions + 4);
    table.writeUInt32LE(firstEnd - 1, positions + 8);
    const doc = buildCompoundFile([
      { name: 'WordDocument', data: word },
      { name: '1Table', data: table },
    ]);
    expect(() => extractTextFromDoc(doc)).toThrow('Word document: the piece table character positions are not contiguous.');
  });
});
