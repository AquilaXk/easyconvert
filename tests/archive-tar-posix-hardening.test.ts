import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST as convertRoute } from '../src/app/api/convert/route';
import { POST as v1ConvertRoute } from '../src/app/api/v1/convert/route';
import {
  ARCHIVE_SECURITY_LIMITS,
  compressZstd,
  convertArchive,
  createTarArchive,
  extractTarArchive,
  inspectArchive,
  readTarEntries,
  resolveArchiveEntryCollisions,
} from '../src/lib/conversions/archive';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { ArchiveEntryCollisionError, ConversionFailedError } from '../src/lib/types';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import {
  END_OF_ARCHIVE,
  TAR_TEST_BLOCK,
  base256Field,
  craftEntry,
  craftHeader,
  craftPaxHeader,
  padToBlock,
  paxRecordBytes,
} from './helpers/tar-craft';
import { expectLinearScaling, expectSizeIndependentOnInputs, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS, settle } from './helpers/timing';

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;
const PAX_FLOOD_HEADERS = 16;
const SLASH_RUN_BASE = 2000;
const SLASH_RUN_ROUND_TRIPS = 100;
vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

/**
 * Hardening of the POSIX TAR reader and writer: resource budgets, hostile numeric fields, link
 * containment, pax semantics, typed errors and archive inspection. Archive bytes come from
 * tests/helpers/tar-craft.ts (hand-assembled per IEEE 1003.1), GNU tar and node:zlib.
 */

const KIB = 1024;
const MIB = KIB * KIB;
const PAX_CAP = MIB; // documented extension-header budget
const OVERSIZED_RECORD_VALUE = 600 * KIB; // two of these exceed the budget, one does not
const HTTP_UNPROCESSABLE = 422;
const LONG_NAME_LENGTH = 150;

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function gnuTar(): string {
  const tool = getOracleToolPath('tar');
  if (!tool) throw new Error('GNU tar is required for this oracle test');
  return tool;
}

describe('TAR reader: cumulative extension-header budget', () => {
  const bigRecord = (key: string) => paxRecordBytes(key, 'v'.repeat(OVERSIZED_RECORD_VALUE));

  it('rejects consecutive local pax headers that together exceed the budget', () => {
    const tar = Buffer.concat([
      craftPaxHeader('x', bigRecord('k1')),
      craftPaxHeader('x', bigRecord('k2')),
      craftEntry('f', 'X'),
      END_OF_ARCHIVE,
    ]);
    expect(() => readTarEntries(tar)).toThrow(ConversionFailedError);
    expect(() => readTarEntries(tar)).toThrow(/extension headers .* exceed/);
  });

  it('counts GNU long-name headers in the same per-entry budget', () => {
    const longName = Buffer.from(`${'n'.repeat(OVERSIZED_RECORD_VALUE)}\0`);
    const tar = Buffer.concat([
      Buffer.concat([craftHeader({ name: '././@LongLink', typeflag: 'L', size: longName.length }), padToBlock(longName)]),
      craftPaxHeader('x', bigRecord('k1')),
      craftEntry('f', 'X'),
      END_OF_ARCHIVE,
    ]);
    expect(() => readTarEntries(tar)).toThrow(/extension headers .* exceed/);
  });

  it('resets the budget once an entry has been emitted', () => {
    const tar = Buffer.concat([
      craftPaxHeader('x', bigRecord('k1')),
      craftEntry('first', 'A'),
      craftPaxHeader('x', bigRecord('k1')),
      craftEntry('second', 'B'),
      END_OF_ARCHIVE,
    ]);
    expect(readTarEntries(tar).map((e) => e.filename)).toEqual(['first', 'second']);
  });

  it('rejects global pax headers whose retained records exceed the budget', () => {
    const tar = Buffer.concat([
      craftPaxHeader('g', bigRecord('k1')),
      craftPaxHeader('g', bigRecord('k2')),
      craftEntry('f', 'X'),
      END_OF_ARCHIVE,
    ]);
    expect(() => readTarEntries(tar)).toThrow(ConversionFailedError);
    expect(() => readTarEntries(tar)).toThrow(/global pax records exceed/);
  });

  it('lets a repeated global key replace its earlier value without growing the budget', () => {
    const tar = Buffer.concat([
      craftPaxHeader('g', bigRecord('k1')),
      craftPaxHeader('g', bigRecord('k1')),
      craftPaxHeader('g', bigRecord('k1')),
      craftEntry('f', 'X'),
      END_OF_ARCHIVE,
    ]);
    expect(readTarEntries(tar).map((e) => e.filename)).toEqual(['f']);
  });

  it('stops a flood of maximum-size pax headers within a bounded amount of work', async () => {
    // The reader refuses the archive once the pax budget is spent, so a flood four times as long must be
    // refused after about the same work (tests/helpers/timing.ts), not after reading all of it.
    const floodTar = (headers: number) => {
      const flood: Buffer[] = [];
      for (let i = 0; i < headers; i++) {
        flood.push(craftPaxHeader('x', paxRecordBytes(`k${i}`, 'v'.repeat(PAX_CAP - KIB))));
      }
      return Buffer.concat([...flood, craftEntry('f', 'X'), END_OF_ARCHIVE]);
    };
    const { largeResult } = await expectSizeIndependentOnInputs(
      'pax flood',
      (tar: Buffer) => settle(() => readTarEntries(tar)),
      { modest: floodTar(PAX_FLOOD_HEADERS), huge: floodTar(PAX_FLOOD_HEADERS * SCALING_FACTOR) }
    );
    expect(largeResult.ok).toBe(false);
    expect(!largeResult.ok && largeResult.error).toBeInstanceOf(ConversionFailedError);
  }, SCALING_TEST_TIMEOUT_MS);
});

