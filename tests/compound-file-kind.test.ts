import { describe, expect, it } from 'vitest';
import { parseCfbf, type CfbfContainer } from '../src/lib/conversions/hwp';
import {
  compoundFileVerdict,
  compoundFileVerdictFrom,
  compoundFileVerdictFromAsync,
  readCompoundFileRoot,
  readCompoundFileRootFrom,
  type ByteSource,
} from '../src/lib/compound-file-kind';
import { HEADER_WINDOW_BYTES } from '../src/lib/format-signatures';
import { buildCompoundFile, placeDirectory } from './helpers/cfb-craft';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * Which kind a compound file is, read from the class ID of the root storage and the names in the root directory, for the formats
 * that exist only as compound files (#783). The rules are the ones the engines apply: libmagic `Magdir/ole2compounddocs` (class
 * IDs of the StarOffice 3 to 5 documents and of Corel Presentations), LibreOffice `include/comphelper/classids.hxx`, Apache Tika
 * `POIFSContainerDetector` (the stream names of StarCalc, StarWriter and StarDraw) and libwps `WPSHeader` (the Quattro Pro 9
 * stream). The GUIDs below are typed from those files, not taken from the module under test.
 */

const KINDS = ['sdw', 'sdc', 'sda', 'shw', 'qpw'] as const;

/** libmagic ole2compounddocs lines 642-652 and 660-713; LibreOffice classids.hxx lines 28-212. */
const STAR_WRITER_30 = 'DC5C7E40-B35C-101B-9961-04021C007002';
const STAR_WRITER_40 = '8B04E9B0-420E-11D0-A45E-00A0249D57B1';
const STAR_WRITER_50 = 'C20CF9D1-85AE-11D1-AAB4-006097DA561A';
const STAR_CALC_30 = '3F543FA0-B6A6-101B-9961-04021C007002';
const STAR_CALC_40 = '6361D441-4235-11D0-89CB-008029E4B0B1';
const STAR_CALC_50 = 'C6A5B861-85D6-11D1-89CB-008029E4B0B1';
const STAR_DRAW_30 = 'AF10AAE0-B36D-101B-9961-04021C007002';
const STAR_DRAW_50 = '2E8905A0-85BD-11D1-89D0-008029E4B0B1';
const STAR_IMPRESS_40 = '012D3CC0-4216-11D0-89CB-008029E4B0B1';
const STAR_IMPRESS_50 = '565C7221-85BC-11D1-89D0-008029E4B0B1';
const COREL_PRESENTATIONS = '402EFE62-1999-101B-99AE-04021C007002';
const WORDPERFECT_7_DOCUMENT = '519873FF-2DAD-0220-1937-0000929679CD';
/** The root class ID of the Quattro Pro 9 sample, which no rule database lists. */
const QUATTRO_PRO_9_SAMPLE = 'EB626F5C-12A9-4F24-A0FC-01B5C2534C35';
/** Microsoft Excel 97-2003 (libmagic `ole2compounddocs` line 329 gives its bytes), a kind this check does not accept under any of the five names. */
const EXCEL_97 = '00020820-0000-0000-C000-000000000046';
/** The root class IDs of Word, Excel and PowerPoint files (libmagic 5.41 `ole2compounddocs` lines 295, 300, 322, 329, 357, 408 and 415, typed from the bytes there). */
const OFFICE_CLASS_IDS: readonly (readonly [string, string])[] = [
  ['Word 6-95', '00020900-0000-0000-C000-000000000046'],
  ['Word 97-2003', '00020906-0000-0000-C000-000000000046'],
  ['Excel 5-95', '00020810-0000-0000-C000-000000000046'],
  ['Excel 97-2003', EXCEL_97],
  ['PowerPoint 4', '00044851-0000-0000-C000-000000000046'],
  ['PowerPoint 95', 'EA7BAE70-FB3B-11CD-A903-00AA00510EA3'],
  ['PowerPoint 97-2003', '64818D10-4F9B-11CF-86EA-00AA00B929E8'],
];

