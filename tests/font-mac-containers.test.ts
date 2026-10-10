import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { convertFile } from '../src/lib/conversions';
import { FontOutlinesMissingError } from '../src/lib/conversions/font';
import { crc16Xmodem, MacFontContainerError } from '../src/lib/conversions/font-mac-resource';
import { ConversionFailedError } from '../src/lib/types';
import {
  buildBitmapOnlyFork,
  buildDfont,
  buildMacBinary,
  buildResourceFork,
  buildResourceForkWithLayout,
  buildTrueTypeFont,
  crc16Table,
  refreshMacBinaryCrc,
} from './helpers/mac-font-containers';

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

const FIXTURE_OTF = path.join(__dirname, 'fixtures/golden/font/variable-geometric.otf');
const HAS_FC_SCAN = spawnSync('fc-scan', ['--version'], { stdio: 'ignore' }).status === 0;
// CI runs the oracles in strict mode: a missing fc-scan must fail there instead of skipping the oracle.
if (process.env.ORACLE_STRICT_MODE === '1' && !HAS_FC_SCAN) {
  throw new Error('ORACLE_STRICT_MODE requires fc-scan (fontconfig) for the font container oracle');
}

const SFNT_TRUETYPE = 0x00010000;
const SFNT_CFF_TAG = 'OTTO';
const WOFF_HEADER_SIZE = 44;
const WOFF_DIRECTORY_ENTRY_SIZE = 20;
const SFNT_HEADER_SIZE = 12;
const SFNT_DIRECTORY_ENTRY_SIZE = 16;
const NAME_ID_FAMILY = 1;
/** Hang guard only: a malformed container is refused in milliseconds; see ENGINE_TEST_TIMEOUT_MS. */
const REJECT_HANG_GUARD_MS = 30_000;
const CRC16_XMODEM_CHECK_VALUE = 0x31c3; // published check value for the ASCII string "123456789"

// ---------------------------------------------------------------------------
// Independent SFNT / WOFF readers (test-local; nothing from src/ is used as an oracle)
// ---------------------------------------------------------------------------

function readSfntTables(font: Buffer): Map<string, Buffer> {
  const tables = new Map<string, Buffer>();
  const numTables = font.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const base = SFNT_HEADER_SIZE + i * SFNT_DIRECTORY_ENTRY_SIZE;
    const tag = font.toString('latin1', base, base + 4);
    const offset = font.readUInt32BE(base + 8);
    const length = font.readUInt32BE(base + 12);
    tables.set(tag, font.subarray(offset, offset + length));
  }
  return tables;
}

function nameRecord(nameTable: Buffer, nameId: number): string {
  const count = nameTable.readUInt16BE(2);
  const stringStart = nameTable.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    const base = 6 + i * 12;
    if (nameTable.readUInt16BE(base) === 3 && nameTable.readUInt16BE(base + 6) === nameId) {
      const length = nameTable.readUInt16BE(base + 8);
      const offset = stringStart + nameTable.readUInt16BE(base + 10);
      return Buffer.from(nameTable.subarray(offset, offset + length)).swap16().toString('utf16le');
    }
  }
  throw new Error(`name record ${nameId} not found`);
}

function familyOf(font: Buffer): string {
  return nameRecord(readSfntTables(font).get('name')!, NAME_ID_FAMILY);
}

