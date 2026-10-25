import { describe, expect, it } from 'vitest';
import { readTarEntries } from '../src/lib/conversions/archive';
import { tarFromEntries, tarFromEntriesInPlace } from '../src/lib/conversions/archive-stream';
import { hostileTarEnd, hostileTarMember } from './helpers/hostile-tar';

/**
 * The tar written for a converted stream is the headers of `tarFromEntries` and the bodies read from the unpacked bytes.
 * When every entry keeps its place those headers are written over the old ones and the unpacked buffer is the result;
 * otherwise the segments come back to be joined. In both cases the bytes are the joined segments, which is what is
 * asserted here against a copy that nothing wrote over.
 */
const BLOCK = 512;

/** The tar `tarFromEntries` writes for `tar`, read from a copy so that the buffer under test is not touched. */
function expectedTar(tar: Buffer): Buffer {
  return Buffer.concat(tarFromEntries(readTarEntries(Buffer.from(tar), { ignoreLinks: true })));
}

function rewrite(tar: Buffer): { unpacked: Buffer; segments: Uint8Array[] } {
  const unpacked = Buffer.from(tar);
  return { unpacked, segments: tarFromEntriesInPlace(unpacked, readTarEntries(unpacked, { ignoreLinks: true })) };
}

function joined(segments: Uint8Array[]): Buffer {
  return Buffer.concat(segments);
}

describe('tarFromEntriesInPlace', () => {
  it('writes new headers over the old ones when every entry keeps its place, without a second copy of the bodies', () => {
    const tar = Buffer.concat([
      hostileTarMember({ name: 'a.txt', mode: 0o4755, magic: 'ustar ', version: ' \0', prefix: 'ignored' }, Buffer.from('first body')),
      hostileTarMember({ name: 'dir/', typeflag: '5' }),
      hostileTarMember({ name: 'empty.txt' }),
      hostileTarMember({ name: 'b.bin' }, Buffer.alloc(1500, 7)),
      hostileTarEnd(),
    ]);
    const expected = expectedTar(tar);
    expect(expected.equals(tar)).toBe(false);

    const { unpacked, segments } = rewrite(tar);

    expect(segments).toHaveLength(1);
    expect(segments[0].buffer).toBe(unpacked.buffer);
    expect(joined(segments).equals(expected)).toBe(true);
  });

  it('leaves out what follows the end-of-archive blocks', () => {
    const tar = Buffer.concat([
      hostileTarMember({ name: 'a.txt' }, Buffer.from('visible')),
      hostileTarEnd(),
      hostileTarMember({ name: 'hidden.txt' }, Buffer.from('HIDDEN')),
      hostileTarEnd(),
    ]);
    const expected = expectedTar(tar);

    const { segments } = rewrite(tar);

    expect(joined(segments).equals(expected)).toBe(true);
    expect(joined(segments).includes('HIDDEN')).toBe(false);
    expect(joined(segments)).toHaveLength(BLOCK + BLOCK + 2 * BLOCK);
  });

  it('gives the segments back, and writes nothing over the unpacked bytes, when a repeated name drops an entry', () => {
    const tar = Buffer.concat([
      hostileTarMember({ name: 'dup.txt' }, Buffer.from('first')),
      hostileTarMember({ name: 'keep.txt' }, Buffer.from('kept')),
      hostileTarMember({ name: 'dup.txt', magic: 'ustar ', version: ' \0' }, Buffer.from('second')),
      hostileTarEnd(),
    ]);
    const expected = expectedTar(tar);

    const { unpacked, segments } = rewrite(tar);

    expect(segments.length).toBeGreaterThan(1);
    expect(joined(segments).equals(expected)).toBe(true);
    expect(unpacked.equals(tar)).toBe(true);
  });

  it('gives the segments back when links are left out', () => {
    const tar = Buffer.concat([
      hostileTarMember({ name: 'a.txt' }, Buffer.from('body')),
      hostileTarMember({ name: 'link', typeflag: '2', linkname: 'a.txt' }),
      hostileTarMember({ name: 'b.txt' }, Buffer.from('other')),
      hostileTarEnd(),
    ]);
    const expected = expectedTar(tar);

    const { unpacked, segments } = rewrite(tar);

    expect(segments.length).toBeGreaterThan(1);
    expect(joined(segments).equals(expected)).toBe(true);
    expect(unpacked.equals(tar)).toBe(true);
  });

  it('gives the segments back when the tar ends before its end-of-archive blocks', () => {
    const tar = hostileTarMember({ name: 'a.txt' }, Buffer.from('body'));
    const expected = expectedTar(tar);
    expect(expected.length).toBeGreaterThan(tar.length);

    const { unpacked, segments } = rewrite(tar);

    expect(joined(segments).equals(expected)).toBe(true);
    expect(unpacked.equals(tar)).toBe(true);
  });

  it('writes the bytes of the segments when long names change the layout', () => {
    const longName = `${'d'.repeat(120)}/file.txt`;
    const tar = Buffer.concat([
      hostileTarMember({ name: 'a.txt' }, Buffer.from('x')),
      hostileTarMember({ name: 'b.txt', prefix: 'p'.repeat(100) }, Buffer.from('y')),
      hostileTarMember({ name: longName.slice(0, 100) }, Buffer.from('z')),
      hostileTarEnd(),
    ]);
    const expected = expectedTar(tar);

    const { segments } = rewrite(tar);

    expect(joined(segments).equals(expected)).toBe(true);
  });

  it('writes into a view of a larger buffer at the view, not at the start of its memory', () => {
    const tar = Buffer.concat([hostileTarMember({ name: 'a.txt', magic: 'ustar ', version: ' \0' }, Buffer.from('body')), hostileTarEnd()]);
    const expected = expectedTar(tar);
    const frame = Buffer.concat([Buffer.alloc(300, 0xaa), tar, Buffer.alloc(700, 0xbb)]);
    const unpacked = frame.subarray(300, 300 + tar.length);

    const segments = tarFromEntriesInPlace(unpacked, readTarEntries(unpacked, { ignoreLinks: true }));

    expect(joined(segments).equals(expected)).toBe(true);
    expect(frame.subarray(0, 300).every((byte) => byte === 0xaa)).toBe(true);
    expect(frame.subarray(300 + tar.length).every((byte) => byte === 0xbb)).toBe(true);
  });
});
