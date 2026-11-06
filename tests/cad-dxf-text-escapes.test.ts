import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDxfDrawing } from '../src/lib/conversions/cad-dxf';
import { decodeDxfBytes } from '../src/lib/conversions/cad-dxf-text';
import { withConversionWarnings } from '../src/lib/conversions/conversion-warnings';

/**
 * How a DXF reader turns the strings of TEXT and MTEXT into characters, from the source of ezdxf (MIT, github.com/mozman/ezdxf,
 * commit c498560b): `\U+XXXX` and `\M+nXXXX` (lldxf/encoding.py, applied by recover.py to every string value), the caret notation
 * and the `%%` codes of TEXT (tools/text.py `plain_text`), the inline codes of MTEXT (tools/text.py `MTextParser`, `plain_mtext`),
 * and the text encoding of a drawing before release 2007 (tools/codepage.py `toencoding`, filemanagement.py `dxf_stream_info`).
 */

const pairs = (...items: Array<[number, string | number]>): string => `${items.map(([code, value]) => `${String(code).padStart(3, ' ')}\n${value}`).join('\n')}\n`;
const section = (name: string, body: string): string => `${pairs([0, 'SECTION'], [2, name])}${body}${pairs([0, 'ENDSEC'])}`;
const drawing = (entities: string, blocks = ''): string => `${blocks ? section('BLOCKS', blocks) : ''}${section('ENTITIES', entities)}${pairs([0, 'EOF'])}`;
const text = (value: string): string => pairs([0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], [1, value]);
const mtext = (value: string, chunks: string[] = []): string => pairs([0, 'MTEXT'], [8, '0'], [10, 0], [20, 0], [40, 1], ...chunks.map((chunk): [number, string] => [3, chunk]), [1, value]);
const textLines = (entities: string): string[][] => parseDxfDrawing(drawing(entities)).texts.map((item) => item.lines);
const oneText = (value: string): string => textLines(text(value))[0][0];
const oneMtext = (value: string): string[] => textLines(mtext(value))[0];

describe('TEXT strings', () => {
  it('decodes \\U+XXXX in either letter case, successive escapes, a stray backslash before one and the digits after one', () => {
    expect(oneText('abc\\U+039B\\U+0391\\U+0393\\U+0395\\U+03A1xyz')).toBe('abcΛΑΓΕΡxyz');
    expect(oneText('abc\\U+039b\\U+0391\\U+0393\\U+0395\\U+03a1xyz')).toBe('abcΛΑΓΕΡxyz');
    expect(oneText('abc\\U+039B\\\\U+0391\\\\U+0393')).toBe('abcΛ\\Α\\Γ');
    expect(oneText('abc\\U+039B0\\U+03911\\U+03932')).toBe('abcΛ0Α1Γ2');
    expect(oneText('27\\U+00B0 C')).toBe('27° C');
  });

  it('leaves a \\U+ with fewer than four hex digits as it is', () => {
    expect(oneText('a\\U+039 b')).toBe('a\\U+039 b');
    expect(oneText('a\\U+ b')).toBe('a\\U+ b');
  });

  it('decodes \\M+nXXXX through the code page its digit names, and leaves a sequence the code page rejects', () => {
    expect(oneText('\\M+5D7DF\\M+5CFDF\\M+5BCDC')).toBe('走线架');
    expect(oneText('*\\M+5d7df*')).toBe('*走*');
    expect(oneText('\\M+5D7DF\\M+5CFDFM+5BCDC')).toBe('走线M+5BCDC');
    expect(oneText('\\M+193FA')).toBe('日');
    expect(oneText('\\M+5BCD')).toBe('\\M+5BCD');
  });

  it('turns the %% codes into characters, ignores the toggles and keeps what it does not know', () => {
    expect(oneText('27%%d, %%P0.1, %%c20, %%D %%C %%p, 100%%%')).toBe('27°, ±0.1, Ø20, ° Ø ±, 100%');
    expect(oneText('%%uunder%%u %%oover%%o %%kstrike%%k')).toBe('under over strike');
    expect(oneText('%%065%%066')).toBe('AB');
    expect(oneText('50% off, %%x, %')).toBe('50% off, %%x, %');
  });

  it('decodes the caret notation and drops a trailing caret', () => {
    expect(oneText('a^Ib')).toBe('a\tb');
    expect(oneText('a^ b')).toBe('a^b');
    expect(oneText('end^')).toBe('end');
  });

  it('reads what the DXF writer of this repository escapes: a percent sign, a caret, a backslash and a degree sign', () => {
    expect(oneText('100%%% ^  \\U+005C \\U+00B0 \\U+0416')).toBe('100% ^ \\ ° Ж');
  });
});