describe('TAR reader: NUL bytes in paths', () => {
  it('rejects a pax path or linkpath containing NUL', () => {
    const nulPath = Buffer.concat([
      craftPaxHeader('x', paxRecordBytes('path', 'good\0evil.txt')),
      craftEntry('innocent', 'X'),
      END_OF_ARCHIVE,
    ]);
    expect(() => readTarEntries(nulPath)).toThrow(ConversionFailedError);
    expect(() => readTarEntries(nulPath)).toThrow(/NUL/);

    const nulLink = Buffer.concat([
      craftPaxHeader('x', paxRecordBytes('linkpath', 'target\0evil')),
      craftHeader({ name: 'l', typeflag: '2', linkname: 'target' }),
      END_OF_ARCHIVE,
    ]);
    expect(() => readTarEntries(nulLink)).toThrow(/NUL/);
  });

  it('surfaces a typed error instead of a TypeError when converting such an archive with a password', async () => {
    const tar = Buffer.concat([
      craftPaxHeader('x', paxRecordBytes('path', 'good\0evil.txt')),
      craftEntry('innocent', 'X'),
      END_OF_ARCHIVE,
    ]);
    for (const options of [{ password: 'pw' }, {}]) {
      const run = convertArchive(tar, 'tar', 'zip', options, 'in.tar');
      await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
      await expect(run).rejects.toThrow(/NUL byte in its path/);
    }
  });
});

