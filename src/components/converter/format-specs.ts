import { FORMAT_REGISTRY } from '@/lib/registry';
import { MEDIA_FORMAT_SPECIFICATIONS } from './format-specs-media';
import { PACKAGE_FORMAT_SPECIFICATIONS } from './format-specs-packages';

export { buildContextualFaqs } from './FormatFaqAndSteps';

export interface FormatSpecification {
  title: string;
  fullName: string;
  developer: string;
  mimeType: string;
  category: string;
  extension: string;
  desc: string;
  advantages: string[];
}

export const FORMAT_SPECIFICATIONS: Record<string, FormatSpecification> = {
  pdf: {
    title: 'PDF (Portable Document Format)',
    fullName: 'Portable Document Format',
    developer: 'Adobe Systems / ISO 32000',
    mimeType: 'application/pdf',
    category: 'Document',
    extension: 'pdf',
    desc: 'PDF is an open ISO standard format for electronic document exchange. It encapsulates formatted text, vector graphics, raster images, and embedded fonts independent of operating system or viewer hardware.',
    advantages: [
      'Preserves vector typography, pagination, and visual layout',
      'Cross-platform document viewing standard',
      'Supports digital signatures, interactive forms, and metadata',
    ],
  },
  docx: {
    title: 'DOCX (Microsoft Word Document)',
    fullName: 'Office Open XML Document',
    developer: 'Microsoft Corporation / ISO/IEC 29500',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    category: 'Document',
    extension: 'docx',
    desc: 'DOCX is an XML-based document container used by Microsoft Word. It packages formatted text, tables, charts, embedded media, and styles inside a compressed ZIP archive.',
    advantages: [
      'Editable typography, headers, footers, and tables',
      'Compact XML compression structure with broad interoperability',
      'Native compatibility across desktop and mobile word processors',
    ],
  },
  doc: {
    title: 'DOC (Legacy Microsoft Word Document)',
    fullName: 'Microsoft Word 97-2003 Binary Document',
    developer: 'Microsoft Corporation',
    mimeType: 'application/msword',
    category: 'Document',
    extension: 'doc',
    desc: 'DOC is a binary document format developed by Microsoft for Word 97 through 2003. It stores styled text, inline graphics, tables, and formatting inside an OLE compound file container.',
    advantages: [
      'Compatibility across legacy word processing workflows',
      'Supports embedded OLE objects, drawing shapes, and font metrics',
      'Direct migration source for modern open standards such as DOCX and PDF',
    ],
  },
  csv: {
    title: 'CSV (Comma-Separated Values)',
    fullName: 'Comma-Separated Values',
    developer: 'Internet Engineering Task Force (IETF / RFC 4180)',
    mimeType: 'text/csv',
    category: 'Structured Data',
    extension: 'csv',
    desc: 'CSV stores two-dimensional tabular records as plain UTF-8 text lines with delimiter-separated fields and RFC 4180 quoting rules.',
    advantages: [
      'Plain-text tabular layout readable in any editor or script',
      'Direct import and export across SQL databases, spreadsheets, and dataframe tools',
      'Low byte overhead well suited for streaming line-by-line parsers',
    ],
  },
  json: {
    title: 'JSON (JavaScript Object Notation)',
    fullName: 'JavaScript Object Notation',
    developer: 'Douglas Crockford / ECMA International (ECMA-404)',
    mimeType: 'application/json',
    category: 'Structured Data',
    extension: 'json',
    desc: 'JSON is a text data-interchange format encoding key-value objects, arrays, numbers, booleans, and UTF-8 strings per RFC 8259 and ECMA-404.',
    advantages: [
      'Primary wire format for HTTP APIs and configuration schemas',
      'Built-in parsers across JavaScript, TypeScript, Python, Go, and Rust',
      'Represents nested hierarchical records cleanly',
    ],
  },
  xlsx: {
    title: 'XLSX (Microsoft Excel Spreadsheet)',
    fullName: 'Office Open XML Spreadsheet',
    developer: 'Microsoft Corporation / ISO/IEC 29500',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    category: 'Spreadsheet',
    extension: 'xlsx',
    desc: 'XLSX packages multi-sheet workbooks, typed cell values, shared string tables, formulas, and number formats inside a ZIP-compressed OpenXML archive.',
    advantages: [
      'Supports up to 1,048,576 rows and 16,384 columns per worksheet',
      'Multi-sheet workbooks with typed cells, formulas, and number formatting',
      'Standard workbook interchange format across spreadsheet suites',
    ],
  },
  xls: {
    title: 'XLS (Legacy Microsoft Excel Spreadsheet)',
    fullName: 'Microsoft Excel 97-2003 Binary Spreadsheet',
    developer: 'Microsoft Corporation',
    mimeType: 'application/vnd.ms-excel',
    category: 'Spreadsheet',
    extension: 'xls',
    desc: 'XLS is the BIFF8 binary workbook format used by Excel 97 through 2003, storing worksheets, cell records, and formulas in a Compound File Binary stream.',
    advantages: [
      'Interoperates with legacy accounting and reporting exports',
      'Converts cleanly to XLSX, CSV, JSON, and PDF',
      'Retains cell types, worksheet names, and numeric formatting',
    ],
  },
  pptx: {
    title: 'PPTX (Microsoft PowerPoint Presentation)',
    fullName: 'Office Open XML Presentation',
    developer: 'Microsoft Corporation / ISO/IEC 29500',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    category: 'Slide Deck',
    extension: 'pptx',
    desc: 'PPTX stores presentation slides, master layouts, DrawingML vector shapes, embedded images, and speaker notes inside an OpenXML ZIP package.',
    advantages: [
      'Structured slide masters, vector shapes, and embedded media assets',
      'Clean XML part layout for slide rendering and PDF export',
      'Supported across desktop, web, and mobile presentation tools',
    ],
  },
  ...MEDIA_FORMAT_SPECIFICATIONS,
  ...PACKAGE_FORMAT_SPECIFICATIONS,
};

