import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildCfbfContainer, type CfbfNode } from '../src/lib/conversions/cfbf-writer';
import { parseCfbf } from '../src/lib/conversions/hwp';
import { ConversionFailedError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';

/**
 * The compound file writer is proven by the reference 7-Zip, whose Compound handler tests and extracts the files
 * the writer produces: every stream must come back with its name, size and bytes, across the mini stream, the
 * regular sectors, the FAT and the DIFAT.
 */

const SEVEN_ZIP_TIMEOUT_MS = 60_000;
const MINI_STREAM_CUTOFF = 4096;
/** Past 109 FAT sectors (about 7 MiB) the FAT sector list continues in DIFAT sectors. */
const DIFAT_STREAM_BYTES = 8 * 1024 * 1024;

function deterministicBytes(length: number, seed: string): Buffer {
  const out = Buffer.alloc(length);
  let block = crypto.createHash('sha256').update(seed).digest();
  for (let at = 0; at < length; at += block.length) {
    block.copy(out, at, 0, Math.min(block.length, length - at));
    block = crypto.createHash('sha256').update(block).digest();
  }
  return out;
}

const sha256 = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex');

function sevenZip(args: string[]): string {
  return execFileSync(requireOracleTool('7z'), args, { encoding: 'utf-8', timeout: SEVEN_ZIP_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
}

function flattenStreams(nodes: CfbfNode[], prefix = ''): Map<string, Buffer> {
  const streams = new Map<string, Buffer>();
  for (const node of nodes) {
    if ('children' in node) {
      for (const [name, data] of flattenStreams(node.children, `${prefix}${node.name}/`)) streams.set(name, data);
    } else {
      streams.set(`${prefix}${node.name}`, node.data);
    }
  }
  return streams;
}

const LAYOUT: CfbfNode[] = [
  { name: 'empty', data: Buffer.alloc(0) },
  { name: 'one', data: Buffer.from([0x2a]) },
  { name: 'sixty-three', data: deterministicBytes(63, 'a') },
  { name: 'sixty-four', data: deterministicBytes(64, 'b') },
  { name: 'just-below-cutoff', data: deterministicBytes(MINI_STREAM_CUTOFF - 1, 'c') },
  { name: 'at-cutoff', data: deterministicBytes(MINI_STREAM_CUTOFF, 'd') },
  { name: 'above-cutoff', data: deterministicBytes(MINI_STREAM_CUTOFF + 1, 'e') },
  { name: '한글 이름', data: deterministicBytes(700, 'f') },
  {
    name: 'Storage',
    children: [
      { name: 'inner', data: deterministicBytes(9000, 'g') },
      { name: 'deeper', children: [{ name: 'leaf', data: deterministicBytes(130, 'h') }] },
    ],
  },
  { name: 'zeta', data: deterministicBytes(2000, 'i') },
  { name: 'Alpha', data: deterministicBytes(2001, 'j') },
];

describe('compound file writer against the reference 7-Zip', () => {
  oracleTest('every stream of a mixed layout is listed and extracted with its bytes', ['7z'], () => {
    const container = buildCfbfContainer(LAYOUT);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfbf-writer-'));
    try {
      const file = path.join(dir, 'layout.cfb');
      fs.writeFileSync(file, container);
      expect(sevenZip(['t', file])).toContain('Everything is Ok');
      const out = path.join(dir, 'out');
      sevenZip(['x', `-o${out}`, '-y', file]);
      for (const [name, data] of flattenStreams(LAYOUT)) {
        const extractedPath = path.join(out, ...name.split('/'));
        if (data.length === 0) {
          // 7-Zip lists a stream without data as an empty file
          expect(fs.existsSync(extractedPath) ? fs.statSync(extractedPath).size : 0, name).toBe(0);
        } else {
          expect(sha256(fs.readFileSync(extractedPath)), name).toBe(sha256(data));
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  oracleTest('a stream past the DIFAT threshold is read back by 7-Zip', ['7z'], () => {
    const payload = deterministicBytes(DIFAT_STREAM_BYTES, 'big');
    const container = buildCfbfContainer([{ name: 'big', data: payload }, { name: 'small', data: Buffer.from('tail') }]);
    // The header lists 109 FAT sectors; the 8 MiB stream needs more, so the DIFAT must be present.
    const difatSectors = container.readUInt32LE(72);
    expect(difatSectors).toBeGreaterThan(0);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfbf-writer-'));
    try {
      const file = path.join(dir, 'big.cfb');
      fs.writeFileSync(file, container);
      expect(sevenZip(['t', file])).toContain('Everything is Ok');
      const out = path.join(dir, 'out');
      sevenZip(['x', `-o${out}`, '-y', file]);
      expect(sha256(fs.readFileSync(path.join(out, 'big')))).toBe(sha256(payload));
      expect(fs.readFileSync(path.join(out, 'small')).toString('utf-8')).toBe('tail');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, SEVEN_ZIP_TIMEOUT_MS);
});

describe('compound file writer against the converter reader', () => {
  it('lists the paths of storages and streams as the writer was told them', () => {
    const container = parseCfbf(buildCfbfContainer(LAYOUT));
    expect([...container.paths.keys()].sort()).toEqual(
      [...flattenStreams(LAYOUT).entries()].filter(([, data]) => data.length > 0).map(([name]) => name).sort()
    );
    for (const [name, data] of flattenStreams(LAYOUT)) {
      if (data.length > 0) expect(sha256(container.paths.get(name) as Buffer), name).toBe(sha256(data));
    }
  });

  it('refuses a name the format cannot hold', () => {
    const tooLong = 'x'.repeat(32);
    expect(() => buildCfbfContainer([{ name: tooLong, data: Buffer.from('a') }])).toThrow(ConversionFailedError);
    expect(() => buildCfbfContainer([{ name: tooLong, data: Buffer.from('a') }])).toThrow(
      `Cannot write compound file entry "${tooLong}": names are 1 to 31 characters without / \\ : !.`
    );
    expect(() => buildCfbfContainer([{ name: 'a/b', data: Buffer.from('a') }])).toThrow(ConversionFailedError);
    expect(() => buildCfbfContainer([{ name: 'dup', data: Buffer.from('a') }, { name: 'DUP', data: Buffer.from('b') }])).toThrow(
      'Cannot write compound file: "DUP" appears twice in one storage.'
    );
  });
});
