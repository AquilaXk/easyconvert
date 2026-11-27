import { describe, it } from 'vitest';
import { readEmlMessage } from '../src/lib/conversions/office/eml-reader';
import { manToMarkdown, rstToMarkdown, texToMarkdown } from '../src/lib/conversions/office/markup-text';
import { expectLinearOnInputs, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

/**
 * Growth of the markup converters and the EML boundary scan on one line of blanks followed by a letter: 4 times the line
 * cost 16 times as long while a pattern restarted at every blank. The PR gate keeps a hang guard on the same input in
 * trailing-blanks-linear.test.ts.
 */
const BASE_CHARS = 64 * 1024;

const eml = (blanks: string): Buffer =>
  Buffer.from(`Content-Type: multipart/mixed; boundary=B\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\n${blanks}a\r\n--B--\r\n`);

const READERS: ReadonlyArray<readonly [string, (blanks: string) => unknown]> = [
  ['TeX', (blanks) => texToMarkdown(`${blanks}a`)],
  ['reStructuredText', (blanks) => rstToMarkdown(`${blanks}a`)],
  ['man', (blanks) => manToMarkdown(`${blanks}a`)],
  ['EML', (blanks) => readEmlMessage(eml(blanks))],
  ['TeX verbatim', (blanks) => texToMarkdown(`\\begin{verbatim}\n${blanks.replaceAll(' ', '\n')}x\\end{verbatim}`)],
];

describe('trailing blanks', () => {
  it.each(READERS)('are cut in linear time by the %s reader', async (_name, read) => {
    await expectLinearOnInputs('read', read, { small: ' '.repeat(BASE_CHARS), large: ' '.repeat(BASE_CHARS * SCALING_FACTOR) });
  }, SCALING_TEST_TIMEOUT_MS);
});
