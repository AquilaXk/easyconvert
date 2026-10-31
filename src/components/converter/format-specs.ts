import { FORMAT_REGISTRY } from '@/lib/registry';

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
  mp4: {
    title: 'MP4 (MPEG-4 Part 14 Video)',
    fullName: 'MPEG-4 Part 14 Multimedia Container',
    developer: 'Moving Picture Experts Group (MPEG) / ISO',
    mimeType: 'video/mp4',
    category: 'Video Media',
    extension: 'mp4',
    desc: 'MP4 is a digital multimedia container used to store video, audio, and subtitle streams. Derived from the ISO Base Media File Format, it combines high compression efficiency with native browser and hardware playback.',
    advantages: [
      'Playback support across modern devices, TVs, and web browsers',
      'High compression efficiency preserving resolution and colour fidelity',
      'Supports progressive streaming and fast-start web playback',
    ],
  },
  mp3: {
    title: 'MP3 (MPEG Audio Layer III)',
    fullName: 'MPEG-1 Audio Layer III',
    developer: 'Fraunhofer Society / MPEG / ISO',
    mimeType: 'audio/mpeg',
    category: 'Audio Media',
    extension: 'mp3',
    desc: 'MP3 is a lossy digital audio compression format. Psychoacoustic perceptual coding attenuates masked frequency components to reduce file size while retaining clear audio playback.',
    advantages: [
      'Compact file size at roughly 10% of uncompressed PCM audio',
      'Native playback across digital audio players and web browsers',
      'Low bandwidth footprint suited for streaming and portable storage',
    ],
  },
  wav: {
    title: 'WAV (Waveform Audio File)',
    fullName: 'Resource Interchange File Format (RIFF WAVE)',
    developer: 'Microsoft & IBM',
    mimeType: 'audio/wav',
    category: 'Audio Media',
    extension: 'wav',
    desc: 'WAV is an uncompressed audio container storing linear pulse-code modulation (LPCM) samples. It records acoustic waveforms sample-for-sample without lossy compression artifacts.',
    advantages: [
      'Uncompressed PCM audio fidelity without encoding artifacts',
      'Minimal decoding overhead for low-latency audio editing',
      'Standard master exchange format for studio production and mastering',
    ],
  },
  aac: {
    title: 'AAC (Advanced Audio Coding)',
    fullName: 'Advanced Audio Coding',
    developer: 'MPEG / Bell Labs / Fraunhofer / Sony',
    mimeType: 'audio/aac',
    category: 'Audio Media',
    extension: 'aac',
    desc: 'AAC is a perceptual audio coding standard designed as the successor to MP3. At matching bitrates, AAC delivers cleaner high-frequency detail across stereo and multichannel layouts.',
    advantages: [
      'Higher coding efficiency than MP3 at matching bitrates',
      'Default audio codec across MP4 streaming and mobile platforms',
      'Supports up to 48 full-bandwidth channels and high sample rates',
    ],
  },
  flac: {
    title: 'FLAC (Free Lossless Audio Codec)',
    fullName: 'Free Lossless Audio Codec',
    developer: 'Xiph.Org Foundation',
    mimeType: 'audio/flac',
    category: 'Audio Media',
    extension: 'flac',
    desc: 'FLAC is an open, royalty-free lossless audio codec. Compressed FLAC streams decode back to an exact bit-for-bit match of the source PCM audio.',
    advantages: [
      'Bit-exact audio reconstruction with 30 to 50% size reduction',
      'Open-source, royalty-free specification with embedded CRC checksums',
      'Supports sample depths up to 32 bits and sample rates up to 655 kHz',
    ],
  },
  ogg: {
    title: 'OGG (Ogg Vorbis Audio)',
    fullName: 'Ogg Vorbis Audio Container',
    developer: 'Xiph.Org Foundation',
    mimeType: 'audio/ogg',
    category: 'Audio Media',
    extension: 'ogg',
    desc: 'OGG is an open multimedia bitstream container commonly paired with the Vorbis or Opus audio codecs for patent-free streaming and game asset delivery.',
    advantages: [
      'Open-source and patent-free container and codec standard',
      'Variable bitrate encoding with low framing overhead',
      'Broad support in game engines and desktop web browsers',
    ],
  },
  m4a: {
    title: 'M4A (MPEG-4 Audio)',
    fullName: 'MPEG-4 Audio Layer',
    developer: 'Apple Inc. / MPEG',
    mimeType: 'audio/mp4',
    category: 'Audio Media',
    extension: 'm4a',
    desc: 'M4A is an audio-only MPEG-4 container carrying AAC or Apple Lossless (ALAC) streams alongside structured chapter and cover-art metadata.',
    advantages: [
      'Compact AAC or lossless ALAC audio inside an ISO MP4 container',
      'Native playback and metadata tagging on macOS, iOS, and web browsers',
      'Supports chapter markers, cover art, and gapless playback',
    ],
  },
  png: {
    title: 'PNG (Portable Network Graphics)',
    fullName: 'Portable Network Graphics',
    developer: 'PNG Development Group / W3C',
    mimeType: 'image/png',
    category: 'Raster Image',
    extension: 'png',
    desc: 'PNG is a raster graphics file format using lossless DEFLATE compression. It supports indexed palettes, greyscale, and full RGBA alpha transparency up to 16 bits per channel.',
    advantages: [
      'Lossless compression with zero generation loss across repeated saves',
      'Full 8-bit and 16-bit alpha channel transparency',
      'Preferred raster format for UI graphics, diagrams, logos, and screenshots',
    ],
  },
  jpg: {
    title: 'JPG / JPEG (Joint Photographic Experts Group)',
    fullName: 'JPEG Continuous-Tone Photographic Image',
    developer: 'Joint Photographic Experts Group / ISO',
    mimeType: 'image/jpeg',
    category: 'Raster Image',
    extension: 'jpg',
    desc: 'JPG is the ISO standard for continuous-tone photographic images, applying Discrete Cosine Transform (DCT) compression tuned for natural colour gradients.',
    advantages: [
      'Adjustable quality factor balancing visual detail and byte size',
      'Native support across every web browser, operating system, and camera',
      'Small payload size for web publishing and messaging',
    ],
  },
  jpeg: {
    title: 'JPEG (Joint Photographic Experts Group)',
    fullName: 'JPEG Continuous-Tone Photographic Image',
    developer: 'Joint Photographic Experts Group / ISO',
    mimeType: 'image/jpeg',
    category: 'Raster Image',
    extension: 'jpeg',
    desc: 'JPEG is the standard continuous-tone photographic format identical in bitstream structure to JPG, using DCT block compression for natural imagery.',
    advantages: [
      'Universal hardware and software decoding support',
      'Configurable chroma subsampling and quantization quality',
      'Default output format across digital cameras and scanners',
    ],
  },
  webp: {
    title: 'WebP (Modern Web Image Format)',
    fullName: 'WebP Image Specification',
    developer: 'Google LLC',
    mimeType: 'image/webp',
    category: 'Raster Image',
    extension: 'webp',
    desc: 'WebP provides both lossy VP8 intra-frame coding and lossless dictionary compression for web imagery, supporting alpha transparency, ICC profiles, and animation.',
    advantages: [
      '26% smaller lossless payloads than PNG with full alpha transparency',
      '25 to 34% smaller lossy files than JPEG at equivalent SSIM',
      'Supports multi-frame animation, ICC colour profiles, and EXIF/XMP metadata',
    ],
  },
  avif: {
    title: 'AVIF (AV1 Image File Format)',
    fullName: 'AV1 Image File Format',
    developer: 'Alliance for Open Media (AOMedia)',
    mimeType: 'image/avif',
    category: 'Raster Image',
    extension: 'avif',
    desc: 'AVIF stores AV1 intra-coded still images inside an ISO HEIF container, supporting 8-bit, 10-bit, and 12-bit colour depths alongside HDR transfer functions.',
    advantages: [
      'Up to 50% smaller byte size than JPEG at matching perceptual quality',
      'Supports High Dynamic Range (PQ / HLG) and wide colour gamuts',
      'Decoded natively by current desktop and mobile browsers',
    ],
  },
  heic: {
    title: 'HEIC (High Efficiency Image Container)',
    fullName: 'High Efficiency Image File Format',
    developer: 'Moving Picture Experts Group (MPEG) / Apple',
    mimeType: 'image/heic',
    category: 'Raster Image',
    extension: 'heic',
    desc: 'HEIC stores HEVC (H.265) intra-coded photographs inside an ISO Base Media container, cutting storage size roughly in half relative to baseline JPEG.',
    advantages: [
      'Roughly half the byte size of equivalent JPEG photographs',
      'Stores 10-bit colour, auxiliary depth maps, and burst sequences',
      'Default camera capture container on iOS and iPadOS devices',
    ],
  },
  svg: {
    title: 'SVG (Scalable Vector Graphics)',
    fullName: 'Scalable Vector Graphics',
    developer: 'World Wide Web Consortium (W3C)',
    mimeType: 'image/svg+xml',
    category: 'Vector Graphic',
    extension: 'svg',
    desc: 'SVG is an XML vector graphics specification describing two-dimensional paths, shapes, text, and gradients mathematically so artwork renders sharply at any DPI.',
    advantages: [
      'Resolution-independent scaling from small UI icons to print layouts',
      'Compact text-based XML structure that compresses well with GZIP or Brotli',
      'Directly scriptable and styleable with CSS in web documents',
    ],
  },
  gif: {
    title: 'GIF (Graphics Interchange Format)',
    fullName: 'Graphics Interchange Format 89a',
    developer: 'CompuServe / Steve Wilhite',
    mimeType: 'image/gif',
    category: 'Raster Image',
    extension: 'gif',
    desc: 'GIF is an indexed-palette bitmap format using lossless LZW compression for up to 256 colours per frame and looping frame sequences.',
    advantages: [
      'Autoplay looping animation support across browsers and chat clients',
      '1-bit index transparency and frame disposal timing control',
      'Convenient target for short screen-capture clips',
    ],
  },
  epub: {
    title: 'EPUB (Electronic Publication)',
    fullName: 'Electronic Publication',
    developer: 'International Digital Publishing Forum (IDPF) / W3C',
    mimeType: 'application/epub+zip',
    category: 'Digital E-Book',
    extension: 'epub',
    desc: 'EPUB packages XHTML content documents, CSS stylesheets, fonts, and navigation manifests in a ZIP container for reflowable digital books.',
    advantages: [
      'Reflowable typography that adapts to screen width and reader font settings',
      'Open W3C publishing standard supported across dedicated e-readers',
      'Structured table of contents, landmarks, and OPF publication metadata',
    ],
  },
  mobi: {
    title: 'MOBI (Mobipocket E-Book)',
    fullName: 'Mobipocket E-Book Format',
    developer: 'Mobipocket / Amazon',
    mimeType: 'application/x-mobipocket-ebook',
    category: 'Digital E-Book',
    extension: 'mobi',
    desc: 'MOBI is a binary PalmDOC-derived e-book container developed by Mobipocket for portable e-ink readers, bundling HTML markup, images, and chapter offsets.',
    advantages: [
      'Compatible with older Kindle e-ink hardware and desktop reader apps',
      'Compact PalmDOC or Huff/CDIC compressed text records',
      'Supports embedded chapter navigation and dictionary lookup tables',
    ],
  },
  zip: {
    title: 'ZIP (Compressed Archive Format)',
    fullName: 'PKZIP Archive Specification',
    developer: 'PKWARE / Phil Katz',
    mimeType: 'application/zip',
    category: 'Archive Package',
    extension: 'zip',
    desc: 'ZIP bundles one or more files and directory trees with independent per-entry DEFLATE compression and a central directory index.',
    advantages: [
      'Built-in extraction on macOS, Windows, Linux, iOS, and Android',
      'Random-access central directory allows extracting single entries quickly',
      'CRC-32 integrity checksums for every archived entry',
    ],
  },
  rar: {
    title: 'RAR (Roshal Archive Compressed File)',
    fullName: 'Roshal Archive Compressed File',
    developer: 'Eugene Roshal / RARLAB',
    mimeType: 'application/vnd.rar',
    category: 'Archive Package',
    extension: 'rar',
    desc: 'RAR is a compressed archive container supporting solid dictionary compression, Reed-Solomon recovery records, and multi-volume split archives.',
    advantages: [
      'Optional recovery records for reconstructing damaged archive sectors',
      'Multi-volume splitting and solid compression across similar files',
      'AES-256 payload and filename encryption support',
    ],
  },
  '7z': {
    title: '7Z (7-Zip Compressed Archive)',
    fullName: '7-Zip Compressed Archive',
    developer: 'Igor Pavlov',
    mimeType: 'application/x-7z-compressed',
    category: 'Archive Package',
    extension: '7z',
    desc: '7Z is an open modular archive container using LZMA and LZMA2 dictionary compression with large solid blocks and optional AES-256 encryption.',
    advantages: [
      'High LZMA and LZMA2 compression ratios on large file sets',
      'Solid block compression reduces redundancy across related files',
      'AES-256 payload and header encryption support',
    ],
  },
  tar: {
    title: 'TAR (Tape Archive)',
    fullName: 'Unix Tape Archive Format (POSIX tar)',
    developer: 'AT&T Bell Laboratories / IEEE POSIX',
    mimeType: 'application/x-tar',
    category: 'Archive Package',
    extension: 'tar',
    desc: 'TAR serializes files and directory hierarchies sequentially in 512-byte blocks while preserving POSIX permissions, ownership, and modification timestamps.',
    advantages: [
      'Preserves POSIX permissions, timestamps, and directory structure',
      'Standard source distribution container across Unix and Linux toolchains',
      'Pairs cleanly with GZIP, BZip2, XZ, or Zstandard stream compressors',
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
  dxf: {
    title: 'DXF (Drawing Exchange Format)',
    fullName: 'AutoCAD Drawing Exchange Format',
    developer: 'Autodesk Inc.',
    mimeType: 'application/dxf',
    category: 'CAD Drawing',
    extension: 'dxf',
    desc: 'DXF is a tagged CAD data exchange format representing 2D and 3D entities, layers, blocks, arcs, polylines, and splines for CAD/CAM interoperability.',
    advantages: [
      'Vector CAD exchange format supported across drafting and CAM software',
      'Preserves named layers, coordinate geometry, arcs, and spline entities',
      'Common input format for laser cutting, plotting, and CNC workflows',
    ],
  },
  ttf: {
    title: 'TTF (TrueType Font)',
    fullName: 'TrueType Font Specification',
    developer: 'Apple Inc. & Microsoft Corporation',
    mimeType: 'font/ttf',
    category: 'Vector Font',
    extension: 'ttf',
    desc: 'TTF defines quadratic Bézier glyph outlines, character-to-glyph cmap tables, kerning metrics, and hinting instructions in a single binary font file.',
    advantages: [
      'Sharp outline glyph rendering across desktop and mobile displays',
      'Grid-fitting hinting tables keep small body text legible',
      'Installed natively on macOS, Windows, Linux, iOS, and Android',
    ],
  },
  woff2: {
    title: 'WOFF2 (Web Open Font Format 2.0)',
    fullName: 'Web Open Font Format 2.0',
    developer: 'World Wide Web Consortium (W3C)',
    mimeType: 'font/woff2',
    category: 'Vector Font',
    extension: 'woff2',
    desc: 'WOFF2 wraps TrueType or OpenType glyph tables with font-specific preprocessing and Brotli compression for `@font-face` delivery on the web.',
    advantages: [
      'Brotli-compressed font payloads roughly 30% smaller than WOFF 1.0',
      'Faster webfont network transfer reduces layout shift during page load',
      'Supported natively across all evergreen desktop and mobile browsers',
    ],
  },
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

export function buildContextualFaqs(
  srcMeta: FormatSpecification,
  tgtMeta: FormatSpecification | null,
  isPair: boolean,
  totalFormatCount: number
) {
  const srcUpper = srcMeta.extension.toUpperCase();
  const tgtUpper = tgtMeta?.extension.toUpperCase() ?? '';

  return [
    {
      q: isPair
        ? `How do I convert ${srcUpper} to ${tgtUpper} for free?`
        : `How do I convert ${srcUpper} files online for free?`,
      a: isPair
        ? `Drop your ${srcUpper} file into the workbench above or click 'Choose Files', confirm ${tgtUpper} as the output format, and click Convert. Download the converted ${tgtUpper} file right away with no watermarks or account requirement.`
        : `Add your ${srcUpper} file to the workbench above, select any output format from ${totalFormatCount} supported formats, and click Convert. Conversions are free without watermarks or daily paywalls.`,
    },
    {
      q: isPair
        ? `How are ${srcUpper} to ${tgtUpper} files handled for privacy?`
        : `How are ${srcUpper} files handled for privacy?`,
      a: 'Supported client formats run directly inside your browser using WebAssembly. Server-assisted jobs transmit over TLS 1.3 into isolated worker sandboxes and delete temporary output automatically upon download or short TTL expiration.',
    },
    {
      q: isPair
        ? `Does converting ${srcUpper} to ${tgtUpper} preserve layout and quality?`
        : `Does ${srcUpper} conversion preserve formatting and quality?`,
      a: 'Yes. Dedicated format engines translate vector paths, embedded fonts, tables, colour profiles, and media streams to match the source structure.',
    },
    {
      q: `Can I batch-convert multiple ${srcUpper} files at once?`,
      a: 'Yes. Drop multiple files into the queue to convert them in parallel, then save each output individually or download a single consolidated ZIP archive.',
    },
    {
      q: 'Do I need to install desktop software or browser extensions?',
      a: 'No installation is needed. EasyConvert runs in standard web browsers across macOS, Windows, Linux, iOS, and Android.',
    },
  ];
}
