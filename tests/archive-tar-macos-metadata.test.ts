import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { ARCHIVE_SECURITY_LIMITS, extractTarArchive, listTarEntries, readTarEntries } from '../src/lib/conversions/archive';
import { END_OF_ARCHIVE, craftEntry, craftPaxHeader, paxRecordBytes } from './helpers/tar-craft';

/**
 * Tar files made by macOS `tar` (bsdtar 3.5.3 on Darwin, `tar -czf` of two files that carry the `com.apple.provenance` attribute the system
 * sets): each file has a pax header with `SCHILY.xattr.com.apple.provenance`, whose value is binary and no UTF-8, and a `._name` entry in
 * front of it, the AppleDouble file of its metadata. libarchive reads such an archive without error, decodes the values of the keys it uses
 * only, and takes a `._` entry for the metadata of the entry after it (archive_read_support_format_tar.c `is_mac_metadata_entry`,
 * `read_mac_metadata_blob`), so neither a listing nor an extraction shows it.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'archive-sources');
const EXPECTED_FILES = ['dir/a.txt', 'dir/b.txt'];
const readFixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURES, name));
const macTar = (): Buffer => zlib.gunzipSync(readFixture('macos-provenance.tar.gz'));

/** A pax record whose value is the raw bytes given, `<len> <key>=<value>\n`. */
function binaryPaxRecord(key: string, value: Buffer): Buffer {
  const tail = Buffer.concat([Buffer.from(` ${key}=`), value, Buffer.from('\n')]);
  let length = tail.length + 1;
  while (String(length).length + tail.length !== length) length = String(length).length + tail.length;
  return Buffer.concat([Buffer.from(String(length)), tail]);
}

const NOT_UTF8 = Buffer.from([0x01, 0x02, 0x00, 0x88, 0xb4, 0x52, 0x3e, 0xad, 0xca, 0x05, 0x8d]);

describe('a tar written by macOS tar', () => {
  it('has the binary attribute and the AppleDouble entries the fixture is meant to carry', () => {
    const raw = macTar();
    expect(raw.includes(Buffer.from('SCHILY.xattr.com.apple.provenance='))).toBe(true);
    expect(raw.includes(Buffer.from('dir/._a.txt'))).toBe(true);
    expect(raw.includes(NOT_UTF8.subarray(3))).toBe(true);
  });

  it('lists the directory and the files in archive order, and no AppleDouble entry', () => {
    expect(listTarEntries(macTar()).map((entry) => entry.path)).toEqual(['dir/', 'dir/b.txt', 'dir/a.txt']);
  });

  it('reads its entries and extracts the files with their content', () => {
    expect(readTarEntries(macTar()).map((entry) => entry.filename).sort()).toEqual(['dir', ...EXPECTED_FILES]);
    const files = extractTarArchive(macTar());
    expect(files.map((file) => file.filename).sort()).toEqual(EXPECTED_FILES);
    expect(Object.fromEntries(files.map((file) => [file.filename, file.buffer.toString('utf-8')]))).toEqual({ 'dir/a.txt': 'hello\n', 'dir/b.txt': 'world\n' });
  });

  it.each(['tar.gz', 'tar.xz'])('converts the .%s to a ZIP of the two files', async (source) => {
    const bytes = readFixture(`macos-provenance.${source}`);
    const result = await convertFile(bytes, source, 'zip', {}, `mac.${source}`);
    const zip = await JSZip.loadAsync(result.buffer);
    expect(Object.keys(zip.files).filter((name) => !name.endsWith('/')).sort()).toEqual(EXPECTED_FILES);
    expect(await zip.file('dir/a.txt')!.async('string')).toBe('hello\n');
  });

  it('converts to a tar and back with the files and no attribute record', async () => {
    const result = await convertFile(readFixture('macos-provenance.tar.gz'), 'tar.gz', 'tar', {}, 'mac.tar.gz');
    expect(extractTarArchive(result.buffer).map((file) => file.filename).sort()).toEqual(EXPECTED_FILES);
  });
});

describe('pax records the reader does not use', () => {
  const entryWith = (...records: Buffer[]): Buffer => Buffer.concat([craftPaxHeader('x', ...records), craftEntry('plain.txt', 'body'), END_OF_ARCHIVE]);

  it.each(['SCHILY.xattr.com.apple.provenance', 'LIBARCHIVE.xattr.user.note', 'vendor.unknown', 'uname', 'gname'])('skips the binary value of %s without decoding it', (key) => {
    expect(extractTarArchive(entryWith(binaryPaxRecord(key, NOT_UTF8))).map((file) => file.filename)).toEqual(['plain.txt']);
  });

  it('still decodes the keys it uses as strict UTF-8', () => {
    for (const key of ['path', 'linkpath']) {
      expect(() => readTarEntries(entryWith(binaryPaxRecord(key, NOT_UTF8)))).toThrow(/pax record is not valid UTF-8/);
    }
    expect(readTarEntries(entryWith(paxRecordBytes('path', '한글.txt')))[0].filename).toBe('한글.txt');
  });

  it('keeps strict keys and record lengths', () => {
    expect(() => readTarEntries(entryWith(Buffer.concat([Buffer.from('13 '), NOT_UTF8.subarray(3, 4), Buffer.from('k=v\n')])))).toThrow(/pax record/);
    expect(() => readTarEntries(entryWith(Buffer.from('99 comment=short\n')))).toThrow(/pax record length does not match/);
    expect(() => readTarEntries(entryWith(Buffer.from('12 noequals\n')))).toThrow(/pax record has no key/);
  });

  it('still refuses a GNU sparse record, whatever its value', () => {
    expect(() => readTarEntries(entryWith(paxRecordBytes('GNU.sparse.major', '1')))).toThrow(/sparse files are not supported/);
  });
});

describe('a tar entry named `._name`', () => {
  const macNames = (...names: string[]): Buffer => Buffer.concat([...names.map((name) => craftEntry(name, `apple double of ${name}`)), END_OF_ARCHIVE]);

  it('is the metadata of the entry after it and is not listed, read or extracted, as libarchive does', () => {
    const tar = macNames('._a.txt', 'a.txt', 'sub/._b.txt', 'sub/b.txt');
    expect(listTarEntries(tar).map((entry) => entry.path)).toEqual(['a.txt', 'sub/b.txt']);
    expect(readTarEntries(tar).map((entry) => entry.filename)).toEqual(['a.txt', 'sub/b.txt']);
    expect(extractTarArchive(tar).map((file) => file.filename)).toEqual(['a.txt', 'sub/b.txt']);
  });

  it('is read as a file when another `._` entry comes right before it, or when the name is just `._`', () => {
    const tar = macNames('._a', '._._a', 'a', '._');
    expect(readTarEntries(tar).map((entry) => entry.filename)).toEqual(['._._a', 'a', '._']);
  });

  it('keeps its content out of the size budget of the extraction', () => {
    const tar = Buffer.concat([craftEntry('._a.txt', Buffer.alloc(2048)), craftEntry('a.txt', 'x'), END_OF_ARCHIVE]);
    expect(extractTarArchive(tar, { limits: { ...ARCHIVE_SECURITY_LIMITS, MAX_UNCOMPRESSED_SIZE: 16 } }).map((file) => file.filename)).toEqual(['a.txt']);
  });
});
