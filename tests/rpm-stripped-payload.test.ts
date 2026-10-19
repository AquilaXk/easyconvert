import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { ARCHIVE_SECURITY_LIMITS } from '../src/lib/conversions/archive';
import { readRpmPackage, MAX_RPM_HEADER_DATA_BYTES, MAX_RPM_HEADER_ENTRIES } from '../src/lib/conversions/rpm-header';
import { strippedPayloadToCpio } from '../src/lib/conversions/rpm-stripped-payload';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { fileDigests, readArchiveTree, unpackWith, type ArchiveTree } from './helpers/archive-output-tree';
import { requireRealworldSample } from './helpers/realworld-sample';
import { buildStrippedPayload, buildStrippedRpm, S_DIR, S_LNK, S_REG, trailer, type RpmTestFile, type RpmTestOptions } from './helpers/rpm-builder';

/**
 * An rpm built by rpm 4.12 or later may carry a cpio with stripped headers (`07070X` and the index of the file): it holds no
 * names, modes or sizes, so 7-Zip lists such a package as empty. The names come from the package header
 * (RPMTAG_BASENAMES, DIRNAMES, DIRINDEXES), the modes and sizes from FILEMODES and FILESIZES or LONGFILESIZES, and which
 * entry carries the content of a set of hard links from the inodes, as rpm decides it.
 *
 * The real package is the published sample `hardlinks-ghosts-v6.rpm` (rpm 6, content worked out from `rpm -qp --dump`:
 * `d-regular` is "hello\n", the two hard links are "shared\n", `b-empty` is empty, `e-ghost-hardlink` and `f-ghost` are
 * ghosts that are not in the package, `g-symlink` and `h-symlink-hardlink` point at `d-regular`). The other packages are
 * written by tests/helpers/rpm-builder.ts from the file format description, and rpm's own `rpm2archive` unpacks every one of
 * them as a second reader.
 */

const ENGINE_TIMEOUT_MS = 120_000;
const MIB = 1024 * 1024;
const TARGETS = ['zip', 'tar', 'tar.gz', '7z'] as const;
const RPM_TOOLS = ['7z', 'tar', 'rpm2archive'] as const;

const SAMPLE_FILES: Readonly<Record<string, Buffer>> = {
  'dir/a-hardlink': Buffer.from('shared\n'),
  'dir/b-empty': Buffer.alloc(0),
  'dir/c-hardlink': Buffer.from('shared\n'),
  'dir/d-regular': Buffer.from('hello\n'),
};
const SAMPLE_LINKS = ['./dir/g-symlink', './dir/h-symlink-hardlink'];

const digestsOf = (files: Readonly<Record<string, Buffer>>): Record<string, string> => fileDigests(new Map(Object.entries(files)));

/** The files and links rpm's own unpacker (`rpm2archive`, read by `tar`) writes for the package. */
function unpackedByRpm(rpm: Buffer): ArchiveTree {
  const archive = execFileSync(requireOracleTool('rpm2archive'), ['-'], { input: rpm, maxBuffer: 256 * MIB });
  return unpackWith((outDir) => {
    execFileSync(requireOracleTool('tar'), ['-xzf', '-', '-C', outDir], { input: archive });
  });
}

async function convert(rpm: Buffer, target: string = 'zip', name = 'stripped.rpm') {
  return dispatchConversion(rpm, 'rpm', target, {}, name);
}

async function refusal(rpm: Buffer): Promise<Error> {
  return (await convert(rpm).then(
    () => {
      throw new Error('Expected a typed refusal but the conversion completed');
    },
    (err: unknown) => err
  )) as Error;
}