describe('TAR reader: shared uncompressed-size budget', () => {
  const HALF_BUDGET = Math.floor(ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE / 2);

  it('counts hardlink content against the same budget as regular files', () => {
    const big = Buffer.alloc(HALF_BUDGET + KIB, 0x41);
    const tar = Buffer.concat([
      craftEntry('big', big),
      craftHeader({ name: 'link', typeflag: '1', linkname: 'big' }),
      END_OF_ARCHIVE,
    ]);
    // the file alone fits; file + hardlink exceed the limit
    expect(readTarEntries(tar.subarray(0, TAR_TEST_BLOCK + padToBlock(big).length))).toHaveLength(1);
    expect(() => extractTarArchive(tar)).toThrow(ConversionFailedError);
    expect(() => extractTarArchive(tar)).toThrow(/Archive bomb detected/);
  });

  it('shares one buffer between a file and its hardlinks instead of copying it', () => {
    const body = Buffer.alloc(20 * KIB, 0x42);
    const tar = Buffer.concat([
      craftEntry('orig', body),
      craftHeader({ name: 'h1', typeflag: '1', linkname: 'orig' }),
      craftHeader({ name: 'h2', typeflag: '1', linkname: './orig' }),
      END_OF_ARCHIVE,
    ]);
    const out = extractTarArchive(tar);
    expect(out.map((f) => f.filename)).toEqual(['orig', 'h1', 'h2']);
    expect(out[1].buffer).toBe(out[0].buffer);
    expect(out[2].buffer).toBe(out[0].buffer);
    expect(out[0].buffer.equals(body)).toBe(true);
  });

  it('resolves a hardlink target by the same normalised path it was contained with', () => {
    const tar = Buffer.concat([
      craftEntry('f', 'ROOT'),
      craftEntry('d/f', 'NESTED'),
      craftHeader({ name: 'h', typeflag: '1', linkname: 'd/../f' }),
      END_OF_ARCHIVE,
    ]);
    const out = extractTarArchive(tar);
    expect(out.find((f) => f.filename === 'h')!.buffer.toString('utf8')).toBe('ROOT');
  });

  it('enforces the entry-count limit with a typed error', () => {
    const entries = (count: number) =>
      Buffer.concat([...Array.from({ length: count }, (_, i) => craftEntry(`f${i}`)), END_OF_ARCHIVE]);
    expect(readTarEntries(entries(ARCHIVE_SECURITY_LIMITS.MAX_FILES))).toHaveLength(ARCHIVE_SECURITY_LIMITS.MAX_FILES);
    const tooMany = entries(ARCHIVE_SECURITY_LIMITS.MAX_FILES + 1);
    expect(() => readTarEntries(tooMany)).toThrow(ConversionFailedError);
    expect(() => readTarEntries(tooMany)).toThrow(/file count exceeds limit/);
  });

  it('raises typed bomb errors through convertArchive for plain, gzip and zstd tars', async () => {
    const bomb = Buffer.concat([craftHeader({ name: 'big', typeflag: '0', size: 0o77777777777 }), END_OF_ARCHIVE]);
    for (const [src, input] of [
      ['tar', bomb],
      ['tar.gz', zlib.gzipSync(bomb)],
      ['tar.zst', compressZstd(bomb)],
    ] as const) {
      const run = convertArchive(input, src, 'zip', {}, `in.${src}`);
      await expect(run, src).rejects.toBeInstanceOf(ConversionFailedError);
      await expect(run, src).rejects.toThrow(/Archive bomb detected/);
    }
  });

  it('copies only the entries it returns out of the archive buffer', () => {
    const wanted = Buffer.alloc(20 * KIB, 0x43);
    const tar = Buffer.concat([craftEntry('skip.bin', Buffer.alloc(20 * KIB, 7)), craftEntry('keep.bin', wanted), END_OF_ARCHIVE]);
    const entries = readTarEntries(tar);
    expect(entries[0].buffer.buffer).toBe(tar.buffer); // reader entries are views, not copies
    const out = extractTarArchive(tar, { entries: ['keep.bin'] });
    expect(out.map((f) => f.filename)).toEqual(['keep.bin']);
    expect(out[0].buffer.buffer).not.toBe(tar.buffer);
    expect(out[0].buffer.equals(wanted)).toBe(true);
  });
});

describe('TAR reader: hostile numeric fields', () => {
  const withSize = (sizeField: Buffer) =>
    Buffer.concat([craftHeader({ name: 'f', typeflag: '0', sizeField }), END_OF_ARCHIVE]);

  it('rejects a negative base-256 size', () => {
    const negative = Buffer.alloc(12, 0xff);
    expect(() => readTarEntries(withSize(negative))).toThrow(ConversionFailedError);
    expect(() => readTarEntries(withSize(negative))).toThrow(/negative size/);
  });

  it('rejects a base-256 marker byte that is neither 0x80 nor 0xff', () => {
    expect(() => readTarEntries(withSize(base256Field(0x81, 5)))).toThrow(/malformed base-256 size/);
    expect(() => readTarEntries(withSize(base256Field(0xfe, 5)))).toThrow(/malformed base-256 size/);
  });

  it('rejects a base-256 value above 2^53', () => {
    const huge = base256Field(0x80, 0);
    huge[4] = 0x20; // 2^(8*7) = 2^56
    expect(() => readTarEntries(withSize(huge))).toThrow(/exceeds the supported range/);
  });

  it('rejects negative base-256 mode, uid and gid but accepts a negative mtime', () => {
    const negative = Buffer.alloc(8, 0xff);
    const mode = craftHeader({ name: 'f', typeflag: '0', modeField: negative });
    const uid = craftHeader({ name: 'f', typeflag: '0', uidField: negative });
    expect(() => readTarEntries(Buffer.concat([mode, END_OF_ARCHIVE]))).toThrow(/negative mode/);
    expect(() => readTarEntries(Buffer.concat([uid, END_OF_ARCHIVE]))).toThrow(/negative uid/);
  });

  it('rejects non-decimal pax mtime, uid and size values', () => {
    for (const [key, value] of [['mtime', '0x10'], ['mtime', '1e3'], ['uid', '-1'], ['size', '12abc']]) {
      const tar = Buffer.concat([
        craftPaxHeader('x', paxRecordBytes(key, value)),
        craftEntry('f', 'X'),
        END_OF_ARCHIVE,
      ]);
      expect(() => readTarEntries(tar), `${key}=${value}`).toThrow(ConversionFailedError);
    }
  });

  it('rejects sparse-file pax keywords', () => {
    const tar = Buffer.concat([
      craftPaxHeader('x', paxRecordBytes('GNU.sparse.major', '1')),
      craftEntry('sparse.bin', 'X'),
      END_OF_ARCHIVE,
    ]);
    expect(() => readTarEntries(tar)).toThrow(ConversionFailedError);
    expect(() => readTarEntries(tar)).toThrow(/sparse/);
  });
});

