import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import { RICH_HEADINGS, fixtureBytes, richStructureImageHashes, sha256 } from './helpers/document-fixtures';
import { structureOfHtml } from '../bench/structure-metrics';

const RICH = fixtureBytes('rich-structure.docx');

describe('docx to epub keeps pictures and structure', () => {
  it('packages the source JPEG byte for byte and keeps the headings', async () => {
    const epub = (await convertFile(RICH, 'docx', 'epub', {}, 'rich-structure.docx')).buffer;
    const zip = await JSZip.loadAsync(epub);
    const { jpeg } = await richStructureImageHashes();
    const media = await Promise.all(
      Object.keys(zip.files)
        .filter((name) => /\.jpe?g$/i.test(name))
        .map(async (name) => sha256(Buffer.from(await (zip.file(name) as JSZip.JSZipObject).async('uint8array'))))
    );
    expect(media).toContain(jpeg);
    const documents = await Promise.all(
      Object.keys(zip.files)
        .filter((name) => /\.xhtml$/.test(name) && !/nav\.xhtml$/.test(name))
        .map((name) => (zip.file(name) as JSZip.JSZipObject).async('string'))
    );
    const headings = documents.flatMap((doc) => structureOfHtml(doc).headings);
    expect(headings).toEqual([...RICH_HEADINGS]);
  });
});

