import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CORPUS_DIR = path.join(__dirname, '..', 'bench', 'corpus');
const MAX_CORPUS_BYTES = 5 * 1024 * 1024;
const JPEG_SOI = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Manifest {
  totalBytes: number;
  files: Array<{ file: string; bytes: number; sha256: string }>;
}

const manifest = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, 'manifest.json'), 'utf8')) as Manifest;

describe('benchmark corpus', () => {
  it('matches the committed checksums, sizes and the 5 MB budget', () => {
    let total = 0;
    for (const entry of manifest.files) {
      const bytes = fs.readFileSync(path.join(CORPUS_DIR, entry.file));
      expect(createHash('sha256').update(bytes).digest('hex'), entry.file).toBe(entry.sha256);
      expect(bytes.length, entry.file).toBe(entry.bytes);
      total += bytes.length;
    }
    expect(total).toBe(manifest.totalBytes);
    expect(total).toBeLessThanOrEqual(MAX_CORPUS_BYTES);
  });

  it('documents every file in PROVENANCE.md', () => {
    const provenance = fs.readFileSync(path.join(CORPUS_DIR, 'PROVENANCE.md'), 'utf8');
    for (const entry of manifest.files) {
      expect(provenance, entry.file).toContain(`\`${entry.file}\``);
    }
  });

  it('holds real image, audio and container payloads, not placeholders', () => {
    const head = (name: string, length: number): Buffer => fs.readFileSync(path.join(CORPUS_DIR, name)).subarray(0, length);
    expect(head('photo-a.jpg', 3).equals(JPEG_SOI)).toBe(true);
    for (const png of ['photo-b.png', 'screenshot.png', 'lineart.png', 'scan.png']) {
      expect(head(png, 8).equals(PNG_MAGIC), png).toBe(true);
    }
    expect(head('speech.wav', 4).toString('latin1')).toBe('RIFF');
    expect(head('music.wav', 4).toString('latin1')).toBe('RIFF');
    expect(head('clip.mp4', 12).subarray(4, 8).toString('latin1')).toBe('ftyp');
    expect(head('report.docx', 2).toString('latin1')).toBe('PK');
  });
});
