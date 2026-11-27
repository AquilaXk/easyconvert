import { describe, expect, it } from 'vitest';
import { readEmlMessage } from '../src/lib/conversions/office/eml-reader';

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
