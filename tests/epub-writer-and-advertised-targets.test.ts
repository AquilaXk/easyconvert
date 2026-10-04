import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import { FORMAT_REGISTRY } from '../src/lib/registry';

/**
 * EPUB output must carry a per-book identifier and honest language metadata, and the registry
 * may only advertise EPUB and RAW targets that have a working conversion path.
 */

const RFC4122_URN = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOOK_TEXT = '# Field Notes\n\nHello from the first chapter.\n';

async function bookMetadata(epub: Buffer) {
  const zip = await JSZip.loadAsync(epub);
  const opf = await zip.file('OEBPS/content.opf')!.async('string');
  const ncx = await zip.file('OEBPS/toc.ncx')!.async('string');
  return {
    identifier: opf.match(/<dc:identifier id="BookId">([^<]+)<\/dc:identifier>/)?.[1],
    language: opf.match(/<dc:language>([^<]+)<\/dc:language>/)?.[1],
    creator: opf.match(/<dc:creator>([^<]*)<\/dc:creator>/)?.[1],
    ncxUid: ncx.match(/<meta name="dtb:uid" content="([^"]+)"\/>/)?.[1],
  };
}

describe('EPUB writer metadata', () => {
  it('gives every book its own RFC 4122 identifier and undetermined language', async () => {
    const first = await bookMetadata((await convertFile(Buffer.from(BOOK_TEXT), 'txt', 'epub', {}, 'notes.txt')).buffer);
    const second = await bookMetadata((await convertFile(Buffer.from(BOOK_TEXT), 'txt', 'epub', {}, 'notes.txt')).buffer);

    expect(first.identifier).toMatch(RFC4122_URN);
    expect(second.identifier).toMatch(RFC4122_URN);
    expect(first.identifier).not.toBe(second.identifier);
    expect(first.ncxUid).toBe(first.identifier);
    expect(first.language).toBe('und');
    // The converter is not the book's author.
    expect(first.creator).toBeUndefined();
  });
});

describe('advertised EPUB and RAW targets', () => {
  it('advertises no EPUB target without a conversion path', () => {
    expect(FORMAT_REGISTRY.epub.targetFormats).toEqual(['pdf', 'docx', 'txt', 'html', 'zip']);
    expect(FORMAT_REGISTRY.raw.targetFormats).not.toContain('dng');
  });

  it('converts an EPUB to every advertised target', async () => {
    const epub = (await convertFile(Buffer.from(BOOK_TEXT), 'txt', 'epub', {}, 'notes.txt')).buffer;
    const magic: Record<string, (b: Buffer) => boolean> = {
      pdf: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
      docx: (b) => b.readUInt32LE(0) === 0x04034b50,
      zip: (b) => b.readUInt32LE(0) === 0x04034b50,
      html: (b) => /<html[\s>]/i.test(b.toString('utf-8')),
      txt: (b) => b.toString('utf-8').includes('Hello from the first chapter'),
    };
    for (const target of FORMAT_REGISTRY.epub.targetFormats) {
      const out = await convertFile(epub, 'epub', target, {}, 'notes.epub');
      expect(magic[target](out.buffer), `epub -> ${target}`).toBe(true);
    }
  });
});
