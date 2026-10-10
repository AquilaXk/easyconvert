import { execFileSync } from 'node:child_process';
import { requireOracleTool } from './differential-oracle';

/**
 * Reads the first worksheet of an XLSX package with Python's zipfile and xml.etree modules, following the package
 * relationships of ECMA-376 Part 1 (workbook -> sheet part, shared strings, inline strings), so a spreadsheet writer
 * is proven by a reader that shares no code with it.
 */
const PYTHON_XLSX_READER = [
  'import io, json, re, sys, zipfile',
  'import xml.etree.ElementTree as ET',
  'M = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"',
  'R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"',
  'P = "{http://schemas.openxmlformats.org/package/2006/relationships}"',
  'z = zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))',
  'def text(node):',
  '    return "".join(t.text or "" for t in node.iter(M + "t"))',
  'shared = []',
  'if "xl/sharedStrings.xml" in z.namelist():',
  '    shared = [text(si) for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(M + "si")]',
  'workbook = ET.fromstring(z.read("xl/workbook.xml"))',
  'first = next(workbook.iter(M + "sheet")).get(R + "id")',
  'rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))',
  'target = next(r.get("Target") for r in rels.iter(P + "Relationship") if r.get("Id") == first)',
  'part = target.lstrip("/") if target.startswith("/") else "xl/" + target',
  'rows = {}',
  'width = 0',
  'for c in ET.fromstring(z.read(part)).iter(M + "c"):',
  '    letters, number = re.match(r"([A-Z]+)(\\d+)", c.get("r")).groups()',
  '    col = 0',
  '    for ch in letters:',
  '        col = col * 26 + ord(ch) - 64',
  '    kind = c.get("t")',
  '    v = c.find(M + "v")',
  '    if kind == "s":',
  '        value = shared[int(v.text)]',
  '    elif kind == "inlineStr":',
  '        value = text(c.find(M + "is"))',
  '    else:',
  '        value = v.text if v is not None and v.text is not None else ""',
  '    rows.setdefault(int(number), {})[col] = value',
  '    width = max(width, col)',
  'print(json.dumps([[rows.get(r, {}).get(col, "") for col in range(1, width + 1)] for r in range(1, max(rows) + 1)]))',
].join('\n');

/** The rows of the first sheet of an XLSX package. */
export function xlsxRowsWithPython(file: Buffer): string[][] {
  return JSON.parse(execFileSync(requireOracleTool('python3'), ['-c', PYTHON_XLSX_READER], { input: file, encoding: 'utf-8', maxBuffer: 1 << 26 })) as string[][];
}
