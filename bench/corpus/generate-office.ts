/**
 * Writes the spreadsheet of the office part of the benchmark corpus (`bench/corpus/office/workbook.xlsx`) and the text
 * it displays (`workbook.gt.txt`), then refreshes the entries of that folder in `manifest.json`. A workbook of two
 * sheets with column widths, number formats, bold headers, SUM formulas that carry their cached results, and a sheet of
 * wrapped text. The displayed text is formatted here, from the same numbers the cells are written from, so it does not
 * come from any spreadsheet program. Run with `npx tsx bench/corpus/generate-office.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { refreshManifest } from './manifest';

const CORPUS_DIR = __dirname;
const FIXED_DATE = new Date(Date.UTC(2020, 0, 1));
const REGIONS = ['North America', 'Europe', 'Asia Pacific', 'Latin America'];
const QUARTERS = ['Q1', 'Q2', 'Q3'];
const HEADERS = ['Region', 'Quarter', 'Units', 'Revenue', 'Margin'];
const NOTES = [
  'Method notes',
  'Revenue is booked in euros at the monthly average rate of the quarter.',
  'Units count shipped devices; returned devices are subtracted in the quarter of the return.',
  'Margin is operating income divided by revenue before group allocations.',
];
const COLUMN_WIDTHS = [22, 9, 11, 16, 10];
const NOTES_WIDTH = 70;
const STYLE = { header: 1, revenue: 2, margin: 3, units: 4, wrap: 5 } as const;

const xml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const grouped = (value: number, decimals: number): string => value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

interface Row {
  region: string;
  quarter: string;
  units: number;
  revenue: number;
  margin: number;
}

function rows(): Row[] {
  return REGIONS.flatMap((region, r) =>
    QUARTERS.map((quarter, q) => {
      const units = 900 + 137 * (r * 3 + q) + 41 * r;
      return { region, quarter, units, revenue: Math.round(units * (118.5 + 7.25 * r - 3.5 * q) * 100) / 100, margin: Math.round((0.21 + 0.017 * r + 0.011 * q) * 1000) / 1000 };
    })
  );
}

const strings: string[] = [];
const sharedIndex = (text: string): number => {
  const known = strings.indexOf(text);
  if (known >= 0) return known;
  strings.push(text);
  return strings.length - 1;
};
const textCell = (ref: string, text: string, style = 0): string => `<c r="${ref}" t="s"${style ? ` s="${style}"` : ''}><v>${sharedIndex(text)}</v></c>`;
const numberCell = (ref: string, value: number, style: number, formula?: string): string => `<c r="${ref}" s="${style}">${formula ? `<f>${formula}</f>` : ''}<v>${value}</v></c>`;

function dataSheet(data: Row[], display: string[]): string {
  const sheetRows: string[] = [];
  sheetRows.push(`<row r="1">${HEADERS.map((h, i) => textCell(`${'ABCDE'[i]}1`, h, STYLE.header)).join('')}</row>`);
  display.push(...HEADERS);
  data.forEach((row, i) => {
    const n = i + 2;
    sheetRows.push(
      `<row r="${n}">${textCell(`A${n}`, row.region)}${textCell(`B${n}`, row.quarter)}${numberCell(`C${n}`, row.units, STYLE.units)}${numberCell(`D${n}`, row.revenue, STYLE.revenue)}${numberCell(`E${n}`, row.margin, STYLE.margin)}</row>`
    );
    display.push(row.region, row.quarter, grouped(row.units, 0), grouped(row.revenue, 2), `${(row.margin * 100).toFixed(1)}%`);
  });
  const last = data.length + 1;
  const total = data.length + 2;
  const units = data.reduce((sum, row) => sum + row.units, 0);
  const revenue = Math.round(data.reduce((sum, row) => sum + row.revenue, 0) * 100) / 100;
  const margin = Math.round((data.reduce((sum, row) => sum + row.margin, 0) / data.length) * 10000) / 10000;
  sheetRows.push(
    `<row r="${total}">${textCell(`A${total}`, 'Total', STYLE.header)}${numberCell(`C${total}`, units, STYLE.units, `SUM(C2:C${last})`)}${numberCell(`D${total}`, revenue, STYLE.revenue, `SUM(D2:D${last})`)}${numberCell(`E${total}`, margin, STYLE.margin, `AVERAGE(E2:E${last})`)}</row>`
  );
  display.push('Total', grouped(units, 0), grouped(revenue, 2), `${(margin * 100).toFixed(1)}%`);
  const cols = COLUMN_WIDTHS.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${cols}</cols><sheetData>${sheetRows.join('')}</sheetData></worksheet>`;
}

function notesSheet(display: string[]): string {
  const sheetRows = NOTES.map((note, i) => `<row r="${i + 1}">${textCell(`A${i + 1}`, note, i === 0 ? STYLE.header : STYLE.wrap)}</row>`);
  display.push(...NOTES);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="${NOTES_WIDTH}" customWidth="1"/></cols><sheetData>${sheetRows.join('')}</sheetData></worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="0.0%"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Liberation Sans"/></font><font><b/><sz val="11"/><name val="Liberation Sans"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/** Every file of the office part of the corpus by its path below the corpus folder. */
export async function officeFiles(): Promise<Map<string, string | Buffer>> {
  const display: string[] = [];
  const sheet1 = dataSheet(rows(), display);
  const sheet2 = notesSheet(display);
  const zip = new JSZip();
  const add = (name: string, content: string): void => {
    zip.file(name, content, { date: FIXED_DATE });
  };
  add(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'
  );
  add('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  add(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>'
  );
  add(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>'
  );
  add('xl/styles.xml', STYLES);
  add('xl/worksheets/sheet1.xml', sheet1);
  add('xl/worksheets/sheet2.xml', sheet2);
  add(
    'xl/sharedStrings.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t>${xml(s)}</t></si>`).join('')}</sst>`
  );
  return new Map<string, string | Buffer>([
    ['office/workbook.xlsx', await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } })],
    ['office/workbook.gt.txt', `${display.join('\n')}\n`],
  ]);
}

async function main(): Promise<void> {
  for (const [relative, data] of await officeFiles()) {
    const target = path.join(CORPUS_DIR, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
  refreshManifest(CORPUS_DIR, ['office']);
}

if (path.basename(process.argv[1] ?? '') === path.basename(__filename)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
