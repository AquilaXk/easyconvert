/**
 * The full names of the formats with a written description, by format id. A standard keeps its name in every language, so
 * the names are data here and the interface source holds no English prose (tests/i18n-hardcoded-strings.test.ts); the
 * description of each is `formatSpecs.<id>.desc` in the messages.
 */
export const FORMAT_FULL_NAMES: Readonly<Record<string, string>> = {
  pdf: 'Portable Document Format',
  docx: 'Office Open XML Document',
  doc: 'Microsoft Word 97-2003 Binary Document',
  csv: 'Comma-Separated Values',
  json: 'JavaScript Object Notation',
  xlsx: 'Office Open XML Spreadsheet',
  xls: 'Microsoft Excel 97-2003 Binary Spreadsheet',
  pptx: 'Office Open XML Presentation',
  mp4: 'MPEG-4 Part 14 Multimedia Container',
  mp3: 'MPEG-1 Audio Layer III',
  wav: 'Resource Interchange File Format (RIFF WAVE)',
  aac: 'Advanced Audio Coding',
  flac: 'Free Lossless Audio Codec',
  ogg: 'Ogg Vorbis Audio Container',
  m4a: 'MPEG-4 Audio Layer',
  png: 'Portable Network Graphics',
  jpg: 'JPEG Continuous-Tone Photographic Image',
  jpeg: 'JPEG Continuous-Tone Photographic Image',
  webp: 'WebP Image Specification',
  avif: 'AV1 Image File Format',
  heic: 'High Efficiency Image File Format',
  svg: 'Scalable Vector Graphics',
  gif: 'Graphics Interchange Format 89a',
  epub: 'Electronic Publication',
  mobi: 'Mobipocket E-Book Format',
  zip: 'PKZIP Archive Specification',
  rar: 'Roshal Archive Compressed File',
  '7z': '7-Zip Compressed Archive',
  tar: 'Unix Tape Archive Format (POSIX tar)',
  dxf: 'AutoCAD Drawing Exchange Format',
  ttf: 'TrueType Font Specification',
  woff2: 'Web Open Font Format 2.0',
};