describe('TAR reader: pax keyword semantics (POSIX.1-2008)', () => {
  it('applies a global record to every later entry and lets a local record override it', () => {
    const tar = Buffer.concat([
      craftPaxHeader('g', paxRecordBytes('uid', '4242'), paxRecordBytes('path', 'global-name.txt')),
      craftPaxHeader('x', paxRecordBytes('path', 'local-name.txt')),
      craftEntry('first', 'A'),
      craftEntry('second', 'B'),
      END_OF_ARCHIVE,
    ]);
    const entries = readTarEntries(tar);
    expect(entries.map((e) => e.filename)).toEqual(['local-name.txt', 'global-name.txt']);
    expect(entries.map((e) => e.uid)).toEqual([4242, 4242]);
    expect(entries.map((e) => e.buffer.toString('utf8'))).toEqual(['A', 'B']);
  });

  oracleTest('GNU tar agrees on global and local path records', ['tar'], () => {
    const tar = Buffer.concat([
      craftPaxHeader('g', paxRecordBytes('path', 'global-name.txt')),
      craftPaxHeader('x', paxRecordBytes('path', 'local-name.txt')),
      craftEntry('first', 'A'),
      craftEntry('second', 'B'),
      END_OF_ARCHIVE,
    ]);
    const res = spawnSync(gnuTar(), ['-tf', '-'], { input: tar, encoding: 'utf8' });
    expect(res.stdout.split('\n').filter(Boolean)).toEqual(['local-name.txt', 'global-name.txt']);
    expect(readTarEntries(tar).map((e) => e.filename)).toEqual(['local-name.txt', 'global-name.txt']);
  });

  it('treats an empty local value as deleting the keyword for that entry only', () => {
    const tar = Buffer.concat([
      craftPaxHeader('g', paxRecordBytes('path', 'global-name.txt')),
      craftPaxHeader('x', paxRecordBytes('path', '')),
      craftEntry('own-name', 'A'),
      craftEntry('next', 'B'),
      END_OF_ARCHIVE,
    ]);
    expect(readTarEntries(tar).map((e) => e.filename)).toEqual(['own-name', 'global-name.txt']);
  });

  it('treats an empty global value as deleting the keyword from then on', () => {
    const tar = Buffer.concat([
      craftPaxHeader('g', paxRecordBytes('path', 'global-name.txt')),
      craftEntry('first', 'A'),
      craftPaxHeader('g', paxRecordBytes('path', '')),
      craftEntry('second', 'B'),
      END_OF_ARCHIVE,
    ]);
    expect(readTarEntries(tar).map((e) => e.filename)).toEqual(['global-name.txt', 'second']);
  });

  it('lets an empty local size fall back to the ustar size field', () => {
    const tar = Buffer.concat([
      craftPaxHeader('g', paxRecordBytes('size', '1')),
      craftPaxHeader('x', paxRecordBytes('size', '')),
      craftEntry('f', 'ABCDE'),
      END_OF_ARCHIVE,
    ]);
    expect(readTarEntries(tar)[0].buffer.toString('utf8')).toBe('ABCDE');
  });
});

