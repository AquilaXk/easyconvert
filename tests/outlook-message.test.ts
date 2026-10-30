import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extractTextContentForOffice } from '../src/lib/conversions/office';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { readCfbContainer } from '../src/lib/conversions/office/cfb-streams';
import { decompressRtf, rtfChecksum } from '../src/lib/conversions/office/msg-rtf-compression';
import { readRtfText } from '../src/lib/conversions/office/rtf-reader';
import { buildCompoundFile, type CfbStream } from './helpers/cfb-craft';
import { requireRealworldSample } from './helpers/realworld-sample';
import { cpuClockMs, expectLinearOnInputs, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

/**
 * Outlook messages (.msg) were handed to the plain-text writers as if they were text: the compound file's bytes became the
 * "text" (a .txt of 28,912 characters of mojibake for a 29 KB message, and an HTML page and a ZIP that held the same), and a PDF
 * failed with "No installed font has a glyph for U+0871" for the first characters of the file's signature. Nothing refused them,
 * so the nightly run counted the text, HTML and ZIP outputs as good. The message is now read as [MS-OXMSG] lays it out.
 *
 * The references are 7-Zip's listing of the streams of each real file (an independent reader of the compound file), whose
 * body streams are pinned below by SHA-256 after the line ends are normalised and the trailing white space is cut.
 */

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

async function text(bytes: Buffer, target = 'txt', name = 'message.msg'): Promise<string> {
  return (await dispatchConversion(bytes, 'msg', target, {}, name)).buffer.toString('utf8');
}

function bodyOf(converted: string): string {
  const afterHeaders = converted.slice(converted.indexOf('\n\n') + 2);
  const end = afterHeaders.indexOf('\n\nAttachments:');
  return end < 0 ? afterHeaders : afterHeaders.slice(0, end);
}

describe('real Outlook messages are read, not taken for text', () => {
  const REAL: ReadonlyArray<{ id: string; subject: string; from: string; bodySha: string | null; attachments: number }> = [
    {
      id: 'tika-test-outlook2003.msg',
      subject: 'Welcome to Microsoft Office Outlook 2003',
      from: 'Microsoft Outlook 2003 Team <olteam@microsoft.com>',
      bodySha: 'ae28280f9872b6b3228c324ae584fef78a8e3db2b538005aa70caa619868a124',
      attachments: 11,
    },
    {
      id: 'tika-test-outlook.msg',
      subject: 'Microsoft Outlook Express 6',
      from: "L'Équipe Microsoft Outlook Express <msoe@microsoft.com>",
      bodySha: 'a7ee3390dc986db5fd5e88fcdaff2cbb188240a2ac05df1676a187ec00901a6e',
      attachments: 0,
    },
    {
      id: 'office-51873.msg',
      subject: 'Test with Olk10SideProps_ Chunk',
      from: '',
      bodySha: null,
      attachments: 0,
    },
  ];

  for (const sample of REAL) {
    it(`${sample.id} gives its headers, its body and its attachments to txt, html, pdf and zip`, async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, sample.id);
      const converted = await text(bytes);
      expect(converted).toContain(`Subject: ${sample.subject}`);
      if (sample.from !== '') expect(converted).toContain(`From: ${sample.from}`);
      expect(converted).not.toMatch(/[\u0000�]/);
      if (sample.bodySha !== null) expect(sha256(bodyOf(converted))).toBe(sample.bodySha);
      expect(converted.match(/^- .+ \(\d+ bytes\)$/gm) ?? []).toHaveLength(sample.attachments);

      expect(await text(bytes, 'html')).toContain(sample.subject.replace(/&/g, '&amp;'));
      expect((await dispatchConversion(bytes, 'msg', 'pdf', {}, sample.id)).buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect((await dispatchConversion(bytes, 'msg', 'zip', {}, sample.id)).buffer.subarray(0, 2).toString('latin1')).toBe('PK');
    }, 60_000);
  }
});

const TYPE_STRING = 0x001f;
const TYPE_INT32 = 0x0003;
const TYPE_FILETIME = 0x0040;