describe('MTEXT strings', () => {
  it('breaks lines at \\P, turns a column break \\N into a space, and keeps no empty line after a last \\P', () => {
    expect(oneMtext('one\\Ptwo\\Pthree')).toEqual(['one', 'two', 'three']);
    expect(oneMtext('one\\Ntwo')).toEqual(['one two']);
    expect(oneMtext('one\\Ptwo\\P')).toEqual(['one', 'two']);
    expect(oneMtext('one\\P\\Pthree')).toEqual(['one', '', 'three']);
  });

  it('turns \\~ into a space and a tab into four, and the other control characters into a space', () => {
    expect(oneMtext('a\\~b')).toEqual(['a b']);
    expect(oneMtext('a^Ib')).toEqual(['a    b']);
    expect(oneMtext('a^Ab')).toEqual(['a b']);
    expect(oneMtext('a^Jb')).toEqual(['a', 'b']);
  });

  it('keeps an escaped backslash, opening brace and closing brace, and drops the braces of a group', () => {
    expect(oneMtext('a\\\\b \\{c\\} {d}')).toEqual(['a\\b {c} d']);
    expect(oneMtext('{\\C1;red} and {\\fArial|b1|i0;bold {\\L}nested}')).toEqual(['red and bold nested']);
  });

  it('drops the codes that change the properties, with or without a terminating semicolon', () => {
    expect(oneMtext('\\A1;\\H0.5x;\\W0.8;\\Q15;\\T2;\\C1;\\c255;text')).toEqual(['text']);
    expect(oneMtext('\\LUnder\\l \\OOver\\o \\KStrike\\k')).toEqual(['Under Over Strike']);
    expect(oneMtext('\\pxi-3,l3,t[4,8];hanging\\fTimes New Roman|b0|i1|c0|p0;text')).toEqual(['hangingtext']);
    expect(oneMtext('\\C1red')).toEqual(['red']);
  });

  it('prints a command it does not know verbatim', () => {
    expect(oneMtext('a\\Zb')).toEqual(['a\\Zb']);
  });

  it('writes a stack as numerator, a slash and denominator, whatever its stacking character, and honours an escape in it', () => {
    expect(oneMtext('\\S1/2; and \\S3^ 4; and \\S5#6; and \\Sx\\/y/z;')).toEqual(['1/2 and 3/4 and 5/6 and x/y/z']);
  });

  it('applies the % codes and the escapes of the file', () => {
    expect(oneMtext('27%%d \\U+00B0 %%c8 %%%')).toEqual(['27° ° Ø8 %']);
  });

  it('joins the 250 character chunks before it decodes, so an escape that spans two of them is read', () => {
    expect(textLines(mtext('B0b', ['a\\U+00']))[0]).toEqual(['a°b']);
  });
});

describe('text encoding of the file', () => {
  const header = (version: string, codepage?: string): string =>
    section('HEADER', pairs([9, '$ACADVER'], [1, version]) + (codepage === undefined ? '' : pairs([9, '$DWGCODEPAGE'], [3, codepage])));
  const file = (head: string, value: Buffer): Buffer =>
    Buffer.concat([Buffer.from(`${head}${pairs([0, 'SECTION'], [2, 'ENTITIES'], [0, 'TEXT'], [8, '0'], [10, 0], [20, 0], [40, 1])}  1\n`, 'latin1'), value, Buffer.from(`\n${pairs([0, 'ENDSEC'], [0, 'EOF'])}`, 'latin1')]);
  const read = (buffer: Buffer): string => parseDxfDrawing(decodeDxfBytes(buffer)).texts[0].lines[0];

  it('reads a release 2000 drawing in the code page it declares', () => {
    expect(read(file(header('AC1015', 'ANSI_1252'), Buffer.from([0x34, 0x35, 0xb0, 0x20, 0xc4, 0xdc, 0xd6])))).toBe('45° ÄÜÖ');
    expect(read(file(header('AC1015', 'ANSI_1251'), Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2])))).toBe('Привет');
    expect(read(file(header('AC1015', 'ANSI_949'), Buffer.from([0xc7, 0xd1, 0xb1, 0xdb])))).toBe('한글');
    expect(read(file(header('AC1015', 'ANSI_932'), Buffer.from([0x93, 0xfa, 0x96, 0x7b])))).toBe('日本');
    expect(read(file(header('AC1015', 'ANSI_936'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4])))).toBe('中文');
    expect(read(file(header('AC1015', 'ANSI_950'), Buffer.from([0xa4, 0xa4, 0xa4, 0xe5])))).toBe('中文');
    expect(read(file(header('AC1015', 'ANSI_1253'), Buffer.from([0xc1, 0xe2])))).toBe('Αβ');
  });

  it('reads a drawing with a code page it does not know, or none, in Windows-1252, as ezdxf does', () => {
    expect(read(file(header('AC1015', 'MAC-ROMAN'), Buffer.from([0xb0])))).toBe('°');
    expect(read(file(header('AC1015', 'ANSI_1361'), Buffer.from([0xb0])))).toBe('°');
    expect(read(file(header('AC1009'), Buffer.from([0xb0])))).toBe('°');
    expect(read(file('', Buffer.from([0xb0])))).toBe('°');
  });

  it('reads release 2007 and later in UTF-8 whatever the code page says', () => {
    expect(read(file(header('AC1021', 'ANSI_949'), Buffer.from('한글', 'utf-8')))).toBe('한글');
    expect(read(file(header('AC1027', 'ANSI_1252'), Buffer.from('45° ÄÜÖ', 'utf-8')))).toBe('45° ÄÜÖ');
  });

  it('reads an older drawing whose bytes are valid UTF-8 with non-ASCII letters as UTF-8', () => {
    expect(read(file(header('AC1015', 'ANSI_1252'), Buffer.from('45° ÄÜÖ', 'utf-8')))).toBe('45° ÄÜÖ');
    expect(read(file(header('AC1009'), Buffer.from('한글', 'utf-8')))).toBe('한글');
  });

  it('reads a file that starts with a byte-order mark as UTF-8 and reads CRLF line ends', () => {
    const body = file(header('AC1015', 'ANSI_1252'), Buffer.from('°', 'utf-8')).toString('latin1').replace(/\n/g, '\r\n');
    expect(read(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'latin1')]))).toBe('°');
  });
});

