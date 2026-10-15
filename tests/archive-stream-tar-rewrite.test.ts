import { afterAll, afterEach, beforeAll, beforeEach, describe, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertFile } from '../src/lib/conversions';
import { convertWithNative7z } from '../src/worker/engines';
import { buildTarWithEntries } from './helpers/hostile-archives';
import {
  hostileTarEnd,
  hostileTarHeader,
  hostileTarMember,
  pythonTarEntries,
  pythonTarMember,
} from './helpers/hostile-tar';
import { oracleTest } from './helpers/oracle-test';
import { createSevenZipSpy, type SevenZipSpy } from './helpers/seven-zip-spy';

/**
 * A compressed tar converted to tar is read, vetted entry by entry and written again from those entries; the bytes
 * of an untrusted archive are never passed through. Every fixture is a tar that a consumer could read differently
 * from this code (a prefix field under a GNU magic, members behind the end-of-archive blocks, a link, a repeated
 * name, a setuid mode). The result is read back with Python's tarfile, so what a second reader finds is what is
 * asserted, not what this reader says.
 */
const TOOLS = ['7z', 'xz', 'python3'] as const;
const TEST_TIMEOUT_MS = 120_000;
const MAX_ENTRIES = 50_000;
const MIB = 1024 * 1024;
const SETUID_MODE = 0o4755;
const HIDDEN_MARKER = 'HIDDEN-IN-A-SECOND-ARCHIVE';

interface Route {
  label: string;
  convert: (compressed: Buffer, options?: Record<string, unknown>) => Promise<{ buffer: Buffer; skippedLinks?: string[] }>;
}

const ROUTES: Route[] = [
  {
    label: 'native 7-Zip route',
    convert: async (compressed, options = {}) => {
      const result = await convertWithNative7z(compressed, 'tar.xz', 'tar', options, 'payload.tar.xz');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      return result;
    },
  },
  { label: 'in-process route', convert: (compressed, options = {}) => convertFile(compressed, 'tar.xz', 'tar', options, 'payload.tar.xz') },
];

let workDir = '';
let spy: SevenZipSpy;

function xz(tar: Buffer): Buffer {
  return execFileSync('xz', ['-1', '-c'], { input: tar, maxBuffer: 256 * MIB });
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-tar-rewrite-'));
  spy = createSevenZipSpy(workDir);
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  spy.reset();
  spy.install();
});

afterEach(() => {
  spy.restore();
});

