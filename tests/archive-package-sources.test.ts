import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { oracleTest } from './helpers/oracle-test';
import { ConversionFailedError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { fileDigests, readArchiveTree, unpackWith } from './helpers/archive-output-tree';
import { hostileTarEnd, hostileTarHeader, hostileTarMember, type HostileTarHeader } from './helpers/hostile-tar';

/**
 * Packages and disk images convert to the files they hold. An rpm carries a cpio and a deb a tar (`data.tar`), usually
 * compressed; converting the package to another archive converts those installed files, with every layer vetted like any
 * other archive. Symbolic links, which every real package and disk image has, are left out and reported, never followed
 * and never a reason to refuse the file; hard links between the files of the package keep their content.
 *
 * The inputs are real packages built by rpmbuild and dpkg-deb, and a disk image written by the macOS disk utility
 * (tests/fixtures/archive-sources/PROVENANCE). The expected files are the literals the packages were built from, and the
 * unpackers of the distributions (rpm2cpio with cpio, dpkg-deb) must agree with those literals: no expectation is read
 * back from the converter.
 */

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'archive-sources');
const ENGINE_TIMEOUT_MS = 120_000;
const BYTE_VALUES = 256;
const TARGETS = ['zip', 'tar', 'tar.gz', 'tar.bz2', '7z'] as const;
const MIB = 1024 * 1024;

const HELLO = Buffer.from('hello archive\n');
const NESTED = Buffer.from('nested file\n');
const DATA_BIN = Buffer.from(Array.from({ length: BYTE_VALUES }, (_unused, index) => index));

const fixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURE_DIR, name));

/** What `links.*.rpm` and `links.*.deb` install: `hard.txt` and `hello.txt` are hard links of one file, `link.txt` points at `hello.txt`. */
const LINKS_PACKAGE_FILES: Readonly<Record<string, Buffer>> = {
  'opt/pkg/hello.txt': HELLO,
  'opt/pkg/hard.txt': HELLO,
  'opt/pkg/dir/nested.txt': NESTED,
  'opt/pkg/dir/data.bin': DATA_BIN,
};
const LINKS_PACKAGE_SYMLINK = 'opt/pkg/link.txt';

/** What `probe.rpm` and `probe.deb` install. */
const PROBE_PACKAGE_FILES: Readonly<Record<string, Buffer>> = {
  'opt/probe/hello.txt': HELLO,
  'opt/probe/dir/nested.txt': NESTED,
  'opt/probe/dir/data.bin': DATA_BIN,
};

function digestsOf(files: Readonly<Record<string, Buffer>>): Record<string, string> {
  return fileDigests(new Map(Object.entries(files)));
}

interface PackageFixture {
  file: string;
  format: 'rpm' | 'deb';
  files: Readonly<Record<string, Buffer>>;
  symlink: string | null;
}

const PACKAGES: PackageFixture[] = [
  { file: 'links.xz.rpm', format: 'rpm', files: LINKS_PACKAGE_FILES, symlink: LINKS_PACKAGE_SYMLINK },
  { file: 'links.zst.rpm', format: 'rpm', files: LINKS_PACKAGE_FILES, symlink: LINKS_PACKAGE_SYMLINK },
  { file: 'links.xz.deb', format: 'deb', files: LINKS_PACKAGE_FILES, symlink: LINKS_PACKAGE_SYMLINK },
  { file: 'links.zst.deb', format: 'deb', files: LINKS_PACKAGE_FILES, symlink: LINKS_PACKAGE_SYMLINK },
  { file: 'probe.rpm', format: 'rpm', files: PROBE_PACKAGE_FILES, symlink: null },
  { file: 'probe.deb', format: 'deb', files: PROBE_PACKAGE_FILES, symlink: null },
];

function unpackPackage(pkg: PackageFixture, outDir: string): void {
  const file = path.join(FIXTURE_DIR, pkg.file);
  if (pkg.format === 'deb') {
    execFileSync(requireOracleTool('dpkg-deb'), ['-x', file, outDir]);
    return;
  }
  const payload = execFileSync(requireOracleTool('rpm2cpio'), [file], { maxBuffer: 64 * MIB });
  execFileSync(requireOracleTool('cpio'), ['--quiet', '-idm', '--no-absolute-filenames'], { cwd: outDir, input: payload });
}

