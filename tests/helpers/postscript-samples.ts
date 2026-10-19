import { inflateSync } from 'node:zlib';

/**
 * The samples of the picture in a PostScript or EPS file the image converter writes: a Level 3 `colorimage` whose data source
 * is `currentfile` through the ASCII85Decode and FlateDecode filters. The filters are read here from their definition (Adobe
 * PostScript Language Reference, 3.13.3), by code that shares nothing with the writer.
 */

const ASCII85_BASE = 85;
const ASCII85_FIRST_CHAR = 33;
const ASCII85_GROUP_CHARS = 5;
const ASCII85_GROUP_BYTES = 4;
const BYTE_VALUES = 256;

/** The bytes of ASCII85 text up to its `~>` end marker; white space is ignored. */
export function decodeAscii85(text: string): Buffer {
  const characters = [...text.replace(/\s+/g, '')].map((char) => char.charCodeAt(0) - ASCII85_FIRST_CHAR);
  const bytes: number[] = [];
  for (let start = 0; start < characters.length; start += ASCII85_GROUP_CHARS) {
    const group = characters.slice(start, start + ASCII85_GROUP_CHARS);
    const bytesInGroup = group.length - 1;
    while (group.length < ASCII85_GROUP_CHARS) group.push(ASCII85_BASE - 1);
    let value = 0;
    for (const digit of group) value = value * ASCII85_BASE + digit;
    for (let byte = 0; byte < bytesInGroup; byte += 1) bytes.push(Math.floor(value / BYTE_VALUES ** (ASCII85_GROUP_BYTES - 1 - byte)) % BYTE_VALUES);
  }
  return Buffer.from(bytes);
}

export function parsePostscriptRgb(postscript: Buffer): { width: number; height: number; rgb: Buffer } {
  const text = postscript.toString('latin1');
  const header = /^(\d+) (\d+) 8 \[/m.exec(text);
  const dataStart = text.indexOf('colorimage\n');
  const dataEnd = text.indexOf('~>', dataStart);
  if (!header || dataStart < 0 || dataEnd < 0) throw new Error('not an ASCII85 and Flate colorimage PostScript file');
  const rgb = inflateSync(decodeAscii85(text.slice(dataStart + 'colorimage\n'.length, dataEnd)));
  return { width: Number(header[1]), height: Number(header[2]), rgb };
}