describe('TAR reader: link chains cannot escape the root', () => {
  it('rejects an entry written through an earlier symlink (p -> ., p/q -> ..)', () => {
    const tar = Buffer.concat([
      craftHeader({ name: 'p', typeflag: '2', linkname: '.' }),
      craftHeader({ name: 'p/q', typeflag: '2', linkname: '..' }),
      craftEntry('q/outside.txt', 'X'),
      END_OF_ARCHIVE,
    ]);
    expect(() => readTarEntries(tar)).toThrow(ConversionFailedError);
    expect(() => readTarEntries(tar)).toThrow(/passes through the symlink 'p'/);
  });

  it('rejects a file stored below a symlinked directory', () => {
    const tar = Buffer.concat([
      craftHeader({ name: 'evil', typeflag: '2', linkname: 'dir' }),
      craftEntry('evil/passwd', 'X'),
      END_OF_ARCHIVE,
    ]);
    expect(() => readTarEntries(tar)).toThrow(/passes through the symlink 'evil'/);
  });

  it('rejects a link target that climbs out through a symlink (s -> ., r -> s/..)', () => {
    const tar = Buffer.concat([
      craftHeader({ name: 's', typeflag: '2', linkname: '.' }),
      craftHeader({ name: 'r', typeflag: '2', linkname: 's/..' }),
      END_OF_ARCHIVE,
    ]);
    expect(() => readTarEntries(tar)).toThrow(/passes through the symlink 's'/);
  });

  it('still accepts siblings whose names merely start with a symlink name', () => {
    const tar = Buffer.concat([
      craftHeader({ name: 'lnk', typeflag: '2', linkname: 'target.txt' }),
      craftEntry('lnk2/file.txt', 'ok'),
      craftEntry('target.txt', 'T'),
      END_OF_ARCHIVE,
    ]);
    expect(readTarEntries(tar).map((e) => e.filename)).toEqual(['lnk', 'lnk2/file.txt', 'target.txt']);
  });

  it('rejects paths and link targets longer than the supported limit', () => {
    const longPath = Buffer.concat([
      craftPaxHeader('x', paxRecordBytes('path', 'p'.repeat(9000))),
      craftEntry('f', 'X'),
      END_OF_ARCHIVE,
    ]);
    expect(() => readTarEntries(longPath)).toThrow(/longer than/);
    expect(() => createTarArchive([{ filename: 'w'.repeat(9000), buffer: Buffer.alloc(0) }])).toThrow(
      ConversionFailedError
    );
  });
});

describe('TAR writer: collisions keep directories as directories', () => {
  const EMPTY = Buffer.alloc(0);
  const typesOf = (tar: Buffer) => readTarEntries(tar).map((e) => `${e.type}:${e.filename}`);

  it('renames a duplicate directory to a directory', () => {
    const tar = createTarArchive([
      { filename: 'd/', buffer: EMPTY },
      { filename: 'd/', buffer: EMPTY },
    ]).buffer;
    expect(typesOf(tar)).toEqual(['directory:d', 'directory:d-1']);
    expect(tar.toString('latin1', 0, 2)).toBe('d/');
    expect(tar.toString('latin1', TAR_TEST_BLOCK, TAR_TEST_BLOCK + 4)).toBe('d-1/');
  });

  it('treats a directory and a file with the same name as colliding', () => {
    const tar = createTarArchive([
      { filename: 'd/', buffer: EMPTY },
      { filename: 'd', buffer: Buffer.from('x') },
    ]).buffer;
    expect(typesOf(tar)).toEqual(['directory:d', 'file:d-1']);
    expect(() =>
      createTarArchive(
        [
          { filename: 'd/', buffer: EMPTY },
          { filename: 'd', buffer: Buffer.from('x') },
        ],
        { collisionPolicy: 'error' }
      )
    ).toThrow(ArchiveEntryCollisionError);
  });

  it('keeps per-file metadata when entries are renamed or overwritten', () => {
    const when = new Date('2022-02-03T04:05:06Z');
    const files = [
      { filename: 'a.txt', buffer: Buffer.from('1'), mtime: when, mode: 0o600 },
      { filename: 'a.txt', buffer: Buffer.from('2'), mtime: when, mode: 0o600 },
    ];
    for (const policy of ['rename', 'overwrite'] as const) {
      const entries = readTarEntries(createTarArchive(files, { collisionPolicy: policy }).buffer);
      for (const entry of entries) {
        expect(entry.mtime).toBe(Math.floor(when.getTime() / 1000));
        expect(entry.mode).toBe(0o600);
      }
    }
    expect(resolveArchiveEntryCollisions(files, 'rename').map((f) => f.filename)).toEqual(['a.txt', 'a-1.txt']);
  });

  it('writes and reads names made of long slash runs in linear time', async () => {
    // The writer refuses names over 8192 characters, so the largest run is 8000 slashes; repeating the round
    // trip makes the smallest run long enough to time.
    const roundTrip = (slashes: number) => {
      const name = `a${'/'.repeat(slashes)}b`;
      let filename = '';
      for (let i = 0; i < SLASH_RUN_ROUND_TRIPS; i++) {
        filename = readTarEntries(createTarArchive([{ filename: name, buffer: Buffer.alloc(0) }]).buffer)[0].filename;
      }
      return filename;
    };
    const { largeResult } = await expectLinearScaling('slash-run names', roundTrip, { baseSize: SLASH_RUN_BASE });
    expect(largeResult).toBe('a/b');
  }, SCALING_TEST_TIMEOUT_MS);
});

