import JSZip from 'jszip';

/**
 * The characters an XPS package draws, read without the XPS reader of the converter: the `UnicodeString` of every glyph run
 * of every fixed page, joined by spaces. Enough to ask whether a word was written at all; the order is the package's.
 */
export async function xpsGlyphText(xps: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(xps);
  const runs: string[] = [];
  for (const name of Object.keys(zip.files)) {
    if (!/\.fpage$/i.test(name)) continue;
    for (const match of (await zip.files[name].async('string')).matchAll(/UnicodeString="([^"]*)"/g)) runs.push(match[1]);
  }
  return runs.join(' ');
}
