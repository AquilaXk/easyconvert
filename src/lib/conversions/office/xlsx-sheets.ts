import type JSZip from 'jszip';
import { PayloadLimitError } from '../../types';
import { safeExtractXmlElements, type SafeXmlElement } from '../safe-xml-scanner';
import { readZipEntryText, type ZipEntryReadOptions } from '../zip-entry-reader';
import { resolveZipPath } from './zip-path';

/**
 * Most cells and rows the reader builds for one workbook, padding included: the 20 million cells that the data-format readers
 * (Parquet) allow for a table. A sparse sheet inside the bounds of a worksheet can still ask for 16.7 billion padded cells (a cell at XFD
 * on each of 1048576 rows), and each padded cell takes about 53 bytes of heap.
 */
export const XLSX_MAX_MATERIALISED_CELLS = 20_000_000;

/** Sheets of one workbook: LibreOffice Calc holds at most 10,000 (`MAXTABCOUNT`, sc/inc/address.hxx), so a workbook that lists more cannot be opened whole. */
export const XLSX_MAX_SHEETS = 10_000;

/** Hyperlinks on one worksheet: 65,530, "Excel specifications and limits" (Microsoft, "Hyperlinks in a worksheet"). */
export const XLSX_MAX_HYPERLINKS_PER_SHEET = 65_530;

/**
 * Merged ranges and hyperlinks the reader holds for all sheets of one workbook: one for each row of a worksheet. A merged range
 * is four numbers and takes 66 bytes of heap (measured: 1,048,576 of them took 66 MiB), so the bound keeps them near 100 MiB. A
 * count per sheet alone would leave sheets times that, and the 256 MiB the sheets decode to holds about 10 million `mergeCell`s.
 */
export const XLSX_MAX_RANGES_PER_WORKBOOK = 1_048_576;

/**
 * Elements of one relationships or content-types part: the 65,530 hyperlinks a worksheet holds (each has a relationship) and the
 * 10,000 sheets of a workbook, with room for the parts that go with them, rounded up.
 */
export const XLSX_MAX_PART_ENTRIES = 100_000;

const DEFAULT_WORKBOOK_PATH = 'xl/workbook.xml';

/**
 * Hands the elements of one tag to `onElement` as the scanner finds them, so that no list of them is held, and refuses (413) the
 * one past `limit` with `refusal`: the scanner's own limit of 50,000 elements would end the list there without a word. The scan
 * stops at that element, so a part that holds millions costs the time of `limit` of them.
 */
export function streamElementsWithin(xml: string, tagName: string, limit: number, refusal: string, onElement: (element: SafeXmlElement) => void): void {
  let taken = 0;
  safeExtractXmlElements(xml, tagName, {
    maxElements: limit + 1,
    onElement: (element) => {
      taken += 1;
      if (taken > limit) throw new PayloadLimitError(refusal);
      onElement(element);
    },
  });
}

/**
 * The relationships of a part that sits in `directory`, by relationship id. Internal targets are resolved to package paths;
 * with `external` the relationships that point outside the package are read instead, and their targets are the URLs as written.
 */
export function readRelationships(xml: string, directory: string, external = false): Map<string, { type: string; target: string }> {
  const relationships = new Map<string, { type: string; target: string }>();
  streamElementsWithin(xml, 'Relationship', XLSX_MAX_PART_ENTRIES, `A relationships part lists more than ${XLSX_MAX_PART_ENTRIES} relationships.`, (rel) => {
    if (rel.attrs.Id && rel.attrs.Target && (rel.attrs.TargetMode === 'External') === external) {
      relationships.set(rel.attrs.Id, { type: rel.attrs.Type ?? '', target: external ? rel.attrs.Target : resolveZipPath(directory, rel.attrs.Target) });
    }
  });
  return relationships;
}

export interface XlsxSheetEntry {
  name: string;
  path: string;
}

export interface XlsxSheets {
  /** The text of the workbook part, when the package has one. */
  workbookXml: string | undefined;
  /** The worksheets as the reader reads them, in order. */
  sheets: XlsxSheetEntry[];
  /** The parts of the sheets that have a relationship but no name: the reader skips them, an office suite opens them. */
  unnamedSheetParts: string[];
}

function directoryOf(part: string): string {
  return part.slice(0, Math.max(0, part.lastIndexOf('/')));
}