describe('the files an rpm or a deb installs', () => {
  for (const pkg of PACKAGES) {
    oracleTest(
      `${pkg.file}: the unpackers of the distributions install the files the package was built from`,
      [pkg.format === 'deb' ? 'dpkg-deb' : 'rpm2cpio', 'cpio'],
      () => {
        const installed = unpackWith((outDir) => unpackPackage(pkg, outDir));
        expect(fileDigests(installed.files)).toEqual(digestsOf(pkg.files));
        expect([...installed.links.keys()]).toEqual(pkg.symlink === null ? [] : [pkg.symlink]);
      }
    );
  }
});

describe('rpm and deb sources convert to the files they install', () => {
  for (const pkg of PACKAGES) {
    for (const target of TARGETS) {
      oracleTest(
        `${pkg.file} to ${target} holds the installed files and reports the symbolic link it leaves out`,
        ['7z', 'tar'],
        async () => {
          const result = await dispatchConversion(fixture(pkg.file), pkg.format, target, {}, pkg.file);
          const output = await readArchiveTree(result.buffer, target);
          expect(fileDigests(output.files)).toEqual(digestsOf(pkg.files));
          expect([...output.links.keys()]).toEqual([]);
          const reported = (result.skippedLinks ?? []).map((name) => name.replace(/^\.\//, ''));
          expect(reported).toEqual(pkg.symlink === null ? [] : [pkg.symlink]);
        },
        ENGINE_TIMEOUT_MS
      );
    }
  }

  oracleTest(
    'the output of a package equals what the distribution unpackers install, for every package and target',
    ['7z', 'tar', 'rpm2cpio', 'cpio', 'dpkg-deb'],
    async () => {
      for (const pkg of PACKAGES) {
        const installed = unpackWith((outDir) => unpackPackage(pkg, outDir));
        for (const target of TARGETS) {
          const result = await dispatchConversion(fixture(pkg.file), pkg.format, target, {}, pkg.file);
          const output = await readArchiveTree(result.buffer, target);
          expect(fileDigests(output.files), `${pkg.file} to ${target}`).toEqual(fileDigests(installed.files));
        }
      }
    },
    ENGINE_TIMEOUT_MS
  );

  for (const format of ['rpm', 'deb'] as const) {
    oracleTest(
      `an empty .${format} (a package that installs no files) converts to an empty archive, not a refusal`,
      ['7z', 'tar'],
      async () => {
        for (const target of TARGETS) {
          const result = await dispatchConversion(fixture(`empty.xz.${format}`), format, target, {}, `empty.${format}`);
          const output = await readArchiveTree(result.buffer, target);
          expect([...output.files.keys(), ...output.links.keys()], target).toEqual([]);
        }
      },
      ENGINE_TIMEOUT_MS
    );
  }

  oracleTest(
    'selecting entries of an rpm applies to the installed files',
    ['7z', 'tar'],
    async () => {
      const result = await dispatchConversion(fixture('links.xz.rpm'), 'rpm', 'zip', { entries: ['opt/pkg/dir/*'] }, 'links.rpm');
      const output = await readArchiveTree(result.buffer, 'zip');
      expect(fileDigests(output.files)).toEqual(digestsOf({ 'opt/pkg/dir/nested.txt': NESTED, 'opt/pkg/dir/data.bin': DATA_BIN }));
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'a caller who sets skipLinks to false still gets the refusal of an archive that holds a link',
    ['7z'],
    async () => {
      const failure = await dispatchConversion(fixture('links.xz.rpm'), 'rpm', 'zip', { skipLinks: false }, 'links.rpm').catch((err: unknown) => err);
      expect(failure).toMatchObject({ name: 'UnsafeArchiveError', reason: 'link-entry' });
    },
    ENGINE_TIMEOUT_MS
  );
});

describe('a disk image converts to the files on its volume', () => {
  oracleTest(
    'a dmg with symbolic links converts to its files; the links are left out and reported',
    ['7z', 'tar'],
    async () => {
      const volume: Record<string, Buffer> = {
        'PROBE/hello.txt': HELLO,
        'PROBE/dir/nested.txt': NESTED,
        'PROBE/dir/data.bin': DATA_BIN,
      };
      for (const target of TARGETS) {
        const result = await dispatchConversion(fixture('links.dmg'), 'dmg', target, {}, 'links.dmg');
        const output = await readArchiveTree(result.buffer, target);
        // The macOS disk utility that wrote the image tagged each file with a provenance attribute; 7-Zip hands out
        // such an HFS+ attribute as a file named `<file>:<attribute>`, which are the only other entries.
        const streams = [...output.files.keys()].filter((name) => name.includes(':'));
        for (const name of streams) output.files.delete(name);
        expect(fileDigests(output.files), target).toEqual(digestsOf(volume));
        expect(streams.every((name) => name.endsWith(':com.apple.provenance')), target).toBe(true);
        expect([...output.links.keys()], target).toEqual([]);
        expect([...(result.skippedLinks ?? [])].sort(), target).toEqual(['PROBE/Applications', 'PROBE/dir/up-link.txt', 'PROBE/link.txt']);
      }
    },
    ENGINE_TIMEOUT_MS
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// Hostile packages: the layer inside the package gets the same vetting as an archive uploaded on its own.
// ---------------------------------------------------------------------------------------------------------------------

const AR_MAGIC = '!<arch>\n';

/** A deb: an ar archive of `debian-binary`, a control tar and the data tar (of any compression, named by the caller). */
function buildDeb(dataMemberName: string, data: Buffer): Buffer {
  const control = Buffer.concat([hostileTarMember({ name: 'control' }, Buffer.from('Package: hostile\nVersion: 1\n')), hostileTarEnd()]);
  const members = [
    { name: 'debian-binary', data: Buffer.from('2.0\n') },
    { name: 'control.tar', data: control },
    { name: dataMemberName, data },
  ];
  const parts: Buffer[] = [Buffer.from(AR_MAGIC)];
  for (const member of members) {
    const header = `${(member.name + '/').padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'100644'.padEnd(8)}${String(member.data.length).padEnd(10)}\`\n`;
    parts.push(Buffer.from(header, 'latin1'), member.data);
    if (member.data.length % 2 === 1) parts.push(Buffer.from('\n'));
  }
  return Buffer.concat(parts);
}

function tarOf(...members: Array<[HostileTarHeader, string?]>): Buffer {
  return Buffer.concat([...members.map(([header, body]) => hostileTarMember(header, Buffer.from(body ?? ''))), hostileTarEnd()]);
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected a typed refusal but the conversion completed');
    },
    (err: unknown) => err
  );
}

const convertDeb = (deb: Buffer, options: Record<string, unknown> = {}): Promise<unknown> =>
  dispatchConversion(deb, 'deb', 'zip', options, 'hostile.deb');

describe('the payload of a package is vetted before anything is extracted', () => {
  oracleTest('a deb whose data tar climbs out of the extraction directory is refused', ['7z'], async () => {
    const deb = buildDeb('data.tar', tarOf([{ name: '../outside.txt' }, 'escaped']));
    expect(await refusal(convertDeb(deb))).toMatchObject({ name: 'UnsafeArchiveError', reason: 'path-traversal' });
  }, ENGINE_TIMEOUT_MS);

  oracleTest('a deb whose data tar holds an absolute path is refused', ['7z'], async () => {
    const deb = buildDeb('data.tar', tarOf([{ name: '/etc/outside.txt' }, 'escaped']));
    expect(await refusal(convertDeb(deb))).toMatchObject({ name: 'UnsafeArchiveError', reason: 'absolute-path' });
  }, ENGINE_TIMEOUT_MS);

  oracleTest('a deb whose data tar holds a device file is refused', ['7z'], async () => {
    const deb = buildDeb('data.tar', tarOf([{ name: 'dev/null', typeflag: '3' }]));
    expect(await refusal(convertDeb(deb))).toMatchObject({ name: 'UnsafeArchiveError', reason: 'special-entry' });
  }, ENGINE_TIMEOUT_MS);

  oracleTest('a deb that writes a file through a symbolic link it also holds is refused, not extracted', ['7z'], async () => {
    const deb = buildDeb(
      'data.tar',
      tarOf([{ name: 'bin', typeflag: '2' }], [{ name: 'bin/escape.txt' }, 'escaped'])
    );
    expect(await refusal(convertDeb(deb))).toMatchObject({ name: 'UnsafeArchiveError', reason: 'link-entry' });
  }, ENGINE_TIMEOUT_MS);

  oracleTest('a hard link to a file the package does not hold is left out and reported, and links nothing', ['7z', 'tar'], async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-hardlink-outside-'));
    try {
      const outside = path.join(outsideDir, 'canary.txt');
      fs.writeFileSync(outside, 'canary');
      const tarWithLink = Buffer.concat([
        hostileTarMember({ name: 'kept.txt' }, Buffer.from('kept')),
        hostileTarHeader({ name: 'stolen.txt', typeflag: '1', linkname: outside }),
        hostileTarEnd(),
      ]);
      const result = await dispatchConversion(buildDeb('data.tar', tarWithLink), 'deb', 'zip', {}, 'hostile.deb');
      const output = await readArchiveTree(result.buffer, 'zip');
      expect([...output.files.keys()]).toEqual(['kept.txt']);
      expect(result.skippedLinks).toEqual(['stolen.txt']);
      expect(fs.statSync(outside).nlink).toBe(1);
      expect(fs.readFileSync(outside, 'utf8')).toBe('canary');
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  }, ENGINE_TIMEOUT_MS);

  oracleTest('a deb whose compressed payload expands past the ratio cap is refused', ['7z', 'xz'], async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-bomb-'));
    try {
      const tarFile = path.join(dir, 'data.tar');
      fs.writeFileSync(tarFile, tarOf([{ name: 'zeros.bin' }, '\0'.repeat(6 * MIB)]));
      execFileSync(requireOracleTool('xz'), ['-9', '-k', tarFile]);
      const deb = buildDeb('data.tar.xz', fs.readFileSync(`${tarFile}.xz`));
      expect(deb.length).toBeLessThan(MIB / 8);
      expect(await refusal(convertDeb(deb))).toMatchObject({ name: 'UnsafeArchiveError', reason: 'compression-ratio' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, ENGINE_TIMEOUT_MS);

  oracleTest('a deb whose Zstandard payload expands past the ratio cap is refused', ['7z', 'zstd'], async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-zstd-bomb-'));
    try {
      const tarFile = path.join(dir, 'data.tar');
      fs.writeFileSync(tarFile, tarOf([{ name: 'zeros.bin' }, '\0'.repeat(6 * MIB)]));
      execFileSync(requireOracleTool('zstd'), ['-19', '-q', tarFile]);
      const deb = buildDeb('data.tar.zst', fs.readFileSync(`${tarFile}.zst`));
      expect(deb.length).toBeLessThan(MIB / 8);
      const failure = await refusal(convertDeb(deb));
      expect(failure).toBeInstanceOf(ConversionFailedError);
      expect((failure as { status?: number }).status ?? 400).toBeLessThan(500);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, ENGINE_TIMEOUT_MS);

  oracleTest('a deb whose payload is not a tar is refused as unreadable, not packed as it is', ['7z'], async () => {
    const deb = buildDeb('data.tar', Buffer.from('this is not a tar archive'.repeat(40)));
    const failure = await refusal(convertDeb(deb));
    expect(failure).toMatchObject({ name: 'UnreadableArchiveError' });
  }, ENGINE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------------------------------
// An rpm whose payload uses the stripped cpio headers (rpm 4.12 and later) lists no files in any reader but rpm itself.
// ---------------------------------------------------------------------------------------------------------------------

const RPM_LEAD_BYTES = 96;
const RPM_HEADER_MAGIC = Buffer.from([0x8e, 0xad, 0xe8, 0x01, 0, 0, 0, 0]);
const NEWC_FIELD_COUNT = 13;

function newcEntry(name: string, mode: number, data: Buffer = Buffer.alloc(0)): Buffer {
  const nameBytes = Buffer.from(`${name}\0`);
  const fields = [0, mode, 0, 0, 1, 0, data.length, 0, 0, 0, 0, nameBytes.length, 0];
  expect(fields).toHaveLength(NEWC_FIELD_COUNT);
  const head = Buffer.from(`070701${fields.map((value) => value.toString(16).toUpperCase().padStart(8, '0')).join('')}`);
  const pad = (length: number): Buffer => Buffer.alloc((4 - (length % 4)) % 4);
  const headAndName = Buffer.concat([head, nameBytes]);
  return Buffer.concat([headAndName, pad(headAndName.length), data, pad(data.length)]);
}

/** An rpm with empty signature and metadata headers around `payload` (7-Zip needs nothing more to open it). */
function buildRpm(payload: Buffer): Buffer {
  const lead = Buffer.alloc(RPM_LEAD_BYTES);
  Buffer.from([0xed, 0xab, 0xee, 0xdb, 3, 0]).copy(lead);
  lead.writeUInt16BE(1, 8);
  lead.write('hostile-1.0-1', 10, 'latin1');
  lead.writeUInt16BE(1, 76);
  lead.writeUInt16BE(5, 78);
  const emptyHeader = Buffer.concat([RPM_HEADER_MAGIC, Buffer.alloc(8)]);
  return Buffer.concat([lead, emptyHeader, emptyHeader, payload]);
}

describe('an rpm 7-Zip cannot list', () => {
  oracleTest('a payload of stripped cpio headers is refused as unreadable, not converted to an empty archive', ['7z'], async () => {
    const stripped = Buffer.concat([Buffer.from('07070X00000000\0\0'), Buffer.from('07070X00000001\0\0hello\n\0\0'), newcEntry('TRAILER!!!', 0)]);
    const failure = await dispatchConversion(buildRpm(stripped), 'rpm', 'zip', {}, 'stripped.rpm').catch((err: unknown) => err);
    expect(failure).toMatchObject({ name: 'UnreadableArchiveError' });
    expect((failure as Error).message).toMatch(/payload holds no entries/);
  }, ENGINE_TIMEOUT_MS);

  oracleTest('a plain cpio payload of an rpm converts to its files', ['7z', 'tar'], async () => {
    const payload = Buffer.concat([
      newcEntry('./opt', 0o040755),
      newcEntry('./opt/a.txt', 0o100644, Buffer.from('shared')),
      newcEntry('TRAILER!!!', 0),
    ]);
    const result = await dispatchConversion(buildRpm(payload), 'rpm', 'zip', {}, 'plain.rpm');
    const output = await readArchiveTree(result.buffer, 'zip');
    expect(fileDigests(output.files)).toEqual(digestsOf({ 'opt/a.txt': Buffer.from('shared') }));
  }, ENGINE_TIMEOUT_MS);
});

describe('a cpio source is vetted like the payload of an rpm', () => {
  oracleTest('a device file and a traversal name are refused', ['7z'], async () => {
    const device = Buffer.concat([newcEntry('dev-null', 0o020666), newcEntry('TRAILER!!!', 0)]);
    expect(await refusal(dispatchConversion(device, 'cpio', 'zip', {}, 'dev.cpio'))).toMatchObject({ reason: 'special-entry' });
    const traversal = Buffer.concat([newcEntry('../outside.txt', 0o100644, Buffer.from('escaped')), newcEntry('TRAILER!!!', 0)]);
    expect(await refusal(dispatchConversion(traversal, 'cpio', 'zip', {}, 'up.cpio'))).toMatchObject({ reason: 'path-traversal' });
  }, ENGINE_TIMEOUT_MS);
});