describe('the published rpm 6 package with a stripped payload', () => {
  for (const target of TARGETS) {
    oracleTest(
      `hardlinks-ghosts-v6.rpm to ${target} holds the four files and reports the two symbolic links it leaves out`,
      ['7z', 'tar'],
      async (ctx) => {
        const sample = await requireRealworldSample(ctx, 'kaitai-hardlinks-ghosts-v6.rpm');
        const result = await convert(sample.bytes, target, 'hardlinks-ghosts-v6.rpm');
        const output = await readArchiveTree(result.buffer, target);
        expect(fileDigests(output.files)).toEqual(digestsOf(SAMPLE_FILES));
        expect([...output.links.keys()]).toEqual([]);
        expect(result.skippedLinks).toEqual(SAMPLE_LINKS);
      },
      ENGINE_TIMEOUT_MS
    );
  }

  oracleTest(
    'the files equal what rpm2archive unpacks from the same package',
    [...RPM_TOOLS],
    async (ctx) => {
      const sample = await requireRealworldSample(ctx, 'kaitai-hardlinks-ghosts-v6.rpm');
      const installed = unpackedByRpm(sample.bytes);
      expect(fileDigests(installed.files)).toEqual(digestsOf(SAMPLE_FILES));
      expect([...installed.links.keys()].sort()).toEqual(['dir/g-symlink', 'dir/h-symlink-hardlink']);
      const output = await readArchiveTree((await convert(sample.bytes)).buffer, 'zip');
      expect(fileDigests(output.files)).toEqual(fileDigests(installed.files));
    },
    ENGINE_TIMEOUT_MS
  );

  it('the header table names every entry: nine files, two of them ghosts, with the sizes and modes rpm -qp --dump prints', async (ctx) => {
    const sample = await requireRealworldSample(ctx, 'kaitai-hardlinks-ghosts-v6.rpm');
    const file = path.join(os.tmpdir(), `v6-${process.pid}.rpm`);
    fs.writeFileSync(file, sample.bytes);
    try {
      const pkg = readRpmPackage(file, ARCHIVE_SECURITY_LIMITS);
      const table = pkg.files();
      expect(table.map((entry) => [entry.path.toString(), entry.mode.toString(8), entry.size, (entry.flags & 64) !== 0])).toEqual([
        ['/dir', '40755', 0, false],
        ['/dir/a-hardlink', '100644', 7, false],
        ['/dir/b-empty', '100644', 0, false],
        ['/dir/c-hardlink', '100644', 7, false],
        ['/dir/d-regular', '100644', 6, false],
        ['/dir/e-ghost-hardlink', '100644', 7, true],
        ['/dir/f-ghost', '100644', 6, true],
        ['/dir/g-symlink', '120777', 9, false],
        ['/dir/h-symlink-hardlink', '120777', 9, false],
      ]);
      expect(table[7].linkTarget.toString()).toBe('d-regular');
      expect(pkg.payloadOffset).toBe(sample.bytes.length - 276);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  oracleTest(
    'the control package built by rpm 4 (ordinary cpio headers) still converts to the same files',
    ['7z', 'tar'],
    async (ctx) => {
      const sample = await requireRealworldSample(ctx, 'kaitai-hardlinks-ghosts-v4.rpm');
      const result = await convert(sample.bytes, 'zip', 'hardlinks-ghosts-v4.rpm');
      const output = await readArchiveTree(result.buffer, 'zip');
      expect(fileDigests(output.files)).toEqual(digestsOf(SAMPLE_FILES));
    },
    ENGINE_TIMEOUT_MS
  );
});

describe('packages written with stripped headers convert to the files rpm unpacks from them', () => {
  const TREE: RpmTestFile[] = [
    { path: '/opt', mode: S_DIR },
    { path: '/opt/empty', mode: S_REG, content: Buffer.alloc(0) },
    { path: '/opt/a.txt', mode: S_REG, content: Buffer.from('alpha\n') },
    { path: '/opt/data.bin', mode: S_REG, content: Buffer.from(Array.from({ length: 256 }, (_unused, i) => i)) },
    { path: '/opt/b.txt', mode: S_REG, content: Buffer.from('shared\n'), inode: 77 },
    { path: '/opt/ghost', mode: S_REG, ghost: true },
    { path: '/opt/c.txt', mode: S_REG, content: Buffer.from('shared\n'), inode: 77 },
    { path: '/opt/d.txt', mode: S_REG, content: Buffer.from('shared\n'), inode: 77 },
    { path: '/opt/link', mode: S_LNK, linkTarget: 'a.txt' },
    { path: '/opt/sub', mode: S_DIR },
    { path: '/opt/sub/odd name é.txt', mode: S_REG, content: Buffer.from('deep\n') },
  ];
  const EXPECTED_FILES: Readonly<Record<string, Buffer>> = {
    'opt/empty': Buffer.alloc(0),
    'opt/a.txt': Buffer.from('alpha\n'),
    'opt/data.bin': Buffer.from(Array.from({ length: 256 }, (_unused, i) => i)),
    'opt/b.txt': Buffer.from('shared\n'),
    'opt/c.txt': Buffer.from('shared\n'),
    'opt/d.txt': Buffer.from('shared\n'),
    'opt/sub/odd name é.txt': Buffer.from('deep\n'),
  };

  const VARIANTS: Array<[string, RpmTestOptions]> = [
    ['an uncompressed payload with 32-bit sizes', {}],
    ['an uncompressed payload with 64-bit sizes', { longSizes: true }],
    ['a gzip payload', { compressor: 'gzip', transformPayload: (payload) => zlib.gzipSync(payload) }],
  ];

  for (const [label, options] of VARIANTS) {
    oracleTest(
      `${label}: the files and the left-out link are what rpm2archive unpacks`,
      [...RPM_TOOLS],
      async () => {
        const rpm = buildStrippedRpm(TREE, options);
        const installed = unpackedByRpm(rpm);
        expect(fileDigests(installed.files)).toEqual(digestsOf(EXPECTED_FILES));
        for (const target of TARGETS) {
          const result = await convert(rpm, target);
          const output = await readArchiveTree(result.buffer, target);
          expect(fileDigests(output.files), `${label} to ${target}`).toEqual(fileDigests(installed.files));
          expect(result.skippedLinks, target).toEqual(['./opt/link']);
        }
      },
      ENGINE_TIMEOUT_MS
    );
  }

  oracleTest(
    'xz, bzip2 and Zstandard payloads are read like the gzip one',
    [...RPM_TOOLS, 'xz', 'bzip2', 'zstd'],
    async () => {
      const compress = (tool: 'xz' | 'bzip2' | 'zstd', args: string[]) => (payload: Buffer) =>
        execFileSync(requireOracleTool(tool), args, { input: payload, maxBuffer: 64 * MIB });
      for (const [compressor, transformPayload] of [
        ['xz', compress('xz', ['-9', '-c'])],
        ['bzip2', compress('bzip2', ['-9', '-c'])],
        ['zstd', compress('zstd', ['-19', '-q', '-c'])],
      ] as const) {
        const rpm = buildStrippedRpm(TREE, { compressor, transformPayload });
        const installed = unpackedByRpm(rpm);
        const output = await readArchiveTree((await convert(rpm)).buffer, 'zip');
        expect(fileDigests(output.files)).toEqual(fileDigests(installed.files));
        expect(fileDigests(output.files)).toEqual(digestsOf(EXPECTED_FILES));
      }
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'a payload compressed twice is read, up to the three layers a package may have',
    ['7z', 'tar'],
    async () => {
      const rpm = buildStrippedRpm(TREE, { transformPayload: (payload) => zlib.gzipSync(zlib.gzipSync(payload)) });
      const output = await readArchiveTree((await convert(rpm)).buffer, 'zip');
      expect(fileDigests(output.files)).toEqual(digestsOf(EXPECTED_FILES));
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'the files of a package come back whichever order its payload lists them in, as long as the content of a hard link set comes last',
    [...RPM_TOOLS],
    async () => {
      // Indexes of TREE, the ghost (5) left out: descending, except that the links 4 and 6 come before 7, which holds their content.
      const rpm = buildStrippedRpm(TREE, { streamOrder: [10, 9, 8, 4, 6, 7, 3, 2, 1, 0] });
      const installed = unpackedByRpm(rpm);
      const output = await readArchiveTree((await convert(rpm)).buffer, 'zip');
      expect(fileDigests(output.files)).toEqual(fileDigests(installed.files));
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'a package that installs no files converts to an empty archive',
    ['7z', 'tar'],
    async () => {
      const output = await readArchiveTree((await convert(buildStrippedRpm([], { omitTags: [1117, 1118, 1116] }))).buffer, 'zip');
      expect([...output.files.keys(), ...output.links.keys()]).toEqual([]);
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'entry selection applies to the installed files',
    ['7z', 'tar'],
    async () => {
      const result = await dispatchConversion(buildStrippedRpm(TREE), 'rpm', 'zip', { entries: ['opt/sub/*'] }, 'stripped.rpm');
      const output = await readArchiveTree(result.buffer, 'zip');
      expect(fileDigests(output.files)).toEqual(digestsOf({ 'opt/sub/odd name é.txt': Buffer.from('deep\n') }));
    },
    ENGINE_TIMEOUT_MS
  );
});

describe('a stripped package is vetted like any other archive', () => {
  oracleTest(
    'a name that climbs out of the extraction directory is refused',
    ['7z'],
    async () => {
      const rpm = buildStrippedRpm([{ path: '/../../outside.txt', mode: S_REG, content: Buffer.from('escaped') }]);
      expect(await refusal(rpm)).toMatchObject({ name: 'UnsafeArchiveError', reason: 'path-traversal' });
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'a device file is refused',
    ['7z'],
    async () => {
      const rpm = buildStrippedRpm([{ path: '/dev/null', mode: 0o020666 }]);
      expect(await refusal(rpm)).toMatchObject({ name: 'UnsafeArchiveError', reason: 'special-entry' });
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'a symbolic link is left out and reported, and a file written through it is refused',
    ['7z'],
    async () => {
      const through = buildStrippedRpm([
        { path: '/opt', mode: S_DIR },
        { path: '/opt/link', mode: S_LNK, linkTarget: '/etc' },
        { path: '/opt/link/passwd', mode: S_REG, content: Buffer.from('escaped') },
      ]);
      expect(await refusal(through)).toMatchObject({ name: 'UnsafeArchiveError', reason: 'link-entry' });
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'a payload that expands past the ratio cap is refused as a bomb',
    ['7z', 'xz'],
    async () => {
      const rpm = buildStrippedRpm([{ path: '/zeros.bin', mode: S_REG, content: Buffer.alloc(40 * MIB) }], {
        transformPayload: (payload) => execFileSync(requireOracleTool('xz'), ['-9', '-c'], { input: payload, maxBuffer: 64 * MIB }),
      });
      expect(rpm.length * ARCHIVE_SECURITY_LIMITS.MAX_RATIO).toBeLessThan(40 * MIB);
      expect(await refusal(rpm)).toMatchObject({ name: 'UnsafeArchiveError', reason: 'compression-ratio' });
    },
    ENGINE_TIMEOUT_MS
  );
});

describe('a damaged header or payload is a typed refusal that says what is wrong', () => {
  const FILES: RpmTestFile[] = [
    { path: '/opt', mode: S_DIR },
    { path: '/opt/a.txt', mode: S_REG, content: Buffer.from('alpha\n') },
    { path: '/opt/b.txt', mode: S_REG, content: Buffer.from('shared\n'), inode: 5 },
    { path: '/opt/c.txt', mode: S_REG, content: Buffer.from('shared\n'), inode: 5 },
  ];
  /** Where the metadata header starts in the packages the builder writes: the 96-byte lead and a signature header of its region entry alone. */
  const METADATA_HEADER_AT = 144;

  async function refusedWith(rpm: Buffer, pattern: RegExp, name = 'UnreadableArchiveError'): Promise<void> {
    const failure = await refusal(rpm);
    expect(failure).toMatchObject({ name });
    expect(failure.message).toMatch(pattern);
  }

  /** The header reader on its own, for the damage 7-Zip would refuse the package for before the reader is asked. */
  function headerFailure(rpm: Buffer): Error {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpm-header-'));
    try {
      const file = path.join(dir, 'damaged.rpm');
      fs.writeFileSync(file, rpm);
      try {
        readRpmPackage(file, ARCHIVE_SECURITY_LIMITS).files();
      } catch (err) {
        return err as Error;
      }
      throw new Error('Expected the header to be refused');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** The payload converter on its own: `payload` is the stripped stream of the package that `FILES` describe. */
  function payloadFailure(payload: Buffer): Error {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpm-payload-'));
    try {
      const rpmFile = path.join(dir, 'p.rpm');
      fs.writeFileSync(rpmFile, buildStrippedRpm(FILES));
      const files = readRpmPackage(rpmFile, ARCHIVE_SECURITY_LIMITS).files();
      const source = path.join(dir, 'payload');
      fs.writeFileSync(source, payload);
      try {
        strippedPayloadToCpio({ files, source, output: path.join(dir, 'out.cpio'), charge: () => {} });
      } catch (err) {
        return err as Error;
      }
      throw new Error('Expected the payload to be refused');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const goodPayload = (): Buffer => buildStrippedPayload(FILES);

  oracleTest(
    'more index entries than a header may hold',
    ['7z'],
    async () => {
      const rpm = buildStrippedRpm(FILES, { header: { indexCountClaim: MAX_RPM_HEADER_ENTRIES + 1 } });
      await refusedWith(rpm, /^Could not read the package: its header is damaged \(the metadata header has 65536 index entries, more than 65535\)\.$/);
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'more header data than the cap, and more than the file holds',
    ['7z'],
    async () => {
      await refusedWith(
        buildStrippedRpm(FILES, { header: { dataLengthClaim: MAX_RPM_HEADER_DATA_BYTES + 1 } }),
        /the metadata header has 67108865 bytes of data, more than 67108864/
      );
      await refusedWith(buildStrippedRpm(FILES, { header: { dataLengthClaim: 100_000 } }), /the metadata header is longer than the file/);
    },
    ENGINE_TIMEOUT_MS
  );

  it('a header cut short, and a file that is not an rpm', () => {
    const rpm = buildStrippedRpm(FILES);
    expect(headerFailure(rpm.subarray(0, METADATA_HEADER_AT + 40)).message).toBe(
      'Could not read the package: its header is damaged (the metadata header is longer than the file).'
    );
    expect(headerFailure(rpm.subarray(0, METADATA_HEADER_AT + 8)).message).toBe('Could not read the package: its header is damaged (the metadata header is cut short).');
    expect(headerFailure(Buffer.alloc(200)).message).toBe('Could not read the package: its header is damaged (the file is not an rpm).');
  });

  oracleTest(
    'no directory names, a directory index outside them, or a relative directory',
    ['7z'],
    async () => {
      await refusedWith(buildStrippedRpm(FILES, { omitTags: [1118] }), /the list of directory names is missing/);
      await refusedWith(
        buildStrippedRpm(FILES, { omitTags: [1116], header: { extraEntries: [{ tag: 1116, type: 4, count: 4, data: Buffer.from('00000000000000000000000000000063', 'hex') }] } }),
        /a directory index points outside the list of directory names/
      );
      await refusedWith(
        buildStrippedRpm(FILES, { omitTags: [1118], header: { extraEntries: [{ tag: 1118, type: 8, count: 1, data: Buffer.from('opt/\0', 'latin1') }] } }),
        /a directory name is not an absolute path/
      );
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'a table with fewer rows than there are files, and a missing table',
    ['7z'],
    async () => {
      await refusedWith(
        buildStrippedRpm(FILES, { omitTags: [1030], header: { extraEntries: [{ tag: 1030, type: 3, count: 3, data: Buffer.alloc(6) }] } }),
        /the list of file modes does not list one value per file/
      );
      await refusedWith(buildStrippedRpm(FILES, { omitTags: [1028, 5008] }), /the list of file sizes is missing/);
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'a table of the wrong type, a string array with more strings than the header holds, and a count past the file cap',
    ['7z'],
    async () => {
      await refusedWith(
        buildStrippedRpm(FILES, { omitTags: [1030], header: { extraEntries: [{ tag: 1030, type: 4, count: 4, data: Buffer.alloc(16) }] } }),
        /the list of file modes has an unexpected type/
      );
      await refusedWith(
        buildStrippedRpm(FILES, { omitTags: [1117], header: { extraEntries: [{ tag: 1117, type: 8, count: 40_000, data: Buffer.from('opt\0', 'latin1') }] } }),
        /the list of base names lists more strings than the header holds/
      );
      await refusedWith(
        buildStrippedRpm(FILES, { omitTags: [1117], header: { extraEntries: [{ tag: 1117, type: 8, count: 0x7fffffff, data: Buffer.from('opt\0', 'latin1') }] } }),
        /Archive bomb detected: file count \(2147483647\) exceeds limit of 50000/,
        'UnsafeArchiveError'
      );
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'more files than an archive may hold',
    ['7z'],
    async () => {
      const files: RpmTestFile[] = Array.from({ length: ARCHIVE_SECURITY_LIMITS.MAX_FILES + 1 }, (_unused, i) => ({ path: `/f/${i}`, mode: S_REG, content: Buffer.alloc(0) }));
      expect(await refusal(buildStrippedRpm(files))).toMatchObject({ name: 'UnsafeArchiveError', reason: 'entry-count' });
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'a path longer than a cpio entry name may be',
    ['7z'],
    async () => {
      const rpm = buildStrippedRpm([{ path: `/${'d'.repeat(5000)}/f`, mode: S_REG, content: Buffer.alloc(0) }]);
      await refusedWith(rpm, /a path is longer than 4096 bytes/);
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'a header index entry that points past the end of the header data',
    ['7z'],
    async () => {
      const rpm = Buffer.from(buildStrippedRpm(FILES));
      // Point the second index entry (the first is the region entry) one byte past the data.
      const entryAt = METADATA_HEADER_AT + 16 + 16;
      rpm.writeUInt32BE(rpm.readUInt32BE(METADATA_HEADER_AT + 12) + 1, entryAt + 8);
      await refusedWith(rpm, /an index entry of the metadata header points outside its data/);
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'an entry for a file the header does not list, a file listed twice, a file the payload lacks, and a link set whose content comes first',
    ['7z'],
    async () => {
      await refusedWith(buildStrippedRpm(FILES, { streamOrder: [0, 1, 2, 3, 99] }), /an entry names a file the package does not list/);
      await refusedWith(buildStrippedRpm(FILES, { streamOrder: [0, 1, 1, 2, 3] }), /a file appears twice/);
      await refusedWith(buildStrippedRpm(FILES, { streamOrder: [0, 2, 3] }), /\/opt\/a\.txt is missing/);
      await refusedWith(buildStrippedRpm(FILES, { streamOrder: [0, 1, 3, 2] }), /the content of a set of hard links does not come after every link/);
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'a size in the header that the payload cannot hold',
    ['7z'],
    async () => {
      const rpm = buildStrippedRpm(FILES, { headerSizes: [0, 100_000, 7, 7] });
      await refusedWith(rpm, /its payload is damaged \(the content of \/opt\/a\.txt is cut short\)/);
    },
    ENGINE_TIMEOUT_MS
  );

  it('a payload cut inside an entry header, inside the content, or before the trailer', () => {
    const payload = goodPayload();
    expect(payloadFailure(payload.subarray(0, 3)).message).toBe('Could not read the package: its payload is damaged (an entry header is cut short).');
    expect(payloadFailure(payload.subarray(0, 10)).message).toBe('Could not read the package: its payload is damaged (an entry header is cut short).');
    // The directory entry is 16 bytes, the header of /opt/a.txt another 16, its content 6 bytes and 2 of padding.
    expect(payloadFailure(payload.subarray(0, 16 + 16 + 3)).message).toBe('Could not read the package: its payload is damaged (the content of /opt/a.txt is cut short).');
    expect(payloadFailure(payload.subarray(0, payload.length - 40)).message).toMatch(/^Could not read the package: its payload is damaged \((an entry header|the trailer) is cut short\)\.$/);
    expect(payloadFailure(payload.subarray(0, 0)).message).toBe('Could not read the package: its payload is damaged (an entry header is cut short).');
  });

  it('an entry header that is not a stripped one, and a full header that is not the trailer', () => {
    const payload = goodPayload();
    expect(payloadFailure(Buffer.concat([Buffer.from('07070X-not-hex-digits-here-0000000000000000')])).message).toBe(
      'Could not read the package: its payload is damaged (an entry header has no file index).'
    );
    expect(payloadFailure(Buffer.concat([Buffer.from('XXXXXXXXXXXXXXXX'), payload])).message).toBe(
      'Could not read the package: its payload is damaged (an entry header has an unknown magic number).'
    );
    // A standard header after the first stripped entry whose name is not TRAILER!!!.
    const fullHeader = Buffer.from(trailer(0));
    fullHeader.write('NOTTRAILER', 110, 'latin1');
    expect(payloadFailure(Buffer.concat([payload.subarray(0, 16), fullHeader])).message).toBe(
      'Could not read the package: its payload is damaged (an entry with a full header follows the stripped ones).'
    );
  });
});

describe('a path from the header is made printable before it is put in a message', () => {
  it('replaces control characters and cuts a long name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stripped-message-'));
    try {
      const source = path.join(dir, 'payload');
      fs.writeFileSync(source, trailer(0));
      const file = (name: string) => ({ path: Buffer.from(name), mode: S_REG, size: 0, mtime: 0, flags: 0, inode: 0, device: 0, linkTarget: Buffer.alloc(0) });
      const failure = (name: string): Error => {
        try {
          strippedPayloadToCpio({ files: [file(name)], source, output: path.join(dir, 'out.cpio'), charge: () => {} });
        } catch (err) {
          return err as Error;
        }
        throw new Error('Expected the payload to be refused');
      };
      expect(failure('/opt/evil\u001b[31m\nname').message).toBe('Could not read the package: its payload is damaged (/opt/evil?[31m?name is missing).');
      expect(failure(`/${'x'.repeat(300)}`).message).toBe(`Could not read the package: its payload is damaged (/${'x'.repeat(119)}... is missing).`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the stripped payload converter writes only as much as its budget allows', () => {
  it('stops at the first write past the budget and leaves a file no larger than the budget plus that write', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stripped-budget-'));
    try {
      const files = Array.from({ length: 200 }, (_unused, i) => ({
        path: Buffer.from(`/${'x'.repeat(1000)}/${i}`),
        mode: S_REG,
        size: 0,
        mtime: 0,
        flags: 0,
        inode: 0,
        device: 0,
        linkTarget: Buffer.alloc(0),
      }));
      const source = path.join(dir, 'payload');
      const entries = files.map((_file, i) => Buffer.from(`07070X${i.toString(16).padStart(8, '0')}\0\0`, 'latin1'));
      const trailer = Buffer.from(`070701${'00000000'.repeat(11)}0000000B00000000TRAILER!!!\0\0\0\0`, 'latin1');
      fs.writeFileSync(source, Buffer.concat([...entries, trailer]));
      const output = path.join(dir, 'out.cpio');
      const budget = 10_000;
      let charged = 0;
      expect(() =>
        strippedPayloadToCpio({
          files,
          source,
          output,
          charge: (bytes) => {
            charged += bytes;
            if (charged > budget) throw new Error('over budget');
          },
        })
      ).toThrow('over budget');
      expect(fs.statSync(output).size).toBeLessThanOrEqual(budget);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
