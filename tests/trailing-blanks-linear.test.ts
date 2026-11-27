import { describe, expect, it } from 'vitest';
import { readEmlMessage } from '../src/lib/conversions/office/eml-reader';
import { manToMarkdown, rstToMarkdown, texToMarkdown } from '../src/lib/conversions/office/markup-text';
import { expectNoHangOnInput } from './helpers/timing';

/**
 * A pattern such as `/[ \t]+$/` restarts at every blank of a run, so one line of 80,000 spaces and a letter took 2.8 s and a
 * megabyte of them about 460 s on the worker thread. The markup converters and the EML boundary scan now cut trailing blanks
 * by index. The growth ratio is in trailing-blanks-linear.perf.test.ts; these cases run one hostile line of a megabyte under the hang guard.
 */
const RUN = 1 << 20;
const BLANKS = ' '.repeat(RUN);

describe('markup converters cut trailing blanks in linear time', () => {
  it('reads a megabyte of spaces followed by a letter as TeX, reStructuredText and man text', async () => {
    const input = `${BLANKS}a`;
    const tex = await expectNoHangOnInput('tex', (text: string) => texToMarkdown(text), input);
    const rst = await expectNoHangOnInput('rst', (text: string) => rstToMarkdown(text), input);
    const man = await expectNoHangOnInput('man', (text: string) => manToMarkdown(text), input);
    expect(tex.largeResult).toBe('a');
    expect(rst.largeResult).toBe('a');
    expect(man.largeResult).toBe('a');
  });

  it('cuts the blanks at the end of a line and keeps the ones inside it', () => {
    expect(texToMarkdown('a \t b  \t\nc')).toBe('a \t b\nc');
  });

  it('cuts the line breaks around a verbatim body, however many there are', async () => {
    const input = `\\begin{verbatim}\n${'\n'.repeat(RUN)}code${'\n'.repeat(RUN)}\\end{verbatim}`;
    const { largeResult } = await expectNoHangOnInput('verbatim', (text: string) => texToMarkdown(text), input);
    expect(largeResult).toBe('```\ncode\n```');
  });
});

describe('the EML boundary scan', () => {
  const message = (padding: string): Buffer =>
    Buffer.from(
      `Content-Type: multipart/mixed; boundary=B\r\n\r\n--B${padding}\r\nContent-Type: text/plain\r\n\r\nhello\r\n--B--${padding}\r\n`
    );

  it('finds boundary lines that carry trailing blanks', () => {
    expect(readEmlMessage(message(' \t ')).textBody).toBe('hello');
  });

  it('reads a megabyte-long line of blanks inside a part within the hang guard', async () => {
    const input = Buffer.from(
      `Content-Type: multipart/mixed; boundary=B\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\n${BLANKS}a\r\n--B--\r\n`
    );
    const { largeResult } = await expectNoHangOnInput('eml', (buffer: Buffer) => readEmlMessage(buffer), input);
    expect(largeResult.textBody).toBe('a');
  });
});
