import { describe, expect, it } from 'vitest';
import { sanitizeNodeOutputFilename } from '../src/lib/queue/graph/node-jobs';

/** A file name is at most 255 bytes in UTF-8 for a file system or object store; a Korean letter takes 3 of them, an emoji 4. */
const MAX_BYTES = 255;
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

describe('sanitizeNodeOutputFilename length', () => {
  it('cuts a long Korean name to 255 bytes on a letter boundary and keeps the extension', () => {
    const name = sanitizeNodeOutputFilename(`${'한'.repeat(200)}.pdf`);
    expect(bytes(name)).toBeLessThanOrEqual(MAX_BYTES);
    expect(name).toBe(`${'한'.repeat(83)}.pdf`);
    expect(name).not.toContain('�');
  });

  it('keeps a compound extension and does not split a letter that sits on the cut', () => {
    const name = sanitizeNodeOutputFilename(`${'가'.repeat(100)}b.tar.gz`);
    expect(name.endsWith('.tar.gz')).toBe(true);
    expect(bytes(name)).toBeLessThanOrEqual(MAX_BYTES);
    expect(Buffer.from(name, 'utf8').toString('utf8')).toBe(name);
    expect(name).toBe(`${'가'.repeat(82)}.tar.gz`);
  });

  it('does not split a pair of surrogates of an emoji', () => {
    const name = sanitizeNodeOutputFilename(`${'😀'.repeat(80)}.png`);
    expect(bytes(name)).toBeLessThanOrEqual(MAX_BYTES);
    expect(name).toBe(`${'😀'.repeat(62)}.png`);
  });

  it('leaves a name alone that fits in 255 bytes', () => {
    const fits = `${'한'.repeat(80)}.pdf`;
    expect(bytes(fits)).toBe(244);
    expect(sanitizeNodeOutputFilename(fits)).toBe(fits);
    const exact = `${'한'.repeat(83)}.pdf`;
    expect(bytes(exact)).toBe(MAX_BYTES - 2);
    expect(sanitizeNodeOutputFilename(exact)).toBe(exact);
  });

  it('keeps the ASCII behaviour: 255 characters in all', () => {
    expect(sanitizeNodeOutputFilename(`${'a'.repeat(260)}.pdf`)).toBe(`${'a'.repeat(251)}.pdf`);
  });
});