const CATEGORY_LABELS: Record<string, string> = {
  audio: 'Audio Media',
  video: 'Video Media',
  image: 'Raster Image',
  vector: 'Vector Graphic',
  document: 'Document',
  spreadsheet: 'Spreadsheet',
  presentation: 'Slide Deck',
  archive: 'Archive Package',
  ebook: 'Digital E-Book',
  font: 'Vector Font',
  cad: 'CAD Drawing',
  data: 'Structured Data',
};

const CATEGORY_DEVELOPERS: Record<string, string> = {
  audio: 'Audio Engineering Standard',
  video: 'Moving Picture Standard',
  image: 'Digital Imaging Standard',
  document: 'Open Document Standard',
  archive: 'Archive Compression Standard',
  spreadsheet: 'Tabular Data Standard',
  ebook: 'Digital Publishing Standard',
  cad: 'Engineering CAD Standard',
  font: 'Digital Typography Standard',
};

export function getCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category?.toLowerCase()] ?? 'File Format';
}

export function getFormatDetail(formatKey: string): FormatSpecification {
  const key = formatKey.toLowerCase();
  const known = FORMAT_SPECIFICATIONS[key];
  if (known) {
    return known;
  }

  const def = FORMAT_REGISTRY[key];
  const ext = def?.extension || key;
  const name = def?.name || `${ext.toUpperCase()} Format`;
  const cat = def?.category || 'document';
  const categoryLabel = getCategoryLabel(cat);
  const mimeType = def?.mimeType || `application/${ext}`;
  const desc =
    def?.description ||
    `${name} is a structured file format supported across modern operating systems and conversion workflows.`;
  const developer = CATEGORY_DEVELOPERS[cat] ?? 'Standard Specification';

  return {
    title: `${ext.toUpperCase()} (${name})`,
    fullName: name,
    developer,
    mimeType,
    category: categoryLabel,
    extension: ext,
    desc,
    advantages: [
      `Accurate ${categoryLabel.toLowerCase()} structure translation`,
      'Sandboxed execution with automatic zero-retention cleanup',
      'Preserves container layout, streams, and metadata',
    ],
  };
}