describe('real drawings', () => {
  const fixture = readFileSync('tests/fixtures/dxf/ezdxf-ascii-r12.dxf');

  it('the fixture is the file its provenance names', () => {
    expect(createHash('sha256').update(fixture).digest('hex')).toBe('b476d3e53fe24c1db3c701d20b2bebd774f7bd7966b12d81891505b9b29e4d21');
  });

  it('reads the release 12 drawing of ezdxf with its single-byte letters and its \\U+XXXX Greek letters', () => {
    const lines = parseDxfDrawing(decodeDxfBytes(fixture)).texts.map((item) => item.lines.join('\n'));
    expect(lines).toEqual(['ABCÄÜÖαβγ']);
  });
});

describe('external references', () => {
  const xref = (flags: number, entities = ''): string => pairs([0, 'BLOCK'], [8, '0'], [2, 'SITE'], [70, flags], [10, 0], [20, 0], [1, 'sites\\site-plan.dwg']) + entities + pairs([0, 'ENDBLK']);
  const insert = (name: string): string => pairs([0, 'INSERT'], [8, '0'], [2, name], [10, 5], [20, 5]);
  const line = pairs([0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 1], [21, 1]);

  it('draws nothing for an xref block and warns once per xref, naming its path, however often it is inserted', async () => {
    const result = await withConversionWarnings(async () => ({ drawn: parseDxfDrawing(drawing(line + insert('SITE') + insert('SITE'), xref(4))), metadata: {} as Record<string, unknown> }));
    expect(result.drawn.strokes).toHaveLength(1);
    expect(result.metadata.warnings).toEqual([expect.stringContaining('sites\\site-plan.dwg')]);
  });

  it('warns for an overlay and a resolved xref alike (flags 8 and 4 + 32 + 64)', async () => {
    for (const flags of [8, 4 | 32 | 64]) {
      const result = await withConversionWarnings(async () => ({ drawn: parseDxfDrawing(drawing(line + insert('SITE'), xref(flags))), metadata: {} as Record<string, unknown> }));
      expect(result.metadata.warnings, String(flags)).toHaveLength(1);
    }
  });

  it('draws the entities a writer put into the xref block and does not warn', async () => {
    const result = await withConversionWarnings(async () => ({ drawn: parseDxfDrawing(drawing(insert('SITE'), xref(4, line))), metadata: {} as Record<string, unknown> }));
    expect(result.drawn.strokes).toHaveLength(1);
    expect(result.metadata.warnings).toBeUndefined();
  });

  it('does not warn for an ordinary empty block or for an xref nothing inserts', async () => {
    const empty = pairs([0, 'BLOCK'], [8, '0'], [2, 'EMPTY'], [70, 0], [10, 0], [20, 0]) + pairs([0, 'ENDBLK']);
    const result = await withConversionWarnings(async () => ({ drawn: parseDxfDrawing(drawing(line + insert('EMPTY'), empty + xref(4))), metadata: {} as Record<string, unknown> }));
    expect(result.metadata.warnings).toBeUndefined();
  });
});
