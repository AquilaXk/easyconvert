import { describe, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';
import { compressLzw } from './helpers/unix-compress';

/**
 * Archive sources that only the native 7-Zip engine reads (the in-process engine answers them with a typed engine
 * error). The dispatcher has to hand every one of them to 7-Zip: a source the worker does not list would stay
 * unconvertible although the registry advertises it. The inputs are real files written by other tools
 * (tests/fixtures/archive-sources/PROVENANCE) and the expected contents are the literals those tools were given.
 */

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'archive-sources');
const ENGINE_TIMEOUT_MS = 120_000;
const LONG_TEXT_LINES = 400;
const LINE_NUMBER_DIGITS = 4;
const BYTE_VALUES = 256;

/** The payload tree the fixtures were built from. */
const PAYLOAD: ReadonlyMap<string, Buffer> = new Map([
  ['hello.txt', Buffer.from('hello archive\n')],
  ['dir/nested.txt', Buffer.from('nested file\n')],
  ['dir/data.bin', Buffer.from(Array.from({ length: BYTE_VALUES }, (_, i) => i))],
]);

/** The 400-line text the single-stream fixtures compress. */
const LONG_TEXT = Buffer.from(
  Array.from({ length: LONG_TEXT_LINES }, (_, i) => `line ${String(i).padStart(LINE_NUMBER_DIGITS, '0')} of the archive probe payload\n`).join('')
);

async function zipFiles(zipBytes: Buffer): Promise<Map<string, Buffer>> {
  const zip = await JSZip.loadAsync(zipBytes);
  const files = new Map<string, Buffer>();
  for (const entry of Object.values(zip.files)) {
    if (!entry.dir) files.set(entry.name, await entry.async('nodebuffer'));
  }
  return files;
}

const fixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURE_DIR, name));

describe('archive sources read by the native 7-Zip engine reach it through the dispatcher', () => {
  for (const [format, file] of [
    ['img', 'probe-fat.img'],
    ['lha', 'probe.lzh'],
  ] as const) {
    oracleTest(`.${format} (a real ${file}) converts to a zip holding the files that were put in`, ['7z'], async () => {
      const result = await dispatchConversion(fixture(file), format, 'zip', {}, `sample.${format}`);
      expect(await zipFiles(result.buffer)).toEqual(PAYLOAD);
    }, ENGINE_TIMEOUT_MS);
  }

  for (const [format, file] of [
    ['lzma', 'long.txt.lzma'],
    ['z', 'long.txt.Z'],
  ] as const) {
    oracleTest(`.${format} (a real ${file}) converts to a zip holding the text that was compressed`, ['7z'], async () => {
      const result = await dispatchConversion(fixture(file), format, 'zip', {}, `sample.${format}`);
      const files = [...(await zipFiles(result.buffer)).values()];
      expect(files).toHaveLength(1);
      expect(files[0].equals(LONG_TEXT)).toBe(true);
    }, ENGINE_TIMEOUT_MS);
  }

  oracleTest('.dmg (a real UDIF image of an empty volume) converts without inventing files', ['7z'], async () => {
    const result = await dispatchConversion(fixture('probe.dmg'), 'dmg', 'zip', {}, 'sample.dmg');
    expect([...(await zipFiles(result.buffer)).keys()]).toEqual([]);
  }, ENGINE_TIMEOUT_MS);

  // A compressed tar goes through the same wrapper path whichever compressor wrote it: the result for a tar compressed
  // with compress (.tar.Z, .tz) has the shape of the result for the same tar compressed with gzip.
  for (const format of ['tar.z', 'tz'] as const) {
    oracleTest(`.${format} (a tar compressed with compress) converts like the same tar compressed with gzip`, ['7z', 'tar'], async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tar-z-'));
      try {
        fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\n');
        const tarFile = path.join(dir, 'sample.tar');
        execFileSync(requireOracleTool('tar'), ['-cf', tarFile, '--blocking-factor=1', '-C', dir, 'a.txt']);
        const tar = fs.readFileSync(tarFile);
        const compressed = compressLzw(tar);
        // gzip reads .Z: the builder's output decompresses to the tar that went in, so the fixture is a real .Z stream.
        expect(execFileSync('gzip', ['-dc'], { input: compressed, maxBuffer: 1 << 20 }).equals(tar)).toBe(true);

        const fromCompress = await zipFiles((await dispatchConversion(compressed, format, 'zip', {}, `sample.${format}`)).buffer);
        const gzipped = execFileSync('gzip', ['-c'], { input: tar, maxBuffer: 1 << 20 });
        const fromGzip = await zipFiles((await dispatchConversion(gzipped, 'tar.gz', 'zip', {}, 'sample.tar.gz')).buffer);
        expect([...fromCompress.keys()]).toEqual([...fromGzip.keys()]);
        expect([...fromCompress.values()].map((bytes) => bytes.equals(tar))).toEqual([...fromGzip.values()].map((bytes) => bytes.equals(tar)));
        expect(fromCompress.size).toBe(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, ENGINE_TIMEOUT_MS);
  }
});
