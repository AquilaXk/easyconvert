import { afterAll, afterEach, beforeAll, beforeEach, describe, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertWithNative7z } from '../src/worker/engines';
import { getOracleToolPath } from './helpers/differential-oracle';
import { hostileTarEnd, hostileTarMember } from './helpers/hostile-tar';
import { oracleTest } from './helpers/oracle-test';
import { createSevenZipSpy, type SevenZipSpy } from './helpers/seven-zip-spy';

/**
 * tar to 7z writes the tar's members to a staging tree for 7-Zip to pack. The tar is hostile in two ways a tree
 * cannot hold (a name used both as a file and as a directory), and its modes are untrusted. The 7z that comes out is
 * read by 7-Zip itself (`7z l -slt`), which reports the attribute string it stores for each member.
 */
const TOOLS = ['7z'] as const;
const TEST_TIMEOUT_MS = 120_000;
const DIRECTORY_TYPE = '5';

let workDir = '';
let spy: SevenZipSpy;

function tarOf(...members: Buffer[]): Buffer {
  return Buffer.concat([...members, hostileTarEnd()]);
}

/** The kind (`D` directory, `F` file) and the Unix mode string 7-Zip stores for every member, by name. The Windows read-only flag it derives from the mode is left out. */
function storedAttributes(archive: Buffer, label: string): Map<string, string> {
  const file = path.join(workDir, `${label}.7z`);
  fs.writeFileSync(file, archive);
  const attributes = new Map<string, string>();
  for (const block of execFileSync(getOracleToolPath('7z') as string, ['l', '-slt', '-ba', file], { encoding: 'utf8' }).split('\n\n')) {
    const fields = new Map(block.split('\n').flatMap((line) => (line.includes(' = ') ? [[line.slice(0, line.indexOf(' = ')), line.slice(line.indexOf(' = ') + 3)] as [string, string]] : [])));
    if (fields.has('Path')) {
      const [flags, mode] = (fields.get('Attributes') as string).split(' ');
      attributes.set(fields.get('Path') as string, `${flags.includes('D') ? 'D' : 'F'} ${mode}`);
    }
  }
  return attributes;
}

async function toSevenZip(tar: Buffer, options: Record<string, unknown> = {}): Promise<Buffer> {
  const result = await convertWithNative7z(tar, 'tar', '7z', options, 'staging.tar');
  if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
  return result.buffer;
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tar-to-seven-zip-staging-'));
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

describe('a name used both as a file and as a directory', () => {
  const FILE = hostileTarMember({ name: 'a' }, Buffer.from('file a'));
  const CHILD = hostileTarMember({ name: 'a/b' }, Buffer.from('child'));
  const DIRECTORY = hostileTarMember({ name: 'a/', typeflag: DIRECTORY_TYPE });

  const CASES: Array<[string, Buffer[], Record<string, unknown>]> = [
    ['a file, then an entry below it', [FILE, CHILD], {}],
    ['an entry below a name, then a file with that name', [CHILD, FILE], {}],
    ['a directory, then a file with its name, when overwriting is allowed', [DIRECTORY, FILE], { collisionPolicy: 'overwrite' }],
    ['a file, then a directory with its name, when overwriting is allowed', [FILE, DIRECTORY], { collisionPolicy: 'overwrite' }],
  ];

  for (const [label, members, options] of CASES) {
    oracleTest(
      `${label} is refused with the malformed-listing error, before anything is staged or packed`,
      [...TOOLS],
      async () => {
        const outcome = await toSevenZip(tarOf(...members), options).then(
          () => null,
          (error: unknown) => error
        );
        expect(outcome).toMatchObject({ name: 'UnsafeArchiveError', reason: 'malformed-listing' });
        expect(spy.calls()).toHaveLength(0);
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'a file repeated under overwrite stays one member holding the last bytes',
    [...TOOLS],
    async () => {
      const archive = await toSevenZip(tarOf(hostileTarMember({ name: 'a' }, Buffer.from('first')), hostileTarMember({ name: 'a' }, Buffer.from('second'))), {
        collisionPolicy: 'overwrite',
      });
      const file = path.join(workDir, 'repeat.7z');
      fs.writeFileSync(file, archive);
      expect([...storedAttributes(archive, 'repeat').keys()]).toEqual(['a']);
      expect(execFileSync(getOracleToolPath('7z') as string, ['x', '-so', '-y', file], { encoding: 'utf8' })).toBe('second');
    },
    TEST_TIMEOUT_MS
  );
});

describe('the modes of the members', () => {
  oracleTest(
    'are kept in the 7z, including a read-only file and a read-only directory, and the staging tree is still removed',
    [...TOOLS],
    async () => {
      const tar = tarOf(
        hostileTarMember({ name: 'locked', typeflag: DIRECTORY_TYPE, mode: 0o555 }),
        hostileTarMember({ name: 'locked/readonly.txt', mode: 0o444 }, Buffer.from('r')),
        hostileTarMember({ name: 'locked/exec.sh', mode: 0o755 }, Buffer.from('x')),
        hostileTarMember({ name: 'private.txt', mode: 0o600 }, Buffer.from('p')),
        hostileTarMember({ name: 'shared.txt', mode: 0o664 }, Buffer.from('s'))
      );
      const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('easyconvert-7z-'));

      const attributes = storedAttributes(await toSevenZip(tar), 'kept-modes');

      expect(Object.fromEntries(attributes)).toEqual({
        locked: 'D dr-xr-xr-x',
        'locked/readonly.txt': 'F -r--r--r--',
        'locked/exec.sh': 'F -rwxr-xr-x',
        'private.txt': 'F -rw-------',
        'shared.txt': 'F -rw-rw-r--',
      });
      expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('easyconvert-7z-'))).toEqual(before);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'carry no setuid, setgid or sticky bit into the 7z',
    [...TOOLS],
    async () => {
      const tar = tarOf(
        hostileTarMember({ name: 'suid', mode: 0o4755 }, Buffer.from('s')),
        hostileTarMember({ name: 'tmp', typeflag: DIRECTORY_TYPE, mode: 0o1777 })
      );
      const attributes = storedAttributes(await toSevenZip(tar), 'no-special-bits');
      expect(Object.fromEntries(attributes)).toEqual({ suid: 'F -rwxr-xr-x', tmp: 'D drwxrwxrwx' });
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'differ from the tar only where 7-Zip could not pack the member otherwise: the owner always keeps read access (and search on a directory)',
    [...TOOLS],
    async () => {
      const tar = tarOf(
        hostileTarMember({ name: 'sealed', typeflag: DIRECTORY_TYPE, mode: 0o000 }),
        hostileTarMember({ name: 'sealed/nothing.txt', mode: 0o000 }, Buffer.from('n')),
        hostileTarMember({ name: 'write-only.txt', mode: 0o200 }, Buffer.from('w'))
      );
      const attributes = storedAttributes(await toSevenZip(tar), 'raised-modes');
      expect(Object.fromEntries(attributes)).toEqual({
        sealed: 'D dr-x------',
        'sealed/nothing.txt': 'F -r--------',
        'write-only.txt': 'F -rw-------',
      });
    },
    TEST_TIMEOUT_MS
  );
});