/** The stream that names each kind (Tika `POIFSContainerDetector` lines 311-316, libwps `WPSHeader` line 220). */
const NAMING_STREAM: Readonly<Record<string, string>> = {
  sdw: 'StarWriterDocument',
  sdc: 'StarCalcDocument',
  sda: 'StarDrawDocument3',
  qpw: 'NativeContent_MAIN',
};

const SECTOR = 512;
const CLASS_ID_OFFSET = 80;
const ENTRY_TYPE_OFFSET = 66;
const FIRST_DIRECTORY_SECTOR_OFFSET = 48;

function guidBytes(guid: string): Buffer {
  const [d1, d2, d3, d4, d5] = guid.split('-');
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(parseInt(d1, 16), 0);
  bytes.writeUInt16LE(parseInt(d2, 16), 4);
  bytes.writeUInt16LE(parseInt(d3, 16), 6);
  Buffer.from(d4 + d5, 'hex').copy(bytes, 8);
  return bytes;
}

const rootEntryOffset = (file: Buffer): number => (file.readUInt32LE(FIRST_DIRECTORY_SECTOR_OFFSET) + 1) * SECTOR;

/** A compound file with the given top-level stream names (a name with a slash puts the stream in a storage) and root class ID. */
function compound(names: readonly string[], classId?: string): Buffer {
  const file = buildCompoundFile(names.map((name) => ({ name, data: Buffer.from('x') })));
  if (classId !== undefined) guidBytes(classId).copy(file, rootEntryOffset(file) + CLASS_ID_OFFSET);
  return file;
}

describe('the real compound files of the five kinds', () => {
  const REAL_FILES: readonly (readonly [(typeof KINDS)[number], string])[] = [
    ['sdw', 'lo-sfxstandalonedocinfoobject.sdw'],
    ['sdw', 'lo-writer_3.1.sdw'],
    ['sdw', 'tika-teststaroffice-5.2-writer.sdw'],
    ['sdc', 'lo-calc_3.1.sdc'],
    ['sdc', 'tika-teststaroffice-5.2-calc.sdc'],
    ['sda', 'lo-draw_3.1.sda'],
    ['sda', 'tika-teststaroffice-5.2-draw.sda'],
    ['shw', 'office-testcorel.shw'],
    ['shw', 'tika-testcorel.shw'],
    ['qpw', 'opf-testquattro.qpw'],
  ];

  it.for(REAL_FILES)('is a .%s file: %s, and none of the other four', async ([kind, id], ctx) => {
    const sample = await requireRealworldSample(ctx, id);
    for (const claimed of KINDS) {
      expect(compoundFileVerdict(claimed, sample.bytes), `${id} claimed as .${claimed}`).toBe(claimed === kind ? 'match' : 'mismatch');
    }
  });

  it.for(REAL_FILES)('lists the same root names as the full parser reads: %s', async ([, id], ctx) => {
    const sample = await requireRealworldSample(ctx, id);
    const root = readCompoundFileRoot(sample.bytes);
    expect(root.status).toBe('read');
    if (root.status !== 'read') return;
    expect(root.complete).toBe(true);
    expect([...root.names].sort()).toEqual(topLevelNames(parseCfbf(sample.bytes)).sort());
  });

  it.for([
    ['lo-writer_3.1.sdw', STAR_WRITER_30],
    ['lo-calc_3.1.sdc', STAR_CALC_30],
    ['lo-draw_3.1.sda', STAR_DRAW_30],
    ['tika-teststaroffice-5.2-writer.sdw', STAR_WRITER_50],
    ['tika-teststaroffice-5.2-calc.sdc', STAR_CALC_50],
    ['tika-teststaroffice-5.2-draw.sda', STAR_DRAW_50],
    ['office-testcorel.shw', COREL_PRESENTATIONS],
    ['opf-testquattro.qpw', QUATTRO_PRO_9_SAMPLE],
  ] as const)('reads the class ID of %s as %s', async ([id, classId], ctx) => {
    const sample = await requireRealworldSample(ctx, id);
    const root = readCompoundFileRoot(sample.bytes);
    expect(root.status === 'read' ? root.classId : undefined).toBe(classId);
  });
});

