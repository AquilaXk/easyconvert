import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { ARCHIVE_SECURITY_LIMITS } from '../src/lib/conversions/archive';
import { PackageRun, decodeZstdPayload, extractPackagePayload } from '../src/lib/conversions/archive-package-payload';
import { SandboxedTimeoutError } from '../src/lib/security/process-sandbox';
import { oracleTest } from './helpers/oracle-test';
import { ConversionFailedError } from '../src/lib/types';
import { getOracleToolPath, requireOracleTool } from './helpers/differential-oracle';
import { fileDigests, listPermissionStrings, readArchiveTree, unpackWith } from './helpers/archive-output-tree';
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
        // The macOS disk utility that wrote the image tagged the volume, the directory and every file with a provenance
        // attribute (8 alternate streams in all, as 7-Zip's own summary counts); they are not files and are left out.
        expect(fileDigests(output.files), target).toEqual(digestsOf(volume));
        expect(result.metadata?.warnings, target).toEqual(['8 alternate streams (extended attributes and resource forks of the files) were left out.']);
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
      fs.writeFileSync(tarFile, tarOf([{ name: 'zeros.bin' }, '\0'.repeat(40 * MIB)]));
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
      fs.writeFileSync(tarFile, tarOf([{ name: 'zeros.bin' }, '\0'.repeat(40 * MIB)]));
      execFileSync(requireOracleTool('zstd'), ['-19', '-q', tarFile]);
      const deb = buildDeb('data.tar.zst', fs.readFileSync(`${tarFile}.zst`));
      expect(deb.length).toBeLessThan(MIB / 8);
      // A 7-Zip that decodes Zstandard stops at the listing; one that does not leaves the stream to the in-process decoder.
      expect(await refusal(convertDeb(deb))).toMatchObject({ name: 'UnsafeArchiveError', reason: 'compression-ratio' });
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
// An rpm whose payload uses the stripped cpio headers (rpm 4.12 and later) lists no files in any reader but rpm itself;
// the names come from the package header (tests/rpm-stripped-payload.test.ts converts real and written packages).
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
  oracleTest('a payload of stripped cpio headers that its header lists no file for is refused as unreadable, not converted to an empty archive', ['7z'], async () => {
    const stripped = Buffer.concat([Buffer.from('07070X00000000\0\0'), Buffer.from('07070X00000001\0\0hello\n\0\0'), newcEntry('TRAILER!!!', 0)]);
    const failure = await dispatchConversion(buildRpm(stripped), 'rpm', 'zip', {}, 'stripped.rpm').catch((err: unknown) => err);
    expect(failure).toMatchObject({ name: 'UnreadableArchiveError' });
    expect((failure as Error).message).toBe('Could not read the package: its payload is damaged (an entry names a file the package does not list).');
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

// ---------------------------------------------------------------------------------------------------------------------
// One byte budget, one deadline and a bounded number of layers for the whole package
// ---------------------------------------------------------------------------------------------------------------------

function xzOf(data: Buffer, dir: string): Buffer {
  const file = path.join(dir, 'layer.bin');
  fs.writeFileSync(file, data);
  execFileSync(requireOracleTool('xz'), ['-9', '-k', '-f', file]);
  return fs.readFileSync(`${file}.xz`);
}

describe('what a package writes is bounded as a whole', () => {
  const tarOfZeros = (mib: number): Buffer => tarOf([{ name: 'zeros.bin' }, '\0'.repeat(mib * MIB)]);

  oracleTest(
    'layers that each fit the cap but add up past it are refused as a bomb; the same package a little smaller converts',
    ['7z', 'xz', 'tar'],
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-budget-'));
      try {
        // The upload is a few KB, so the bound is the 32 MiB ratio floor. The decompressed tar (20 MiB) and the files
        // extracted from it (20 MiB) are each under it; together they are 40 MiB.
        const over = buildDeb('data.tar.xz', xzOf(tarOfZeros(20), dir));
        expect(over.length).toBeLessThan(MIB / 4);
        expect(await refusal(convertDeb(over))).toMatchObject({ name: 'UnsafeArchiveError', reason: 'compression-ratio' });

        const within = buildDeb('data.tar.xz', xzOf(tarOfZeros(12), dir));
        const result = await dispatchConversion(within, 'deb', 'zip', {}, 'within.deb');
        const output = await readArchiveTree(result.buffer, 'zip');
        expect([...output.files.values()].map((bytes) => bytes.length)).toEqual([12 * MIB]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    ENGINE_TIMEOUT_MS
  );

  it('charges bytes against the bound of the upload and refuses the byte that passes it', () => {
    const run = new PackageRun({ timeoutMs: 1000, limits: ARCHIVE_SECURITY_LIMITS } as never, 1000);
    run.charge(32 * MIB);
    expect(() => run.charge(1)).toThrow(expect.objectContaining({ name: 'UnsafeArchiveError', reason: 'compression-ratio' }));
  });

  it('gives each 7-Zip step what is left of one deadline, and refuses a step once it has passed', () => {
    let clock = 10_000;
    const run = new PackageRun({ timeoutMs: 1000, limits: ARCHIVE_SECURITY_LIMITS } as never, 1000, () => clock);
    expect(run.step({}).timeoutMs).toBe(1000);
    clock += 400;
    expect(run.step({}).timeoutMs).toBe(600);
    clock += 600;
    expect(() => run.step({})).toThrow(SandboxedTimeoutError);
  });
});

describe('the compression layers of a payload', () => {
  const gzipTimes = (data: Buffer, layers: number): Buffer => Array.from({ length: layers }).reduce<Buffer>((inner) => zlib.gzipSync(inner), data);
  const payloadTar = (): Buffer => tarOf([{ name: 'opt/a.txt' }, 'layered']);

  oracleTest('a payload compressed three times is read', ['7z', 'tar'], async () => {
    const deb = buildDeb('data.tar.gz', gzipTimes(payloadTar(), 3));
    const output = await readArchiveTree((await dispatchConversion(deb, 'deb', 'zip', {}, 'layers.deb')).buffer, 'zip');
    expect(fileDigests(output.files)).toEqual(digestsOf({ 'opt/a.txt': Buffer.from('layered') }));
  }, ENGINE_TIMEOUT_MS);

  oracleTest('a payload still compressed after the third layer is refused without a fourth decode', ['7z'], async () => {
    // Three real layers around a fourth that only looks like gzip: a decode of it would be a "7-Zip rejected" error.
    const looksCompressed = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.alloc(64, 0x41)]);
    const deb = buildDeb('data.tar.gz', gzipTimes(looksCompressed, 3));
    const failure = await refusal(convertDeb(deb));
    expect(failure).toMatchObject({ name: 'UnreadableArchiveError' });
    expect((failure as Error).message).toMatch(/not a cpio or tar archive/);
  }, ENGINE_TIMEOUT_MS);
});

describe('the files a package leaves behind and the one deadline', () => {
  const sevenZip = getOracleToolPath('7z');

  function request(workDir: string, archive: Buffer, timeoutMs: number): Parameters<typeof extractPackagePayload>[0] {
    const archivePath = path.join(workDir, 'input.deb');
    fs.writeFileSync(archivePath, archive);
    const extractDir = path.join(workDir, 'extracted');
    fs.mkdirSync(extractDir);
    return {
      p7zBin: sevenZip!,
      archivePath,
      extractDir,
      cwd: workDir,
      timeoutMs,
      maxBuffer: ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE,
      limits: ARCHIVE_SECURITY_LIMITS,
      label: 'archive',
      skipLinks: true,
    };
  }

  oracleTest('every layer and the package extraction are removed once the files are extracted', ['7z'], async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-leftovers-'));
    try {
      const tar = tarOf([{ name: 'opt/a.txt' }, 'kept']);
      const deb = buildDeb('data.tar.gz', zlib.gzipSync(zlib.gzipSync(tar)));
      const payload = await extractPackagePayload(request(workDir, deb, 60_000), 'deb');
      expect(fs.readFileSync(path.join(payload.root, 'opt', 'a.txt'), 'utf8')).toBe('kept');
      expect(fs.readdirSync(workDir).sort()).toEqual(['extracted-payload', 'input.deb']);
      expect(fs.readdirSync(path.join(workDir, 'extracted-payload'))).toEqual(['files']);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  oracleTest('a package with a 1 ms allowance times out instead of running its steps', ['7z'], async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-deadline-'));
    try {
      const deb = buildDeb('data.tar.gz', zlib.gzipSync(tarOf([{ name: 'opt/a.txt' }, 'kept'])));
      const failure = await extractPackagePayload(request(workDir, deb, 1), 'deb').catch((err: unknown) => err);
      expect(failure).toMatchObject({ name: 'SandboxedTimeoutError', timeoutMs: 1 });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe('set-user-ID, set-group-ID and sticky bits do not reach the converted archive', () => {
  const SETUID_FILE = 0o104755;
  const SETGID_FILE = 0o102755;
  const STICKY_DIR = 0o041777;

  const payload = (): Buffer =>
    Buffer.concat([
      newcEntry('./opt', STICKY_DIR),
      newcEntry('./opt/su', SETUID_FILE, Buffer.from('suid')),
      newcEntry('./opt/sg', SETGID_FILE, Buffer.from('sgid')),
      newcEntry('TRAILER!!!', 0),
    ]);

  for (const target of ['tar', 'tar.gz', 'zip', '7z'] as const) {
    oracleTest(`an rpm with a setuid file, a setgid file and a sticky directory to ${target}`, ['7z', 'tar', 'zipinfo'], async () => {
      const result = await dispatchConversion(buildRpm(payload()), 'rpm', target, {}, 'special.rpm');
      const permissions = listPermissionStrings(result.buffer, target);
      expect(permissions.get('opt/su'), target).toBe('-rwxr-xr-x');
      expect(permissions.get('opt/sg'), target).toBe('-rwxr-xr-x');
      // 7-Zip creates the directory under the umask, so only the absence of the sticky bit is the point here.
      expect(permissions.get('opt'), target).toMatch(/^d[-rwx]{9}$/);
      expect([...permissions.values()].filter((mode) => /[sStT]/.test(mode)), target).toEqual([]);
    }, ENGINE_TIMEOUT_MS);
  }
});

describe('the bytes a package holds at once, not the bytes it ever wrote', () => {
  const sevenZip = getOracleToolPath('7z');
  const STORED = { level: 0 };
  const storedGzip = (data: Buffer): Buffer => zlib.gzipSync(data, STORED);

  // A tiny upload is judged against the 32 MiB floor, which is too large to fill in a test; a size cap of 3 MiB is the same
  // rule at a scale a test can reach. Stored layers keep every layer about the size of the payload.
  const SMALL_LIMITS = { ...ARCHIVE_SECURITY_LIMITS, MAX_UNCOMPRESSED_SIZE: 3 * MIB };

  function layeredPackage(payloadBytes: number): Buffer {
    let seed = 1;
    // Printable bytes, so the tar's UTF-8 body is exactly as long as asked.
    const noise = Buffer.alloc(payloadBytes, 0).map(() => (((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 0x3f) + 0x30);
    return buildDeb('data.tar.gz', storedGzip(storedGzip(tarOf([{ name: 'opt/noise.bin' }, noise.toString('latin1')]))));
  }

  async function extractWithSmallLimits(workDir: string, deb: Buffer): Promise<unknown> {
    const archivePath = path.join(workDir, 'input.deb');
    fs.writeFileSync(archivePath, deb);
    const extractDir = path.join(workDir, 'extracted');
    fs.mkdirSync(extractDir);
    return extractPackagePayload(
      { p7zBin: sevenZip!, archivePath, extractDir, cwd: workDir, timeoutMs: 60_000, maxBuffer: SMALL_LIMITS.MAX_UNCOMPRESSED_SIZE, limits: SMALL_LIMITS, label: 'archive', skipLinks: true },
      'deb'
    ).catch((err: unknown) => err);
  }

  oracleTest(
    'a payload whose layers would add up to more than the cap but never sit on disk together is read; one whose peak passes the cap is refused',
    ['7z'],
    async () => {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-live-'));
      try {
        // 1.2 MiB per layer: written in all about 6 MiB over the package's layers and tree, never more than 2.4 MiB held.
        const fits = await extractWithSmallLimits(workDir, layeredPackage(1_200_000));
        expect(fits).toMatchObject({ root: expect.stringContaining('files') });
        fs.rmSync(workDir, { recursive: true, force: true });
        fs.mkdirSync(workDir);
        // 1.6 MiB: the layer being read and the tree being written are 3.2 MiB together.
        const over = await extractWithSmallLimits(workDir, layeredPackage(1_600_000));
        expect(over).toMatchObject({ name: 'UnsafeArchiveError', reason: expect.stringMatching(/compression-ratio|uncompressed-size/) });
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    },
    ENGINE_TIMEOUT_MS
  );

  it('credits the bytes of a layer back when it is removed, and refuses the byte that passes the bound', () => {
    const run = new PackageRun({ timeoutMs: 1000, limits: SMALL_LIMITS } as never, 1000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-credit-'));
    try {
      const layer = path.join(dir, 'layer.bin');
      fs.writeFileSync(layer, 'x');
      run.charge(2 * MIB);
      run.release(layer, 2 * MIB);
      expect(fs.existsSync(layer)).toBe(false);
      expect(run.liveBytes).toBe(0);
      run.charge(3 * MIB);
      expect(() => run.charge(1)).toThrow(expect.objectContaining({ name: 'UnsafeArchiveError' }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the Zstandard bound of the in-process decoder', () => {
  // Frame header only: magic, a single-segment frame whose 4-byte content size says 100 MiB (within the decoder's window limit), one empty raw block. Nothing
  // follows that a decoder could produce, so only a bound checked on the declared size refuses it before any output.
  const DECLARES_100_MIB = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xa0, 0x00, 0x00, 0x40, 0x06, 0x01, 0x00, 0x00]);

  it('refuses a frame that declares more than the upload may unpack to, before it decodes or charges anything', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-zstd-bound-'));
    try {
      const frame = path.join(dir, 'payload.zst');
      fs.writeFileSync(frame, DECLARES_100_MIB);
      const run = new PackageRun({ timeoutMs: 1000, limits: ARCHIVE_SECURITY_LIMITS } as never, DECLARES_100_MIB.length);
      expect(() => decodeZstdPayload(run, frame, dir, 0)).toThrow(expect.objectContaining({ name: 'UnsafeArchiveError', reason: 'compression-ratio' }));
      expect(run.liveBytes).toBe(0);
      expect(fs.readdirSync(dir)).toEqual(['payload.zst']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
