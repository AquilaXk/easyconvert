import { describe, it, expect } from 'vitest';
import {
  FORMAT_REGISTRY,
  getAllFormats,
  getFormatsByCategory,
  getAvailableTargetFormats,
  CATEGORIES,
} from '../src/lib/registry';

describe('9 Domains & 200+ Format Matrix Tests', () => {
  it('contains more than 200 registered formats in total', () => {
    const all = getAllFormats();
    expect(all.length).toBeGreaterThanOrEqual(200);
  });

  it('covers all 9 primary converter domains', () => {
    const all = getAllFormats();
    const categories = new Set(all.map((f) => f.category));

    expect(categories.has('audio')).toBe(true);
    expect(categories.has('video')).toBe(true);
    expect(categories.has('document')).toBe(true);
    expect(categories.has('ebook')).toBe(true);
    expect(categories.has('spreadsheet') || categories.has('data')).toBe(true);
    expect(categories.has('presentation')).toBe(true);
    expect(categories.has('image')).toBe(true);
    expect(categories.has('archive')).toBe(true);
    expect(categories.has('font') || categories.has('cad')).toBe(true);
  });

  it('verifies audio and video format options and targets', () => {
    const mp3 = FORMAT_REGISTRY['mp3'];
    expect(mp3).toBeDefined();
    expect(mp3.category).toBe('audio');
    expect(mp3.targetFormats).toContain('wav');
    expect(mp3.targetFormats).toContain('flac');
    expect(mp3.optionsSchema?.audioBitrate).toBe(true);
    expect(mp3.optionsSchema?.audioChannels).toBe(true);

    const mp4 = FORMAT_REGISTRY['mp4'];
    expect(mp4).toBeDefined();
    expect(mp4.category).toBe('video');
    expect(mp4.targetFormats).toContain('webm');
    expect(mp4.targetFormats).toContain('mp3');
    expect(mp4.optionsSchema?.videoResolution).toBe(true);
  });

  it('verifies office and ebook format mappings', () => {
    const docx = FORMAT_REGISTRY['docx'];
    expect(docx).toBeDefined();
    expect(docx.targetFormats).toContain('pdf');
    expect(docx.targetFormats).toContain('html');
    expect(docx.targetFormats).toContain('txt');

    const xlsx = FORMAT_REGISTRY['xlsx'];
    expect(xlsx).toBeDefined();
    expect(xlsx.targetFormats).toContain('csv');
    expect(xlsx.targetFormats).toContain('json');
    expect(xlsx.targetFormats).toContain('pdf');

    const epub = FORMAT_REGISTRY['epub'];
    expect(epub).toBeDefined();
    expect(epub.category).toBe('ebook');
    expect(epub.targetFormats).toContain('pdf');
    expect(epub.targetFormats).toContain('mobi');
  });

  it('retrieves available target format definitions for complex media', () => {
    const targets = getAvailableTargetFormats('wav');
    const targetExtensions = targets.map((t) => t.extension);
    expect(targetExtensions).toContain('mp3');
    expect(targetExtensions).toContain('aac');
    expect(targetExtensions).toContain('ogg');
  });
});