/** The uppercase names of the entries under the root of a parsed container, following child and sibling links. */
function topLevelNames(container: CfbfContainer): string[] {
  const byId = new Map(container.directoryEntries.map((entry) => [entry.id, entry]));
  const root = container.directoryEntries.find((entry) => entry.type === 5);
  const names: string[] = [];
  const pending = root ? [root.childId] : [];
  while (pending.length > 0) {
    const entry = byId.get(pending.pop() as number);
    if (entry === undefined) continue;
    names.push(entry.name.toUpperCase());
    pending.push(entry.leftSiblingId, entry.rightSiblingId);
  }
  return names;
}

describe('a compound file told apart by the streams of its root directory', () => {
  it.for(Object.entries(NAMING_STREAM))('is a .%s file when it holds %s, whatever its class ID', ([kind, stream]) => {
    for (const classId of [undefined, QUATTRO_PRO_9_SAMPLE]) {
      expect(compoundFileVerdict(kind, compound([stream, '\u0005SummaryInformation'], classId))).toBe('match');
    }
  });

  it('reads the names without regard to case, as Tika compares them', () => {
    expect(compoundFileVerdict('sdw', compound(['starwriterdocument']))).toBe('match');
  });

  it('folds the letters a to z only, so a long s or a dotless i does not spell a name as the office suite reads it', () => {
    expect(compoundFileVerdict('sdc', compound(['\u017ftarcalcdocument']))).toBe('mismatch');
    expect(compoundFileVerdict('sdc', compound(['StarCalcDocument']))).toBe('match');
    expect(compoundFileVerdict('qpw', compound(['nativecontent_ma\u0131n']))).toBe('mismatch');
    expect(compoundFileVerdict('qpw', compound(['nativecontent_main']))).toBe('match');
  });

  it.for(Object.entries(NAMING_STREAM))('refuses the .%s stream under the names of the other kinds', ([kind, stream]) => {
    const file = compound([stream]);
    for (const claimed of KINDS.filter((candidate) => candidate !== kind)) {
      expect(compoundFileVerdict(claimed, file), `${stream} claimed as .${claimed}`).toBe('mismatch');
    }
  });

  it('takes a StarDraw document for the Draw and the Impress name alike, as its stream is one for both', () => {
    expect(compoundFileVerdict('sda', compound([NAMING_STREAM.sda]))).toBe('match');
  });

  it('lets the Excel workbook stream decide first, as Tika checks it before the StarOffice names', () => {
    expect(compoundFileVerdict('sdc', compound(['Workbook', NAMING_STREAM.sdc]))).toBe('mismatch');
  });

  it('refuses the streams of a Word, Excel or PowerPoint file and of a file with no known stream', () => {
    for (const streams of [['WordDocument', '1Table'], ['Workbook'], ['PowerPoint Document'], ['VisioDocument'], ['Contents'], []]) {
      for (const kind of KINDS) expect(compoundFileVerdict(kind, compound(streams, EXCEL_97)), `${streams.join()} as .${kind}`).toBe('mismatch');
    }
  });

  it('looks at the names under the root only, so a stream inside another storage names nothing', () => {
    const embedded = compound(['WordDocument', 'ObjectPool/StarWriterDocument']);
    expect(compoundFileVerdict('sdw', embedded)).toBe('mismatch');
  });
});

