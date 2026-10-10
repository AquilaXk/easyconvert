import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSvg } from '../src/lib/security/svg-sanitizer';

/** Longest prefix, in bytes, the sniff may decode before it knows the payload is not markup. */
const MAX_BINARY_DECODE_BYTES = 256;

/** A payload that starts with the given signature and is large enough to exceed the sniff window. */
function binaryPayload(signature: number[]): Buffer {
  const payload = Buffer.alloc(300 * 1024, 0x9d);
  Buffer.from(signature).copy(payload);
  return payload;
}

const BINARY_SIGNATURES: Array<[string, number[]]> = [
  ['PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['JPEG', [0xff, 0xd8, 0xff, 0xe0]],
  ['GIF', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
  ['WebP (RIFF)', [0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]],
  ['TIFF', [0x49, 0x49, 0x2a, 0x00]],
  ['BMP', [0x42, 0x4d, 0x36, 0x00]],
  ['AVIF (ISO BMFF)', [0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]],
];

describe('isSvg on binary image payloads', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(BINARY_SIGNATURES)('rejects a %s payload without decoding more than its head into a string', (_name, signature) => {
    const payload = binaryPayload(signature);
    const decode = vi.spyOn(Buffer.prototype, 'toString');
    expect(isSvg(payload)).toBe(false);
    const decodedBytes = decode.mock.calls.map(([encoding, start, end]) => (encoding === 'utf-8' || encoding === 'utf8' ? Number(end ?? payload.length) - Number(start ?? 0) : 0));
    expect(Math.max(0, ...decodedBytes)).toBeLessThanOrEqual(MAX_BINARY_DECODE_BYTES);
  });

  it('still recognises an SVG whose root follows a BOM, whitespace, a declaration, a comment and a doctype', () => {
    const svg = '﻿ \n\t<?xml version="1.0"?><!-- c --><!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>';
    expect(isSvg(Buffer.from(svg, 'utf-8'))).toBe(true);
  });

  it('still recognises an SVG that follows more whitespace than the head window holds', () => {
    expect(isSvg(Buffer.from(`${' '.repeat(500)}<svg/>`, 'utf-8'))).toBe(true);
  });

  it('rejects markup that is not SVG and text that is not markup', () => {
    expect(isSvg(Buffer.from('<html><svg/></html>'))).toBe(false);
    expect(isSvg(Buffer.from('plain text <svg/>'))).toBe(false);
    expect(isSvg(Buffer.from('  {"a":"<svg/>"}'))).toBe(false);
  });
});
