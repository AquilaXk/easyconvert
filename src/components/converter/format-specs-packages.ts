import type { FormatFacts } from './format-specs';

export const PACKAGE_FORMAT_SPECIFICATIONS: Record<string, FormatFacts> = {
  epub: {
    fullName: 'Electronic Publication',
    extension: 'epub',
  },
  mobi: {
    fullName: 'Mobipocket E-Book Format',
    extension: 'mobi',
  },
  zip: {
    fullName: 'PKZIP Archive Specification',
    extension: 'zip',
  },
  rar: {
    fullName: 'Roshal Archive Compressed File',
    extension: 'rar',
  },
  '7z': {
    fullName: '7-Zip Compressed Archive',
    extension: '7z',
  },
  tar: {
    fullName: 'Unix Tape Archive Format (POSIX tar)',
    extension: 'tar',
  },
  dxf: {
    fullName: 'AutoCAD Drawing Exchange Format',
    extension: 'dxf',
  },
  ttf: {
    fullName: 'TrueType Font Specification',
    extension: 'ttf',
  },
  woff2: {
    fullName: 'Web Open Font Format 2.0',
    extension: 'woff2',
  },
};
