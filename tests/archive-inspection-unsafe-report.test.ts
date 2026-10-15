import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { inspectArchive } from '../src/lib/conversions/archive';
import { summarizeInspectionSafety } from '../src/lib/conversions/archive-extraction-safety';
import { ArchiveInspectResponseSchema } from '../src/lib/api/contracts/schemas';
import { POST as inspectRoute } from '../src/app/api/v1/archives/inspect/route';
import { NextRequest } from 'next/server';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import {
  build7zFromStagedLinks,
  build7zWithManyFiles,
  build7zZeroBomb,
  buildTarWithEntries,
  buildZipWithEntries,
  createHostileWorkspace,
  type HostileWorkspace,
} from './helpers/hostile-archives';

/**
 * Inspection reports why an archive is unsafe instead of refusing it: links, traversal or absolute
 * names and duplicate paths come back as per-entry flags plus `extractable: false` and reasons.
 * Only resource caps (entry count, declared size, ratio) still refuse. Nothing is ever extracted.
 */

const TOOLS = ['7z', 'python3'] as const;
const SLOW_TEST_TIMEOUT_MS = 120_000;
const OVER_CAP_BOMB_MIB = 600;
const OVER_CAP_ENTRY_COUNT = 50_001;

function entryByName<T extends { name: string }>(entries: T[], name: string): T {
  const found = entries.find((entry) => entry.name === name);
  if (!found) throw new Error(`No entry named ${name}`);
  return found;
}

describe('summarizeInspectionSafety', () => {
  const plain = (name: string, isDirectory = false) => ({ name, isDirectory });

  it('reports a clean archive as extractable with no reasons', () => {
    expect(summarizeInspectionSafety([plain('a.txt'), plain('docs/', true), plain('docs/b.txt')])).toEqual({
      extractable: true,
      unextractableReasons: [],
      flags: [{}, {}, {}],
    });
  });

  it('flags traversal, absolute, drive-letter and NUL names without altering them', () => {
    const summary = summarizeInspectionSafety([
      plain('../../evil'),
      plain('/etc/passwd'),
      plain('C:\\Windows\\x'),
      plain('a\\..\\b'),
      plain('bad\0name'),
      plain('fine..txt'),
    ]);

    expect(summary.flags.map((flag) => flag.unsafePath === true)).toEqual([true, true, true, true, true, false]);
    expect(summary.extractable).toBe(false);
    expect(summary.unextractableReasons).toEqual([
      "entries with an absolute, traversal or invalid path: 5 (first: '../../evil')",
    ]);
  });

  it('keeps link and special kinds and reports each category once', () => {
    const summary = summarizeInspectionSafety([
      { ...plain('sym'), kind: 'symlink' as const },
      { ...plain('hard'), kind: 'hardlink' as const },
      { ...plain('pipe'), kind: 'special' as const },
    ]);

    expect(summary.flags).toEqual([{ kind: 'symlink' }, { kind: 'hardlink' }, { kind: 'special' }]);
    expect(summary.unextractableReasons).toEqual([
      "symbolic or hard link entries: 2 (first: 'sym')",
      "device, FIFO or socket entries: 1 (first: 'pipe')",
    ]);
  });

  it('flags every entry of a duplicated path, but not repeated directories', () => {
    const summary = summarizeInspectionSafety([
      plain('a.txt'),
      plain('x'),
      plain('a.txt'),
      plain('d', true),
      plain('d/', true),
      plain('f'),
      plain('f/', true),
    ]);

    expect(summary.flags.map((flag) => flag.duplicate === true)).toEqual([true, false, true, false, false, true, true]);
    expect(summary.unextractableReasons).toEqual(["duplicated paths: 2 (first: 'a.txt')"]);
  });
});

