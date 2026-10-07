import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { requireOracleTool } from './differential-oracle';
import { pyarrowRead } from './parquet-oracle';
import { xmlWellFormed, xpathAttributes } from './xml-oracle';

/**
 * What standard tools report about the files of the synthetic golden corpus: poppler for the PDF, 7-Zip for the
 * 7z, GNU tar, the zstd CLI, ImageMagick for the PNG, xmllint for every XML part of a package and pyarrow for
 * the Parquet file. Each function returns plain facts, so a test compares them with the values the corpus is
 * meant to contain, written out by hand next to the assertion.
 */

const TOOL_TIMEOUT_MS = 60_000;

function withTempFile<T>(bytes: Buffer, extension: string, run: (file: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-facts-'));
  try {
    const file = path.join(dir, `file.${extension}`);
    fs.writeFileSync(file, bytes);
    return run(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runTool(tool: Parameters<typeof requireOracleTool>[0], args: string[]): string {
  return execFileSync(requireOracleTool(tool), args, { encoding: 'utf-8', timeout: TOOL_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
}

export function pdfFacts(pdf: Buffer): { pages: number; title: string; text: string } {
  return withTempFile(pdf, 'pdf', (file) => {
    const info = runTool('pdfinfo', [file]);
    return {
      pages: Number(/^Pages:\s+(\d+)$/m.exec(info)?.[1]),
      title: /^Title:\s+(.*)$/m.exec(info)?.[1] ?? '',
      text: runTool('pdftotext', ['-layout', file, '-']).replace(/\s+/g, ' ').trim(),
    };
  });
}

export function sevenZipFacts(archive: Buffer): { testPassed: boolean; entries: Array<{ path: string; size: number; crc: string }> } {
  return withTempFile(archive, '7z', (file) => {
    const tool = requireOracleTool('7z');
    const testRun = execFileSync(tool, ['t', '-y', file], { encoding: 'utf-8', timeout: TOOL_TIMEOUT_MS });
    const listing = runTool('7z', ['l', '-slt', file]);
    const entries = listing
      .split(/\r?\n\r?\n/)
      .filter((block) => /^Path = /m.test(block) && /^Size = /m.test(block))
      .map((block) => ({
        path: /^Path = (.*)$/m.exec(block)?.[1] ?? '',
        size: Number(/^Size = (\d+)$/m.exec(block)?.[1]),
        crc: /^CRC = (\w+)$/m.exec(block)?.[1] ?? '',
      }));
    return { testPassed: /Everything is Ok/.test(testRun), entries };
  });
}

export function tarFacts(archive: Buffer): Array<{ path: string; size: number }> {
  return withTempFile(archive, 'tar', (file) =>
    runTool('tar', ['-tvf', file])
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const fields = line.split(/\s+/);
        return { path: fields[fields.length - 1], size: Number(fields[2]) };
      })
  );
}

export function zstdFacts(stream: Buffer): { testPassed: boolean; text: string } {
  return withTempFile(stream, 'zst', (file) => {
    const tool = requireOracleTool('zstd');
    execFileSync(tool, ['-t', file], { stdio: 'ignore', timeout: TOOL_TIMEOUT_MS });
    return { testPassed: true, text: execFileSync(tool, ['-dc', file], { encoding: 'utf-8', timeout: TOOL_TIMEOUT_MS }) };
  });
}

export function pngFacts(png: Buffer): string {
  return withTempFile(png, 'png', (file) => runTool('identify', ['-format', '%m %wx%h %z-bit %[colorspace]', file]));
}

/** Entry names of a ZIP package and, for each XML or relationship part, whether xmllint finds it well-formed. */
export async function packageFacts(bytes: Buffer): Promise<{ entries: string[]; malformedParts: string[]; zip: JSZip }> {
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
  const malformedParts: string[] = [];
  for (const name of entries) {
    if (!/\.(?:xml|rels)$/.test(name)) continue;
    const xml = await zip.files[name].async('text');
    if (!xmlWellFormed(xml).ok) malformedParts.push(name);
  }
  return { entries, malformedParts, zip };
}

export function xpathNames(xml: string, expression: string): string[] {
  return xpathAttributes(xml, expression);
}

/** Entity types of a DXF file, read as (group code, value) line pairs, and the layer names of its LAYER table. */
export function dxfFacts(dxf: string): { entities: string[]; layers: string[] } {
  const lines = dxf.split(/\r?\n/);
  const entities: string[] = [];
  const layers: string[] = [];
  let section = '';
  let table = '';
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    const value = lines[i + 1].trim();
    if (code === '2' && section === '') {
      section = value;
      continue;
    }
    if (code === '0' && value === 'ENDSEC') {
      section = '';
      table = '';
      continue;
    }
    if (section === 'ENTITIES' && code === '0') entities.push(value);
    if (section === 'TABLES' && code === '0' && value === 'TABLE') table = 'pending';
    else if (section === 'TABLES' && code === '2' && table === 'pending') table = value;
    else if (section === 'TABLES' && table === 'LAYER' && code === '2') layers.push(value);
  }
  return { entities, layers };
}

export function parquetFacts(bytes: Buffer): { numRows: number; columns: string[]; codec: string } {
  const read = pyarrowRead(bytes);
  return {
    numRows: read.numRows,
    columns: read.schema.map((column) => `${column.name}:${column.type}`),
    codec: read.rowGroups[0].columns[0].codec,
  };
}
