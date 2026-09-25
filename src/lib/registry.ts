import { FormatCategory, FormatDefinition } from './types';

export const FORMAT_REGISTRY: Record<string, FormatDefinition> = {
  // Images
  png: {
    id: 'png',
    name: 'PNG',
    extension: 'png',
    mimeType: 'image/png',
    category: 'image',
    description: 'Portable Network Graphics - Lossless raster format with alpha transparency support.',
    targetFormats: ['jpg', 'jpeg', 'webp', 'avif', 'tiff', 'gif', 'bmp', 'ico', 'pdf', 'zip'],
    optionsSchema: { quality: true, dimensions: true, fit: true, stripMetadata: true },
  },
  jpg: {
    id: 'jpg',
    name: 'JPG',
    extension: 'jpg',
    mimeType: 'image/jpeg',
    category: 'image',
    description: 'Joint Photographic Experts Group - Standard lossy image compression for photography.',
    targetFormats: ['png', 'webp', 'avif', 'tiff', 'gif', 'bmp', 'ico', 'pdf', 'zip'],
    optionsSchema: { quality: true, dimensions: true, fit: true, stripMetadata: true },
  },
  jpeg: {
    id: 'jpeg',
    name: 'JPEG',
    extension: 'jpeg',
    mimeType: 'image/jpeg',
    category: 'image',
    description: 'Joint Photographic Experts Group standard image format.',
    targetFormats: ['png', 'webp', 'avif', 'tiff', 'gif', 'bmp', 'ico', 'pdf', 'zip'],
    optionsSchema: { quality: true, dimensions: true, fit: true, stripMetadata: true },
  },
  webp: {
    id: 'webp',
    name: 'WEBP',
    extension: 'webp',
    mimeType: 'image/webp',
    category: 'image',
    description: 'Modern web image format providing superior lossless and lossy compression.',
    targetFormats: ['png', 'jpg', 'jpeg', 'avif', 'tiff', 'gif', 'bmp', 'ico', 'pdf', 'zip'],
    optionsSchema: { quality: true, dimensions: true, fit: true, stripMetadata: true },
  },
  avif: {
    id: 'avif',
    name: 'AVIF',
    extension: 'avif',
    mimeType: 'image/avif',
    category: 'image',
    description: 'Next-generation AV1 Image File Format delivering state-of-the-art compression.',
    targetFormats: ['png', 'jpg', 'webp', 'tiff', 'pdf', 'zip'],
    optionsSchema: { quality: true, dimensions: true, fit: true },
  },
  tiff: {
    id: 'tiff',
    name: 'TIFF',
    extension: 'tiff',
    mimeType: 'image/tiff',
    category: 'image',
    description: 'Tagged Image File Format - High-depth raster format favored in publishing and printing.',
    targetFormats: ['png', 'jpg', 'webp', 'pdf', 'zip'],
    optionsSchema: { quality: true, dimensions: true },
  },
  gif: {
    id: 'gif',
    name: 'GIF',
    extension: 'gif',
    mimeType: 'image/gif',
    category: 'image',
    description: 'Graphics Interchange Format with animated frame support.',
    targetFormats: ['png', 'webp', 'jpg', 'pdf', 'zip'],
    optionsSchema: { dimensions: true },
  },
  bmp: {
    id: 'bmp',
    name: 'BMP',
    extension: 'bmp',
    mimeType: 'image/bmp',
    category: 'image',
    description: 'Bitmap Image File - Uncompressed bitmap format.',
    targetFormats: ['png', 'jpg', 'webp', 'pdf', 'zip'],
    optionsSchema: { dimensions: true },
  },
  svg: {
    id: 'svg',
    name: 'SVG',
    extension: 'svg',
    mimeType: 'image/svg+xml',
    category: 'image',
    description: 'Scalable Vector Graphics - XML-based 2D vector format.',
    targetFormats: ['png', 'jpg', 'webp', 'pdf'],
    optionsSchema: { dimensions: true },
  },
  ico: {
    id: 'ico',
    name: 'ICO',
    extension: 'ico',
    mimeType: 'image/x-icon',
    category: 'image',
    description: 'Icon format used for website favicons and application icons.',
    targetFormats: ['png', 'jpg', 'webp'],
    optionsSchema: { dimensions: true },
  },

  // Documents
  pdf: {
    id: 'pdf',
    name: 'PDF',
    extension: 'pdf',
    mimeType: 'application/pdf',
    category: 'document',
    description: 'Portable Document Format - Universal digital document standard.',
    targetFormats: ['txt', 'html', 'md', 'zip'],
    optionsSchema: { orientation: true },
  },
  md: {
    id: 'md',
    name: 'Markdown (MD)',
    extension: 'md',
    mimeType: 'text/markdown',
    category: 'document',
    description: 'Lightweight markup language with plain-text formatting syntax.',
    targetFormats: ['html', 'txt', 'pdf', 'zip'],
    optionsSchema: { orientation: true },
  },
  html: {
    id: 'html',
    name: 'HTML',
    extension: 'html',
    mimeType: 'text/html',
    category: 'document',
    description: 'HyperText Markup Language - Standard document format for web pages.',
    targetFormats: ['txt', 'md', 'pdf', 'zip'],
    optionsSchema: { orientation: true },
  },
  txt: {
    id: 'txt',
    name: 'Plain Text (TXT)',
    extension: 'txt',
    mimeType: 'text/plain',
    category: 'document',
    description: 'Standard unformatted plain text document.',
    targetFormats: ['pdf', 'html', 'md', 'zip'],
    optionsSchema: { orientation: true },
  },

  // Data & Spreadsheets
  csv: {
    id: 'csv',
    name: 'CSV',
    extension: 'csv',
    mimeType: 'text/csv',
    category: 'data',
    description: 'Comma-Separated Values tabular data format.',
    targetFormats: ['json', 'tsv', 'html', 'yaml', 'zip'],
    optionsSchema: { delimiter: true },
  },
  tsv: {
    id: 'tsv',
    name: 'TSV',
    extension: 'tsv',
    mimeType: 'text/tab-separated-values',
    category: 'data',
    description: 'Tab-Separated Values structured data format.',
    targetFormats: ['csv', 'json', 'html', 'yaml', 'zip'],
    optionsSchema: { delimiter: true },
  },
  json: {
    id: 'json',
    name: 'JSON',
    extension: 'json',
    mimeType: 'application/json',
    category: 'data',
    description: 'JavaScript Object Notation lightweight data interchange format.',
    targetFormats: ['csv', 'tsv', 'yaml', 'xml', 'txt', 'zip'],
    optionsSchema: { delimiter: true },
  },
  yaml: {
    id: 'yaml',
    name: 'YAML',
    extension: 'yaml',
    mimeType: 'application/x-yaml',
    category: 'data',
    description: 'Human-friendly data serialization language.',
    targetFormats: ['json', 'txt', 'zip'],
  },
  yml: {
    id: 'yml',
    name: 'YML',
    extension: 'yml',
    mimeType: 'application/x-yaml',
    category: 'data',
    description: 'YAML data serialization language alternative extension.',
    targetFormats: ['json', 'txt', 'zip'],
  },
  xml: {
    id: 'xml',
    name: 'XML',
    extension: 'xml',
    mimeType: 'application/xml',
    category: 'data',
    description: 'Extensible Markup Language structured document format.',
    targetFormats: ['json', 'txt', 'zip'],
  },

  // Archives
  zip: {
    id: 'zip',
    name: 'ZIP',
    extension: 'zip',
    mimeType: 'application/zip',
    category: 'archive',
    description: 'Standard lossless compression archive format.',
    targetFormats: ['tar', 'gz'],
    optionsSchema: { compressionLevel: true },
  },
  tar: {
    id: 'tar',
    name: 'TAR',
    extension: 'tar',
    mimeType: 'application/x-tar',
    category: 'archive',
    description: 'Tape archive file format commonly used for packaging unix collections.',
    targetFormats: ['zip', 'gz'],
  },
  gz: {
    id: 'gz',
    name: 'GZIP',
    extension: 'gz',
    mimeType: 'application/gzip',
    category: 'archive',
    description: 'GNU zip compression file format.',
    targetFormats: ['zip', 'tar'],
  },
};

