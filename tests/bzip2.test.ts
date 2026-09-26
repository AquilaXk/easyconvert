import { describe, it, expect } from 'vitest';
import { compressBzip2, decompressBzip2 } from '../src/lib/conversions/bzip2';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('Bzip2 Pure TypeScript Implementation', () => {
  it('compresses data that can be verified by system /usr/bin/bzip2', () => {
    const originalText = 'Hello World! The quick brown fox jumps over the lazy dog. EasyConvert pure-TS bzip2 engine.';
    const inputBuf = Buffer.from(originalText, 'utf-8');
    const compressed = compressBzip2(inputBuf);

    expect(compressed.length).toBeGreaterThan(0);
    expect(compressed.subarray(0, 3).toString('ascii')).toBe('BZh');

    // Test with system bzip2
    const tmpDir = os.tmpdir();
    const tmpBz2 = path.join(tmpDir, `test-${Date.now()}.bz2`);
    fs.writeFileSync(tmpBz2, compressed);

    try {
      const decompressedSystem = cp.execSync(`/usr/bin/bzip2 -dc "${tmpBz2}"`).toString('utf-8');
      expect(decompressedSystem).toBe(originalText);
    } finally {
      if (fs.existsSync(tmpBz2)) fs.unlinkSync(tmpBz2);
    }
  });

  it('decompresses data compressed by system /usr/bin/bzip2', () => {
    const originalText = 'Universal File Conversion Testing string for Bzip2 decompression roundtrip.';
    const tmpDir = os.tmpdir();
    const tmpTxt = path.join(tmpDir, `test-in-${Date.now()}.txt`);
    fs.writeFileSync(tmpTxt, originalText);

    try {
      cp.execSync(`/usr/bin/bzip2 -f "${tmpTxt}"`);
      const bz2File = `${tmpTxt}.bz2`;
      const bz2Buf = fs.readFileSync(bz2File);
      const decompressed = decompressBzip2(bz2Buf);
      expect(decompressed.toString('utf-8')).toBe(originalText);
      fs.unlinkSync(bz2File);
    } finally {
      if (fs.existsSync(tmpTxt)) fs.unlinkSync(tmpTxt);
    }
  });
});
