import { describe, expect, it } from 'vitest';
import { compressBzip2 } from '../src/lib/conversions/bzip2';
import { ARCHIVE_SECURITY_LIMITS, inspectArchive } from '../src/lib/conversions/archive';
import { UnsafeArchiveError } from '../src/lib/conversions/archive-extraction-safety';

/**
 * Listing a .tar.bz2 decodes the stream in the process that serves the request, so it is held to the ratio of the other readers
 * (gzip, 7-Zip, RAR): 100 to 1 past the 32 MiB floor all archive paths share. A bz2 of 370 bytes that holds 480 MiB of zeros used
 * to decode whole (1.1 GB resident, the event loop stopped) and list as an empty archive.
 */
const ZEROS_480_MIB_BZ2 = Buffer.from('QlpoOTFBWSZTWQ4J4t8BX45AAMAAAAggADCATUZCoCWpCoCXMUFZJlNZDgni3wFfjkAAwAAACCAAMIBNRkKgJakKgJcxQVkmU1kOCeLfAV+OQADAAAAIIAAwgE1GQqAlqQqAlzFBWSZTWQ4J4t8BX45AAMAAAAggADCATUZCoCWpCoCXMUFZJlNZDgni3wFfjkAAwAAACCAAMIBNRkKgJakKgJcxQVkmU1kOCeLfAV+OQADAAAAIIAAwgE1GQqAlqQqAlzFBWSZTWQ4J4t8BX45AAMAAAAggADCATUZCoCWpCoCXMUFZJlNZDgni3wFfjkAAwAAACCAAMIBNRkKgJakKgJcxQVkmU1kOCeLfAV+OQADAAAAIIAAwgE1GQqAlqQqAlzFBWSZTWQ4J4t8BX45AAMAAAAggADCATUZCoCWpCoCXMUFZJlNZZDvBPQFTfmAAwAAAEAAIIAAwzAmqaagIpLakBFJeLuSKcKEhVY5U8A==', 'base64');

describe('listing a bzip2 stream', () => {
  it('refuses 370 bytes that hold 480 MiB of zeros as a compression-ratio bomb', async () => {
    expect(ZEROS_480_MIB_BZ2.length).toBe(370);
    const error = await inspectArchive(ZEROS_480_MIB_BZ2, { filename: 'bomb.tar.bz2' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsafeArchiveError);
    expect(error).toMatchObject({ reason: 'compression-ratio', refusalCode: 'unsafe_archive' });
  });

  it('refuses a stream whose output is over the ratio of its own size past the floor', async () => {
    const zeros = Buffer.alloc(ARCHIVE_SECURITY_LIMITS.MAX_RATIO * 400 * 1024 + 33 * 1024 * 1024);
    const stream = compressBzip2(zeros);
    expect(zeros.length / stream.length).toBeGreaterThan(ARCHIVE_SECURITY_LIMITS.MAX_RATIO);
    await expect(inspectArchive(stream, { filename: 'bomb.tar.bz2' })).rejects.toBeInstanceOf(UnsafeArchiveError);
  });

  it('still lists the files of an ordinary .tar.bz2', async () => {
    const block = Buffer.alloc(512);
    block.write('hello.txt', 0, 'ascii');
    block.write('0000644\0', 100, 'ascii');
    block.write('00000000005\0', 124, 'ascii');
    block.write('0', 156, 'ascii');
    block.write('ustar\0', 257, 'ascii');
    block.write('00', 263, 'ascii');
    block.fill(0x20, 148, 156);
    block.write(`${[...block].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    const tar = Buffer.concat([block, Buffer.from('hello\0\0\0'.padEnd(512, '\0')), Buffer.alloc(1024)]);
    const listing = await inspectArchive(compressBzip2(tar), { filename: 'files.tar.bz2' });
    expect(listing.entries.map((entry) => entry.name)).toEqual(['hello.txt']);
  });
});
