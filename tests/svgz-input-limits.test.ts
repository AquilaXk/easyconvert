import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { convertVectorCad } from '../src/lib/conversions/vector-cad';
import { CadGeometryUnavailableError } from '../src/lib/types';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect x="1" y="1" width="5" height="5" fill="#ff0000"/></svg>';
const BOMB_BYTES = 50 * 1024 * 1024;

describe('SVGZ input handling', () => {
  it('rejects a gzip bomb with a typed error', async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(BOMB_BYTES, 0x20));
    expect(bomb.length).toBeLessThan(1024 * 1024);
    await expect(convertVectorCad(bomb, 'svgz', 'emf')).rejects.toThrow(CadGeometryUnavailableError);
    await expect(convertVectorCad(bomb, 'svgz', 'emf')).rejects.toThrow(/beyond/);
  });

  it('rejects truncated gzip instead of treating the bytes as SVG', async () => {
    const full = zlib.gzipSync(Buffer.from(SVG, 'utf-8'));
    const truncated = full.subarray(0, full.length - 12);
    await expect(convertVectorCad(truncated, 'svgz', 'emf')).rejects.toThrow(CadGeometryUnavailableError);
    await expect(convertVectorCad(truncated, 'svgz', 'emf')).rejects.toThrow(/gzip/i);
  });

  it('rejects an svgz payload that is not gzip at all', async () => {
    await expect(convertVectorCad(Buffer.from(SVG, 'utf-8'), 'svgz', 'emf')).rejects.toThrow(/gzip/i);
  });

  it('converts a valid svgz payload', async () => {
    const result = await convertVectorCad(zlib.gzipSync(Buffer.from(SVG, 'utf-8')), 'svgz', 'emf');
    expect(result.buffer.subarray(40, 44).toString('latin1')).toBe(' EMF');
  });
});
