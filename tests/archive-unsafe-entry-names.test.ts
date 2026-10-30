import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  convertArchive,
  extract7zArchive,
  extractRarArchive,
  extractTarArchive,
  inspectArchive,
  sanitizeArchivePath,
} from '../src/lib/conversions/archive';
import { UnsafeArchiveError, type UnsafeArchiveReason } from '../src/lib/conversions/archive-extraction-safety';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { pythonTarEntries } from './helpers/hostile-tar';
import { buildStoredRar4 } from './helpers/rar4-stored';
import { craftSevenZip } from './helpers/seven-zip-craft';
import { END_OF_ARCHIVE, craftEntry, craftPaxHeader, paxRecordBytes } from './helpers/tar-craft';

/**
 * Entry names that are not plain relative paths are refused in tar, 7z and RAR archives, as they are in ZIP, and never
 * rewritten into a path the archive did not state. The reference is libarchive, which refuses a `..` component and an
 * absolute path when it extracts (ARCHIVE_EXTRACT_SECURE_NODOTDOT and ARCHIVE_EXTRACT_SECURE_NOABSOLUTEPATHS in
 * archive_write_disk_posix.c). The archives are written byte by byte, because the tools that write archives refuse
 * these names, and the names they hold are read back by an independent lister (tar, 7-Zip or Python's tarfile).
 */
const TEST_TIMEOUT_MS = 120_000;
const LONG_NAME_FILLER = 'x'.repeat(120);
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

interface UnsafeName {
  label: string;
  name: string;
  reason: UnsafeArchiveReason;
  /** The RAR 4 file header stores Latin-1 and a line break splits a listing, so only plain ASCII names are written there. */
  inRar: boolean;
}

const UNSAFE_NAMES: UnsafeName[] = [
  { label: 'parent traversal', name: '../evil.txt', reason: 'path-traversal', inRar: true },
  { label: 'traversal inside the path', name: 'a/../b.txt', reason: 'path-traversal', inRar: true },
  { label: 'absolute path', name: '/etc/evil.txt', reason: 'absolute-path', inRar: true },
  { label: 'drive letter', name: 'C:\\evil.txt', reason: 'absolute-path', inRar: true },
  { label: 'backslash-rooted path', name: '\\evil.txt', reason: 'absolute-path', inRar: true },
  { label: 'backslash traversal', name: '..\\evil.txt', reason: 'path-traversal', inRar: true },
  { label: 'fullwidth full stops that fold to a traversal', name: '\uFF0E\uFF0E/evil.txt', reason: 'path-traversal', inRar: false },
  { label: 'fullwidth solidus that folds to a traversal', name: '..\uFF0Fevil.txt', reason: 'path-traversal', inRar: false },
  { label: 'line break', name: 'a\nb.txt', reason: 'invalid-entry-name', inRar: false },
];

const BODY = Buffer.from('payload');
let workDir = '';

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unsafe-entry-names-'));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

type TarVariant = 'ustar' | 'gnu-long-name' | 'pax-long-path';

/** A tar whose second member is stored under `name`, in the header field, a GNU long-name record or a pax `path` record. */
function tarWithMember(variant: TarVariant, name: string): Buffer {
  const first = craftEntry('ok.txt', 'fine');
  switch (variant) {
    case 'ustar':
      return Buffer.concat([first, craftEntry(name, BODY), END_OF_ARCHIVE]);
    case 'gnu-long-name':
      return Buffer.concat([first, craftEntry('././@LongLink', Buffer.from(`${name}${LONG_NAME_FILLER}\0`), 'L'), craftEntry('short.txt', BODY), END_OF_ARCHIVE]);
    case 'pax-long-path':
      return Buffer.concat([first, craftPaxHeader('x', paxRecordBytes('path', `${name}${LONG_NAME_FILLER}`)), craftEntry('short.txt', BODY), END_OF_ARCHIVE]);
  }
}

/** The name a variant stores, which is what the message of a refusal has to carry. */
function storedName(variant: TarVariant, name: string): string {
  return variant === 'ustar' ? name : `${name}${LONG_NAME_FILLER}`;
}

function sevenZipWithMember(name: string): Buffer {
  return craftSevenZip([
    { name: 'ok.txt', data: Buffer.from('fine') },
    { name, data: BODY },
  ]);
}

function rarWithMember(name: string): Buffer {
  return buildStoredRar4([
    { name: 'ok.txt', data: Buffer.from('fine') },
    { name, data: BODY },
  ]);
}

function write(label: string, bytes: Buffer): string {
  const file = path.join(workDir, label);
  fs.writeFileSync(file, bytes);
  return file;
}

