import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTextFileCharacters } from '../src/lib/conversions/text-input';
import { decodeWindows1252 } from '../src/lib/conversions/office/windows-1252';

/**
 * Child process of tests/text-input-legacy-encodings.test.ts, started with a small V8 heap limit. It writes a text file
 * of 64 MiB that is valid UTF-8 except for its last byte, scans it as the PDF route does, and checks that the file was read
 * as Windows-1252 (the characters of the bytes read one by one). A scan that holds the file, or its text, cannot finish
 * inside that heap.
 */

const MIB = 1024 * 1024;
const FILE_BYTES = 64 * MIB;
const UNIT = Buffer.from('héllo wörld 日本語 « ok »\n', 'utf-8');
const LATE_INVALID_BYTE = Buffer.from([0xe9]);

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-memory-'));
try {
  const file = path.join(dir, 'large.txt');
  const block = Buffer.concat(Array.from({ length: Math.floor(MIB / UNIT.length) }, () => UNIT));
  const fd = fs.openSync(file, 'w');
  for (let written = 0; written + block.length <= FILE_BYTES; written += block.length) fs.writeSync(fd, block);
  fs.writeSync(fd, LATE_INVALID_BYTE);
  fs.closeSync(fd);

  const started = Date.now();
  const characters = readTextFileCharacters(file, MIB);
  const expected = new Set(decodeWindows1252(Buffer.concat([UNIT, LATE_INVALID_BYTE])));
  const byCodePoint = (a: string, b: string): number => (a.codePointAt(0) ?? 0) - (b.codePointAt(0) ?? 0);
  if ([...characters].sort(byCodePoint).join('') !== [...expected].sort(byCodePoint).join('')) fail(`characters differ: ${JSON.stringify(characters)}`);
  const maxRssMiB = Math.round(process.resourceUsage().maxRSS / 1024);
  process.stdout.write(`ok ${fs.statSync(file).size} bytes in ${Date.now() - started} ms, peak rss ${maxRssMiB} MiB\n`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