function fixedEntry(id: number, type: number, value: Buffer): Buffer {
  const entry = Buffer.alloc(16);
  entry.writeUInt16LE(type, 0);
  entry.writeUInt16LE(id, 2);
  entry.writeUInt32LE(0x6, 4);
  value.copy(entry, 8);
  return entry;
}

const int32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32LE(value);
  return bytes;
};

function filetime(date: Date): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(date.getTime()) * 10_000n + 116_444_736_000_000_000n);
  return bytes;
}

function propertyStream(header: number, entries: Buffer[]): Buffer {
  return Buffer.concat([Buffer.alloc(header), ...entries]);
}

const unicode = (name: string, tag: string, value: string): CfbStream => ({ name: `${name}__substg1.0_${tag}001F`, data: Buffer.from(`${value}\u0000`, 'utf16le') });

const RTF_PREFIX = '{\\rtf1\\ansi';
const DICTIONARY_LENGTH = 207;

/**
 * A compressed RTF stream written by a compressor of the test's own, from [MS-OXRTFCP] 2.1: the prefix of the dictionary as a
 * reference, the rest as literals in groups of eight tokens, and a reference to the write position as the end marker.
 */
function compressedRtf(tail: string): Buffer {
  const literals = [...Buffer.from(tail, 'latin1')];
  const tokens: number[] = [];
  const reference = (offset: number, length: number): number[] => {
    const token = (offset << 4) | (length - 2);
    return [token >> 8, token & 0xff];
  };
  let group: number[] = [0x01, ...reference(0, RTF_PREFIX.length)];
  let slots = 1;
  for (const literal of literals) {
    if (slots === 8) {
      tokens.push(...group);
      group = [0x00];
      slots = 0;
    }
    group.push(literal);
    slots += 1;
  }
  const write = DICTIONARY_LENGTH + RTF_PREFIX.length + literals.length;
  if (slots === 8) {
    tokens.push(...group);
    group = [0x00];
    slots = 0;
  }
  group[0] |= 1 << slots;
  group.push(...reference(write, 2));
  tokens.push(...group);
  const contents = Buffer.from(tokens);
  const header = Buffer.alloc(16);
  header.writeUInt32LE(contents.length + 12, 0);
  header.writeUInt32LE(RTF_PREFIX.length + literals.length, 4);
  header.writeUInt32LE(0x75465a4c, 8);
  header.writeUInt32LE(rtfChecksum(contents), 12);
  return Buffer.concat([header, contents]);
}

function message(extra: CfbStream[], properties: Buffer[] = []): Buffer {
  return buildCompoundFile([{ name: '__properties_version1.0', data: propertyStream(32, properties) }, ...extra]);
}