/** Names a lister that is not the code under test finds in a tar: the system tar for plain ASCII (it escapes a backslash in its listing), Python's tarfile otherwise. */
function independentTarNames(tar: Buffer, label: string, expected: string): string[] {
  if (PRINTABLE_ASCII.test(expected) && !expected.includes('\\')) {
    return execFileSync(getOracleToolPath('tar') as string, ['-tf', write(`${label}.tar`, tar)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C.UTF-8' } })
      .split('\n')
      .filter((line) => line !== '');
  }
  return pythonTarEntries(tar).map((entry) => entry.name);
}

/** Paths 7-Zip lists, with the backslashes it turns into separators put back to one spelling. */
function sevenZipNames(archive: Buffer, label: string, extension: string): string[] {
  return execFileSync(getOracleToolPath('7z') as string, ['l', '-slt', '-ba', write(`${label}.${extension}`, archive)], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.startsWith('Path = '))
    .map((line) => line.slice('Path = '.length));
}

function slashes(name: string): string {
  return name.replaceAll('\\', '/');
}

async function refusal(run: Promise<unknown>): Promise<UnsafeArchiveError> {
  const error = await run.then(
    () => null,
    (thrown: unknown) => thrown
  );
  expect(error).toBeInstanceOf(UnsafeArchiveError);
  return error as UnsafeArchiveError;
}

describe('tar entries with an unsafe name are refused', () => {
  for (const variant of ['ustar', 'gnu-long-name', 'pax-long-path'] as const) {
    for (const unsafe of UNSAFE_NAMES) {
      oracleTest(
        `${variant}: ${unsafe.label}`,
        ['tar', 'python3'],
        async () => {
          const stored = storedName(variant, unsafe.name);
          const tar = tarWithMember(variant, unsafe.name);
          expect(independentTarNames(tar, `${variant}-${unsafe.reason}`, stored)).toContain(stored);

          const error = await refusal(convertArchive(tar, 'tar', 'zip', {}, 'hostile.tar'));
          expect(error.reason).toBe(unsafe.reason);
          if (!/[\r\n]/.test(unsafe.name)) expect(error.message).toContain(stored);
          expect(() => extractTarArchive(tar)).toThrow(UnsafeArchiveError);
        },
        TEST_TIMEOUT_MS
      );
    }
  }

  it('refuses the archive instead of leaving out the unsafe member', async () => {
    const tar = tarWithMember('ustar', '../evil.txt');
    await expect(convertArchive(tar, 'tar', 'tar', {}, 'hostile.tar')).rejects.toBeInstanceOf(UnsafeArchiveError);
  });
});

describe('7z entries with an unsafe name are refused', () => {
  for (const unsafe of UNSAFE_NAMES) {
    oracleTest(
      unsafe.label,
      ['7z'],
      async () => {
        const archive = sevenZipWithMember(unsafe.name);
        if (!/[\r\n]/.test(unsafe.name)) {
          expect(sevenZipNames(archive, `seven-${unsafe.reason}`, '7z').map(slashes)).toContain(slashes(unsafe.name));
        }

        const error = await refusal(convertArchive(archive, '7z', 'zip', {}, 'hostile.7z'));
        expect(error.reason).toBe(unsafe.reason);
        if (!/[\r\n]/.test(unsafe.name)) expect(error.message).toContain(unsafe.name);
        expect(() => extract7zArchive(archive)).toThrow(UnsafeArchiveError);
      },
      TEST_TIMEOUT_MS
    );
  }
});

describe('RAR entries with an unsafe name are refused', () => {
  for (const unsafe of UNSAFE_NAMES.filter((candidate) => candidate.inRar)) {
    oracleTest(
      unsafe.label,
      ['7z'],
      async () => {
        const archive = rarWithMember(unsafe.name);
        expect(sevenZipNames(archive, `rar-${unsafe.reason}`, 'rar').map(slashes)).toContain(slashes(unsafe.name));
        const unrar = getOracleToolPath('unrar');
        if (unrar !== null) {
          const listed = execFileSync(unrar, ['lb', write(`rar-unrar-${unsafe.reason}.rar`, archive)], { encoding: 'utf8' }).split('\n');
          expect(listed.map(slashes)).toContain(slashes(unsafe.name));
        }

        const error = await refusal(convertArchive(archive, 'rar', 'zip', {}, 'hostile.rar'));
        expect(['path-traversal', 'absolute-path']).toContain(error.reason);
        expect(error.message).toContain(slashes(unsafe.name));
        expect(() => extractRarArchive(archive)).toThrow(UnsafeArchiveError);
      },
      TEST_TIMEOUT_MS
    );
  }
});

describe('sanitizeArchivePath and tar inspection', () => {
  function reasonOf(name: string): string | undefined {
    try {
      sanitizeArchivePath(name);
    } catch (error) {
      return error instanceof UnsafeArchiveError ? error.reason : undefined;
    }
    return undefined;
  }

  it('refuses the names it used to rewrite, and says why', () => {
    expect(reasonOf('../../etc/passwd')).toBe('path-traversal');
    expect(reasonOf('..\\..\\windows\\system32\\cmd.exe')).toBe('path-traversal');
    expect(reasonOf('C:\\Users\\admin\\secrets.txt')).toBe('absolute-path');
    expect(reasonOf('/absolute/root/file.txt')).toBe('absolute-path');
    expect(reasonOf('////multiple/slashes/file.txt')).toBe('absolute-path');
    expect(reasonOf('..')).toBe('path-traversal');
    expect(reasonOf('')).toBe('invalid-entry-name');
    for (const unsafe of UNSAFE_NAMES) expect(reasonOf(unsafe.name), unsafe.label).toBe(unsafe.reason);
  });

  it('keeps the spelling of a safe name apart from the separators and the current-directory parts it has always dropped', () => {
    expect(sanitizeArchivePath('docs/a.txt')).toBe('docs/a.txt');
    expect(sanitizeArchivePath('./docs//a.txt')).toBe('docs/a.txt');
    expect(sanitizeArchivePath('docs\\a.txt')).toBe('docs/a.txt');
    expect(sanitizeArchivePath('.')).toBeNull();
  });

  oracleTest(
    'a tar inspection reports an unsafe name as it is stored and marks the archive unextractable',
    ['tar'],
    async () => {
      const report = await inspectArchive(tarWithMember('ustar', '../evil.txt'), { filename: 'hostile.tar' });
      expect(report.entries.map((entry) => entry.name)).toEqual(['ok.txt', '../evil.txt']);
      expect(report.entries[1]).toMatchObject({ unsafePath: true });
      expect(report.extractable).toBe(false);
    },
    TEST_TIMEOUT_MS
  );
});

describe('safe names are kept and ordinary archives convert byte for byte as before', () => {
  const SAFE_TAR = Buffer.concat([craftEntry('a.txt', 'alpha'), craftEntry('dir/b.txt', 'bravo'), craftEntry('./c.txt', 'charlie'), END_OF_ARCHIVE]);
  const SAFE_SEVEN_ZIP = craftSevenZip([
    { name: 'a.txt', data: Buffer.from('alpha') },
    { name: 'dir/b.txt', data: Buffer.from('bravo') },
  ]);
  const SAFE_RAR = buildStoredRar4([
    { name: 'a.txt', data: Buffer.from('alpha') },
    { name: 'dir/b.txt', data: Buffer.from('bravo') },
  ]);
  const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
  const SEVEN_ZIP_AND_RAR_TAR = 'fa8eab2a4bfbfeca9adadb62951b696da2e47b87efd9a4c3a0d6ba66cb2f2816';

  it('writes the same tar for each source as the readers wrote before the names were checked', async () => {
    expect(sha256((await convertArchive(SAFE_TAR, 'tar', 'tar', {}, 'ordinary.tar')).buffer)).toBe('0bf56c43a3de1ab8247169e5b78652a0f33daeca85086ed53107927c5191f3c3');
    expect(sha256((await convertArchive(SAFE_SEVEN_ZIP, '7z', 'tar', {}, 'ordinary.7z')).buffer)).toBe(SEVEN_ZIP_AND_RAR_TAR);
    expect(sha256((await convertArchive(SAFE_RAR, 'rar', 'tar', {}, 'ordinary.rar')).buffer)).toBe(SEVEN_ZIP_AND_RAR_TAR);
  });

  oracleTest(
    'lists the members of a converted ordinary archive under their own names',
    ['7z'],
    async () => {
      const expected = ['a.txt', 'c.txt', 'dir/b.txt'];
      const fromTar = await convertArchive(SAFE_TAR, 'tar', 'zip', {}, 'ordinary.tar');
      expect(sevenZipNames(fromTar.buffer, 'ordinary-tar', 'zip').filter((name) => !name.endsWith('/') && name !== 'dir').sort()).toEqual(expected);
      for (const [source, archive] of [['7z', SAFE_SEVEN_ZIP], ['rar', SAFE_RAR]] as const) {
        const converted = await convertArchive(archive, source, 'zip', {}, `ordinary.${source}`);
        expect(sevenZipNames(converted.buffer, `ordinary-${source}`, 'zip').filter((name) => !name.endsWith('/') && name !== 'dir').sort()).toEqual(['a.txt', 'dir/b.txt']);
      }
    },
    TEST_TIMEOUT_MS
  );
});