describe('inspectArchive reports unsafe entries', () => {
  const originalP7zipPath = process.env.P7ZIP_PATH;
  let ws: HostileWorkspace;

  beforeAll(() => {
    const sevenZip = getOracleToolPath('7z');
    if (sevenZip) {
      process.env.P7ZIP_PATH = sevenZip;
    }
  });

  afterAll(() => {
    if (originalP7zipPath === undefined) {
      delete process.env.P7ZIP_PATH;
    } else {
      process.env.P7ZIP_PATH = originalP7zipPath;
    }
  });

  beforeEach(() => {
    ws = createHostileWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  function inspect(archivePath: string) {
    const buffer = fs.readFileSync(archivePath);
    return ws.withTmpdir(() => inspectArchive(buffer, { filename: path.basename(archivePath) }));
  }

  oracleTest('describes a 7z archive that holds a symlink and marks it unextractable', [...TOOLS], async () => {
    const archive = build7zFromStagedLinks(
      path.join(ws.fixturesDir, 'link.7z'),
      path.join(ws.fixturesDir, 'stage'),
      [{ name: 'link', target: ws.outsideDir }],
      [{ name: 'f.txt', data: 'hello' }]
    );
    const before = ws.snapshot();

    const report = await inspect(archive);

    expect(report.format).toBe('7z');
    expect(report.extractable).toBe(false);
    expect(report.unextractableReasons).toEqual(["symbolic or hard link entries: 1 (first: 'link')"]);
    expect(entryByName(report.entries, 'link')).toMatchObject({ kind: 'symlink', isDirectory: false });
    expect(entryByName(report.entries, 'f.txt').kind).toBeUndefined();
    expect(ws.snapshot()).toEqual(before);
  });

  oracleTest('describes a clean 7z archive as extractable', [...TOOLS], async () => {
    const archive = build7zFromStagedLinks(
      path.join(ws.fixturesDir, 'clean.7z'),
      path.join(ws.fixturesDir, 'stage-clean'),
      [],
      [
        { name: 'a.txt', data: 'alpha' },
        { name: 'b.txt', data: 'bravo!' },
      ]
    );

    const report = await inspect(archive);

    expect(report.extractable).toBe(true);
    expect(report.unextractableReasons).toEqual([]);
    expect(report.entries.map((entry) => [entry.name, entry.uncompressedSize]).sort()).toEqual([
      ['a.txt', 5],
      ['b.txt', 6],
    ]);
    expect(report.entries.every((entry) => entry.unsafePath === undefined && entry.duplicate === undefined)).toBe(true);
  });

  oracleTest('keeps traversal and absolute names verbatim in a zip and flags them', [...TOOLS], async () => {
    const absolute = path.join(ws.outsideDir, 'abs.txt');
    const zip = buildZipWithEntries(path.join(ws.fixturesDir, 'names.zip'), [
      { name: '../../evil.txt', data: 'x' },
      { name: absolute, data: 'x' },
      { name: 'ok.txt', data: 'x' },
    ]);
    const before = ws.snapshot();

    const report = await inspect(zip);

    expect(report.entries.map((entry) => entry.name)).toEqual(['../../evil.txt', absolute, 'ok.txt']);
    expect(report.entries.map((entry) => entry.unsafePath === true)).toEqual([true, true, false]);
    expect(report.extractable).toBe(false);
    expect(report.unextractableReasons).toEqual([
      "entries with an absolute, traversal or invalid path: 2 (first: '../../evil.txt')",
    ]);
    expect(ws.snapshot()).toEqual(before);
  });

  oracleTest('flags a zip symlink by its unix mode and never resolves it', [...TOOLS], async () => {
    const zip = buildZipWithEntries(path.join(ws.fixturesDir, 'link.zip'), [
      { name: 'alias', mode: 0o120777, data: ws.outsideDir },
      { name: 'f.txt', data: 'hello' },
    ]);
    const before = ws.snapshot();

    const report = await inspect(zip);

    expect(entryByName(report.entries, 'alias')).toMatchObject({ kind: 'symlink' });
    expect(entryByName(report.entries, 'f.txt').kind).toBeUndefined();
    expect(report.extractable).toBe(false);
    expect(ws.snapshot()).toEqual(before);
  });

  oracleTest('flags both entries of a duplicated path in zip and tar archives', [...TOOLS], async () => {
    const entries = [
      { name: 'a.txt', data: 'one' },
      { name: 'b.txt', data: 'two' },
      { name: 'a.txt', data: 'three' },
    ];
    const zip = buildZipWithEntries(path.join(ws.fixturesDir, 'dup.zip'), entries);
    const tar = buildTarWithEntries(path.join(ws.fixturesDir, 'dup.tar'), entries);

    for (const archive of [zip, tar]) {
      const report = await inspect(archive);

      expect(report.entries.map((entry) => entry.duplicate === true)).toEqual([true, false, true]);
      expect(report.extractable).toBe(false);
      expect(report.unextractableReasons).toEqual(["duplicated paths: 1 (first: 'a.txt')"]);
    }
  });

  oracleTest('still refuses resource bombs: an oversized declared total and an entry flood', [...TOOLS], async () => {
    const bomb = build7zZeroBomb(path.join(ws.fixturesDir, 'bomb.7z'), path.join(ws.fixturesDir, 'stage-bomb'), OVER_CAP_BOMB_MIB);
    const flood = build7zWithManyFiles(path.join(ws.fixturesDir, 'flood.7z'), path.join(ws.fixturesDir, 'stage-flood'), OVER_CAP_ENTRY_COUNT);

    await expect(inspect(bomb)).rejects.toMatchObject({ name: 'UnsafeArchiveError', reason: 'uncompressed-size' });
    await expect(inspect(flood)).rejects.toMatchObject({ name: 'UnsafeArchiveError', reason: 'entry-count' });
  }, SLOW_TEST_TIMEOUT_MS);

  oracleTest('serves the report through the inspect API', [...TOOLS], async () => {
    const zip = buildZipWithEntries(path.join(ws.fixturesDir, 'api.zip'), [{ name: '../x', data: 'x' }]);
    const email = `inspector_${Date.now()}_${Math.random().toString(36).slice(2)}@test.local`;
    const user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'Inspector', tier: 'pro' }));
    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(fs.readFileSync(zip))], { type: 'application/zip' }), 'api.zip');
    const request = new NextRequest('http://localhost:3000/api/v1/archives/inspect', {
      method: 'POST',
      headers: { Cookie: `easyconvert_session=${createSessionToken(user)}` },
      body: formData,
    });

    const response = await inspectRoute(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, extractable: false });
    expect(body.entries[0]).toMatchObject({ name: '../x', unsafePath: true });
  });

  it('documents the new fields in the response schema', () => {
    expect(ArchiveInspectResponseSchema.required).toContain('extractable');
    expect(ArchiveInspectResponseSchema.properties.extractable).toMatchObject({ type: 'boolean' });
    expect(ArchiveInspectResponseSchema.properties.unextractableReasons).toMatchObject({ type: 'array' });
    const entryProps = ArchiveInspectResponseSchema.properties.entries.items.properties;
    expect(entryProps.kind).toMatchObject({ enum: ['symlink', 'hardlink', 'special'] });
    expect(entryProps.unsafePath).toMatchObject({ type: 'boolean' });
    expect(entryProps.duplicate).toMatchObject({ type: 'boolean' });
  });
});