describe('a compound file told apart by the class ID of its root storage', () => {
  it.for([
    ['sdw', STAR_WRITER_30],
    ['sdw', STAR_WRITER_40],
    ['sdw', STAR_WRITER_50],
    ['sdc', STAR_CALC_30],
    ['sdc', STAR_CALC_40],
    ['sdc', STAR_CALC_50],
    ['sda', STAR_DRAW_30],
    ['sda', STAR_DRAW_50],
    ['shw', COREL_PRESENTATIONS],
  ] as const)('is a .%s file with the class ID %s', ([kind, classId]) => {
    expect(compoundFileVerdict(kind, compound(['\u0005SummaryInformation'], classId))).toBe('match');
  });

  it('refuses a class ID under the names of the other four kinds', () => {
    const owners: readonly (readonly [string, string])[] = [['sdw', STAR_WRITER_50], ['sdc', STAR_CALC_50], ['sda', STAR_DRAW_50], ['shw', COREL_PRESENTATIONS]];
    for (const [owner, classId] of owners) {
      for (const claimed of KINDS.filter((kind) => kind !== owner)) {
        expect(compoundFileVerdict(claimed, compound(['x'], classId)), `${classId} as .${claimed}`).toBe('mismatch');
      }
    }
  });

  it('takes the StarOffice 3 Draw class ID, which StarOffice 3 gives to Impress too, as a Draw file but not as Writer or Calc', () => {
    const file = compound([], STAR_DRAW_30);
    expect(compoundFileVerdict('sda', file)).toBe('match');
    expect(compoundFileVerdict('sdw', file)).toBe('mismatch');
    expect(compoundFileVerdict('sdc', file)).toBe('mismatch');
  });

  it('keeps the Impress class IDs out of .sda, since Impress is a presentation and its name is .sdd', () => {
    expect(compoundFileVerdict('sda', compound([], STAR_IMPRESS_40))).toBe('mismatch');
    expect(compoundFileVerdict('sda', compound([], STAR_IMPRESS_50))).toBe('mismatch');
  });

  it('refuses a wrong class ID even when the streams name the claimed kind', () => {
    expect(compoundFileVerdict('sdw', compound([NAMING_STREAM.sdw], STAR_CALC_30))).toBe('mismatch');
    expect(compoundFileVerdict('sdc', compound([NAMING_STREAM.sdc], STAR_WRITER_50))).toBe('mismatch');
    expect(compoundFileVerdict('qpw', compound([NAMING_STREAM.qpw], WORDPERFECT_7_DOCUMENT))).toBe('mismatch');
  });

  it('refuses a correct class ID when the streams name another kind', () => {
    expect(compoundFileVerdict('sdw', compound([NAMING_STREAM.sdc], STAR_WRITER_30))).toBe('mismatch');
    expect(compoundFileVerdict('sdc', compound([NAMING_STREAM.sdw], STAR_CALC_50))).toBe('mismatch');
  });

  it('accepts a class ID that no database lists when the streams name the claimed kind, as Tika never reads the class ID', () => {
    expect(compoundFileVerdict('qpw', compound([NAMING_STREAM.qpw], QUATTRO_PRO_9_SAMPLE))).toBe('match');
    expect(compoundFileVerdict('sdw', compound([NAMING_STREAM.sdw], '12345678-1234-1234-1234-123456789ABC'))).toBe('match');
  });

  it.for(OFFICE_CLASS_IDS)('refuses the root class ID of a %s file under all five names, whatever streams it holds', ([, classId]) => {
    for (const [kind, stream] of Object.entries(NAMING_STREAM)) {
      expect(compoundFileVerdict(kind, compound([stream], classId)), `${classId} with ${stream} as .${kind}`).toBe('mismatch');
    }
    expect(compoundFileVerdict('shw', compound(['PerfectOffice_MAIN'], classId))).toBe('mismatch');
  });

  it('needs the class ID for Corel Presentations, whose streams no engine uses to name it', () => {
    expect(compoundFileVerdict('shw', compound(['PerfectOffice_MAIN', 'SlideShow/Main']))).toBe('mismatch');
    expect(compoundFileVerdict('shw', compound(['PerfectOffice_MAIN', 'SlideShow/Main'], COREL_PRESENTATIONS))).toBe('match');
    expect(compoundFileVerdict('shw', compound(['PerfectOffice_MAIN'], WORDPERFECT_7_DOCUMENT))).toBe('mismatch');
  });
});

