import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { extractRarArchive, get7zBinaryPath } from '../src/lib/conversions/archive';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipUnless } from './helpers/strict-skip';

/**
 * A compressed RAR (the archive tool, `archive-extract`) is extracted by 7-Zip when `unrar` is not installed, as the conversion route
 * (`rar` to `zip`) already did: the worker image ships 7-Zip and no `unrar`, and the tool answered "unrar binary is required" for a
 * RAR 4.x archive of compression method 0x33 (the sweep of 2026-11-20). Whichever program serves the call, the files are the files of the archive.
 */

// No unrar for this file, whatever the host has installed: the compressed archives are read by 7-Zip.
vi.hoisted(() => {
  process.env.UNRAR_PATH = '';
});

/** Whether the 7-Zip the product resolves has the RAR decoders (the upstream build of the worker image does; the distributions' packages do not). */
function sevenZipDecodesRar(): boolean {
  const binary = get7zBinaryPath();
  if (binary === null) return false;
  try {
    return /\bRar3\b/.test(execFileSync(binary, ['i'], { encoding: 'utf-8', timeout: 20_000 }));
  } catch {
    return false;
  }
}

const needsRarDecoder = skipUnless('a 7-Zip with the RAR decoders (the pinned upstream build; P7ZIP_PATH)', sevenZipDecodesRar());

/** What `tika-test-documents.rar` holds: the names and sizes of its nine test documents (RAR 4.x, compressed). */
const TIKA_DOCUMENTS: Array<[string, number]> = [
  ['test-documents/testEXCEL.xls', 13824],
  ['test-documents/testHTML.html', 167],
  ['test-documents/testOpenOffice2.odt', 26448],
  ['test-documents/testPDF.pdf', 34824],
  ['test-documents/testPPT.ppt', 16384],
  ['test-documents/testRTF.rtf', 3410],
  ['test-documents/testTXT.txt', 49],
  ['test-documents/testWORD.doc', 19456],
  ['test-documents/testXML.xml', 766],
];

describe.skipIf(needsRarDecoder)('extracting a compressed RAR without unrar', () => {
  it('reads a RAR 4.x archive of compressed files, with the bytes of the originals', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'tika-test-documents.rar');
    const files = extractRarArchive(bytes);
    expect(files.map((file) => [file.filename, file.buffer.length]).sort()).toEqual([...TIKA_DOCUMENTS].sort());
    const text = files.find((file) => file.filename.endsWith('testTXT.txt'));
    expect(text?.buffer.toString('utf-8')).toContain('Test d');
  });

  it('selects entries by name, as the other readers do', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'tika-test-documents.rar');
    const files = extractRarArchive(bytes, { entries: ['test-documents/testXML.xml', 'test-documents/testTXT.txt'] });
    expect(files.map((file) => file.filename).sort()).toEqual(['test-documents/testTXT.txt', 'test-documents/testXML.xml']);
  });

  it('reads a RAR 5.0 archive, whose files are compressed by the new method', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'rarfile-rar5-crc.rar');
    const files = extractRarArchive(bytes);
    expect(files.map((file) => file.filename).sort()).toEqual(['stest1.txt', 'stest2.txt']);
    for (const file of files) {
      expect(file.buffer.length).toBe(2048);
      expect(zlib.crc32(file.buffer).toString(16).toUpperCase()).toBe('C5B7E6A2');
    }
  });

  it('refuses a damaged archive in a typed error that names the archive', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'tika-test-documents.rar');
    const damaged = Buffer.from(bytes);
    // The compressed data of the first file is inside the first kilobytes; flipping bytes there breaks its CRC.
    for (let offset = 300; offset < 900; offset += 7) damaged[offset] ^= 0xff;
    expect(() => extractRarArchive(damaged)).toThrow(/RAR|archive|rar/i);
  });
});
