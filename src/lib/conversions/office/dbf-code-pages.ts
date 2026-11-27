import iconv from 'iconv-lite';

/**
 * The language driver ID (LDID, byte 29 of a dBASE header) names the code page of the text fields.
 * The table is the one of dbfread (MIT, Copyright (c) Ole Martin Bjorndalen / UiT The Arctic University of Norway,
 * https://github.com/olemb/dbfread, dbfread/codepages.py at commit dce544641065d966c76a97864b4e9908ec922ce8), which takes it from dbf.py by Ethan Furman. Only the iconv-lite
 * names differ from the Python codec names (`mac_roman` is `macintosh`). The drivers that dbfread leaves out (0x68 Kamenicky,
 * 0x69 Mazovia) have no code page here either, and LibreOffice's dBASE import maps the same IDs to the same Windows and DOS pages.
 * A byte that is not in the table (and 0x00, "none") keeps the reader's earlier rule: UTF-8 when valid, Windows-1252 otherwise.
 */
const DBF_CODE_PAGE_BY_LDID: ReadonlyMap<number, string> = new Map([
  [0x01, 'cp437'], [0x02, 'cp850'], [0x03, 'cp1252'], [0x04, 'macintosh'], [0x08, 'cp865'], [0x09, 'cp437'], [0x0a, 'cp850'],
  [0x0b, 'cp437'], [0x0d, 'cp437'], [0x0e, 'cp850'], [0x0f, 'cp437'], [0x10, 'cp850'], [0x11, 'cp437'], [0x12, 'cp850'],
  [0x13, 'cp932'], [0x14, 'cp850'], [0x15, 'cp437'], [0x16, 'cp850'], [0x17, 'cp865'], [0x18, 'cp437'], [0x19, 'cp437'],
  [0x1a, 'cp850'], [0x1b, 'cp437'], [0x1c, 'cp863'], [0x1d, 'cp850'], [0x1f, 'cp852'], [0x22, 'cp852'], [0x23, 'cp852'],
  [0x24, 'cp860'], [0x25, 'cp850'], [0x26, 'cp866'], [0x37, 'cp850'], [0x40, 'cp852'], [0x4d, 'cp936'], [0x4e, 'cp949'],
  [0x4f, 'cp950'], [0x50, 'cp874'], [0x57, 'cp1252'], [0x58, 'cp1252'], [0x59, 'cp1252'], [0x64, 'cp852'], [0x65, 'cp866'],
  [0x66, 'cp865'], [0x67, 'cp861'], [0x6a, 'cp737'], [0x6b, 'cp857'], [0x78, 'cp950'], [0x79, 'cp949'], [0x7a, 'cp936'],
  [0x7b, 'cp932'], [0x7c, 'cp874'], [0x7d, 'cp1255'], [0x7e, 'cp1256'], [0x96, 'maccyrillic'], [0x97, 'maccenteuro'],
  [0x98, 'macgreek'], [0xc8, 'cp1250'], [0xc9, 'cp1251'], [0xca, 'cp1254'], [0xcb, 'cp1253'],
]);

const ASCII_LIMIT = 0x80;

/** The iconv-lite code page for a language driver ID, or undefined when the ID is 0x00 or not in the table. */
export function dbfCodePageForLdid(ldid: number): string | undefined {
  return DBF_CODE_PAGE_BY_LDID.get(ldid);
}

/** `slice` decoded as `codePage`; a slice of ASCII bytes is the same in every page and skips the codec. */
export function decodeDbfBytes(slice: Buffer, codePage: string): string {
  for (let i = 0; i < slice.length; i += 1) {
    if (slice[i] >= ASCII_LIMIT) return iconv.decode(slice, codePage);
  }
  return slice.toString('latin1');
}
