import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { nextVolumeName } from '../src/lib/conversions/archive-refusal-reasons';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { buildStoredRar4 } from './helpers/rar4-stored';
import { requireRealworldSample } from './helpers/realworld-sample';
import { craftSevenZip } from './helpers/seven-zip-craft';

/**
 * Two answers that used to read "7-Zip rejected the archive as malformed or unsupported" name what the file lacks:
 *  - the first part of a multi-volume RAR set names the volume that is not in the upload, by the numbering the set uses
 *    (`.r00` for the old one, `.part2.rar` for the new one);
 *  - an entry whose compression method the installed 7-Zip does not decode names the entry and the method.
 * The expected volume names are what 7-Zip itself reports for the same file on disk (`ERROR = Missing volume`) and what
 * unrar reports (`Cannot find volume`); the first-volume archives are real or written to the RAR 4.x layout by hand.
 */

const ENGINE_TIMEOUT_MS = 120_000;
const ENTRIES = [
  { name: 'a.txt', data: Buffer.from('first file') },
  { name: 'vols/big.txt', data: Buffer.alloc(4000, 0x41) },
];
const MISSING_VOLUME_LINE = /^ERROR = Missing volume : (.+)$/m;
const UNRAR_VOLUME_LINE = /^Cannot find volume (.+)$/m;
const MESSAGE = (volume: string): string =>
  `Could not read the archive: it is the first part of a multi-volume set and the next volume, ${volume}, is not part of the upload; upload all parts together as one archive.`;

async function failureOf(source: Buffer, format: string, name: string): Promise<Error> {
  return (await dispatchConversion(source, format, 'zip', {}, name).then(
    () => {
      throw new Error('Expected a typed refusal but the conversion completed');
    },
    (err: unknown) => err
  )) as Error;
}

