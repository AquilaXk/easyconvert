import { describe, expect, it } from 'vitest';
import { attachmentContentDisposition } from '../src/lib/api/content-disposition';

/**
 * A download name comes from a file a person uploaded, so it is untrusted: whatever it holds, the header stays one line whose
 * `filename` is a quoted ASCII string and whose `filename*` carries the whole name percent-encoded.
 */

const asciiFallbackOf = (header: string) => /; filename="([^"]*)";/.exec(header)?.[1];
const extendedNameOf = (header: string) => /filename\*=UTF-8''(.*)$/.exec(header)?.[1];

describe('attachmentContentDisposition', () => {
  it('writes both forms of a plain name', () => {
    expect(attachmentContentDisposition('report.docx')).toBe(`attachment; filename="report.docx"; filename*=UTF-8''report.docx`);
  });

  it('removes a carriage return and a line feed, so a name cannot add a header', () => {
    const header = attachmentContentDisposition('a\r\nSet-Cookie: session=1.pdf');

    expect(header).not.toMatch(/[\r\n]/);
    expect(header.split('; ')).toHaveLength(3);
    expect(decodeURIComponent(extendedNameOf(header) ?? '')).toBe('aSet-Cookie: session=1.pdf');
  });

  it('removes quotes and backslashes from the quoted name so it cannot end early', () => {
    const header = attachmentContentDisposition('say "hi" \\ bye.pdf');

    expect(asciiFallbackOf(header)).toBe('say hi  bye.pdf');
    expect(decodeURIComponent(extendedNameOf(header) ?? '')).toBe('say hi  bye.pdf');
  });

  it('encodes a percent sign in the extended name so that it is not read as an escape', () => {
    const header = attachmentContentDisposition('100%25 sure.pdf');

    expect(extendedNameOf(header)).toBe('100%2525%20sure.pdf');
    expect(decodeURIComponent(extendedNameOf(header) ?? '')).toBe('100%25 sure.pdf');
  });

  it('writes the characters that RFC 5987 does not allow as percent escapes', () => {
    expect(extendedNameOf(attachmentContentDisposition("it's (a)*.pdf"))).toBe('it%27s%20%28a%29%2A.pdf');
  });

  it('keeps a name above U+00FF whole in filename* and replaces it with underscores in the ASCII filename', () => {
    const header = attachmentContentDisposition('농협 IT.pdf');

    expect(asciiFallbackOf(header)).toBe('__ IT.pdf');
    expect(decodeURIComponent(extendedNameOf(header) ?? '')).toBe('농협 IT.pdf');
    expect(() => new Headers({ 'Content-Disposition': header })).not.toThrow();
  });

  it('writes an empty name as two empty values on one line', () => {
    expect(attachmentContentDisposition('')).toBe(`attachment; filename=""; filename*=UTF-8''`);
  });
});
