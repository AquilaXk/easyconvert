import { describe, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeSfnt, encodeWoff2 } from '../src/lib/conversions/font';
import { OracleToolMissingError, requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { readSfntTables } from './helpers/font-oracles';
import { readWoff2Reference } from './helpers/woff2-reference';

/**
 * The WOFF2 encoder's output is read by the independent tools the format ships with: the
 * reference decoder (woff2_decompress, woff2_info) and fontTools. Each test skips locally when its tool
 * is missing and throws under ORACLE_STRICT_MODE=1.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'woff2');
const COMPARE_SCRIPT = path.join(__dirname, 'helpers', 'woff2_compare.py');
const HEAD_ADJUSTMENT_OFFSET = 8;
const RINGS_GLYPH = 7; // the glyph of synthetic-triplets that carries the overlap bit

const SOURCES = [
  ['dejavu-sans-latin.ttf', 'dejavu-sans-latin.reference-decoded.ttf'],
  ['dejavu-serif-hinted-ascii.ttf', 'dejavu-serif-hinted-ascii.reference-decoded.ttf'],
  ['synthetic-triplets.ttf', 'synthetic-triplets.reference-decoded.ttf'],
  ['synthetic-cff.otf', 'synthetic-cff.reference-decoded.otf'],
] as const;

const fixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURES, name));

function encodeFixture(name: string): Buffer {
  return encodeWoff2(decodeSfnt(fixture(name), name));
}

function inTempDir<T>(body: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woff2-oracle-'));
  try {
    return body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withoutAdjustment(tables: Map<string, Buffer>): Map<string, Buffer> {
  const head = Buffer.from(tables.get('head')!);
  head.writeUInt32BE(0, HEAD_ADJUSTMENT_OFFSET);
  return new Map(tables).set('head', head);
}

describe('WOFF2 encoder output read by the reference tools', () => {
  for (const [source, referenceDecoded] of SOURCES) {
    oracleTest(`woff2_decompress rebuilds ${source} like it rebuilds the reference encoder's file`, ['woff2_decompress'], () => {
      const decoder = requireOracleTool('woff2_decompress');
      inTempDir((dir) => {
        const file = path.join(dir, 'ours.woff2');
        fs.writeFileSync(file, encodeFixture(source));
        const run = spawnSync(decoder, [file], { encoding: 'utf8' });
        expect(run.status, run.stderr).toBe(0);
        const decoded = readSfntTables(fs.readFileSync(path.join(dir, 'ours.ttf')));
        const reference = readSfntTables(fixture(referenceDecoded));
        // the decoder predates the overlapSimple bitmap, so neither side carries the overlap bit
        const ours = withoutAdjustment(decoded);
        const theirs = withoutAdjustment(reference);
        expect([...ours.keys()].sort()).toEqual([...theirs.keys()].sort());
        for (const [tag, data] of theirs) expect(ours.get(tag)!.equals(data), `table '${tag}'`).toBe(true);
      });
    });
  }

  oracleTest('woff2_info lists the directory the encoder wrote', ['woff2_info'], () => {
    const info = requireOracleTool('woff2_info');
    inTempDir((dir) => {
      const file = path.join(dir, 'ours.woff2');
      const woff2 = encodeFixture('dejavu-serif-hinted-ascii.ttf');
      fs.writeFileSync(file, woff2);
      const run = spawnSync(info, [file], { encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      const reading = readWoff2Reference(woff2);
      expect(run.stdout).toContain(`numTables           ${reading.header.numTables}`);
      expect(run.stdout).toContain(`length              ${woff2.length}`);
      expect(run.stdout).toContain(`totalSfntSize       ${reading.header.totalSfntSize}`);
      expect(run.stdout).toContain(`totalCompressedSize ${reading.header.totalCompressedSize}`);
      for (const row of reading.directory) {
        const flags = `0x${row.flags.toString(16).padStart(2, '0')} ${row.tag}`;
        expect(run.stdout, `directory row of '${row.tag}'`).toContain(flags);
      }
    });
  });
});

describe('WOFF2 encoder output read by fontTools', () => {
  function fontToolsReady(): string {
    const python = requireOracleTool('python3');
    const probe = spawnSync(python, ['-c', 'import fontTools, brotli'], { encoding: 'utf8' });
    if (probe.status !== 0) throw new OracleToolMissingError('fontTools', 'python3 fontTools and brotli are not importable');
    return python;
  }

  for (const [source] of SOURCES) {
    oracleTest(`${source}: fontTools reads the encoded file as the same font`, ['python3'], () => {
      const python = fontToolsReady();
      inTempDir((dir) => {
        const file = path.join(dir, 'ours.woff2');
        fs.writeFileSync(file, encodeFixture(source));
        const run = spawnSync(python, [COMPARE_SCRIPT, path.join(FIXTURES, source), file], { encoding: 'utf8' });
        expect(run.status, run.stderr).toBe(0);
        expect(JSON.parse(run.stdout)).toEqual([]);
      });
    });
  }

  oracleTest('fontTools decompresses the encoded file with its own command line', ['python3'], () => {
    const python = fontToolsReady();
    inTempDir((dir) => {
      const file = path.join(dir, 'ours.woff2');
      const out = path.join(dir, 'out.ttf');
      fs.writeFileSync(file, encodeFixture('dejavu-sans-latin.ttf'));
      const run = spawnSync(python, ['-m', 'fontTools.ttLib.woff2', 'decompress', '-o', out, file], { encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      const decoded = readSfntTables(fs.readFileSync(out));
      const source = readSfntTables(fixture('dejavu-sans-latin.ttf'));
      for (const tag of ['cmap', 'name', 'hmtx', 'maxp', 'post']) expect(decoded.get(tag)!.equals(source.get(tag)!), `table '${tag}'`).toBe(true);
    });
  });

  oracleTest('fontTools sees the overlap bit the encoder carried in the overlapSimple bitmap', ['python3'], () => {
    const python = fontToolsReady();
    inTempDir((dir) => {
      const file = path.join(dir, 'ours.woff2');
      fs.writeFileSync(file, encodeFixture('synthetic-triplets.ttf'));
      const script = `import sys; from fontTools.ttLib import TTFont; f=TTFont(sys.argv[1]); g=f['glyf']; print(g[f.getGlyphOrder()[${RINGS_GLYPH}]].getCoordinates(g)[2][0] & 0x40)`;
      const run = spawnSync(python, ['-c', script, file], { encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe('64');
    });
  });
});