describe('a message is read from its properties', () => {
  it('writes the headers, recipients by kind, the date, the plain body and the attachments', async () => {
    const sent = new Date('2026-03-04T05:06:07.000Z');
    const recipient = (index: number, kind: number, name: string, address: string): CfbStream[] => [
      { name: `__recip_version1.0_#0000000${index}/__properties_version1.0`, data: propertyStream(8, [fixedEntry(0x0c15, TYPE_INT32, int32(kind))]) },
      unicode(`__recip_version1.0_#0000000${index}/`, '3001', name),
      unicode(`__recip_version1.0_#0000000${index}/`, '39FE', address),
    ];
    const bytes = message(
      [
        unicode('', '0037', 'Quarterly numbers'),
        unicode('', '0C1A', 'Ada Lovelace'),
        unicode('', '0C1E', 'EX'),
        unicode('', '0C1F', '/O=EXCH/OU=FIRST/CN=ADA'),
        unicode('', '5D01', 'ada@example.org'),
        unicode('', '1000', 'First line\r\nSecond line\r\n'),
        ...recipient(0, 1, 'Grace Hopper', 'grace@example.org'),
        ...recipient(1, 2, 'Alan Turing', 'alan@example.org'),
        ...recipient(2, 3, 'Edsger Dijkstra', 'edsger@example.org'),
        { name: '__attach_version1.0_#00000000/__substg1.0_37010102', data: Buffer.alloc(300) },
        unicode('__attach_version1.0_#00000000/', '3707', 'report.xlsx'),
      ],
      [fixedEntry(0x0039, TYPE_FILETIME, filetime(sent))]
    );
    expect(await text(bytes)).toBe(
      [
        'From: Ada Lovelace <ada@example.org>',
        'To: Grace Hopper <grace@example.org>',
        'Cc: Alan Turing <alan@example.org>',
        'Bcc: Edsger Dijkstra <edsger@example.org>',
        'Date: 2026-03-04T05:06:07.000Z',
        'Subject: Quarterly numbers',
        '',
        'First line\nSecond line',
        '',
        'Attachments:',
        '- report.xlsx (300 bytes)',
      ].join('\n')
    );
  });

  it('reads an 8-bit string in the code page of the message', async () => {
    const russian = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    const bytes = message(
      [
        { name: '__substg1.0_0037001E', data: Buffer.concat([russian, Buffer.from([0])]) },
        { name: '__substg1.0_1000001E', data: Buffer.concat([russian, Buffer.from([0])]) },
      ],
      [fixedEntry(0x3fde, TYPE_INT32, int32(1251))]
    );
    expect(await text(bytes)).toBe('Subject: Привет\n\nПривет');
  });

  it('falls back to the HTML body, then to the compressed RTF body, when there is no plain one', async () => {
    const html = message([{ name: '__substg1.0_10130102', data: Buffer.from('<html><body><p>From <b>html</b></p></body></html>') }]);
    expect(await text(html)).toBe('From html');

    const rtf = message([{ name: '__substg1.0_10090102', data: compressedRtf(' hi mom}') }]);
    expect(await text(rtf)).toBe('hi mom');
  });
});

describe('the compressed RTF of a message', () => {
  it('starts from the 207-byte dictionary of the specification, so a reference into it gives its text', () => {
    const stream = compressedRtf(' hello}');
    expect(decompressRtf(stream)?.toString('latin1')).toBe('{\\rtf1\\ansi hello}');
  });

  it('decompresses the RTF stream of a real message to the raw size it declares, and its words are the body', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'tika-test-outlook.msg');
    const stream = readCfbContainer(bytes, 'MSG').paths.get('__substg1.0_10090102') as Buffer;
    const rtf = decompressRtf(stream);
    expect(rtf?.length).toBe(stream.readUInt32LE(4));
    expect(rtf?.subarray(0, 11).toString('latin1')).toBe('{\\rtf1\\ansi');
    expect(readRtfText(rtf as Buffer)).toContain('Messagerie et groupes de discussion');
  });

  it('refuses a checksum that does not match, a raw size past the limit and a cut-off token', () => {
    const good = compressedRtf(' hello}');
    const wrongChecksum = Buffer.from(good);
    wrongChecksum.writeUInt32LE(0, 12);
    expect(decompressRtf(wrongChecksum)).toBeUndefined();
    const huge = Buffer.from(good);
    huge.writeUInt32LE(0xffffffff, 4);
    expect(decompressRtf(huge)).toBeUndefined();
    expect(decompressRtf(good.subarray(0, 10))).toBeUndefined();
  });
});

describe('what is not an Outlook message is refused with a typed answer', () => {
  it('refuses a compound file that is a Word document named .msg', async () => {
    const bytes = buildCompoundFile([{ name: 'WordDocument', data: Buffer.alloc(600, 1) }]);
    await expect(text(bytes)).rejects.toMatchObject({ name: 'LegacyOfficeFormatError', status: 400 });
  });

  it('refuses bytes that are no compound file', async () => {
    await expect(text(Buffer.from('plain text, not a message'))).rejects.toMatchObject({ name: 'LegacyOfficeFormatError' });
  });

  it('refuses a binary container that has no reader instead of writing its bytes as text', async () => {
    const djvu = Buffer.concat([Buffer.from('AT&TFORM'), Buffer.alloc(64), Buffer.from('DJVMDIRM')]);
    await expect(dispatchConversion(djvu, 'djvu', 'txt', {}, 'book.djvu')).rejects.toThrow(/fail-closed against mojibake/);
    await expect(dispatchConversion(djvu, 'djvu', 'pdf', {}, 'book.djvu')).rejects.toThrow(/fail-closed against mojibake/);
  });
});

