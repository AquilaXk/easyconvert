import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import type { DocumentStructure } from '../../bench/structure-metrics';

/**
 * The golden documents in tests/fixtures/document (see PROVENANCE.md there) and the structure each one holds,
 * written by hand from the content `build_docx_fixtures.py` authors. Nothing here reads a converter's output.
 */

export const DOCUMENT_FIXTURES = path.join(__dirname, '..', 'fixtures', 'document');

export function fixtureBytes(name: string): Buffer {
  return fs.readFileSync(path.join(DOCUMENT_FIXTURES, name));
}

export function sha256(bytes: Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** SHA-256 of the two pictures of rich-structure.docx, read straight from the package. */
export async function richStructureImageHashes(): Promise<{ jpeg: string; png: string; jpegBytes: Buffer }> {
  const zip = await JSZip.loadAsync(fixtureBytes('rich-structure.docx'));
  const jpegBytes = Buffer.from(await (zip.file('word/media/photo.jpeg') as JSZip.JSZipObject).async('uint8array'));
  const pngBytes = Buffer.from(await (zip.file('word/media/diagram.png') as JSZip.JSZipObject).async('uint8array'));
  return { jpeg: sha256(jpegBytes), png: sha256(pngBytes), jpegBytes };
}

/** Headings of rich-structure.docx as "level|text", in document order. */
export const RICH_HEADINGS: readonly string[] = [
  '1|Pump Station Handbook',
  '1|1 Overview',
  '2|Scope',
  '2|Readings',
  '1|2 Images',
  '2|Sub heading by inheritance',
];

/** List items of rich-structure.docx as "level|ol-or-ul|text", in document order. */
export const RICH_LIST_ITEMS: readonly string[] = [
  '0|ol|Inspect pumps',
  '0|ol|Check valves',
  '1|ol|Isolate line',
  '1|ol|Drain line',
  '2|ol|Record level',
  '0|ol|Close out',
  '0|ol|Restart item one',
  '0|ol|Restart item two',
  '0|ul|Bearings',
  '1|ul|Seals',
  '0|ul|Gaskets',
  '0|ol|Roman list from three',
  '0|ol|Second roman item',
];

/** The marker Word shows in front of each list item of rich-structure.docx, in document order. */
export const RICH_LIST_MARKERS: readonly string[] = ['1.', '2.', 'a.', 'b.', 'i.', '3.', '1.', '2.', '•', '◦', '•', 'III)', 'IV)'];

/** Table cells of rich-structure.docx as "text|colspan|rowspan". */
export const RICH_TABLE_CELLS: readonly string[] = [
  'Station|1|1',
  'Flow rate|2|1',
  'East|1|1',
  '12.5|1|1',
  '13.1|1|1',
  'North|1|2',
  '9.8|1|1',
  '10.2|1|1',
  '11.0|1|1',
  '11.4|1|1',
];

export const RICH_NOTES: readonly string[] = ['Flow figures are monthly means.', 'Calibration certificates are on file.'];

export async function richStructureTruth(): Promise<DocumentStructure> {
  const hashes = await richStructureImageHashes();
  return {
    headings: [...RICH_HEADINGS],
    listItems: [...RICH_LIST_ITEMS],
    tableCells: [...RICH_TABLE_CELLS],
    images: [hashes.jpeg, hashes.png],
    notes: [...RICH_NOTES],
  };
}
