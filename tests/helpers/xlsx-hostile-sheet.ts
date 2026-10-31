import JSZip from 'jszip';

export const RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MERGE = '<mergeCell ref="A1:B2"/>';

/** The worksheet root of the writer declares the main namespace only; a sheet with `r:id` attributes declares the relationships one as well. */
export const withRelationshipsNamespace = (sheet: string): string => sheet.replace('<worksheet ', `<worksheet xmlns:r="${RELATIONSHIPS_NAMESPACE}" `);

/** `base`, a workbook of one worksheet, with `sheetTail` before the end of that worksheet and `extra` free to add parts to the package. */
export async function withSheetTail(base: Buffer, sheetTail: string, extra: (zip: JSZip) => void = () => undefined): Promise<Buffer> {
  const zip = await JSZip.loadAsync(base);
  const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('text');
  zip.file('xl/worksheets/sheet1.xml', withRelationshipsNamespace(sheet).replace('</worksheet>', `${sheetTail}</worksheet>`));
  extra(zip);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export const mergeCells = (count: number): string => `<mergeCells count="${count}">${MERGE.repeat(count)}</mergeCells>`;
