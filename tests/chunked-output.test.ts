import { describe, expect, it } from 'vitest';
import { ChunkedOutput } from '../src/lib/conversions/chunked-output';
import { DataLimitExceededError } from '../src/lib/types';

describe('ChunkedOutput', () => {
  it('joins writes of both encodings across chunk boundaries into the bytes written', () => {
    const out = new ChunkedOutput({ expectedBytes: 16, chunkBytes: 16 });
    const parts = ['plain ascii', 'ünïcödé 李小龍 😀', 'x'.repeat(100), 'tail'];
    out.writeUtf8(parts[0]);
    out.writeUtf8(parts[1]);
    out.writeLatin1(Buffer.from(parts[2], 'latin1').toString('latin1'));
    out.writeUtf8(parts[3]);
    const expected = Buffer.concat(parts.map((part) => Buffer.from(part, 'utf8')));
    expect(out).toHaveLength(expected.length);
    expect(out.toBuffer().equals(expected)).toBe(true);
  });

  it('copies one-byte characters byte for byte', () => {
    const out = new ChunkedOutput({ chunkBytes: 8 });
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    out.writeLatin1(bytes.toString('latin1'));
    expect(out.toBuffer().equals(bytes)).toBe(true);
  });

  it('returns an empty buffer when nothing was written', () => {
    expect(new ChunkedOutput().toBuffer()).toHaveLength(0);
  });

  it('fails with a typed limit error instead of growing past its bound', () => {
    const out = new ChunkedOutput({ chunkBytes: 16, maxBytes: 40 });
    out.writeLatin1('a'.repeat(30));
    expect(() => out.writeLatin1('b'.repeat(11))).toThrow(DataLimitExceededError);
  });
});
