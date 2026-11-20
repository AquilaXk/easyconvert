/**
 * Regenerates `expected.json`: writes the inputs and formulas of `cases.ts` as one XLSX workbook with no cached values,
 * has LibreOffice (headless) recalculate and save it, and reads the computed value of every formula cell.
 *
 *   npx tsx tests/fixtures/formula-oracle/generate.mts [--soffice /path/to/soffice] [--workdir /dir/for/temporary/files]
 *
 * The values are stored as they come from LibreOffice: `{ "t": "n" | "s" | "b" | "e", "v": ... }`. The file also records
 * the LibreOffice version. Nothing in the test run needs LibreOffice; run this again only when `cases.ts` changes.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { ORACLE_FORMULAS, ORACLE_INPUTS, type OracleInput } from './cases';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface ExpectedValue {
  t: 'n' | 's' | 'b' | 'e';
  v: number | string | boolean;
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colRow(ref: string): { col: number; row: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col, row: Number(m[2]) };
}

function inputCell(ref: string, value: OracleInput): string {
  if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

async function buildWorkbook(): Promise<Buffer> {
  const rows = new Map<number, Array<{ col: number; xml: string }>>();
  const put = (ref: string, xml: string): void => {
    const { col, row } = colRow(ref);
    const list = rows.get(row) ?? [];
    list.push({ col, xml });
    rows.set(row, list);
  };
  for (const [ref, value] of Object.entries(ORACLE_INPUTS)) put(ref, inputCell(ref, value));
  ORACLE_FORMULAS.forEach((c, i) => put(`H${i + 1}`, `<c r="H${i + 1}"><f>${escapeXml(c.formula)}</f></c>`));
  const sheetRows = [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([r, cells]) => `<row r="${r}">${cells.sort((a, b) => a.col - b.col).map((c) => c.xml).join('')}</row>`)
    .join('');
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  );
  zip.file(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const unescapeXml = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

async function readValues(xlsx: Buffer): Promise<Record<string, ExpectedValue>> {
  const zip = await JSZip.loadAsync(xlsx);
  const sstFile = zip.file('xl/sharedStrings.xml');
  const shared: string[] = [];
  if (sstFile) {
    const xml = await sstFile.async('string');
    for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push(unescapeXml([...si[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')));
    }
  }
  const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  const out: Record<string, ExpectedValue> = {};
  for (const m of sheet.matchAll(/<c r="(H\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const ref = m[1]!;
    const type = /t="(\w+)"/.exec(m[2]!)?.[1] ?? 'n';
    const raw = /<v>([\s\S]*?)<\/v>/.exec(m[3] ?? '')?.[1];
    if (raw === undefined) throw new Error(`LibreOffice wrote no value for ${ref}`);
    if (type === 'n') out[ref] = { t: 'n', v: Number(raw) };
    else if (type === 'b') out[ref] = { t: 'b', v: raw === '1' };
    else if (type === 'e') out[ref] = { t: 'e', v: unescapeXml(raw) };
    else if (type === 's') out[ref] = { t: 's', v: shared[Number(raw)]! };
    else out[ref] = { t: 's', v: unescapeXml(raw) };
  }
  return out;
}

async function main(): Promise<void> {
  const argIdx = process.argv.indexOf('--soffice');
  const soffice = argIdx > 0 ? process.argv[argIdx + 1]! : 'soffice';
  const workIdx = process.argv.indexOf('--workdir');
  const dir = mkdtempSync(path.join(workIdx > 0 ? process.argv[workIdx + 1]! : tmpdir(), 'formula-oracle-'));
  try {
    const input = path.join(dir, 'in', 'oracle.xlsx');
    execFileSync('mkdir', ['-p', path.join(dir, 'in'), path.join(dir, 'out')]);
    writeFileSync(input, await buildWorkbook());
    const version = execFileSync(soffice, ['--version'], { encoding: 'utf8' }).trim();
    execFileSync(
      soffice,
      [
        `-env:UserInstallation=file://${path.join(dir, 'profile')}`,
        '--headless',
        '--convert-to',
        'xlsx:Calc MS Excel 2007 XML',
        '--outdir',
        path.join(dir, 'out'),
        input,
      ],
      { stdio: 'inherit', timeout: 120_000 },
    );
    const values = await readValues(readFileSync(path.join(dir, 'out', 'oracle.xlsx')));
    const expected: Record<string, ExpectedValue & { id: string }> = {};
    ORACLE_FORMULAS.forEach((c, i) => {
      const v = values[`H${i + 1}`];
      if (!v) throw new Error(`no value for ${c.id}`);
      expected[`H${i + 1}`] = { id: c.id, ...v };
    });
    writeFileSync(
      path.join(HERE, 'expected.json'),
      `${JSON.stringify({ generator: 'tests/fixtures/formula-oracle/generate.mts', libreoffice: version, values: expected }, null, 2)}\n`,
    );
    console.log(`${ORACLE_FORMULAS.length} values from ${version}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
