import { describe, expect, it, vi } from 'vitest';
import { readEmlMessage } from '../src/lib/conversions/office/eml-reader';
import { PayloadLimitError } from '../src/lib/types';

const HEAD = 'Content-Type: multipart/mixed; boundary=B\r\n\r\n';
const PART = (body: string): string => `--B\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`;

describe('a multipart message that ends without its close delimiter', () => {
  it('keeps the part that was still open when the input ended', () => {
    const message = readEmlMessage(Buffer.from(`${HEAD}${PART('first')}--B\r\nContent-Type: text/plain\r\n\r\nsecond, cut off`));
    expect(message.textBody).toBe('first\n\nsecond, cut off');
  });

  it('keeps the only part of a message cut right after its first line', () => {
    expect(readEmlMessage(Buffer.from(`${HEAD}--B\r\nContent-Type: text/plain\r\n\r\nhello`)).textBody).toBe('hello');
  });

  it('keeps the open part of a nested multipart that is cut off', () => {
    const inner = 'Content-Type: multipart/alternative; boundary=C\r\n\r\n--C\r\nContent-Type: text/plain\r\n\r\nnested text';
    const message = readEmlMessage(Buffer.from(`${HEAD}--B\r\n${inner}`));
    expect(message.textBody).toBe('nested text');
  });

  it('reads the same parts when the close delimiter is present', () => {
    const message = readEmlMessage(Buffer.from(`${HEAD}${PART('first')}${PART('second')}--B--\r\n`));
    expect(message.textBody).toBe('first\n\nsecond');
  });
});

describe('the size of an EML input', () => {
  const LIMIT = 64 * 1024 * 1024;

  it('refuses an input over the limit with the typed input-over-limit error before reading it as text', () => {
    const input = Buffer.alloc(LIMIT + 1, 0x61);
    const toString = vi.spyOn(input, 'toString');
    expect(() => readEmlMessage(input)).toThrow(PayloadLimitError);
    expect(toString).not.toHaveBeenCalled();
  });

  it('reads an input of exactly the limit when most of it is a preamble that the walk ignores', () => {
    const message = Buffer.from('\r\n--B\r\nContent-Type: text/plain\r\n\r\nhello\r\n--B--\r\n');
    const head = Buffer.from('Subject: s\r\nContent-Type: multipart/mixed; boundary=B\r\n\r\n');
    const input = Buffer.concat([head, Buffer.alloc(LIMIT - head.length - message.length, 0x61), message]);
    expect(input.length).toBe(LIMIT);
    expect(readEmlMessage(input).textBody).toBe('hello');
  });
});
