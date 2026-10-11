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

  it('holds real table, font and ebook payloads in the formats their names say', () => {
    const head = (name: string, length: number): Buffer => fs.readFileSync(path.join(CORPUS_DIR, name)).subarray(0, length);
    const tail = (name: string, length: number): Buffer => fs.readFileSync(path.join(CORPUS_DIR, name)).subarray(-length);
    expect(head('data/table.parquet', 4).toString('latin1')).toBe('PAR1');
    expect(tail('data/table.parquet', 4).toString('latin1')).toBe('PAR1');
    expect(head('data/table.xlsx', 2).toString('latin1')).toBe('PK');
    expect(head('fonts/sans.ttf', 4).equals(Buffer.from([0x00, 0x01, 0x00, 0x00]))).toBe(true);
    expect(head('fonts/sans-cff.otf', 4).toString('latin1')).toBe('OTTO');
    expect(head('ebooks/book.epub', 2).toString('latin1')).toBe('PK');
    expect(head('ebooks/book.epub', 58).subarray(30).toString('latin1')).toContain('mimetype');
    expect(head('ebooks/book.fb2', 5).toString('latin1')).toBe('<?xml');
    // A MOBI file is a PalmDB whose first record header carries the type and creator at offset 60.
    expect(head('ebooks/book.mobi', 68).subarray(60, 68).toString('latin1')).toBe('BOOKMOBI');
  });

  it('keeps the table, its JSON lines and its CSV the same 2,500 records', () => {
    const lines = fs.readFileSync(path.join(CORPUS_DIR, 'data/table.jsonl'), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2_500);
    const records = lines.map((line) => JSON.parse(line) as Record<string, string | number | boolean | null>);
    expect(Object.keys(records[0])).toEqual(['id', 'code', 'name', 'city', 'amount', 'score', 'active', 'note', 'ts']);
    expect(records.map((record) => record.id)).toEqual(Array.from({ length: 2_500 }, (_, index) => index + 1));
    const csv = fs.readFileSync(path.join(CORPUS_DIR, 'data/table.csv'), 'utf8');
    expect(csv.startsWith('id,code,name,city,amount,score,active,note,ts\r\n')).toBe(true);
    // The cells that break converters are in the table.
    expect(records.some((record) => record.code === '00004' || /^0\d+$/.test(String(record.code)))).toBe(true);
    expect(records.some((record) => /^\de\d$/.test(String(record.code)))).toBe(true);
    expect(records.some((record) => String(record.name).includes('\n'))).toBe(true);
    expect(records.some((record) => record.note === null)).toBe(true);
  });
});
