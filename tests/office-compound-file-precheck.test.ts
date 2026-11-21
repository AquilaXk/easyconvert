import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { REGRESSION_KNOWN_REFUSALS_PATH } from '../bench/realworld/regression/merge';
import { knownRefusal, readKnownRefusals, type JobRecord } from '../bench/realworld/report';
import { getAvailableTargetFormats } from '../src/lib/registry';
import { CompoundFileStructureError } from '../src/lib/types';
import { resetNativeBinaryCache } from '../src/worker/engines';
import { assertLegacyCompoundFileReadable } from '../src/worker/office-input-checks';
import { buildCompoundFile } from './helpers/cfb-craft';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * The check that runs before the office suite opens a legacy Word, Excel or PowerPoint file (`assertLegacyCompoundFileReadable`).
 * A compound file whose first directory sector lies past its end has no root storage for the suite to open, so the suite's type
 * detection imports its bytes as text (1,447 pages of binary for `gd-608556.xls`, 364 for `gd-597001.xls`). The check refuses it, as
 * Apache POI (`getBlockAt`: "Block N not found") and xlrd ("MSAT extension: accessing sector N but only M in file") refuse it.
 */

const SECTOR_BYTES = 512;
const HEADER_BYTES = 512;
const FIRST_DIRECTORY_SECTOR_OFFSET = 48;
const WORKBOOK_BYTES = 8192;
const CUT_FILE = 'gd-597001.xls';
const CUT_FILE_SHA256 = 'd07ee07f640cc75401cd81fbfa91d97f8dfe59623a8837f76766552c8643c52f';
const CHAIN_PAST_THE_FILE = /^Corrupt CFBF container: the sector chain starting at sector (\d+) reaches sector \1, which the file does not hold\.$/;

/** A whole compound file with one `Workbook` stream, and the sector its directory starts at (read from its header). */
function workbook(): { file: Buffer; directorySector: number } {
  const file = buildCompoundFile([{ name: 'Workbook', data: Buffer.alloc(WORKBOOK_BYTES, 0x09) }]);
  return { file, directorySector: file.readUInt32LE(FIRST_DIRECTORY_SECTOR_OFFSET) };
}

const sectorStart = (sector: number): number => HEADER_BYTES + sector * SECTOR_BYTES;

/** What the check does with the bytes: `passed`, or the message it refuses them with. */
function outcome(input: Buffer, src: string): string {
  try {
    assertLegacyCompoundFileReadable(input, src);
    return 'passed';
  } catch (error) {
    return (error as Error).message;
  }
}