/** The relationships part of a part: `xl/workbook.xml` has `xl/_rels/workbook.xml.rels`. */
function relationshipsPartOf(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

/** The part the package's root relationships name as its office document, else `xl/workbook.xml`. */
async function readWorkbookPath(zip: JSZip, readOptions: ZipEntryReadOptions): Promise<string> {
  const rootRelationships = zip.file('_rels/.rels');
  if (rootRelationships) {
    const relationships = readRelationships(await readZipEntryText(rootRelationships, readOptions), '');
    for (const relationship of relationships.values()) {
      if (relationship.type.endsWith('/officeDocument')) return relationship.target;
    }
  }
  return DEFAULT_WORKBOOK_PATH;
}

/**
 * A target written relative to the package root instead of the workbook's directory (`xl/worksheets/sheet1.xml` in
 * `xl/_rels/workbook.xml.rels`), which resolves to `xl/xl/worksheets/sheet1.xml`: the part at the package root, when that is the
 * one the package has, as the reader has always followed it.
 */
function withoutRepeatedDirectory(zip: JSZip, directory: string, resolved: string): string {
  if (zip.file(resolved) !== null || directory === '' || !resolved.startsWith(`${directory}/${directory}/`)) return resolved;
  const fromRoot = resolved.slice(directory.length + 1);
  return zip.file(fromRoot) === null ? resolved : fromRoot;
}

/** The relationship id of a `sheet`: `r:id`, or the attribute of that name under another prefix for the relationships namespace. */
function relationshipIdOf(attrs: SafeXmlElement['attrs']): string | undefined {
  if (attrs['r:id'] !== undefined) return attrs['r:id'];
  const other = Object.keys(attrs).find((key) => key.endsWith(':id') && key !== 'xml:id');
  return other === undefined ? undefined : attrs[other];
}

/**
 * The worksheets of an XLSX package as the reader finds them, which is where every other check of a workbook's sheets must look.
 * The workbook is the part the root relationships name as the office document (`xl/workbook.xml` when they name none), and each
 * `sheet` of it, in order, is at the part its relationship id names in the relationships of the workbook, resolved against the
 * workbook's directory, or at the part its position implies when it has none. A part is listed once, at its first sheet. When the
 * workbook lists no named sheet, the `xl/worksheets/sheetN.xml` parts are taken in number order. A workbook with more than
 * `XLSX_MAX_SHEETS` sheets is refused (413); a package without a worksheet is for the caller to refuse. The reader skips a sheet without a name, so that
 * its output is the same as before; the part of such a sheet that has a relationship is returned apart, for the checks that must
 * cover whatever an office suite opens.
 */
export async function discoverXlsxSheets(zip: JSZip, readOptions: ZipEntryReadOptions = {}): Promise<XlsxSheets> {
  const sheets: XlsxSheetEntry[] = [];
  const unnamedSheetParts: string[] = [];
  const workbookPath = await readWorkbookPath(zip, readOptions);
  const wbFile = zip.file(workbookPath);
  const workbookXml = wbFile ? await readZipEntryText(wbFile, readOptions) : undefined;

  if (workbookXml !== undefined) {
    const directory = directoryOf(workbookPath);
    const relsFile = zip.file(relationshipsPartOf(workbookPath));
    const targets = new Map<string, string>();
    if (relsFile) {
      for (const [id, relationship] of readRelationships(await readZipEntryText(relsFile, readOptions), directory)) targets.set(id, relationship.target);
    }

    const listed = new Set<string>();
    let named = 0;
    streamElementsWithin(workbookXml, 'sheet', XLSX_MAX_SHEETS, `The XLSX workbook lists more than ${XLSX_MAX_SHEETS} sheets, the most an office suite opens.`, (sEl) => {
      const name = sEl.attrs.name;
      const rId = relationshipIdOf(sEl.attrs);
      const target = rId === undefined ? undefined : targets.get(rId);
      if (!name && target === undefined) return;
      if (name) named += 1;
      const path = target === undefined ? resolveZipPath(directory, `worksheets/sheet${named}.xml`) : withoutRepeatedDirectory(zip, directory, target);
      if (listed.has(path)) return;
      listed.add(path);
      if (name) sheets.push({ name, path });
      else unnamedSheetParts.push(path);
    });
  }

  // Fallback: search zip directly for worksheets
  if (sheets.length === 0) {
    const wsFiles = Object.keys(zip.files)
      .filter((fn) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(fn))
      .sort((a, b) => {
        const numA = parseInt(a.replace(/\D/g, ''), 10) || 0;
        const numB = parseInt(b.replace(/\D/g, ''), 10) || 0;
        return numA - numB;
      });

    for (let idx = 0; idx < wsFiles.length; idx++) {
      sheets.push({ name: `Sheet${idx + 1}`, path: wsFiles[idx] });
    }
  }

  return { workbookXml, sheets, unnamedSheetParts };
}
