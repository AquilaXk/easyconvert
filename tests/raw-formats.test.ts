import { describe, it, expect } from 'vitest';
import { RAW_CAMERA_FORMATS } from '../src/lib/conversions/raw-formats';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { resolveResourceClass } from '../src/lib/queue/resource-class';

const REGISTRY_RAW_SOURCES = ['3fr', 'arw', 'cr2', 'cr3', 'crw', 'dcr', 'dng', 'erf', 'mos', 'mrw', 'nef', 'orf', 'pef', 'raf', 'raw', 'rw2', 'x3f'];

describe('camera RAW format list', () => {
  it('covers every RAW source the registry advertises, plus srw and kdc', () => {
    expect(REGISTRY_RAW_SOURCES.filter((format) => !FORMAT_REGISTRY[format] || !RAW_CAMERA_FORMATS.has(format))).toEqual([]);
    expect(RAW_CAMERA_FORMATS.has('srw')).toBe(true);
    expect(RAW_CAMERA_FORMATS.has('kdc')).toBe(true);
    expect([...RAW_CAMERA_FORMATS].filter((format) => !REGISTRY_RAW_SOURCES.includes(format)).sort()).toEqual(['kdc', 'srw']);
  });

  it('sends every camera RAW source to the memory queue', () => {
    expect([...RAW_CAMERA_FORMATS].filter((format) => resolveResourceClass(format, 'png') !== 'memory')).toEqual([]);
  });
});
