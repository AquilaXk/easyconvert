import { describe, it, expect } from 'vitest';
import { isSvg } from '../src/lib/security/svg-sanitizer';

const TIFF_LE_HEADER = Buffer.from([0x49, 0x49, 0x2a, 0x00]);
const LARGE_BINARY_BYTES = 256 * 1024 * 1024;

describe('isSvg on large binary payloads', () => {
  it('rejects a 256 MiB TIFF-framed buffer by looking at its start only', () => {
    const payload = Buffer.alloc(LARGE_BINARY_BYTES, 0xa5);
    TIFF_LE_HEADER.copy(payload);
    const started = Date.now();
    expect(isSvg(payload)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('still recognizes an SVG that follows an XML declaration, comment and doctype', () => {
    const svg = Buffer.from(
      '<?xml version="1.0"?><!-- c --><!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
    );
    expect(isSvg(svg)).toBe(true);
  });

  it('recognizes an SVG followed by a large trailing payload', () => {
    const body = Buffer.concat([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.alloc(LARGE_BINARY_BYTES / 4, 0x20)]);
    expect(isSvg(body)).toBe(true);
  });
});