describe('assertLegacyCompoundFileReadable and a directory the file does not hold', () => {
  const { file, directorySector } = workbook();

  it('accepts the whole file for every legacy extension', () => {
    for (const src of ['doc', 'dot', 'xls', 'xlt', 'ppt', 'pps', 'pot']) expect(outcome(file, src), src).toBe('passed');
  });

  it('refuses a file that ends where its directory starts, and names the sector', () => {
    const cut = file.subarray(0, sectorStart(directorySector));
    expect(() => assertLegacyCompoundFileReadable(cut, 'xls')).toThrow(CompoundFileStructureError);
    expect(() => assertLegacyCompoundFileReadable(cut, 'xls')).toThrow(new RegExp(`sector chain starting at sector ${directorySector} reaches sector ${directorySector}, which the file does not hold`));
  });

  it('leaves a first directory sector that the file cuts short, as the suite reads gd-200188.xls (25,087 bytes, one short of its last sector)', () => {
    for (const held of [SECTOR_BYTES - 1, SECTOR_BYTES / 2, 1]) {
      const cut = file.subarray(0, sectorStart(directorySector) + held);
      expect(outcome(cut, 'ppt'), `${held} bytes of the sector`).toBe('passed');
    }
  });

  it('refuses a file of the header alone and a header that points the directory past the end', () => {
    expect(() => assertLegacyCompoundFileReadable(file.subarray(0, HEADER_BYTES), 'doc')).toThrow(CHAIN_PAST_THE_FILE);
    const moved = Buffer.from(file);
    moved.writeUInt32LE(33_225, FIRST_DIRECTORY_SECTOR_OFFSET);
    expect(() => assertLegacyCompoundFileReadable(moved, 'xls')).toThrow(/starting at sector 33225 reaches sector 33225/);
  });

  it('refuses the same bytes handed over as a file on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-precheck-'));
    try {
      const cutPath = path.join(dir, 'input.xls');
      fs.writeFileSync(cutPath, file.subarray(0, sectorStart(directorySector)));
      expect(() => assertLegacyCompoundFileReadable({ inputPath: cutPath, outputPath: path.join(dir, 'out') }, 'xls')).toThrow(CHAIN_PAST_THE_FILE);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a file whose directory is whole and whose stream is cut to the suite, which decides', () => {
    const streamCut = file.subarray(0, file.length - SECTOR_BYTES * 2);
    expect(sectorStart(directorySector)).toBeLessThan(streamCut.length);
    expect(outcome(streamCut, 'xls')).toBe('passed');
  });

  it('leaves what is not a compound file and the formats that are not legacy compound files alone', () => {
    expect(outcome(Buffer.from('{\\rtf1 plain text named .doc}'), 'doc')).toBe('passed');
    expect(outcome(file.subarray(0, HEADER_BYTES), 'xlsx')).toBe('passed');
    expect(outcome(file.subarray(0, HEADER_BYTES), 'txt')).toBe('passed');
  });

  it('stops a conversion before the office suite starts', async () => {
    const cut = file.subarray(0, sectorStart(directorySector));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-precheck-soffice-'));
    const sentinel = path.join(dir, 'soffice-invoked.txt');
    const fakeSoffice = path.join(dir, 'soffice');
    fs.writeFileSync(fakeSoffice, `#!/bin/sh\ntouch "${sentinel}"\nexit 1\n`, { mode: 0o755 });
    const previous = process.env.SOFFICE_PATH;
    process.env.SOFFICE_PATH = fakeSoffice;
    resetNativeBinaryCache();
    try {
      for (const target of ['pdf', 'jpg', 'png', 'html', 'ods']) {
        await expect(dispatchConversion(cut, 'xls', target, {}, 'cut.xls'), target).rejects.toBeInstanceOf(CompoundFileStructureError);
      }
      expect(fs.existsSync(sentinel)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.SOFFICE_PATH;
      else process.env.SOFFICE_PATH = previous;
      resetNativeBinaryCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe(`${CUT_FILE} (regression corpus): a copy cut off at 598,016 bytes of a file whose directory lies at sector 33,225`, () => {
  it('is the file the manifest pins, and its header places the FAT and the directory far past its 1,167 sectors', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, CUT_FILE);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(CUT_FILE_SHA256);
    expect((bytes.length - HEADER_BYTES) / SECTOR_BYTES).toBe(1166.0 + 1);
    expect(bytes.readUInt32LE(FIRST_DIRECTORY_SECTOR_OFFSET)).toBe(33_225);
  });

  it('is refused for every target that reads it, and no target prints its bytes as text', { timeout: 120_000 }, async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, CUT_FILE);
    const targets = getAvailableTargetFormats('xls').map((definition) => definition.id);
    expect(targets).toContain('pdf');
    for (const target of targets.filter((id) => id !== 'zip')) {
      const refusal = await dispatchConversion(bytes, 'xls', target, {}, CUT_FILE).catch((error: unknown) => error);
      expect(refusal, target).toBeInstanceOf(CompoundFileStructureError);
      expect((refusal as Error).message, target).toMatch(CHAIN_PAST_THE_FILE);
    }
  });

  it('is packed as it is into a zip, which reads no part of it', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, CUT_FILE);
    const zip = (await dispatchConversion(bytes, 'xls', 'zip', {}, CUT_FILE)).buffer;
    expect(zip.subarray(0, 2).toString('latin1')).toBe('PK');
  });
});

describe('gd-085904.xls (regression corpus): a copy cut off at 4 MiB whose directory lies at sector 14,632', () => {
  const FILE = 'gd-085904.xls';
  const SHA256 = '0b0ee9be0055f594cdabb71ae2bc3ed49e0a22f42dbc4121add5b94b62537067';

  it('is the file the manifest pins and is refused for the targets the baseline converted it to', { timeout: 60_000 }, async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, FILE);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(SHA256);
    expect(bytes.readUInt32LE(FIRST_DIRECTORY_SECTOR_OFFSET)).toBe(14_632);
    expect(bytes.length).toBe(4_194_304);
    for (const target of ['ods', 'pdf', 'csv']) {
      const refusal = await dispatchConversion(bytes, 'xls', target, {}, FILE).catch((error: unknown) => error);
      expect(refusal, target).toBeInstanceOf(CompoundFileStructureError);
      expect((refusal as Error).message, target).toMatch(CHAIN_PAST_THE_FILE);
    }
  });
});

describe('gd-200188.xls (regression corpus): one byte short of its last sector, which is its directory', () => {
  it('passes the check and converts, as it did before the check read the directory sector', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'gd-200188.xls');
    expect(bytes.length).toBe(25_087);
    expect(outcome(bytes, 'xls')).toBe('passed');
    const csv = (await dispatchConversion(bytes, 'xls', 'csv', {}, 'gd-200188.xls')).buffer;
    expect(csv.length).toBeGreaterThan(0);
    expect(csv.includes(0)).toBe(false);
  });
});

describe('the regression gate rows of the two cut-off workbooks', () => {
  const rows = readKnownRefusals(REGRESSION_KNOWN_REFUSALS_PATH);
  const refused = (file: string, detail: string): JobRecord => ({ file, source: 'xls', target: 'ods', verdict: 'refused', ms: 1, detail });
  const message = 'CompoundFileStructureError: Corrupt CFBF container: the sector chain starting at sector 14632 reaches sector 14632, which the file does not hold.';

  it('explain the chain message for their own file only', () => {
    for (const file of ['gd-085904.xls', 'gd-597001.xls']) expect(knownRefusal(refused(file, message), rows), file).not.toBeNull();
    expect(knownRefusal(refused('gd-000001.xls', message), rows), 'another file').toBeNull();
    expect(knownRefusal(refused('gd-597001.xls', 'ConversionFailedError: The XLS file is encrypted.'), rows), 'another message').toBeNull();
  });
});