function checksum(data: Buffer): number {
  const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

/** Table checksum as recorded in directories: for 'head' the checkSumAdjustment field counts as zero. */
function directoryChecksum(tag: string, data: Buffer): number {
  if (tag !== 'head') return checksum(data);
  const zeroed = Buffer.from(data);
  zeroed.writeUInt32BE(0, 8);
  return checksum(zeroed);
}

function alignedLength(length: number): number {
  return Math.ceil(length / 4) * 4;
}

/** Decodes a WOFF 1.0 file per the W3C spec and returns the flavor, header fields and inflated tables. */
function decodeWoff(woff: Buffer) {
  expect(woff.toString('latin1', 0, 4)).toBe('wOFF');
  const flavor = woff.readUInt32BE(4);
  const declaredLength = woff.readUInt32BE(8);
  const numTables = woff.readUInt16BE(12);
  const totalSfntSize = woff.readUInt32BE(16);
  const tables = new Map<string, Buffer>();
  const entries: Array<{ tag: string; offset: number; compLength: number; origLength: number; origChecksum: number }> = [];
  for (let i = 0; i < numTables; i++) {
    const base = WOFF_HEADER_SIZE + i * WOFF_DIRECTORY_ENTRY_SIZE;
    const entry = {
      tag: woff.toString('latin1', base, base + 4),
      offset: woff.readUInt32BE(base + 4),
      compLength: woff.readUInt32BE(base + 8),
      origLength: woff.readUInt32BE(base + 12),
      origChecksum: woff.readUInt32BE(base + 16),
    };
    entries.push(entry);
    const stored = woff.subarray(entry.offset, entry.offset + entry.compLength);
    tables.set(entry.tag, entry.compLength < entry.origLength ? zlib.inflateSync(stored) : Buffer.from(stored));
  }
  return { flavor, declaredLength, numTables, totalSfntSize, entries, tables };
}

/** Rebuilds a plain SFNT file from decoded tables so fontconfig can inspect a WOFF payload. */
function rebuildSfnt(flavor: number, tables: Map<string, Buffer>): Buffer {
  const tags = [...tables.keys()].sort();
  const directory = Buffer.alloc(SFNT_HEADER_SIZE + tags.length * SFNT_DIRECTORY_ENTRY_SIZE);
  directory.writeUInt32BE(flavor, 0);
  directory.writeUInt16BE(tags.length, 4);
  let offset = directory.length;
  const bodies: Buffer[] = [];
  tags.forEach((tag, i) => {
    const body = tables.get(tag)!;
    const base = SFNT_HEADER_SIZE + i * SFNT_DIRECTORY_ENTRY_SIZE;
    directory.write(tag, base, 4, 'latin1');
    directory.writeUInt32BE(checksum(body), base + 4);
    directory.writeUInt32BE(offset, base + 8);
    directory.writeUInt32BE(body.length, base + 12);
    const padded = Buffer.concat([body, Buffer.alloc(alignedLength(body.length) - body.length)]);
    bodies.push(padded);
    offset += padded.length;
  });
  return Buffer.concat([directory, ...bodies]);
}

// ---------------------------------------------------------------------------
// fontconfig oracle
// ---------------------------------------------------------------------------

const FC_FORMAT = '%{family}|%{style}|%{fullname}|%{postscriptname}|%{charset}|%{fontformat}\n';

interface FcInfo {
  family: string;
  style: string;
  fullname: string;
  postscriptname: string;
  charset: string;
  fontformat: string;
}

let workDir = '';
let fileCounter = 0;

function fcScan(data: Buffer, extension: string): FcInfo {
  const file = path.join(workDir, `probe-${fileCounter++}.${extension}`);
  fs.writeFileSync(file, data);
  const line = execFileSync('fc-scan', ['--format', FC_FORMAT, file], { encoding: 'utf8' }).trim();
  const [family, style, fullname, postscriptname, charset, fontformat] = line.split('|');
  return { family, style, fullname, postscriptname, charset, fontformat };
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-mac-font-'));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const ALPHA_TTF = buildTrueTypeFont({ family: 'Alpha Sans' });
const BETA_TTF = buildTrueTypeFont({
  family: 'Beta Sans',
  glyphs: [{ codePoint: 0x5a, contours: [[[0, 0], [0, 500], [500, 500], [500, 0]]] }],
});

type Container = 'dfont' | 'bin';

function wrap(container: Container, fonts: Buffer[]): Buffer {
  const fork = buildDfont(fonts);
  return container === 'dfont' ? fork : buildMacBinary({ resourceFork: fork });
}

async function convert(input: Buffer, source: Container, target: string) {
  return convertFile(input, source, target, {}, `sample.${source}`);
}

async function expectContainerRejection(
  input: Buffer,
  source: Container,
  message: RegExp,
  kind: MacFontContainerError['kind'] = 'malformed'
): Promise<void> {
  const started = performance.now();
  const failure = await convert(input, source, 'ttf').then(
    () => null,
    (err: unknown) => err
  );
  expect(performance.now() - started).toBeLessThan(REJECT_HANG_GUARD_MS);
  expect(failure).toBeInstanceOf(MacFontContainerError);
  // The API maps ConversionFailedError to HTTP 400.
  expect(failure).toBeInstanceOf(ConversionFailedError);
  expect((failure as MacFontContainerError).kind).toBe(kind);
  expect((failure as MacFontContainerError).message).toMatch(message);
}

// ---------------------------------------------------------------------------
// Helper self-checks (guard the oracle inputs themselves)
// ---------------------------------------------------------------------------

describe('Mac font container helpers', () => {
  it('computes CRC-16/XMODEM to the published check value', () => {
    const sample = Buffer.from('123456789', 'ascii');
    expect(crc16Table(sample)).toBe(CRC16_XMODEM_CHECK_VALUE);
    expect(crc16Xmodem(sample)).toBe(CRC16_XMODEM_CHECK_VALUE);
  });

  // skip-ok: requireStrictFcScan / the ORACLE_STRICT_MODE check at the top of this file throws before this suite is collected when fc-scan is missing.
  it.skipIf(!HAS_FC_SCAN)('writes a resource fork that fontconfig itself opens as the wrapped font (needs fc-scan)', () => {
    const direct = fcScan(ALPHA_TTF, 'ttf');
    expect(direct.family).toBe('Alpha Sans');
    expect(fcScan(buildDfont([ALPHA_TTF]), 'dfont')).toEqual(direct);
  });
});

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

const OUTLINE_TARGETS = new Set(['ttf', 'otf']);
const PAIRS: ReadonlyArray<readonly [Container, string]> = [
  ['dfont', 'otf'],
  ['dfont', 'ttf'],
  ['dfont', 'woff'],
  ['bin', 'otf'],
  ['bin', 'ttf'],
];

describe('dfont and MacBinary font containers convert through convertFile', () => {
  const originalTables = readSfntTables(ALPHA_TTF);
  const originalNumGlyphs = 4; // .notdef plus the glyphs for A, B and C
  expect(originalTables.get('maxp')!.readUInt16BE(4)).toBe(originalNumGlyphs);

  it.each(PAIRS)('%s -> %s keeps outlines, names and the character set', async (source, target) => {
    const result = await convert(wrap(source, [ALPHA_TTF]), source, target);
    expect(result.filename).toBe(`sample.${target}`);
    expect(result.size).toBe(result.buffer.length);

    let sfnt: Buffer;
    if (target === 'woff') {
      expect(result.mimeType).toBe('font/woff');
      const woff = decodeWoff(result.buffer);
      expect(woff.flavor).toBe(SFNT_TRUETYPE);
      expect(woff.declaredLength).toBe(result.buffer.length);
      expect(woff.numTables).toBe(originalTables.size);
      expect(woff.entries.map((e) => e.tag).sort()).toEqual([...originalTables.keys()].sort());
      let expectedSfntSize = SFNT_HEADER_SIZE + woff.numTables * SFNT_DIRECTORY_ENTRY_SIZE;
      for (const entry of woff.entries) {
        const original = originalTables.get(entry.tag)!;
        expect(entry.origLength).toBe(original.length);
        expect(entry.origChecksum).toBe(directoryChecksum(entry.tag, original));
        expect(entry.offset % 4).toBe(0);
        expect(entry.offset + entry.compLength).toBeLessThanOrEqual(result.buffer.length);
        expect(woff.tables.get(entry.tag)!.equals(original)).toBe(true);
        expectedSfntSize += alignedLength(original.length);
      }
      expect(woff.totalSfntSize).toBe(expectedSfntSize);
      sfnt = rebuildSfnt(woff.flavor, woff.tables);
    } else if (target === 'ttf') {
      expect(result.mimeType).toBe('font/ttf');
      expect(result.buffer.readUInt32BE(0)).toBe(SFNT_TRUETYPE);
      sfnt = result.buffer;
      const tables = readSfntTables(sfnt);
      for (const tag of ['glyf', 'loca', 'cmap', 'name', 'head', 'hmtx']) {
        expect(tables.get(tag)!.equals(originalTables.get(tag)!)).toBe(true);
      }
    } else {
      expect(result.mimeType).toBe('font/otf');
      expect(result.buffer.toString('latin1', 0, 4)).toBe(SFNT_CFF_TAG);
      sfnt = result.buffer;
      const tables = readSfntTables(sfnt);
      expect(tables.has('CFF ')).toBe(true);
      expect(tables.has('glyf')).toBe(false);
    }

    const tables = readSfntTables(sfnt);
    expect(familyOf(sfnt)).toBe('Alpha Sans');
    expect(tables.get('maxp')!.readUInt16BE(4)).toBe(originalNumGlyphs);
  });

  // skip-ok: requireStrictFcScan / the ORACLE_STRICT_MODE check at the top of this file throws before this suite is collected when fc-scan is missing.
  it.skipIf(!HAS_FC_SCAN).each(PAIRS)(
    '%s -> %s is read by fontconfig as the same face as the original TrueType font (needs fc-scan)',
    async (source, target) => {
      const original = fcScan(ALPHA_TTF, 'ttf');
      expect(original.charset).toBe('41-43');
      const result = await convert(wrap(source, [ALPHA_TTF]), source, target);
      let probe = result.buffer;
      if (target === 'woff') {
        const woff = decodeWoff(result.buffer);
        probe = rebuildSfnt(woff.flavor, woff.tables);
      }
      const converted = fcScan(probe, target === 'woff' ? 'ttf' : target);
      expect(converted.family).toBe(original.family);
      expect(converted.style).toBe(original.style);
      expect(converted.fullname).toBe(original.fullname);
      expect(converted.postscriptname).toBe(original.postscriptname);
      expect(converted.charset).toBe(original.charset);
      expect(converted.fontformat).toBe(target === 'otf' ? 'CFF' : 'TrueType');
    }
  );

  it.each(PAIRS.filter(([, target]) => OUTLINE_TARGETS.has(target)))(
    '%s -> %s rejects the repository golden font because it has no glyph outlines to convert',
    async (source, target) => {
      // The golden font carries identity tables only (no glyf, loca or CFF), so a TrueType or CFF file
      // would need invented glyphs: the engine fails closed with a typed error.
      const fixture = fs.readFileSync(FIXTURE_OTF);
      const failure = await convert(wrap(source, [fixture]), source, target).then(
        () => null,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(FontOutlinesMissingError);
      expect(failure).toBeInstanceOf(ConversionFailedError);
      expect((failure as Error).message).toMatch(/no glyph outlines/);
    }
  );

  it.each(PAIRS.filter(([, target]) => !OUTLINE_TARGETS.has(target)))('%s -> %s preserves the identity tables of the repository golden font', async (source, target) => {
    const fixture = fs.readFileSync(FIXTURE_OTF);
    const fixtureTables = readSfntTables(fixture);
    const result = await convert(wrap(source, [fixture]), source, target);
    const outputTables =
      target === 'woff' ? decodeWoff(result.buffer).tables : readSfntTables(result.buffer);
    expect(familyOf(rebuildSfnt(SFNT_TRUETYPE, outputTables))).toBe(familyOf(fixture));
    // The engine regenerates outline tables when targeting TrueType/CFF; name, fvar and STAT describe the variable family.
    for (const tag of ['name', 'fvar', 'STAT']) {
      expect(outputTables.get(tag)!.equals(fixtureTables.get(tag)!), `table ${tag}`).toBe(true);
    }
  });

  it('picks the first sfnt resource in resource-map order from a suitcase', async () => {
    // The first face has the higher resource id, so id order and map order disagree.
    const fork = buildResourceFork([
      { type: 'sfnt', id: 300, data: ALPHA_TTF },
      { type: 'sfnt', id: 129, data: BETA_TTF },
    ]);
    for (const input of [fork, buildMacBinary({ resourceFork: fork })]) {
      const source: Container = input === fork ? 'dfont' : 'bin';
      const result = await convert(input, source, 'ttf');
      expect(familyOf(result.buffer)).toBe('Alpha Sans');
    }
  });

  it('skips non-font resources that precede the sfnt resource', async () => {
    const fork = buildResourceFork([
      { type: 'FOND', id: 128, name: 'Alpha Sans', data: Buffer.alloc(52, 0x33) },
      { type: 'sfnt', id: 128, name: 'Alpha Sans', data: ALPHA_TTF },
    ]);
    const result = await convert(fork, 'dfont', 'ttf');
    expect(familyOf(result.buffer)).toBe('Alpha Sans');
  });

  it('reads MacBinary III headers and an unpadded final fork', async () => {
    const full = buildMacBinary({ version: 'III', resourceFork: buildDfont([ALPHA_TTF]) });
    expect(full.toString('latin1', 102, 106)).toBe('mBIN');
    const forkLength = full.readUInt32BE(87);
    const unpadded = full.subarray(0, 128 + forkLength);
    for (const input of [full, unpadded]) {
      const result = await convert(input, 'bin', 'ttf');
      expect(familyOf(result.buffer)).toBe('Alpha Sans');
    }
  });

  it('falls back to an SFNT stored in the MacBinary data fork', async () => {
    const dataForkOnly = buildMacBinary({ dataFork: ALPHA_TTF });
    expect(familyOf((await convert(dataForkOnly, 'bin', 'ttf')).buffer)).toBe('Alpha Sans');

    const bitmapResourcesPlusDataFont = buildMacBinary({ dataFork: ALPHA_TTF, resourceFork: buildBitmapOnlyFork() });
    expect(familyOf((await convert(bitmapResourcesPlusDataFont, 'bin', 'ttf')).buffer)).toBe('Alpha Sans');
  });

  it('prefers the resource-fork sfnt over a data-fork SFNT', async () => {
    const both = buildMacBinary({ dataFork: BETA_TTF, resourceFork: buildDfont([ALPHA_TTF]) });
    expect(familyOf((await convert(both, 'bin', 'ttf')).buffer)).toBe('Alpha Sans');
  });
});

// ---------------------------------------------------------------------------
// Hostile inputs: every one must fail fast with the typed error and never emit output
// ---------------------------------------------------------------------------

describe('hostile dfont resource forks are rejected with a typed error', () => {
  const layout = buildResourceForkWithLayout([
    { type: 'sfnt', id: 128, data: ALPHA_TTF },
    { type: 'FOND', id: 128, data: Buffer.alloc(40, 0x44) },
  ]);
  const valid = layout.fork;
  const patched = (edit: (copy: Buffer) => void): Buffer => {
    const copy = Buffer.from(valid);
    edit(copy);
    return copy;
  };

  it('accepts the unmodified fork (control)', async () => {
    expect(familyOf((await convert(valid, 'dfont', 'ttf')).buffer)).toBe('Alpha Sans');
  });

  it('rejects a truncated header', async () => {
    await expectContainerRejection(valid.subarray(0, 10), 'dfont', /truncated header/);
  });

  it('rejects an sfnt resource whose table directory is cut short', async () => {
    const hollow = Buffer.alloc(SFNT_HEADER_SIZE);
    hollow.writeUInt32BE(SFNT_TRUETYPE, 0);
    hollow.writeUInt16BE(50, 4);
    const run = convert(buildDfont([hollow]), 'dfont', 'ttf');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toThrow(/directory of 50 tables is cut short/);
  });

  it('rejects an sfnt resource whose table extends past its end', async () => {
    const clipped = ALPHA_TTF.subarray(0, ALPHA_TTF.length - 8);
    const run = convert(buildDfont([clipped]), 'dfont', 'ttf');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toThrow(/extends past the end of the font/);
  });

  it('rejects every truncation of the fork, which always cuts into the resource map', async () => {
    for (let length = 1; length < valid.length; length += 7) {
      const failure = await convert(valid.subarray(0, length), 'dfont', 'ttf').then(
        () => null,
        (err: unknown) => err
      );
      expect((failure as Error | null)?.message, `length ${length}`).toMatch(/^Invalid Macintosh resource fork: /);
      expect((failure as MacFontContainerError).kind).toBe('malformed');
    }
  });

  it('rejects a resource map offset beyond the end of the file', async () => {
    await expectContainerRejection(
      patched((b) => b.writeUInt32BE(valid.length + 4096, 4)),
      'dfont',
      /resource map is outside the file/
    );
  });

  it('rejects a map length that overflows 32-bit arithmetic', async () => {
    await expectContainerRejection(
      patched((b) => b.writeUInt32BE(0xfffffff0, 12)),
      'dfont',
      /resource map is outside the file/
    );
  });

  it('rejects a data area that runs past the end of the file', async () => {
    await expectContainerRejection(
      patched((b) => b.writeUInt32BE(0xffffffff, 8)),
      'dfont',
      /data area is outside the file/
    );
  });

  it('rejects a data area that overlaps the resource map', async () => {
    await expectContainerRejection(
      patched((b) => b.writeUInt32BE(layout.mapOffset - 100, 0)),
      'dfont',
      /data area overlaps the resource map|data area is outside the file/
    );
  });

  it('rejects a type list offset outside the map', async () => {
    await expectContainerRejection(
      patched((b) => b.writeUInt16BE(0xfff0, layout.mapOffset + 24)),
      'dfont',
      /type list offset is outside the resource map/
    );
  });

  it('rejects an absurd resource type count', async () => {
    await expectContainerRejection(
      patched((b) => b.writeUInt16BE(0x7ffe, layout.typeListOffset)),
      'dfont',
      /implausible resource type count/
    );
  });

  it('rejects a type list that runs past the map', async () => {
    await expectContainerRejection(
      patched((b) => b.writeUInt16BE(500, layout.typeListOffset)),
      'dfont',
      /type list runs past the resource map/
    );
  });

  it('rejects a reference list that loops back into the type list', async () => {
    await expectContainerRejection(
      patched((b) => b.writeUInt16BE(0, layout.typeEntryOffsets[0] + 6)),
      'dfont',
      /reference list of type 'sfnt' points into the type list/
    );
  });

  it('rejects two types sharing (overlapping) one reference list', async () => {
    await expectContainerRejection(
      patched((b) => b.writeUInt16BE(b.readUInt16BE(layout.typeEntryOffsets[0] + 6), layout.typeEntryOffsets[1] + 6)),
      'dfont',
      /overlapping reference lists/
    );
  });

  it('rejects an implausible resource reference count', async () => {
    await expectContainerRejection(
      patched((b) => b.writeUInt16BE(0xffff, layout.typeEntryOffsets[0] + 4)),
      'dfont',
      /implausible resource count|runs past the resource map/
    );
  });

  it('rejects a resource whose data offset is outside the data area', async () => {
    await expectContainerRejection(
      patched((b) => b.writeUInt32BE(0x00fffff0, layout.refEntryOffsets[0] + 4)),
      'dfont',
      /starts outside the data area/
    );
  });

  it('rejects a resource length that runs past the data area', async () => {
    await expectContainerRejection(
      patched((b) => b.writeUInt32BE(0xfffffff0, 256)), // first resource's length prefix
      'dfont',
      /runs past the data area/
    );
  });

  it('rejects two resources sharing the same data', async () => {
    const twin = buildResourceForkWithLayout([
      { type: 'sfnt', id: 128, data: ALPHA_TTF },
      { type: 'sfnt', id: 129, data: BETA_TTF },
    ]);
    const copy = Buffer.from(twin.fork);
    copy.writeUInt32BE(copy.readUInt32BE(twin.refEntryOffsets[0] + 4), twin.refEntryOffsets[1] + 4);
    await expectContainerRejection(copy, 'dfont', /overlapping resource data/);
  });

  it('rejects an sfnt resource that is not an SFNT font', async () => {
    const junk = buildResourceFork([{ type: 'sfnt', id: 128, data: Buffer.from('this is not a font at all') }]);
    await expectContainerRejection(junk, 'dfont', /is not an SFNT font/);
  });

  it('rejects an out-of-range resource name offset', async () => {
    const named = buildResourceForkWithLayout([{ type: 'sfnt', id: 128, name: 'Alpha', data: ALPHA_TTF }]);
    const copy = Buffer.from(named.fork);
    copy.writeUInt16BE(0x7000, named.refEntryOffsets[0] + 2);
    await expectContainerRejection(copy, 'dfont', /name offset is outside the resource map/);
  });

  it('rejects a bitmap-only (NFNT/FOND) suitcase with a message that says so', async () => {
    await expectContainerRejection(buildBitmapOnlyFork(), 'dfont', /only holds bitmap\/FOND font resources \(FOND, NFNT\)/, 'bitmap-only');
  });

  it('rejects a fork with no font resources at all', async () => {
    const icons = buildResourceFork([{ type: 'ICON', id: 128, data: Buffer.alloc(128, 0x55) }]);
    await expectContainerRejection(icons, 'dfont', /no 'sfnt' font resource \(resource types found: ICON\)/, 'no-font');
  });

  it('rejects arbitrary non-resource bytes declared as dfont', async () => {
    await expectContainerRejection(Buffer.alloc(300, 0xab), 'dfont', /Invalid Macintosh resource fork/);
    await expectContainerRejection(ALPHA_TTF, 'dfont', /Invalid Macintosh resource fork/);
  });
});

describe('hostile MacBinary files are rejected with a typed error', () => {
  const fork = buildDfont([ALPHA_TTF]);
  const valid = buildMacBinary({ resourceFork: fork });
  const patched = (edit: (copy: Buffer) => void, refreshCrc = true): Buffer => {
    const copy = Buffer.from(valid);
    edit(copy);
    if (refreshCrc) refreshMacBinaryCrc(copy);
    return copy;
  };

  it('accepts the unmodified file (control)', async () => {
    expect(familyOf((await convert(valid, 'bin', 'ttf')).buffer)).toBe('Alpha Sans');
  });

  it('rejects a truncated header', async () => {
    await expectContainerRejection(valid.subarray(0, 100), 'bin', /truncated 128-byte header/);
  });

  it('rejects every truncation that cuts into the resource fork', async () => {
    const validLength = 128 + fork.length;
    for (let length = 1; length < validLength; length += 11) {
      const failure = await convert(valid.subarray(0, length), 'bin', 'ttf').then(
        () => null,
        (err: unknown) => err
      );
      expect((failure as Error | null)?.message, `length ${length}`).toMatch(/^Invalid (?:MacBinary file|Macintosh resource fork): /);
      expect((failure as MacFontContainerError).kind).toBe('malformed');
    }
  });

  it('rejects a header whose CRC does not match', async () => {
    await expectContainerRejection(
      patched((b) => {
        b[10] ^= 0xff; // alter the filename without refreshing the CRC
      }, false),
      'bin',
      /CRC-16 mismatch/
    );
    await expectContainerRejection(
      patched((b) => b.writeUInt16BE(b.readUInt16BE(124) ^ 1, 124), false),
      'bin',
      /CRC-16 mismatch/
    );
  });

  it.each([
    ['version byte 0', 0, 1],
    ['zero byte 74', 74, 1],
    ['zero byte 82', 82, 1],
  ])('rejects a non-zero %s', async (_label, offset, value) => {
    await expectContainerRejection(
      patched((b) => {
        b[offset] = value;
      }),
      'bin',
      /zero bytes \(0, 74, 82\) are not zero/
    );
  });

  it.each([0, 64, 255])('rejects filename length %i', async (length) => {
    await expectContainerRejection(
      patched((b) => {
        b[1] = length;
      }),
      'bin',
      /filename length/
    );
  });

  it('rejects fork lengths that overflow the file', async () => {
    await expectContainerRejection(
      patched((b) => b.writeUInt32BE(0xfffffff0, 83)),
      'bin',
      /fork lengths run past the end of the file/
    );
    await expectContainerRejection(
      patched((b) => b.writeUInt32BE(0xffffffff, 87)),
      'bin',
      /fork lengths run past the end of the file/
    );
    await expectContainerRejection(
      patched((b) => b.writeUInt32BE(valid.length, 83)), // data fork claims the whole file, pushing the resource fork out
      'bin',
      /fork lengths run past the end of the file/
    );
  });

  it('rejects a secondary header length that points outside the file', async () => {
    await expectContainerRejection(
      patched((b) => b.writeUInt16BE(0xffff, 120)),
      'bin',
      /fork lengths run past the end of the file/
    );
  });

  it('rejects an unrecognised pre-MacBinary-II header version', async () => {
    await expectContainerRejection(
      patched((b) => {
        b[122] = 0;
        b[123] = 7;
      }, false),
      'bin',
      /unrecognised header version/
    );
  });

  it('rejects a corrupt resource fork inside a valid MacBinary wrapper', async () => {
    const broken = Buffer.from(fork);
    broken.writeUInt32BE(fork.length + 100, 4);
    await expectContainerRejection(buildMacBinary({ resourceFork: broken }), 'bin', /resource map is outside the file/);
  });

  it('rejects a bitmap-only NFNT/FOND file with a message that says so', async () => {
    await expectContainerRejection(
      buildMacBinary({ resourceFork: buildBitmapOnlyFork() }),
      'bin',
      /only holds bitmap\/FOND font resources/,
      'bitmap-only'
    );
  });

  it('rejects a MacBinary file with no font in either fork', async () => {
    await expectContainerRejection(
      buildMacBinary({ dataFork: Buffer.from('plain text, not a font') }),
      'bin',
      /neither the resource fork nor the data fork contains an SFNT font/,
      'no-font'
    );
  });

  it('rejects bare SFNT bytes and arbitrary data declared as bin', async () => {
    await expectContainerRejection(ALPHA_TTF, 'bin', /Invalid MacBinary file/);
    await expectContainerRejection(Buffer.alloc(400, 0xcd), 'bin', /Invalid MacBinary file/);
  });
});
