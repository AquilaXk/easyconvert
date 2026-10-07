import { describe, it, expect } from 'vitest';
import {
  FORMAT_REGISTRY,
  detectFormatFromFilename,
  getFormatByExtension,
  getAvailableTargetFormats,
  getAllFormats,
} from '@/lib/registry';

describe('Format Registry & Lookup Tests', () => {
  it('should have all key format categories defined', () => {
    const formats = getAllFormats();
    const categories = new Set(formats.map((f) => f.category));

    expect(categories.has('image')).toBe(true);
    expect(categories.has('document')).toBe(true);
    expect(categories.has('data')).toBe(true);
    expect(categories.has('archive')).toBe(true);
  });

  it('should accurately detect formats from extensions with case insensitivity', () => {
    expect(detectFormatFromFilename('photo.PNG')?.id).toBe('png');
    expect(detectFormatFromFilename('DOCUMENT.PDF')?.id).toBe('pdf');
    expect(detectFormatFromFilename('data.metrics.CSV')?.id).toBe('csv');
    expect(detectFormatFromFilename('archive.tar.gz')?.id).toBe('gz');
    expect(detectFormatFromFilename('archive.tar.bz2')).toBeUndefined(); // Unregistered extension returns undefined
    expect(detectFormatFromFilename('bundle.ZIP')?.id).toBe('zip');
    expect(detectFormatFromFilename('noextension')).toBeUndefined();
  });

  it('should retrieve target conversion options for given formats', () => {
    const pngTargets = getAvailableTargetFormats('png');
    const targetIds = pngTargets.map((t) => t.id);

    // The advertised targets, pinned: a pair added or withdrawn changes these lists on purpose.
    expect(targetIds).toEqual([
      'jpg', 'jpeg', 'webp', 'avif', 'tiff', 'gif', 'bmp', 'ico', 'pdf', 'zip',
      'eps', 'icns', 'odd', 'png', 'ps', 'psd', 'xps', 'hocr', 'alto',
    ]);

    const csvTargets = getAvailableTargetFormats('csv');
    expect(csvTargets.map((t) => t.id)).toEqual(['xlsx', 'json', 'tsv', 'parquet', 'html', 'yaml', 'pdf', 'ods', 'xls', 'zip']);
  });

  it('should return empty targets for unknown format', () => {
    expect(getAvailableTargetFormats('nonexistent_format')).toEqual([]);
  });
});