const EMPTY_RTF_TAIL = '\\deff0 {\\fonttbl{\\f0 Arial;}}\\pard\\f0\\fs20\\par}';
const attachment = (index: number, name: string, size: number): CfbStream[] => [
  { name: `__attach_version1.0_#0000000${index}/__substg1.0_37010102`, data: Buffer.alloc(size) },
  unicode(`__attach_version1.0_#0000000${index}/`, '3707', name),
];

describe('the body of a message is trimmed in linear time', () => {
  it('trims a run of white space followed by a character in CPU time linear in its length', async () => {
    const BASE_SPACES = 50_000;
    const body = (spaces: number): Buffer => message([unicode('', '1000', `${' '.repeat(spaces)}x`)]);
    const { largeResult } = await expectLinearOnInputs('white space before the last character of the body', (bytes: Buffer) => text(bytes), {
      small: body(BASE_SPACES),
      large: body(BASE_SPACES * SCALING_FACTOR),
      clock: cpuClockMs,
    });
    expect(await largeResult).toMatch(/x$/);
  }, SCALING_TEST_TIMEOUT_MS);
});

describe('the RTF body of a message', () => {
  it('converts a message whose only body is an RTF without text to its headers and its attachment list', async () => {
    const bytes = message([
      unicode('', '0037', 'Please see attached'),
      unicode('', '0C1A', 'Ada'),
      { name: '__substg1.0_10090102', data: compressedRtf(EMPTY_RTF_TAIL) },
      ...attachment(0, 'scan.pdf', 100),
    ]);
    expect(await text(bytes)).toBe(['From: Ada', 'Subject: Please see attached', '', 'Attachments:', '- scan.pdf (100 bytes)'].join('\n'));
    const noBody = message([unicode('', '0037', 'Please see attached'), unicode('', '0C1A', 'Ada'), ...attachment(0, 'scan.pdf', 100)]);
    expect(await text(noBody)).toBe(await text(bytes));
  });

  it('names an RTF it cannot read in a warning and still converts the message', async () => {
    const damaged = Buffer.from(compressedRtf(' hi}'));
    damaged.writeUInt32LE(0, 12);
    const result = await dispatchConversion(message([unicode('', '0037', 'Subject line'), { name: '__substg1.0_10090102', data: damaged }]), 'msg', 'txt', {}, 'message.msg');
    expect(result.buffer.toString('utf8')).toBe('Subject: Subject line');
    expect(result.metadata?.warnings).toEqual([expect.stringMatching(/RTF body/)]);
  });

  it('gives no warning when the RTF only holds no text', async () => {
    const result = await dispatchConversion(message([unicode('', '0037', 'S'), { name: '__substg1.0_10090102', data: compressedRtf(EMPTY_RTF_TAIL) }]), 'msg', 'txt', {}, 'message.msg');
    expect(result.metadata?.warnings).toBeUndefined();
  });
});