describe('a compound file whose root cannot be read', () => {
  const stub = (): Buffer => Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]);

  it('is refused when the header names no directory, whatever the kind', () => {
    for (const kind of KINDS) expect(compoundFileVerdict(kind, stub())).toBe('mismatch');
  });

  it('is refused when the first directory entry is not the root storage', () => {
    for (const type of [0, 1, 2]) {
      const file = compound([NAMING_STREAM.sdw], STAR_WRITER_50);
      file.writeUInt8(type, rootEntryOffset(file) + ENTRY_TYPE_OFFSET);
      expect(readCompoundFileRoot(file).status).toBe('malformed');
      expect(compoundFileVerdict('sdw', file)).toBe('mismatch');
    }
  });

  it('is refused when the sector shift is neither 9 nor 12', () => {
    const file = compound([NAMING_STREAM.sdw]);
    file.writeUInt16LE(10, 30);
    expect(compoundFileVerdict('sdw', file)).toBe('mismatch');
  });

  it('is refused when the file is shorter than its header', () => {
    expect(compoundFileVerdict('sdw', compound([NAMING_STREAM.sdw]).subarray(0, 400))).toBe('mismatch');
  });

  it('is refused when the directory chain returns to a sector it has read', () => {
    const file = compound(Array.from({ length: 8 }, (_, index) => `Stream${index}`));
    const fatSector = file.readUInt32LE(76);
    file.writeUInt32LE(0, (fatSector + 1) * SECTOR + 4);
    expect(readCompoundFileRoot(file).status).toBe('malformed');
    expect(compoundFileVerdict('sdw', file)).toBe('mismatch');
  });

  it('is refused when the sibling links of the directory tree return to an entry', () => {
    const file = compound([NAMING_STREAM.sdw, 'Other']);
    const second = rootEntryOffset(file) + 128;
    file.writeUInt32LE(1, second + 72);
    expect(readCompoundFileRoot(file).status).toBe('malformed');
    expect(compoundFileVerdict('sdw', file)).toBe('mismatch');
  });

  it('is refused when the directory declares more entries than the parser reads', () => {
    const entries = 65_536 + 32;
    const file = directoryOfEmptyEntries(entries);
    const started = performance.now();
    expect(compoundFileVerdict('sdw', file)).toBe('mismatch');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  describe('because the directory lies past the bytes given', () => {
    const SECTORS_IN_WINDOW = HEADER_WINDOW_BYTES / SECTOR;

    /** The header of a Writer file that names its directory in sector `sector`, in a buffer of `length` bytes, with that directory copied there when it fits. */
    function withDirectoryAt(sector: number, length: number): Buffer {
      const source = compound([NAMING_STREAM.sdw], STAR_WRITER_50);
      const file = Buffer.alloc(length);
      source.copy(file, 0, 0, SECTOR);
      file.writeUInt32LE(sector, FIRST_DIRECTORY_SECTOR_OFFSET);
      file.writeUInt32LE(0, 44);
      const directory = rootEntryOffset(source);
      source.copy(file, (sector + 1) * SECTOR, directory, directory + SECTOR);
      return file;
    }

    it('is unreadable, not wrong, when the buffer ends before the directory', () => {
      for (const length of [HEADER_WINDOW_BYTES, SECTOR + 4, 3 * SECTOR]) {
        const file = withDirectoryAt(SECTORS_IN_WINDOW + 40, length);
        expect(readCompoundFileRoot(file).status).toBe('unreadable');
        expect(compoundFileVerdict('sdw', file)).toBe('unreadable');
      }
    });

    it('is read when the directory lies inside a buffer longer than the header window', () => {
      const file = withDirectoryAt(SECTORS_IN_WINDOW + 40, HEADER_WINDOW_BYTES + 40_000);
      expect(compoundFileVerdict('sdw', file)).toBe('match');
      expect(compoundFileVerdict('sdc', file)).toBe('mismatch');
    });
  });
});

/** A version 4 compound file (4096-byte sectors) whose directory chain holds `entries` entries, all unused but the root. */
function directoryOfEmptyEntries(entries: number): Buffer {
  const sectorBytes = 4096;
  const perSector = sectorBytes / 128;
  const directorySectors = Math.ceil(entries / perSector);
  const fatSectors = Math.ceil((directorySectors + 1) / (sectorBytes / 4));
  const file = Buffer.alloc((1 + directorySectors + fatSectors) * sectorBytes);
  file.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  file.writeUInt16LE(4, 26);
  file.writeUInt16LE(0xfffe, 28);
  file.writeUInt16LE(12, 30);
  file.writeUInt16LE(6, 32);
  file.writeUInt32LE(fatSectors, 44);
  file.writeUInt32LE(0, 48);
  file.writeUInt32LE(0xfffffffe, 60);
  file.writeUInt32LE(0xfffffffe, 68);
  for (let index = 0; index < 109; index++) file.writeUInt32LE(index < fatSectors ? directorySectors + index : 0xffffffff, 76 + index * 4);
  const rootName = Buffer.from('Root Entry', 'utf16le');
  rootName.copy(file, sectorBytes);
  file.writeUInt16LE(rootName.length + 2, sectorBytes + 64);
  file.writeUInt8(5, sectorBytes + ENTRY_TYPE_OFFSET);
  const fatStart = (1 + directorySectors) * sectorBytes;
  for (let sector = 0; sector < directorySectors; sector++) {
    file.writeUInt32LE(sector === directorySectors - 1 ? 0xfffffffe : sector + 1, fatStart + sector * 4);
  }
  return file;
}

