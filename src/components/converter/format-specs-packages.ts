import type { FormatFacts } from './format-specs';

export const PACKAGE_FORMAT_SPECIFICATIONS: Record<string, FormatFacts> = {
  epub: {
    fullName: 'Electronic Publication',
  },
  mobi: {
    fullName: 'Mobipocket E-Book Format',
  },
  zip: {
    fullName: 'PKZIP Archive Specification',
  },
  rar: {
    fullName: 'Roshal Archive Compressed File',
  },
  '7z': {
    fullName: '7-Zip Compressed Archive',
  },
  tar: {
    fullName: 'Unix Tape Archive Format (POSIX tar)',
  },
  dxf: {
    fullName: 'AutoCAD Drawing Exchange Format',
  },
  ttf: {
    fullName: 'TrueType Font Specification',
  },
  woff2: {
    fullName: 'Web Open Font Format 2.0',
  },
};
