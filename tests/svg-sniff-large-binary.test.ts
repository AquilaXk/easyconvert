import { describe, it, expect } from 'vitest';
import { isSvg } from '../src/lib/security/svg-sanitizer';
import { expectSizeIndependentOnInputs, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

const TIFF_LE_HEADER = Buffer.from([0x49, 0x49, 0x2a, 0x00]);
const LARGE_BINARY_BYTES = 256 * 1024 * 1024;
const MODEST_BINARY_BYTES = 4 * 1024 * 1024;

describe('isSvg on large binary payloads', () => {
  it('rejects a 256 MiB TIFF-framed buffer by looking at its start only', async () => {
    const framed = (bytes: number) => {
      const payload = Buffer.alloc(bytes, 0xa5);
      TIFF_LE_HEADER.copy(payload);
      return payload;
    };
    // Looking at the start only means a 64x larger payload costs the same (tests/helpers/timing.ts).
    const { largeResult } = await expectSizeIndependentOnInputs('isSvg on a TIFF-framed buffer', (payload: Buffer) => isSvg(payload), {
      modest: framed(MODEST_BINARY_BYTES),
      huge: framed(LARGE_BINARY_BYTES),
    });
    expect(largeResult).toBe(false);
  }, SCALING_TEST_TIMEOUT_MS);

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