/** A source over a buffer that counts the ranges it is asked for. */
function countingSource(file: Buffer): { source: ByteSource; ranges: number[] } {
  const ranges: number[] = [];
  const source: ByteSource = (offset, length) => {
    ranges.push(offset);
    return file.subarray(offset, offset + length);
  };
  return { source, ranges };
}

/** A Word document renamed to a StarOffice name, the one whose directory a header read cannot reach. */
const wordDocument = (): Buffer => compound(['WordDocument', '1Table'], OFFICE_CLASS_IDS[1][1]);
const starWriterDocument = (): Buffer => compound([NAMING_STREAM.sdw, '\u0005SummaryInformation'], STAR_WRITER_50);
const WINDOW_SECTORS = HEADER_WINDOW_BYTES / SECTOR;

describe('a compound file whose directory lies past the first 64 KiB', () => {
  it('is told apart by reading the directory where it lies, which the first 64 KiB cannot show', () => {
    const word = placeDirectory(wordDocument(), { directorySectors: [WINDOW_SECTORS + 150] });
    const writer = placeDirectory(starWriterDocument(), { directorySectors: [WINDOW_SECTORS + 150] });
    expect(word.length).toBeGreaterThan(HEADER_WINDOW_BYTES);

    expect(compoundFileVerdict('sdw', word.subarray(0, HEADER_WINDOW_BYTES))).toBe('unreadable');
    expect(compoundFileVerdictFrom('sdw', countingSource(word).source)).toBe('mismatch');
    expect(compoundFileVerdictFrom('sdw', countingSource(writer).source)).toBe('match');
    expect(compoundFileVerdictFrom('sdc', countingSource(writer).source)).toBe('mismatch');
    expect(compoundFileVerdict('sdw', word)).toBe('mismatch');
    expect(compoundFileVerdict('sdw', writer)).toBe('match');
  });

  it('is read in blocks of 64 KiB, each once', () => {
    const { source, ranges } = countingSource(placeDirectory(starWriterDocument(), { directorySectors: [WINDOW_SECTORS + 150] }));
    expect(compoundFileVerdictFrom('sdw', source)).toBe('match');
    expect(ranges.every((offset) => offset % HEADER_WINDOW_BYTES === 0)).toBe(true);
    expect(new Set(ranges).size).toBe(ranges.length);
  });

  it('is unreadable, not wrong, when the source ends before the directory does', () => {
    const file = placeDirectory(starWriterDocument(), { directorySectors: [WINDOW_SECTORS + 150] });
    expect(compoundFileVerdictFrom('sdw', countingSource(file.subarray(0, (WINDOW_SECTORS + 100) * SECTOR)).source)).toBe('unreadable');
  });

  it('gives the same verdict through an asynchronous source', async () => {
    const word = placeDirectory(wordDocument(), { directorySectors: [WINDOW_SECTORS + 150] });
    const writer = placeDirectory(starWriterDocument(), { directorySectors: [WINDOW_SECTORS + 150] });
    const over = (file: Buffer) => async (offset: number, length: number) => file.subarray(offset, offset + length);
    expect(await compoundFileVerdictFromAsync('sdw', over(word))).toBe('mismatch');
    expect(await compoundFileVerdictFromAsync('sdw', over(writer))).toBe('match');
  });
});