describe('the code page of a message', () => {
  const ESCAPE = 0x1b;
  const subjectIn = async (bytes: Buffer, codePages: readonly number[]): Promise<string> =>
    text(
      message(
        [{ name: '__substg1.0_0037001E', data: Buffer.concat([bytes, Buffer.alloc(2)]) }],
        codePages.map((codePage, index) => fixedEntry(index === 0 ? 0x3fde : 0x3ffd, TYPE_INT32, int32(codePage)))
      )
    );

  it.each([
    ['50220 (ISO-2022-JP)', 50220, Buffer.from([ESCAPE, 0x24, 0x42, 0x24, 0x22, ESCAPE, 0x28, 0x42]), 'あ'],
    ['51932 (EUC-JP)', 51932, Buffer.from([0xa4, 0xa2]), 'あ'],
    ['20932 (EUC-JP, JIS X 0208-1990)', 20932, Buffer.from([0xa4, 0xa2]), 'あ'],
    ['54936 (GB18030)', 54936, Buffer.from([0xc4, 0xe3]), '你'],
    ['50221 (ISO-2022-JP)', 50221, Buffer.from([ESCAPE, 0x24, 0x42, 0x24, 0x22, ESCAPE, 0x28, 0x42]), 'あ'],
    ['51949 (EUC-KR)', 51949, Buffer.from([0xb0, 0xa1]), '가'],
    ['21866 (KOI8-U)', 21866, Buffer.from([0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4]), 'Привет'],
  ])('reads a string in code page %s', async (_label, codePage, bytes, expected) => {
    expect(await subjectIn(bytes, [codePage])).toBe(`Subject: ${expected}`);
  });

  it('takes code page 1200 for unset, since 8-bit strings are never UTF-16, and uses the next property', async () => {
    expect(await subjectIn(Buffer.from('Hello', 'latin1'), [1200])).toBe('Subject: Hello');
    expect(await subjectIn(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), [1200, 1251])).toBe('Subject: Привет');
  });

  it('takes a code page of 0 or below for unset and uses the next property, then Windows-1252', async () => {
    const russian = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    expect(await subjectIn(russian, [0, 1251])).toBe('Subject: Привет');
    expect(await subjectIn(russian, [-1, 1251])).toBe('Subject: Привет');
    expect(await subjectIn(Buffer.from([0xe9]), [0, 0])).toBe('Subject: é');
    expect(await subjectIn(Buffer.from([0xe9]), [-5])).toBe('Subject: é');
  });

  it('refuses a code page no decoder reads with the typed 400, not a 500', async () => {
    for (const codePage of [28602, 437, 99999]) {
      await expect(subjectIn(Buffer.from('abc'), [codePage])).rejects.toMatchObject({ name: 'LegacyOfficeFormatError', status: 400 });
    }
  });
});

describe('recipients and the sender are written by one rule', () => {
  const recipient = (index: number, name: string, addressType: string, address: string, smtp?: string): CfbStream[] => [
    unicode(`__recip_version1.0_#0000000${index}/`, '3001', name),
    unicode(`__recip_version1.0_#0000000${index}/`, '3002', addressType),
    unicode(`__recip_version1.0_#0000000${index}/`, '3003', address),
    ...(smtp === undefined ? [] : [unicode(`__recip_version1.0_#0000000${index}/`, '39FE', smtp)]),
  ];

  it('leaves out an Exchange address unless the SMTP one is there, as for the sender', async () => {
    const bytes = message([
      unicode('', '0C1A', 'Ada'),
      unicode('', '0C1E', 'EX'),
      unicode('', '0C1F', '/O=EXCH/OU=FIRST/CN=ADA'),
      ...recipient(0, 'Grace Hopper', 'EX', '/O=EXCH/OU=FIRST/CN=GRACE'),
      ...recipient(1, 'Alan Turing', 'EX', '/O=EXCH/OU=FIRST/CN=ALAN', 'alan@example.org'),
      ...recipient(2, 'Edsger Dijkstra', 'SMTP', 'edsger@example.org'),
    ]);
    expect(await text(bytes)).toBe(['From: Ada', 'To: Grace Hopper; Alan Turing <alan@example.org>; Edsger Dijkstra <edsger@example.org>'].join('\n'));
  });
});

describe('the text of a message for the office writers', () => {
  it('is the same headers and body the text target gives, not the compound file refusal', async () => {
    const bytes = message([unicode('', '0037', 'Quarterly numbers'), unicode('', '0C1A', 'Ada Lovelace'), unicode('', '1000', 'Body of the message')]);
    expect(await extractTextContentForOffice(bytes, 'msg', {}, 'message')).toBe(await text(bytes));
  });
});
