import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import { extractZipArchive } from '../src/lib/conversions/archive';
import { ConversionFailedError, EngineMissingError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';

/**
 * An archive the in-process engine cannot read is not "converted" by putting the archive file itself into the
 * target as a single entry. The 7-Zip family is left to the native engine (a typed, retryable engine error); a
 * format nothing reads is refused outright; the ZIP-based Java packages and tar.bz are read for real.
 */

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'archive-sources');

describe('archive sources the in-process engine cannot read', () => {
  it.each([
    ['cab', 'probe.cab'],
    ['iso', 'udf.iso'],
    ['rpm', 'probe.rpm'],
    ['deb', 'probe.deb'],
    ['cpio', 'newc.cpio'],
    ['arj', 'probe.arj'],
    ['lha', 'probe.lzh'],
    ['dmg', 'probe.dmg'],
    ['lzma', 'long.txt.lzma'],
    ['z', 'long.txt.Z'],
  ])('.%s (a real %s) is left to the native 7-Zip engine, not wrapped into the target', async (format, fixture) => {
    const bytes = fs.readFileSync(path.join(FIXTURE_DIR, fixture));
    const failure = await convertFile(bytes, format, 'zip', {}, `sample.${format}`).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(EngineMissingError);
    expect((failure as Error).message).toBe(`Engine '7-Zip' is unavailable: reading .${format} archives needs the native 7-Zip engine`);
  });

  it.each(['ace', 'alz', 'arc', 'lz', 'lzo', 'rz', 'tar.lzo', 'tzo'])('.%s has no reader on any engine and is refused', async (format) => {
    const failure = await convertFile(Buffer.from('anything at all'), format, 'zip', {}, `sample.${format}`).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect(failure).not.toBeInstanceOf(EngineMissingError);
    expect((failure as Error).message).toBe(`Cannot read .${format} archives: no engine reads this format.`);
  });

  it('still packs a file that is not an archive into the target archive', async () => {
    const converted = await convertFile(Buffer.from('plain text body'), 'txt', 'zip', {}, 'note.txt');
    const entries = await extractZipArchive(converted.buffer);
    expect(entries.map((entry) => [entry.filename, entry.buffer.toString('utf-8')])).toEqual([['note.txt', 'plain text body']]);
  });
});

describe('ZIP-based and bzip2-based archive sources are read', () => {
  it.each(['jar', 'war', 'ear'])('.%s is a ZIP package: its entries are the entries of the zip, not the package inside the zip', async (format) => {
    const source = await new JSZip().file('META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\n').file('app/Main.class', 'CAFEBABE').generateAsync({ type: 'nodebuffer' });
    const converted = await convertFile(source, format, 'zip', {}, `sample.${format}`);
    const entries = await extractZipArchive(converted.buffer);
    expect(entries.map((entry) => [entry.filename, entry.buffer.toString('utf-8')]).sort()).toEqual([
      ['META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\n'],
      ['app/Main.class', 'CAFEBABE'],
    ]);
  });

  oracleTest('.tar.bz (a tar compressed with bzip2 by the reference tool) is read like .tar.bz2', ['tar', 'bzip2'], async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tar-bz-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha');
      fs.writeFileSync(path.join(dir, 'b.txt'), 'bravo');
      const archive = path.join(dir, 'sample.tar.bz');
      execFileSync(requireOracleTool('tar'), ['-cjf', archive, '-C', dir, 'a.txt', 'b.txt']);
      const converted = await convertFile(fs.readFileSync(archive), 'tar.bz', 'zip', {}, 'sample.tar.bz');
      const entries = await extractZipArchive(converted.buffer);
      expect(entries.map((entry) => [entry.filename, entry.buffer.toString('utf-8')]).sort()).toEqual([
        ['a.txt', 'alpha'],
        ['b.txt', 'bravo'],
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