/** What 7-Zip says the next volume of `archive` (saved under `name`) is called. */
function sevenZipsNextVolume(archive: Buffer, name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-volume-'));
  try {
    const file = path.join(dir, name);
    fs.writeFileSync(file, archive);
    const listing = execFileSync(requireOracleTool('7z'), ['l', '-slt', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return MISSING_VOLUME_LINE.exec(listing)?.[1] ?? '';
  } catch (err) {
    // 7-Zip exits 2 for the missing volume but prints the listing first.
    const printed = (err as { stdout?: Buffer | string }).stdout?.toString() ?? '';
    return MISSING_VOLUME_LINE.exec(printed)?.[1] ?? '';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('the first part of a multi-volume RAR set names the volume that is missing', () => {
  oracleTest(
    'a real first volume of the old numbering (rarfile-rar3-old.rar) names rarfile-rar3-old.r00, as unrar does',
    ['7z', 'unrar'],
    async (ctx) => {
      const sample = await requireRealworldSample(ctx, 'rarfile-rar3-old.rar');
      const failure = await failureOf(sample.bytes, 'rar', 'rarfile-rar3-old.rar');
      expect(failure).toMatchObject({ name: 'UnreadableArchiveError' });
      expect(failure.message).toBe(MESSAGE('rarfile-rar3-old.r00'));

      const unrar = (() => {
        try {
          return execFileSync(requireOracleTool('unrar'), ['t', sample.path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
          // unrar exits non-zero for the missing volume; what it says is on its output either way.
          const failure = err as { stdout?: Buffer | string; stderr?: Buffer | string };
          return `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`;
        }
      })();
      expect(path.basename(UNRAR_VOLUME_LINE.exec(unrar)?.[1] ?? '')).toBe('rarfile-rar3-old.r00');
      expect(sevenZipsNextVolume(sample.bytes, 'rarfile-rar3-old.rar')).toBe('rarfile-rar3-old.r00');
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'a first volume with the old numbering is followed by .r00 whatever the base name',
    ['7z'],
    async () => {
      const archive = buildStoredRar4(ENTRIES, { firstVolume: true });
      for (const name of ['part1.rar', 'my backup.rar']) {
        const failure = await failureOf(archive, 'rar', name);
        expect(failure.message, name).toBe(MESSAGE(`${name.replace(/\.rar$/, '')}.r00`));
        expect(sevenZipsNextVolume(archive, name), name).toBe(`${name.replace(/\.rar$/, '')}.r00`);
      }
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'a first volume with the new numbering is followed by the next .partN.rar, keeping the zero padding',
    ['7z'],
    async () => {
      const archive = buildStoredRar4(ENTRIES, { firstVolume: true, newNumbering: true });
      for (const [name, next] of [
        ['set.part1.rar', 'set.part2.rar'],
        ['set.part01.rar', 'set.part02.rar'],
        ['set.part09.rar', 'set.part10.rar'],
        ['Set.Part1.RAR', 'Set.Part2.RAR'],
      ] as const) {
        const failure = await failureOf(archive, 'rar', name);
        expect(failure.message, name).toBe(MESSAGE(next));
        expect(sevenZipsNextVolume(archive, name).toLowerCase(), name).toBe(next.toLowerCase());
      }
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'a first volume uploaded under a name the numbering cannot be read from says only that the other parts are missing',
    ['7z'],
    async () => {
      const failure = await failureOf(buildStoredRar4(ENTRIES, { firstVolume: true, newNumbering: true }), 'rar', 'upload.bin');
      expect(failure.message).toBe(
        'Could not read the archive: it is the first part of a multi-volume set and the other parts are not part of the upload; upload all parts together as one archive.'
      );
    },
    ENGINE_TIMEOUT_MS
  );
});

describe('the name of the next volume', () => {
  const rar4 = (flags: number): Buffer => {
    const head = Buffer.alloc(14);
    Buffer.from('Rar!\x1a\x07\x00', 'latin1').copy(head);
    head.writeUInt8(0x73, 9);
    head.writeUInt16LE(flags, 10);
    return head;
  };
  const rar5 = Buffer.concat([Buffer.from('Rar!\x1a\x07\x01\x00', 'latin1'), Buffer.alloc(16)]);

  function nameOf(header: Buffer, archiveName: string | undefined): string | null {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-volume-name-'));
    try {
      const file = path.join(dir, 'input.rar');
      fs.writeFileSync(file, header);
      return nextVolumeName(file, archiveName);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('follows the numbering flag of a RAR 4.x main header', () => {
    expect(nameOf(rar4(0x0001), 'a.rar')).toBe('a.r00');
    expect(nameOf(rar4(0x0011), 'a.part1.rar')).toBe('a.part2.rar');
    expect(nameOf(rar4(0x0011), 'a.rar')).toBeNull();
  });

  it('reads only the name of a RAR 5 set, whose volumes are numbered by name', () => {
    expect(nameOf(rar5, 'a.part3.rar')).toBe('a.part4.rar');
    expect(nameOf(rar5, 'a.rar')).toBeNull();
  });

  it('names nothing without a file name, for a name with a directory part, or for another archive', () => {
    expect(nameOf(rar4(0x0001), undefined)).toBeNull();
    expect(nameOf(rar4(0x0001), 'dir/sub\\a.rar')).toBe('a.r00');
    expect(nameOf(Buffer.from('PK\x03\x04'.padEnd(20, '\0'), 'latin1'), 'a.rar')).toBeNull();
    expect(nameOf(Buffer.alloc(3), 'a.rar')).toBeNull();
  });

  it('does not count past the digits it can write: part99 gets part100', () => {
    expect(nameOf(rar4(0x0011), 'a.part99.rar')).toBe('a.part100.rar');
  });
});

describe('an entry whose compression method is not decoded names the entry and the method', () => {
  const methodOf = (archive: Buffer, name: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'method-oracle-'));
    try {
      const file = path.join(dir, name);
      fs.writeFileSync(file, archive);
      const listing = execFileSync(requireOracleTool('7z'), ['l', '-slt', '-ba', file], { encoding: 'utf8' });
      return /^Method = (.+)$/m.exec(listing)?.[1] ?? '';
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  oracleTest(
    'a RAR entry stored with method byte 0x60 (no RAR method) is an unsupported method, named as 7-Zip lists it',
    ['7z'],
    async () => {
      const archive = buildStoredRar4(ENTRIES, { unpack: { version: 29, method: 0x60 } });
      const method = methodOf(archive, 'odd.rar');
      expect(method).toBe('96');
      const failure = await failureOf(archive, 'rar', 'odd.rar');
      expect(failure).toMatchObject({ name: 'UnsupportedArchiveMethodError', status: 422 });
      expect(failure.message).toBe(`Could not read the archive: the data of 'a.txt' uses the compression method ${method}, which this 7-Zip build does not decode.`);
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'a RAR entry of an unpack version newer than any (99) is an unsupported method',
    ['7z'],
    async () => {
      const archive = buildStoredRar4(ENTRIES, { unpack: { version: 99, method: 0x33 } });
      const failure = await failureOf(archive, 'rar', 'future.rar');
      expect(failure).toMatchObject({ name: 'UnsupportedArchiveMethodError' });
      expect(failure.message).toMatch(/^Could not read the archive: the data of 'a\.txt' uses the compression method m3:\d+, which this 7-Zip build does not decode\.$/);
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'a 7z whose coder id is unknown names the entry and the method id',
    ['7z'],
    async () => {
      const archive = craftSevenZip([{ name: 'dir/a.txt', data: Buffer.from('hello') }], { codecId: 0x7f });
      expect(methodOf(archive, 'odd.7z')).toBe('7F');
      const failure = await failureOf(archive, '7z', 'odd.7z');
      expect(failure).toMatchObject({ name: 'UnsupportedArchiveMethodError', status: 422 });
      expect(failure.message).toBe("Could not read the archive: the data of 'dir/a.txt' uses the compression method 7F, which this 7-Zip build does not decode.");
    },
    ENGINE_TIMEOUT_MS
  );

  it('keeps the entry name printable: control characters are replaced and a long name is cut', async () => {
    const { unsupportedMethodMessage } = await import('../src/lib/conversions/archive-refusal-reasons');
    const long = `${'x'.repeat(200)}`;
    const message = unsupportedMethodMessage(`ERROR: Unsupported Method : evil\u001b[31m${long}`, [{ path: `evil\u001b[31m${long}`, method: 'LZMA2:24' }]);
    expect(message).toBe(`Could not read the archive: the data of 'evil?[31m${'x'.repeat(120 - 'evil?[31m'.length)}...' uses the compression method LZMA2:24, which this 7-Zip build does not decode.`);
  });

  it('is not claimed for the wrong-password line that 7-Zip prints in the same words', async () => {
    const { unsupportedMethodMessage } = await import('../src/lib/conversions/archive-refusal-reasons');
    const stderr = 'ERROR: Unsupported Method : zz : Cannot open encrypted archive. Wrong password?';
    expect(unsupportedMethodMessage(stderr, [{ path: 'zz', method: 'LZMA2:24' }])).toBeNull();
  });

  it('says the method is unknown when the listing has none for the entry', async () => {
    const { unsupportedMethodMessage } = await import('../src/lib/conversions/archive-refusal-reasons');
    expect(unsupportedMethodMessage('ERROR: Unsupported Method : a.txt\n', [{ path: 'a.txt' }])).toBe(
      "Could not read the archive: the data of 'a.txt' uses a compression method this 7-Zip build does not decode."
    );
  });
});
