import type JSZip from 'jszip';
import { ConversionFailedError, PayloadLimitError } from '../../types';
import { safeExtractXmlElements, type SafeXmlElement } from '../office';
import { readZipEntryText, type ZipEntryReadOptions } from '../zip-entry-reader';

/**
 * Most cells and rows the reader builds for one workbook, padding included: the 20 million cells that the data-format readers
 * (Parquet) allow for a table. A sparse sheet inside the bounds of a worksheet can still ask for 16.7 billion padded cells (a cell at XFD
 * on each of 1048576 rows), and each padded cell takes about 53 bytes of heap.
 */
export const XLSX_MAX_MATERIALISED_CELLS = 20_000_000;

/**
 * The elements of one tag, taken within the cell budget of a workbook and refused (413) past it, as `readSharedStrings` does: the
 * scanner's own limit of 50,000 elements would end the list there without a word.
 */
export function extractWithinCellBudget(xml: string, tagName: string, what: string): SafeXmlElement[] {
  const elements = safeExtractXmlElements(xml, tagName, { maxElements: XLSX_MAX_MATERIALISED_CELLS + 1 });
  if (elements.length > XLSX_MAX_MATERIALISED_CELLS) {
    throw new PayloadLimitError(`The XLSX ${what} hold more than ${XLSX_MAX_MATERIALISED_CELLS} entries, more than the cells a workbook is read with.`);
  }
  return elements;
}

export interface XlsxSheetEntry {
  name: string;
  path: string;
}

/**
 * The worksheets of an XLSX package as the reader finds them, which is where every other check of a workbook's sheets must look:
 * each `sheet` of `xl/workbook.xml` in order, at the part its `r:id` names in `xl/_rels/workbook.xml.rels` (or the part the position
 * implies when there is none), and only when the workbook lists no sheet the `xl/worksheets/sheetN.xml` parts in number order. A
 * package without a worksheet is refused. `workbookXml` is the text of `xl/workbook.xml`, when the package has one.
 */
export async function discoverXlsxSheets(zip: JSZip, readOptions: ZipEntryReadOptions = {}): Promise<{ workbookXml: string | undefined; sheets: XlsxSheetEntry[] }> {
  const sheets: XlsxSheetEntry[] = [];
  const wbFile = zip.file('xl/workbook.xml');
  const wbRelsFile = zip.file('xl/_rels/workbook.xml.rels');
  const workbookXml = wbFile ? await readZipEntryText(wbFile, readOptions) : undefined;

  if (workbookXml !== undefined) {
    const relsMap = new Map<string, string>();
    if (wbRelsFile) {
      const wbRelsXml = await readZipEntryText(wbRelsFile, readOptions);
      for (const rEl of extractWithinCellBudget(wbRelsXml, 'Relationship', 'relationships')) {
        if (rEl.attrs.Id && rEl.attrs.Target) {
          relsMap.set(rEl.attrs.Id, rEl.attrs.Target);
        }
      }
    }

    for (const sEl of extractWithinCellBudget(workbookXml, 'sheet', 'sheets')) {
      const sheetName = sEl.attrs.name;
      const rId = sEl.attrs['r:id'];
      if (sheetName) {
        let relTarget = (rId ? relsMap.get(rId) : undefined) || `worksheets/sheet${sheets.length + 1}.xml`;
        // Normalize target path
        if (!relTarget.startsWith('xl/')) {
          relTarget = relTarget.startsWith('/') ? relTarget.slice(1) : `xl/${relTarget}`;
        }
        sheets.push({ name: sheetName, path: relTarget });
      }
    }
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

  if (sheets.length === 0) {
    throw new ConversionFailedError('Invalid XLSX workbook: no worksheets found in archive.');
  }
  return { workbookXml, sheets };
}

