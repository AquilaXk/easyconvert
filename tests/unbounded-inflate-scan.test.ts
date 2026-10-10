import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Source scan for decompression with no output cap. A one-shot inflate of attacker-controlled data must pass
 * `maxOutputLength` (or go through `inflateBounded`), a JSZip entry must be read through `readZipEntryBytes` or
 * `readZipEntryText`, and a zlib stream decoder may only live in the files that count its output and stop at a cap.
 */

const SRC_DIR = path.resolve(__dirname, '..', 'src');
const ONE_SHOT_INFLATE = /\b(?:inflateSync|inflateRawSync|gunzipSync|unzipSync|brotliDecompressSync|zstdDecompressSync)\s*\(/g;
const JSZIP_ASYNC_READ = /\.async\s*\(/g;
const STREAM_DECODER = /\b(?:createGunzip|createInflate|createInflateRaw|createUnzip|createBrotliDecompress)\s*\(|new\s+DecompressionStream\s*\(/g;
/** Files that decode a stream and stop it at a cap of their own, each covered by a bomb test. */
const STREAM_DECODER_FILES = new Set([
  'lib/conversions/archive.ts', // gunzipStreamingWithLimits: 500 MiB and 100:1
  'lib/conversions/bounded-inflate.ts', // inflateRawSalvage: stream cap and document budget
  'lib/edge/workers/opfs-archive.ts', // createGunzipTarTransformer: maxOutputBytes
]);

export interface Finding {
  file: string;
  line: number;
  rule: string;
  text: string;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** The text of the call whose opening parenthesis is the last character of `head`, up to its matching parenthesis. */
function callText(source: string, openIndex: number): string {
  let depth = 0;
  for (let at = openIndex; at < source.length; at++) {
    if (source[at] === '(') depth++;
    else if (source[at] === ')' && --depth === 0) return source.slice(openIndex, at + 1);
  }
  return source.slice(openIndex);
}

export function scanSource(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  const code = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, (comment) => ' '.repeat(comment.length));
  for (const match of code.matchAll(ONE_SHOT_INFLATE)) {
    const call = callText(code, match.index + match[0].length - 1);
    if (!call.includes('maxOutputLength')) {
      findings.push({ file, line: lineOf(code, match.index), rule: 'one-shot inflate without maxOutputLength', text: match[0] });
    }
  }
  for (const match of code.matchAll(JSZIP_ASYNC_READ)) {
    findings.push({ file, line: lineOf(code, match.index), rule: 'JSZip .async() read; use readZipEntryBytes or readZipEntryText', text: match[0] });
  }
  if (!STREAM_DECODER_FILES.has(file)) {
    for (const match of code.matchAll(STREAM_DECODER)) {
      findings.push({ file, line: lineOf(code, match.index), rule: 'stream decoder outside the files that cap it', text: match[0] });
    }
  }
  return findings;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(?:ts|tsx|mts|js|mjs)$/.test(entry.name) ? [full] : [];
  });
}

describe('no decompression without an output cap in src/', () => {
  it('finds no unbounded inflate, JSZip read or stream decoder', () => {
    const findings = sourceFiles(SRC_DIR).flatMap((full) =>
      scanSource(path.relative(SRC_DIR, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf-8'))
    );
    expect(findings).toEqual([]);
  });

  describe('the scan itself', () => {
    it('flags a one-shot inflate with no cap and passes one with a cap', () => {
      const bad = scanSource('x.ts', "const a = zlib.inflateSync(data);\nconst b = gunzipSync(data, { level: 1 });");
      expect(bad.map((finding) => [finding.line, finding.rule])).toEqual([
        [1, 'one-shot inflate without maxOutputLength'],
        [2, 'one-shot inflate without maxOutputLength'],
      ]);
      expect(scanSource('x.ts', 'const a = zlib.inflateRawSync(data, { maxOutputLength: cap });')).toEqual([]);
    });

    it('flags a JSZip read and a stream decoder in an unlisted file', () => {
      const bad = scanSource('x.ts', "const t = await entry.async('text');\nconst g = zlib.createGunzip();");
      expect(bad.map((finding) => finding.rule)).toEqual([
        'JSZip .async() read; use readZipEntryBytes or readZipEntryText',
        'stream decoder outside the files that cap it',
      ]);
    });

    it('ignores calls that appear only in comments', () => {
      expect(scanSource('x.ts', '// gunzipSync(data)\n/* entry.async("text") */')).toEqual([]);
    });
  });
});
