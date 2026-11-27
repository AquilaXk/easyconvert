import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { withoutPageMargins } from '../src/worker/office-metafile-page';

/** The margins that the office suite's PDF import gives a page (measured: 1 cm on top of a page-sized picture), which its metafile export cuts off the page. */
const STYLES =
  '<office:document-styles><office:automatic-styles><style:page-layout style:name="PM1">' +
  '<style:page-layout-properties fo:margin-top="1cm" fo:margin-bottom="0.6cm" fo:margin-left="0.4cm" fo:margin-right="1.5cm" fo:page-width="21.166cm" fo:page-height="14.111cm" style:print-orientation="landscape"/>' +
  '</style:page-layout></office:automatic-styles></office:document-styles>';

async function drawing(entries: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.graphics', { compression: 'STORE' });
  for (const [name, text] of Object.entries(entries)) zip.file(name, text);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

describe('the drawing of a PDF page without the margins of its page', () => {
  it('sets every margin of the page layout to nothing and keeps the page size and the other entries', async () => {
    const written = await JSZip.loadAsync(await withoutPageMargins(await drawing({ 'styles.xml': STYLES, 'content.xml': '<office:document-content fo:margin-top="3cm"/>' })));
    const styles = await written.file('styles.xml')!.async('string');
    expect(styles.match(/fo:margin-(top|bottom|left|right)="0cm"/g)).toHaveLength(4);
    expect(styles).not.toMatch(/fo:margin-[a-z]+="[1-9.]/);
    expect(styles).toContain('fo:page-width="21.166cm" fo:page-height="14.111cm"');
    expect(await written.file('content.xml')!.async('string')).toBe('<office:document-content fo:margin-top="3cm"/>');
  });

  it('keeps the mimetype entry first and stored, as an OpenDocument package needs', async () => {
    const bytes = await withoutPageMargins(await drawing({ 'styles.xml': STYLES }));
    expect(bytes.subarray(30, 38).toString('latin1')).toBe('mimetype');
    expect(bytes.readUInt16LE(8)).toBe(0);
    expect(Object.keys((await JSZip.loadAsync(bytes)).files)[0]).toBe('mimetype');
  });

  it.each([
    ['a file that is not a package', Buffer.from('not a zip')],
    ['a package with no styles', undefined],
  ])('refuses %s', async (_name, bytes) => {
    await expect(withoutPageMargins(bytes ?? (await drawing({ 'content.xml': '<a/>' })))).rejects.toThrow('The office suite wrote no drawing of the page.');
  });
});