describe('TAR inspection reads pax and GNU long names', () => {
  const NAMES = ['한글-문서.txt', `${'x'.repeat(LONG_NAME_LENGTH)}.txt`, 'plain.txt'];

  it('reports the real names, sizes and CRC-32 of writer output', async () => {
    const files = NAMES.map((filename, i) => ({ filename, buffer: Buffer.from(`content-${i}`) }));
    const tar = createTarArchive(files).buffer;
    const info = await inspectArchive(tar, { filename: 'a.tar' });
    expect(info.totalEntries).toBe(NAMES.length);
    expect(info.entries.map((e) => e.name)).toEqual(NAMES);
    expect(info.entries.map((e) => e.uncompressedSize)).toEqual(files.map((f) => f.buffer.length));
    expect(info.entries.map((e) => e.crc32)).toEqual(
      files.map((f) => zlib.crc32(f.buffer).toString(16).padStart(8, '0'))
    );
    expect(info.totalUncompressedBytes).toBe(files.reduce((sum, f) => sum + f.buffer.length, 0));
  });

  oracleTest('lists the same names as GNU tar for a GNU-format long-name archive', ['tar'], () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-tar-inspect-'));
    tempDirs.push(root);
    const names = [`${'g'.repeat(LONG_NAME_LENGTH)}.txt`, '한글.txt'];
    for (const name of names) fs.writeFileSync(path.join(root, name), `body of ${name.length}`);
    const out = path.join(root, '..', `inspect-${path.basename(root)}.tar`);
    tempDirs.push(out);
    const made = spawnSync(gnuTar(), ['--format=gnu', '--sort=name', '-cf', out, '-C', root, ...names], {
      env: { ...process.env, LC_ALL: 'C.UTF-8' },
    });
    expect(made.status).toBe(0);
    const archive = fs.readFileSync(out);
    const listed = spawnSync(gnuTar(), ['--quoting-style=literal', '-tf', '-'], {
      input: archive,
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C.UTF-8' },
    }).stdout.split('\n').filter(Boolean);
    return inspectArchive(archive, { filename: 'gnu.tar' }).then((info) => {
      expect(info.entries.map((e) => e.name)).toEqual(listed);
    });
  });
});

describe('collision errors map to 422 at the convert routes', () => {
  const duplicateEntries = Buffer.concat([craftEntry('a.txt', '1'), craftEntry('a.txt', '2'), END_OF_ARCHIVE]);
  const optionsJson = JSON.stringify({ collisionPolicy: 'error' });

  function form(): FormData {
    const data = new FormData();
    data.append('file', new Blob([new Uint8Array(duplicateEntries)]), 'dup.tar');
    data.append('targetFormat', 'tar.zst');
    data.append('options', optionsJson);
    return data;
  }

  it('POST /api/convert answers 422 for an entry collision', async () => {
    const res = await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', body: form() }));
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    expect((await res.json()).error).toMatch(/collision detected for 'a\.txt'/);
  });

  it('POST /api/v1/convert answers 422 for an entry collision', async () => {
    const user = await userStore.createUser({
      name: 'Collision Tester',
      email: `collision_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
      tier: 'pro',
    });
    const key = await redisKeyStore.generateApiKey(user.id, 'Collision Key', { scopes: ['convert:write', 'convert:read'] });
    const res = await v1ConvertRoute(
      new NextRequest('http://localhost/api/v1/convert', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key.secretKey}` },
        body: form(),
      })
    );
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    expect((await res.json()).detail).toMatch(/collision detected for 'a\.txt'/);
  });
});