export const CATEGORIES: { id: FormatCategory; label: string; count: number }[] = [
  { id: 'image', label: 'Images', count: 10 },
  { id: 'document', label: 'Documents', count: 4 },
  { id: 'data', label: 'Data & Tables', count: 6 },
  { id: 'archive', label: 'Archives', count: 3 },
];

export function getFormatByExtension(ext: string): FormatDefinition | undefined {
  const cleanExt = ext.toLowerCase().replace(/^\./, '').trim();
  return FORMAT_REGISTRY[cleanExt];
}

export function detectFormatFromFilename(filename: string): FormatDefinition | undefined {
  const parts = filename.split('.');
  if (parts.length <= 1) return undefined;
  const ext = parts[parts.length - 1];
  return getFormatByExtension(ext);
}

export function getAllFormats(): FormatDefinition[] {
  return Object.values(FORMAT_REGISTRY);
}

export function getFormatsByCategory(category: FormatCategory): FormatDefinition[] {
  return getAllFormats().filter((f) => f.category === category);
}

export function getAvailableTargetFormats(sourceFormatId: string): FormatDefinition[] {
  const source = FORMAT_REGISTRY[sourceFormatId.toLowerCase()];
  if (!source) return [];
  return source.targetFormats
    .map((targetId) => FORMAT_REGISTRY[targetId])
    .filter((def): def is FormatDefinition => Boolean(def));
}
