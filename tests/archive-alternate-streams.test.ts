import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { ARCHIVE_SECURITY_LIMITS } from '../src/lib/conversions/archive';
import { separateAlternateStreams } from '../src/lib/conversions/archive-alternate-streams';
import { assertSafeArchiveListing, parse7zTechnicalListing } from '../src/lib/conversions/archive-extraction-safety';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { fileDigests, readArchiveTree } from './helpers/archive-output-tree';

/**
 * An HFS+ volume stores extended attributes and resource forks as alternate streams, which 7-Zip hands out as items named
 * `<file>:<stream>`. They are not files of the volume, so they are left out of a conversion and counted in one warning.
 * The name is no way to tell a stream from a file (a name that starts with one letter and a colon reads as a drive path),
 * so the listing's own `Alternate Stream` property decides; a real entry named like a drive path stays refused.
 *
 * `streams.dmg` was written by the macOS disk utility (tests/fixtures/archive-sources/PROVENANCE): a volume named `A`, a file `a`
 * ("alpha\n") with the attribute `attr`, and `dir/b.txt` ("beta\n") with the attribute `user.note`; the disk utility added
 * `com.apple.provenance` to the volume, `a`, `dir` and `b.txt`. That is 6 streams, as 7-Zip's own summary counts.
 */

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'archive-sources');
const ENGINE_TIMEOUT_MS = 120_000;
const TARGETS = ['zip', 'tar', 'tar.gz', '7z'] as const;
const FILES_OF_THE_VOLUME: Readonly<Record<string, Buffer>> = {
  'A/a': Buffer.from('alpha\n'),
  'A/dir/b.txt': Buffer.from('beta\n'),
};
const STREAMS_OF_THE_VOLUME = 6;
const STREAMS_WARNING = '6 alternate streams (extended attributes and resource forks of the files) were left out.';

const fixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURE_DIR, name));

describe('the listing property that marks an alternate stream', () => {
  const listing = [
    'Path = A/a',
    'Size = 6',
    'Alternate Stream = -',
    '',
    'Path = A/a:attr',
    'Size = 5',
    'Alternate Stream = +',
    '',
    'Path = A:com.apple.provenance',
    'Size = 11',
    'Alternate Stream = +',
    '',
  ].join('\n');

  it('is read from the listing and the streams are counted, not vetted', () => {
    const split = separateAlternateStreams(parse7zTechnicalListing(listing));
    expect(split.entries.map((entry) => entry.path)).toEqual(['A/a']);
    expect(split.alternateStreams).toBe(2);
  });

  it('lets a stream named like a drive path through while a real entry named like one is still refused', () => {
    const stream = 'Path = A:com.apple.provenance\nSize = 11\nAlternate Stream = +\n';
    const realEntry = 'Path = C:evil.txt\nSize = 4\nAlternate Stream = -\n';
    const vet = (text: string): unknown =>
      assertSafeArchiveListing(separateAlternateStreams(parse7zTechnicalListing(text)).entries, 1000, ARCHIVE_SECURITY_LIMITS);
    expect(vet(stream)).toMatchObject({ entryCount: 0 });
    expect(() => vet(realEntry)).toThrow(expect.objectContaining({ name: 'UnsafeArchiveError', reason: 'absolute-path' }));
    // The same name without the property is a file name, whatever follows the colon.
    expect(() => vet('Path = A:com.apple.provenance\nSize = 11\n')).toThrow(expect.objectContaining({ reason: 'absolute-path' }));
  });

  it('does not let a stream carry a traversal name or a size past the caps into the extraction', () => {
    const hostile = 'Path = A/a:../../evil\nSize = 999999999999\nAlternate Stream = +\n';
    const split = separateAlternateStreams(parse7zTechnicalListing(hostile));
    expect(split.entries).toEqual([]);
    expect(split.alternateStreams).toBe(1);
  });
});

describe('a disk image with alternate streams converts to the files of its volume', () => {
  for (const target of TARGETS) {
    oracleTest(
      `streams.dmg to ${target} holds the two files only and reports the six streams it left out`,
      ['7z', 'tar'],
      async () => {
        const result = await dispatchConversion(fixture('streams.dmg'), 'dmg', target, {}, 'streams.dmg');
        const output = await readArchiveTree(result.buffer, target);
        expect(fileDigests(output.files)).toEqual(fileDigests(new Map(Object.entries(FILES_OF_THE_VOLUME))));
        expect([...output.files.keys()].filter((name) => name.includes(':'))).toEqual([]);
        expect(result.metadata?.warnings).toEqual([STREAMS_WARNING]);
      },
      ENGINE_TIMEOUT_MS
    );
  }

  oracleTest(
    'the files equal what 7-Zip extracts with alternate streams switched off, and the count equals its own listing',
    ['7z', 'tar'],
    async () => {
      const sevenZip = requireOracleTool('7z');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alternate-streams-oracle-'));
      try {
        const image = path.join(dir, 'streams.dmg');
        fs.writeFileSync(image, fixture('streams.dmg'));
        const extracted = path.join(dir, 'out');
        execFileSync(sevenZip, ['x', '-y', '-sns-', `-o${extracted}`, image], { stdio: 'pipe' });
        const listed = execFileSync(sevenZip, ['l', '-slt', '-ba', '-sns', image], { encoding: 'utf8' });
        const streamsListed = listed.split('\n\n').filter((block) => block.includes('Alternate Stream = +')).length;
        expect(streamsListed).toBe(STREAMS_OF_THE_VOLUME);

        const expected = new Map<string, Buffer>();
        const pending = [extracted];
        for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
          for (const entry of fs.readdirSync(next, { withFileTypes: true })) {
            const full = path.join(next, entry.name);
            if (entry.isDirectory()) pending.push(full);
            else if (entry.isFile()) expected.set(path.relative(extracted, full).split(path.sep).join('/'), fs.readFileSync(full));
          }
        }
        const result = await dispatchConversion(fixture('streams.dmg'), 'dmg', 'zip', {}, 'streams.dmg');
        const output = await readArchiveTree(result.buffer, 'zip');
        expect(fileDigests(output.files)).toEqual(fileDigests(expected));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'a volume with no alternate streams reports nothing',
    ['7z', 'tar'],
    async () => {
      const result = await dispatchConversion(fixture('probe.dmg'), 'dmg', 'zip', {}, 'probe.dmg');
      expect(result.metadata?.warnings).toBeUndefined();
    },
    ENGINE_TIMEOUT_MS
  );
});