describe('a header that cannot be a compound file', () => {
  it.for([0xfffffffa, 0xfffffffb, 0xfffffffc, 0xfffffffd, 0xfffffffe, 0xffffffff])('is malformed when the first directory sector is the marker %d', (sector) => {
    const file = compound([NAMING_STREAM.sdw], STAR_WRITER_50);
    file.writeUInt32LE(sector, FIRST_DIRECTORY_SECTOR_OFFSET);
    for (const given of [file, Buffer.concat([file, Buffer.alloc(HEADER_WINDOW_BYTES)]).subarray(0, HEADER_WINDOW_BYTES)]) {
      expect(readCompoundFileRoot(given).status).toBe('malformed');
      expect(compoundFileVerdict('sdw', given)).toBe('mismatch');
    }
  });
});

describe('a directory reached through the DIFAT chain', () => {
  /** The directory fills two sectors (the root and four streams), and the stream that names the kind is the last, in the second. */
  const twoSectorDirectory = (classId?: string): Buffer =>
    compound([...Array.from({ length: 3 }, (_, index) => `Stream${index}`), NAMING_STREAM.sdw], classId);
  /** The FAT index of a sector past the 109 slots of the header: sector 13,952 is the first of FAT sector 109. */
  const PAST_HEADER_FAT = 109 * (SECTOR / 4);

  it('is followed to the second directory sector that lies past FAT index 108', () => {
    const file = placeDirectory(twoSectorDirectory(), { directorySectors: [PAST_HEADER_FAT + 5, PAST_HEADER_FAT + 6] });
    expect(file.readUInt32LE(68)).toBeLessThan(0xfffffffa);
    expect(compoundFileVerdict('sdw', file)).toBe('match');
    expect(compoundFileVerdict('sdc', file)).toBe('mismatch');
    expect(compoundFileVerdictFrom('sdw', countingSource(file).source)).toBe('match');
    const root = readCompoundFileRoot(file);
    expect(root.status === 'read' && root.complete).toBe(true);
  });

  it('is followed to a directory sector in the second DIFAT sector as well', () => {
    const second = 109 * (SECTOR / 4) + 127 * (SECTOR / 4);
    const file = placeDirectory(twoSectorDirectory(), { directorySectors: [second + 3, second + 4] });
    expect(file.readUInt32LE(72)).toBe(2);
    expect(compoundFileVerdict('sdw', file)).toBe('match');
  });

  it('is refused when the DIFAT chain returns to a sector it has read', () => {
    const file = placeDirectory(twoSectorDirectory(), { directorySectors: [3, PAST_HEADER_FAT + 128], difatLoop: true });
    expect(file.readUInt32LE(72)).toBeGreaterThan(0);
    expect(readCompoundFileRoot(file).status).toBe('malformed');
    expect(compoundFileVerdict('sdw', file)).toBe('mismatch');
  });
});

describe('a directory spread over a large file', () => {
  const FIRST_BLOCK_SECTORS = HEADER_WINDOW_BYTES / 4096;
  /** `sectors` version 4 directory sectors, each in a block of its own. */
  const spread = (sectors: number): Buffer =>
    placeDirectory(starWriterDocument(), {
      sectorBytes: 4096,
      directorySectors: Array.from({ length: sectors }, (_, index) => index * FIRST_BLOCK_SECTORS),
    });

  it('is read when it fits the 256 blocks a read may fetch', () => {
    const { source, ranges } = countingSource(spread(200));
    expect(readCompoundFileRootFrom(source).status).toBe('read');
    expect(ranges.length).toBeLessThanOrEqual(256 + 1);
  });

  it('is malformed when it needs more blocks, after no more than 256 fetches', () => {
    const { source, ranges } = countingSource(spread(300));
    expect(readCompoundFileRootFrom(source).status).toBe('malformed');
    expect(ranges.length).toBeLessThanOrEqual(256 + 1);
  });

  it('is read in run-sized blocks, not sector by sector, when the 65,568 entries lie in one run', () => {
    const { source, ranges } = countingSource(directoryOfEmptyEntries(65_536 + 32));
    expect(readCompoundFileRootFrom(source).status).toBe('malformed');
    expect(ranges.length).toBeLessThanOrEqual(130);
  });
});
