import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import { dbfCodePageForLdid } from '../src/lib/conversions/office/dbf-code-pages';
import { dispatchConversion } from '../src/lib/conversions/dispatch';

/** A dBASE III table of one text column `fieldName` with one record, whose language driver byte (29) is `ldid`. */
function dbf(ldid: number, fieldName: Buffer, cell: Buffer): Buffer {
  const headerSize = 32 + 32 + 1;
  const width = 12;
  const buf = Buffer.alloc(headerSize + 1 + width + 1, 0x20);
  buf[0] = 0x03;
  buf.writeUInt32LE(1, 4);
  buf.writeUInt16LE(headerSize, 8);
  buf.writeUInt16LE(1 + width, 10);
  buf[29] = ldid;
  buf.fill(0, 32, 43);
  fieldName.copy(buf, 32);
  buf[32 + 11] = 'C'.charCodeAt(0);
  buf[32 + 16] = width;
  buf[headerSize - 1] = 0x0d;
  buf[headerSize] = 0x20;
  cell.copy(buf, headerSize + 1);
  buf[buf.length - 1] = 0x1a;
  return buf;
}

async function toCsv(table: Buffer): Promise<string> {
  const result = await dispatchConversion(table, 'dbf', 'csv', { engine: 'easyconvert' }, 'table.dbf');
  return result.buffer.toString('utf-8').replace(/\r?\n$/, '');
}

describe('the code page of a dBASE table', () => {
  it('reads Korean text of a Windows table (language driver 0x79, CP949)', async () => {
    const csv = await toCsv(dbf(0x79, iconv.encode('이름', 'cp949'), iconv.encode('한글 문서', 'cp949')));
    expect(csv).toBe('이름\n한글 문서'.replace('\n', '\r\n'));
  });

  it('reads Western text of a DOS table (language driver 0x01, CP437) where Windows-1252 would read other letters', async () => {
    const cp437 = iconv.encode('Café Ünï', 'cp437');
    expect(iconv.decode(cp437, 'cp1252')).not.toBe('Café Ünï');
    expect(await toCsv(dbf(0x01, Buffer.from('NAME'), cp437))).toBe('NAME\r\nCafé Ünï');
  });

  it('reads a Windows ANSI table (language driver 0x03, CP1252), euro sign included', async () => {
    expect(await toCsv(dbf(0x03, Buffer.from('NAME'), iconv.encode('Café €5', 'cp1252')))).toBe('NAME\r\nCafé €5');
  });

  it('keeps the earlier rule when the driver byte is 0x00 or not in the table: UTF-8 when valid, Windows-1252 otherwise', async () => {
    const utf8 = Buffer.from('Café €5');
    expect(await toCsv(dbf(0x00, Buffer.from('NAME'), utf8))).toBe('NAME\r\nCafé €5');
    expect(await toCsv(dbf(0x68, Buffer.from('NAME'), utf8))).toBe('NAME\r\nCafé €5');
    expect(await toCsv(dbf(0x20, Buffer.from('NAME'), Buffer.from([0x43, 0x61, 0x66, 0xe9])))).toBe('NAME\r\nCafé');
  });

  it('maps the drivers of the dbfread table and no others', () => {
    expect(dbfCodePageForLdid(0x4e)).toBe('cp949');
    expect(dbfCodePageForLdid(0x79)).toBe('cp949');
    expect(dbfCodePageForLdid(0x7b)).toBe('cp932');
    expect(dbfCodePageForLdid(0xc9)).toBe('cp1251');
    expect(dbfCodePageForLdid(0x00)).toBeUndefined();
    expect(dbfCodePageForLdid(0x68)).toBeUndefined();
    expect(dbfCodePageForLdid(0xff)).toBeUndefined();
  });
});