describe.each(ROUTES)('$label writes a new tar from the vetted entries', (route) => {
  oracleTest(
    'reads a name the way a tar tool does when a GNU-magic header carries a prefix, instead of handing the header on',
    [...TOOLS],
    async () => {
      // bsdtar and GNU tar ignore the prefix under the GNU magic; Python's tarfile joins it. The converted tar must
      // not leave that choice to the next reader.
      const tar = Buffer.concat([
        hostileTarMember({ name: 'x.txt', magic: 'ustar ', version: ' \0', prefix: '../../escape' }, Buffer.from('hello')),
        hostileTarEnd(),
      ]);
      expect(pythonTarEntries(tar).map((entry) => entry.name)).toEqual(['../../escape/x.txt']);

      const result = await route.convert(xz(tar));

      expect(pythonTarEntries(result.buffer).map((entry) => entry.name)).toEqual(['x.txt']);
      expect(pythonTarMember(result.buffer, 'x.txt').toString()).toBe('hello');
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'leaves out whatever follows the end-of-archive blocks',
    [...TOOLS],
    async () => {
      const tar = Buffer.concat([
        hostileTarMember({ name: 'a.txt' }, Buffer.from('visible')),
        hostileTarEnd(),
        hostileTarMember({ name: '../../hidden.txt' }, Buffer.from(HIDDEN_MARKER)),
        hostileTarEnd(),
      ]);
      expect(pythonTarEntries(tar, { ignoreZeros: true }).map((entry) => entry.name)).toEqual(['a.txt', '../../hidden.txt']);

      const result = await route.convert(xz(tar));

      expect(pythonTarEntries(result.buffer, { ignoreZeros: true }).map((entry) => entry.name)).toEqual(['a.txt']);
      expect(result.buffer.includes(HIDDEN_MARKER)).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'refuses a tar with more entries than the limit',
    [...TOOLS],
    async () => {
      const members: Buffer[] = [];
      // Random names keep the compressed tar far enough from the 100:1 ratio cap that the entry count is what trips.
      for (let index = 0; index <= MAX_ENTRIES; index++) members.push(hostileTarMember({ name: crypto.randomBytes(24).toString('hex') }));
      members.push(hostileTarEnd());
      await expect(route.convert(xz(Buffer.concat(members)))).rejects.toThrow(/Archive bomb detected: file count/);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'applies the collision policy to a repeated name',
    [...TOOLS],
    async () => {
      const tar = Buffer.concat([
        hostileTarMember({ name: 'dup.txt' }, Buffer.from('first')),
        hostileTarMember({ name: 'dup.txt' }, Buffer.from('second')),
        hostileTarEnd(),
      ]);
      await expect(route.convert(xz(tar), { collisionPolicy: 'error' })).rejects.toMatchObject({ name: 'ArchiveEntryCollisionError' });

      const result = await route.convert(xz(tar), { collisionPolicy: 'overwrite' });

      expect(pythonTarEntries(result.buffer).map((entry) => entry.name)).toEqual(['dup.txt']);
      expect(pythonTarMember(result.buffer, 'dup.txt').toString()).toBe('second');
    },
    TEST_TIMEOUT_MS
  );

});

describe('native route: links and modes', () => {
  oracleTest(
    'writes modes without the setuid, setgid and sticky bits',
    [...TOOLS],
    async () => {
      const tar = Buffer.concat([
        hostileTarMember({ name: 'tool', mode: SETUID_MODE }, Buffer.from('#!/bin/sh\n')),
        hostileTarMember({ name: 'tmp', typeflag: '5', mode: 0o1777 }),
        hostileTarEnd(),
      ]);
      expect(pythonTarEntries(tar).map((entry) => entry.mode)).toEqual([SETUID_MODE, 0o1777]);

      const result = await ROUTES[0].convert(xz(tar));

      expect(pythonTarEntries(result.buffer).map((entry) => [entry.name, entry.mode])).toEqual([
        ['tool', 0o755],
        ['tmp', 0o777],
      ]);
    },
    TEST_TIMEOUT_MS
  );
  oracleTest(
    'applies skipLinks: the link is left out and named, the other member stays',
    [...TOOLS],
    async () => {
      const tar = fs.readFileSync(
        buildTarWithEntries(path.join(workDir, 'links.tar'), [
          { name: 'ok.txt', data: 'fine' },
          { name: 'escape', kind: 'symlink', target: '/etc' },
        ])
      );
      await expect(ROUTES[0].convert(xz(tar))).rejects.toMatchObject({ name: 'UnsafeArchiveError', reason: 'link-entry' });

      const result = await ROUTES[0].convert(xz(tar), { skipLinks: true });

      expect(pythonTarEntries(result.buffer).map((entry) => [entry.name, entry.type])).toEqual([['ok.txt', '0']]);
      expect(result.skippedLinks).toEqual(['escape']);
    },
    TEST_TIMEOUT_MS
  );
});

describe('native route: a payload whose first header is a valid tar header', () => {
  const V7 = { magic: '', version: '' } as const;

  oracleTest(
    'is read as a tar when it has no ustar magic and is well formed',
    [...TOOLS],
    async () => {
      const tar = Buffer.concat([hostileTarMember({ name: 'old.txt', ...V7 }, Buffer.from('v7 body')), hostileTarEnd()]);
      const result = await ROUTES[0].convert(xz(tar));
      expect(pythonTarEntries(result.buffer).map((entry) => entry.name)).toEqual(['old.txt']);
      expect(pythonTarMember(result.buffer, 'old.txt').toString()).toBe('v7 body');
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'fails with the unreadable-archive error when it has no ustar magic and is cut short, instead of being wrapped as data',
    [...TOOLS],
    async () => {
      const cut = Buffer.concat([hostileTarHeader({ name: 'old.txt', size: 4096, ...V7 }), Buffer.from('only a few bytes')]);
      await expect(ROUTES[0].convert(xz(cut))).rejects.toMatchObject({
        name: 'UnreadableArchiveError',
        message: expect.stringMatching(/the tar inside it is malformed/),
      });
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'keeps the archive-bomb error when the size it declares is over the cap',
    [...TOOLS],
    async () => {
      const bomb = Buffer.concat([hostileTarHeader({ name: 'huge.bin', size: 600 * MIB, ...V7 }), Buffer.alloc(4096)]);
      const outcome = await ROUTES[0].convert(xz(bomb)).then(
        () => null,
        (error: unknown) => error as Error
      );
      expect(outcome).not.toBeNull();
      expect(outcome?.name).not.toBe('UnreadableArchiveError');
      expect(outcome?.message).toMatch(/Archive bomb detected/);
    },
    TEST_TIMEOUT_MS
  );
});
