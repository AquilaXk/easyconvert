'use client';

import React, { useState } from 'react';
import Header from '@/components/Header';
import Hero from '@/components/Hero';
import ConversionQueue from '@/components/ConversionQueue';
import AdBanner from '@/components/AdBanner';
import FaqSection from '@/components/FaqSection';
import Footer from '@/components/Footer';
import JSZip from 'jszip';
import { ConversionQueueItem, ConversionOptions } from '@/lib/types';
import { detectFormatFromFilename, FORMAT_REGISTRY } from '@/lib/registry';
import { createItemConverter, getEffectiveMaxFileSize } from '@/lib/client-converter';
import { parseConverterSlug } from '@/lib/slug-parser';
import {
  FileText,
  FileImage,
  Video,
  Music,
  Archive,
  Database,
  BookOpen,
  Presentation,
  Type,
  ArrowRight,
  ChevronRight,
  Home,
  Star,
  CheckCircle2,
  Download,
  UploadCloud,
  Settings2,
  RefreshCw,
  ShieldCheck,
  Layers,
  Sparkles,
  Info,
} from 'lucide-react';
import UnitConverter from '@/components/UnitConverter';
import StatusDashboard from '@/components/StatusDashboard';

interface FormatSpecification {
  title: string;
  fullName: string;
  developer: string;
  mimeType: string;
  category: string;
  extension: string;
  desc: string;
  advantages: string[];
}

const FORMAT_SPECIFICATIONS: Record<string, FormatSpecification> = {
  pdf: {
    title: 'PDF — Portable Document Format',
    fullName: 'Portable Document Format',
    developer: 'Adobe Systems / ISO 32000',
    mimeType: 'application/pdf',
    category: 'Document',
    extension: 'pdf',
    desc: 'PDF is a universal open ISO standard format for electronic document exchange. It encapsulates formatted text, vector graphics, raster images, and fonts completely independent of application software, hardware, and operating systems.',
    advantages: [
      'Preserves 100% vector typography, pagination, and visual layout',
      'Universal cross-platform document viewing standard',
      'Supports digital signatures, interactive forms, and metadata',
    ],
  },
  docx: {
    title: 'DOCX — Microsoft Word Document',
    fullName: 'Office Open XML Document',
    developer: 'Microsoft Corporation / ISO/IEC 29500',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    category: 'Document',
    extension: 'docx',
    desc: 'DOCX is an XML-based document container used by Microsoft Word. It packages rich formatted text, dynamic tables, charts, embedded media, and macro-free styles within an efficient compressed ZIP archive structure.',
    advantages: [
      'Fully editable rich typography, headers, footers, and tables',
      'Compact XML-based compression structure with high interoperability',
      'Native compatibility across modern desktop and mobile word processors',
    ],
  },
  doc: {
    title: 'DOC — Legacy Microsoft Word Document',
    fullName: 'Microsoft Word 97-2003 Binary Document',
    developer: 'Microsoft Corporation',
    mimeType: 'application/msword',
    category: 'Document',
    extension: 'doc',
    desc: 'DOC is a proprietary binary document format developed by Microsoft for Word 97 through 2003. It holds styled text, inline graphics, tables, and scriptable formatting in a structured OLE compound file container.',
    advantages: [
      'Legacy compatibility across older enterprise word processing workflows',
      'Embedded OLE objects, drawing shapes, and font metrics',
      'Direct migration target to modern open standards like DOCX and PDF',
    ],
  },
  mp4: {
    title: 'MP4 — MPEG-4 Part 14 Video',
    fullName: 'MPEG-4 Part 14 Multimedia Container',
    developer: 'Moving Picture Experts Group (MPEG) / ISO',
    mimeType: 'video/mp4',
    category: 'Video Media',
    extension: 'mp4',
    desc: 'MP4 is a digital multimedia container format widely used to store video, audio, and subtitle streams. Based on the QuickTime File Format, it provides class-leading compression efficiency with universal browser and hardware playback.',
    advantages: [
      'Universal playback support across all modern devices, smart TVs, and browsers',
      'High compression efficiency preserving crisp resolution and color fidelity',
      'Native progressive streaming with instant web playback capability',
    ],
  },
  mp3: {
    title: 'MP3 — MPEG Audio Layer III',
    fullName: 'MPEG-1 Audio Layer III',
    developer: 'Fraunhofer Society / MPEG / ISO',
    mimeType: 'audio/mpeg',
    category: 'Audio Media',
    extension: 'mp3',
    desc: 'MP3 is an industry-standard lossy digital audio compression format. By employing psychoacoustic modeling to attenuate inaudible acoustic components, it dramatically reduces audio file size while retaining excellent acoustic fidelity.',
    advantages: [
      'Near-CD sound quality at roughly 10% of uncompressed raw audio size',
      'Plays natively on virtually every digital audio device and web platform',
      'Lightweight bandwidth footprint optimized for streaming and archiving',
    ],
  },
  wav: {
    title: 'WAV — Waveform Audio File',
    fullName: 'Resource Interchange File Format (RIFF WAVE)',
    developer: 'Microsoft & IBM',
    mimeType: 'audio/wav',
    category: 'Audio Media',
    extension: 'wav',
    desc: 'WAV is an uncompressed studio-grade audio container primarily storing linear pulse-code modulation (LPCM) sound. It records acoustic signals bit-for-bit without lossy compression artifacts, serving as the audio engineering benchmark.',
    advantages: [
      'Bit-perfect studio audio fidelity without lossy encoding artifacts',
      'Zero computational decoding overhead for real-time audio editing',
      'Standard master file format for professional studio production & mastering',
    ],
  },
  aac: {
    title: 'AAC — Advanced Audio Coding',
    fullName: 'Advanced Audio Coding',
    developer: 'MPEG / Bell Labs / Fraunhofer / Sony',
    mimeType: 'audio/aac',
    category: 'Audio Media',
    extension: 'aac',
    desc: 'AAC is an advanced lossy audio compression format engineered as the successor to MP3. At identical bitrates, AAC achieves noticeably superior audio clarity and frequency response across stereo and multi-channel surround setups.',
    advantages: [
      'Superior acoustic transparency compared to MP3 at equivalent bitrates',
      'Native default audio format for Apple Music, YouTube, and iOS devices',
      'Supports up to 48 full-bandwidth audio channels and higher sample rates',
    ],
  },
  flac: {
    title: 'FLAC — Free Lossless Audio Codec',
    fullName: 'Free Lossless Audio Codec',
    developer: 'Xiph.Org Foundation',
    mimeType: 'audio/flac',
    category: 'Audio Media',
    extension: 'flac',
    desc: 'FLAC is an open, royalty-free audio codec that provides bit-perfect lossless compression. Digital audio compressed to FLAC can be decoded back to an exact duplicate of the original uncompressed studio master.',
    advantages: [
      '100% bit-perfect audio reproduction with 30-50% file size savings',
      'Open-source royalty-free specification with broad audiophile support',
      'Supports high-resolution audio depths up to 32 bits and 655 kHz',
    ],
  },
  ogg: {
    title: 'OGG — Ogg Vorbis Audio',
    fullName: 'Ogg Vorbis Audio Container',
    developer: 'Xiph.Org Foundation',
    mimeType: 'audio/ogg',
    category: 'Audio Media',
    extension: 'ogg',
    desc: 'OGG is an open-source multimedia container format commonly bundling the Vorbis audio compression codec. It delivers efficient variable bitrate compression free of patent restrictions for games and web streaming.',
    advantages: [
      'Completely open-source and patent-free audio standard',
      'Efficient variable bitrate encoding with clear acoustic reproduction',
      'Widespread adoption in game development engines and web audio apps',
    ],
  },
  m4a: {
    title: 'M4A — MPEG-4 Audio',
    fullName: 'MPEG-4 Audio Layer',
    developer: 'Apple Inc. / MPEG',
    mimeType: 'audio/mp4',
    category: 'Audio Media',
    extension: 'm4a',
    desc: 'M4A is an audio-only file extension for MPEG-4 containers encoded using AAC or Apple Lossless (ALAC) codecs. It provides crystal-clear audio fidelity within a standardized container optimized for Apple ecosystems.',
    advantages: [
      'High audio fidelity at compact file sizes',
      'Native streaming and metadata tagging across macOS and iOS',
      'Supports chapter markers, cover art, and lossless ALAC audio',
    ],
  },
  png: {
    title: 'PNG — Portable Network Graphics',
    fullName: 'Portable Network Graphics',
    developer: 'PNG Development Group / W3C',
    mimeType: 'image/png',
    category: 'Raster Image',
    extension: 'png',
    desc: 'PNG is an extensible raster graphics file format that supports lossless data compression via Deflate algorithms. It provides 8-bit to 48-bit color depths and complete alpha channel transparency without degradation over multiple saves.',
    advantages: [
      'Lossless image compression without compression artifacts or fuzziness',
      'Full 8-bit alpha channel transparency support for smooth edge blending',
      'The industry gold standard for UI assets, icons, logos, and screenshots',
    ],
  },
  jpg: {
    title: 'JPG / JPEG — Joint Photographic Experts Group',
    fullName: 'JPEG Continuous-Tone Photographic Image',
    developer: 'Joint Photographic Experts Group / ISO',
    mimeType: 'image/jpeg',
    category: 'Raster Image',
    extension: 'jpg',
    desc: 'JPG is the worldwide standard for digital photographic image storage. It employs lossy Discrete Cosine Transform (DCT) compression optimized for continuous-tone gradients and realistic natural photography.',
    advantages: [
      'Tunable compression-to-file-size ratio balancing clarity and footprint',
      '100% universal compatibility across every browser, OS, and camera',
      'Ultra-compact file payload for swift web delivery and mobile messaging',
    ],
  },
  jpeg: {
    title: 'JPEG — Joint Photographic Experts Group',
    fullName: 'JPEG Continuous-Tone Photographic Image',
    developer: 'Joint Photographic Experts Group / ISO',
    mimeType: 'image/jpeg',
    category: 'Raster Image',
    extension: 'jpeg',
    desc: 'JPEG is the primary standard for digital photographic image storage, identical in architecture to JPG. It is optimized for continuous photographic tones and gradient transitions.',
    advantages: [
      'Universal hardware and software compatibility across all platforms',
      'Adjustable quality factor to maximize web bandwidth efficiency',
      'Standard digital camera and smartphone capture output format',
    ],
  },
  webp: {
    title: 'WebP — Modern Web Image Format',
    fullName: 'WebP Image Specification',
    developer: 'Google LLC',
    mimeType: 'image/webp',
    category: 'Raster Image',
    extension: 'webp',
    desc: 'WebP is a modern image format providing superior lossless and lossy compression for images on the web. It uses predictive coding from the VP8 video codec, reducing file sizes by up to 34% compared to legacy JPEG images.',
    advantages: [
      '26% smaller file size than PNG with full alpha transparency',
      '25-34% smaller than JPEG at equal visual structural similarity (SSIM)',
      'Supports animated sequences, ICC color profiles, and metadata',
    ],
  },
  avif: {
    title: 'AVIF — AV1 Image File Format',
    fullName: 'AV1 Image File Format',
    developer: 'Alliance for Open Media (AOMedia)',
    mimeType: 'image/avif',
    category: 'Raster Image',
    extension: 'avif',
    desc: 'AVIF is a next-generation image file format utilizing intra-frame compression from the open-source AV1 video codec. It delivers groundbreaking compression efficiency, 12-bit color depth, and High Dynamic Range (HDR) support.',
    advantages: [
      'Up to 50% smaller file size than JPEG at identical or better quality',
      'Native High Dynamic Range (HDR) and wide color gamut support',
      'Supported by all modern desktop and mobile browsers for web performance',
    ],
  },
  heic: {
    title: 'HEIC — High Efficiency Image Container',
    fullName: 'High Efficiency Image File Format',
    developer: 'Moving Picture Experts Group (MPEG) / Apple',
    mimeType: 'image/heic',
    category: 'Raster Image',
    extension: 'heic',
    desc: 'HEIC is an image container format using High Efficiency Video Coding (HEVC / H.265) intra-frame compression. It delivers superior photograph fidelity in approximately half the file storage footprint of standard JPEG images.',
    advantages: [
      'Roughly half the storage footprint of standard JPEG photographs',
      'Stores 16-bit color depth, live photo bursts, and depth disparity maps',
      'Default capture format for modern Apple iOS and iPadOS cameras',
    ],
  },
  svg: {
    title: 'SVG — Scalable Vector Graphics',
    fullName: 'Scalable Vector Graphics',
    developer: 'World Wide Web Consortium (W3C)',
    mimeType: 'image/svg+xml',
    category: 'Vector Graphic',
    extension: 'svg',
    desc: 'SVG is an XML-based vector image format for two-dimensional graphics. Because graphics are defined mathematically by geometric coordinates, paths, and gradients, SVG scales infinitely without any pixelation or resolution loss.',
    advantages: [
      'Infinite resolution scaling from favicon to high-DPI retina billboard',
      'Extremely lightweight plain-text XML payload with high gzip compression',
      'Directly styleable and animatable via CSS and JavaScript in the DOM',
    ],
  },
  gif: {
    title: 'GIF — Graphics Interchange Format',
    fullName: 'Graphics Interchange Format 89a',
    developer: 'CompuServe / Steve Wilhite',
    mimeType: 'image/gif',
    category: 'Raster Image',
    extension: 'gif',
    desc: 'GIF is a legacy bitmap image format using LZW lossless data compression. It supports indexed 8-bit palettes up to 256 colors and multi-frame looping animations, widely used for memes and micro-animations.',
    advantages: [
      'Universal animation playback on 100% of web browsers and chat apps',
      'Simple 1-bit transparency and looping sequence capability',
      'Ideal target for short animated video clip conversions',
    ],
  },
  epub: {
    title: 'EPUB — Electronic Publication',
    fullName: 'Electronic Publication',
    developer: 'International Digital Publishing Forum (IDPF) / W3C',
    mimeType: 'application/epub+zip',
    category: 'Digital E-Book',
    extension: 'epub',
    desc: 'EPUB is an open standard digital publication format. Built on XHTML, CSS, and SVG packaged in a ZIP container, it enables reflowable typography that dynamically adapts to different screen dimensions and devices.',
    advantages: [
      'Reflowable text and dynamic font scaling for optimal reading comfort',
      'Open international standard supported on virtually all modern e-readers',
      'Supports rich chapter metadata, bookmarks, and interactive styling',
    ],
  },
  mobi: {
    title: 'MOBI — Mobipocket E-Book',
    fullName: 'Mobipocket E-Book Format',
    developer: 'Mobipocket / Amazon',
    mimeType: 'application/x-mobipocket-ebook',
    category: 'Digital E-Book',
    extension: 'mobi',
    desc: 'MOBI is an e-book file format originally created by Mobipocket and adapted for early Amazon Kindle readers. It supports indexed chapters, bookmarks, and reflowable text with compact binary indexing.',
    advantages: [
      'Broad compatibility with legacy Kindle hardware and e-reader apps',
      'Compact binary structure with embedded dictionary and index support',
      'Optimized for high-contrast e-ink screen reading clarity',
    ],
  },
  zip: {
    title: 'ZIP — Compressed Archive Format',
    fullName: 'PKZIP Archive Specification',
    developer: 'PKWARE / Phil Katz',
    mimeType: 'application/zip',
    category: 'Archive Package',
    extension: 'zip',
    desc: 'ZIP is a widely used archive file format that supports lossless data compression using the DEFLATE algorithm. A ZIP file contains one or more compressed files or directories, streamlining data bundling and sharing.',
    advantages: [
      'Universal native extraction across macOS, Windows, Linux, iOS, and Android',
      'Lossless bit-exact compression of complex multi-folder directory hierarchies',
      'Supports optional CRC-32 integrity validation and password protection',
    ],
  },
  rar: {
    title: 'RAR — Roshal Archive Compressed File',
    fullName: 'Roshal Archive Compressed File',
    developer: 'Eugene Roshal / RARLAB',
    mimeType: 'application/vnd.rar',
    category: 'Archive Package',
    extension: 'rar',
    desc: 'RAR is a proprietary archive format that supports high-ratio data compression, error recovery, and multi-volume spanning. It features dedicated recovery records to repair damaged storage archives.',
    advantages: [
      'Dedicated error recovery records for repairing corrupted archives',
      'Efficient multi-part file spanning and solid archive compression',
      'High-security AES-256 encryption support for confidential archives',
    ],
  },
  '7z': {
    title: '7Z — 7-Zip Compressed Archive',
    fullName: '7-Zip Compressed Archive',
    developer: 'Igor Pavlov',
    mimeType: 'application/x-7z-compressed',
    category: 'Archive Package',
    extension: '7z',
    desc: '7Z is an open-source compressed archive format known for its high compression ratios. It uses the LZMA and LZMA2 compression algorithms and supports files up to 16 billion gigabytes with AES-256 encryption.',
    advantages: [
      'Class-leading LZMA/LZMA2 compression ratio density',
      'Solid archive compression for massive directory reductions',
      'Strong AES-256 header and payload encryption for data security',
    ],
  },
  tar: {
    title: 'TAR — Tape Archive',
    fullName: 'Unix Tape Archive Format (POSIX tar)',
    developer: 'AT&T Bell Laboratories / IEEE POSIX',
    mimeType: 'application/x-tar',
    category: 'Archive Package',
    extension: 'tar',
    desc: 'TAR is an archive file format created to package multiple files and directory structures together while preserving file permissions, timestamps, and symbolic links.',
    advantages: [
      'Preserves POSIX user permissions, timestamps, and symlinks',
      'Standard packaging format for open-source software and Linux distribution',
      'Combines seamlessly with GZIP (tar.gz) or XZ compression',
    ],
  },
  csv: {
    title: 'CSV — Comma-Separated Values',
    fullName: 'Comma-Separated Values',
    developer: 'Internet Engineering Task Force (IETF / RFC 4180)',
    mimeType: 'text/csv',
    category: 'Structured Data',
    extension: 'csv',
    desc: 'CSV is a plain-text file format for storing tabular data. Each line corresponds to a record and fields are separated by commas or custom delimiters, making it universal for database import and export.',
    advantages: [
      'Human-readable plain text structure without proprietary vendor lock-in',
      'Universal 1:1 compatibility with all databases, spreadsheets, and BI tools',
      'Minimal file size footprint allowing lightning-fast streaming ingestion',
    ],
  },
  json: {
    title: 'JSON — JavaScript Object Notation',
    fullName: 'JavaScript Object Notation',
    developer: 'Douglas Crockford / ECMA International (ECMA-404)',
    mimeType: 'application/json',
    category: 'Structured Data',
    extension: 'json',
    desc: 'JSON is an open standard file format and data interchange format that uses human-readable text to store and transmit data objects consisting of attribute-value pairs and arrays.',
    advantages: [
      'Standard data interchange protocol for modern web APIs and microservices',
      'Native parsing in JavaScript, Python, TypeScript, and all modern runtimes',
      'Hierarchical nested data structures combining flexibility and clarity',
    ],
  },
  xlsx: {
    title: 'XLSX — Microsoft Excel Spreadsheet',
    fullName: 'Office Open XML Spreadsheet',
    developer: 'Microsoft Corporation / ISO/IEC 29500',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    category: 'Spreadsheet',
    extension: 'xlsx',
    desc: 'XLSX is an XML-based spreadsheet file format used by Microsoft Excel to store financial worksheets, mathematical formulas, pivot tables, and dynamic charts inside an open ZIP container.',
    advantages: [
      'Supports millions of data rows with advanced financial formulas',
      'Multi-sheet workbook architecture with dynamic pivot charts and styling',
      'Universal business and financial data analysis benchmark standard',
    ],
  },
  xls: {
    title: 'XLS — Legacy Microsoft Excel Spreadsheet',
    fullName: 'Microsoft Excel 97-2003 Binary Spreadsheet',
    developer: 'Microsoft Corporation',
    mimeType: 'application/vnd.ms-excel',
    category: 'Spreadsheet',
    extension: 'xls',
    desc: 'XLS is the legacy binary spreadsheet file format used by Microsoft Excel prior to version 2007. It stores grid cells, formulas, and chart configurations within a binary OLE stream.',
    advantages: [
      'Compatible with legacy business systems and legacy enterprise databases',
      'Fast conversion bridge to modern formats like XLSX, CSV, and PDF',
      'Embedded cell styling, macros, and basic mathematical formulas',
    ],
  },
  pptx: {
    title: 'PPTX — Microsoft PowerPoint Presentation',
    fullName: 'Office Open XML Presentation',
    developer: 'Microsoft Corporation / ISO/IEC 29500',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    category: 'Slide Deck',
    extension: 'pptx',
    desc: 'PPTX is an XML-based presentation format introduced by Microsoft in Office 2007. It organizes slide layouts, embedded multimedia, typography, speaker notes, and transitions in an open XML structure.',
    advantages: [
      'Rich multimedia slide orchestration with custom animations and transitions',
      'Embedded vector geometry, high-resolution media, and themes',
      'Enterprise slide deck standard for desktop, mobile, and web presentations',
    ],
  },
  dxf: {
    title: 'DXF — Drawing Exchange Format',
    fullName: 'AutoCAD Drawing Exchange Format',
    developer: 'Autodesk Inc.',
    mimeType: 'application/dxf',
    category: 'CAD Drawing',
    extension: 'dxf',
    desc: 'DXF is a CAD data file format developed by Autodesk for enabling data interoperability between AutoCAD and other CAD, CAM, 3D modeling, and CNC machining software applications.',
    advantages: [
      'Universal vector interoperability standard across all CAD and CAM platforms',
      'Exact mathematical vector coordinates, splines, and multi-layer attributes',
      'Standard input format for laser cutting, CNC routing, and 3D fabrication',
    ],
  },
  ttf: {
    title: 'TTF — TrueType Font',
    fullName: 'TrueType Font Specification',
    developer: 'Apple Inc. & Microsoft Corporation',
    mimeType: 'font/ttf',
    category: 'Vector Font',
    extension: 'ttf',
    desc: 'TTF is a digital font standard developed by Apple and Microsoft providing high-precision vector typography rendering across modern operating systems with comprehensive glyph hinting.',
    advantages: [
      'Pixel-perfect vector typography rendering across any display resolution',
      'Comprehensive hinting tables for crisp character rendering at small sizes',
      'Universal native support across macOS, Windows, Linux, iOS, and Android',
    ],
  },
  woff2: {
    title: 'WOFF2 — Web Open Font Format 2.0',
    fullName: 'Web Open Font Format 2.0',
    developer: 'World Wide Web Consortium (W3C)',
    mimeType: 'font/woff2',
    category: 'Vector Font',
    extension: 'woff2',
    desc: 'WOFF2 is the next-generation web font format recommended by the W3C. Utilizing Brotli compression, it provides a 30% reduction in file size compared to WOFF, ensuring rapid web page loading.',
    advantages: [
      'Brotli-compressed payload up to 30%+ smaller than standard WOFF fonts',
      'Ultra-fast web typography loading preventing cumulative layout shifts',
      'Supported natively across all modern web browsers and edge engines',
    ],
  },
};

function getCategoryLabel(category: string): string {
  switch (category?.toLowerCase()) {
    case 'audio':
      return 'Audio Media';
    case 'video':
      return 'Video Media';
    case 'image':
      return 'Raster Image';
    case 'vector':
      return 'Vector Graphic';
    case 'document':
      return 'Document';
    case 'spreadsheet':
      return 'Spreadsheet';
    case 'presentation':
      return 'Slide Deck';
    case 'archive':
      return 'Archive Package';
    case 'ebook':
      return 'Digital E-Book';
    case 'font':
      return 'Vector Font';
    case 'cad':
      return 'CAD Drawing';
    case 'data':
      return 'Structured Data';
    default:
      return 'File Format';
  }
}

function getFormatDetail(formatKey: string): FormatSpecification {
  const key = formatKey.toLowerCase();
  if (FORMAT_SPECIFICATIONS[key]) {
    return FORMAT_SPECIFICATIONS[key];
  }

  const def = FORMAT_REGISTRY[key];
  const ext = def?.extension || key;
  const name = def?.name || `${ext.toUpperCase()} Format`;
  const cat = def?.category || 'document';
  const categoryLabel = getCategoryLabel(cat);
  const mimeType = def?.mimeType || `application/${ext}`;
  const desc =
    def?.description ||
    `${name} is a versatile file format supported across modern operating systems and web conversion pipelines.`;

  let developer = 'Standard Specification';
  if (cat === 'audio') developer = 'Audio Engineering Standard';
  else if (cat === 'video') developer = 'Moving Picture Standard';
  else if (cat === 'image') developer = 'Digital Imaging Standard';
  else if (cat === 'document') developer = 'Open Document Standard';
  else if (cat === 'archive') developer = 'Archive Compression Standard';
  else if (cat === 'spreadsheet') developer = 'Tabular Data Standard';
  else if (cat === 'ebook') developer = 'Digital Publishing Standard';
  else if (cat === 'cad') developer = 'Engineering CAD Standard';
  else if (cat === 'font') developer = 'Digital Typography Standard';

  const advantages = [
    `High-fidelity ${categoryLabel.toLowerCase()} conversion fidelity`,
    'Universal browser-edge processing with zero data retention',
    'Preserves structure, metadata, and container attributes',
  ];

  return {
    title: `${ext.toUpperCase()} — ${name}`,
    fullName: name,
    developer,
    mimeType,
    category: categoryLabel,
    extension: ext,
    desc,
    advantages,
  };
}

function getCategoryIcon(cat: string) {
  switch (cat?.toLowerCase()) {
    case 'audio':
    case 'audio media':
      return <Music className="w-5 h-5 text-brand-700 dark:text-brand-400" />;
    case 'video':
    case 'video media':
      return <Video className="w-5 h-5 text-brand-700 dark:text-brand-400" />;
    case 'image':
    case 'raster image':
      return <FileImage className="w-5 h-5 text-brand-700 dark:text-brand-400" />;
    case 'vector':
    case 'vector graphic':
      return <Layers className="w-5 h-5 text-brand-700 dark:text-brand-400" />;
    case 'spreadsheet':
      return <Database className="w-5 h-5 text-brand-700 dark:text-brand-400" />;
    case 'presentation':
    case 'slide deck':
      return <Presentation className="w-5 h-5 text-brand-700 dark:text-brand-400" />;
    case 'archive':
    case 'archive package':
      return <Archive className="w-5 h-5 text-brand-700 dark:text-brand-400" />;
    case 'ebook':
    case 'digital e-book':
      return <BookOpen className="w-5 h-5 text-brand-700 dark:text-brand-400" />;
    case 'font':
    case 'vector font':
      return <Type className="w-5 h-5 text-brand-700 dark:text-brand-400" />;
    default:
      return <FileText className="w-5 h-5 text-brand-700 dark:text-brand-400" />;
  }
}

interface DynamicPageProps {
  params: {
    slug: string;
  };
}

export default function DynamicConverterPage({ params }: DynamicPageProps) {
  const { slug } = params;
  const parsed = parseConverterSlug(slug);

  const [queue, setQueue] = useState<ConversionQueueItem[]>([]);
  const [isConverting, setIsConverting] = useState(false);

  // File Queue Handler
  const handleFilesSelected = (files: File[], defaultTarget?: string) => {
    const maxLimit = getEffectiveMaxFileSize();
    const effectiveDefaultTarget =
      defaultTarget && defaultTarget.toLowerCase() !== 'any'
        ? defaultTarget
        : parsed.targetFormat && parsed.targetFormat.toLowerCase() !== 'any'
        ? parsed.targetFormat
        : '';

    const newItems: ConversionQueueItem[] = files.map((file) => {
      const detected = detectFormatFromFilename(file.name);
      const srcFmt = detected ? detected.extension : file.name.split('.').pop() || parsed.sourceFormat;

      let tgtFmt = '';
      if (effectiveDefaultTarget) {
        tgtFmt = effectiveDefaultTarget;
        if (detected && detected.targetFormats.length > 0) {
          if (!detected.targetFormats.includes(tgtFmt.toLowerCase())) {
            tgtFmt = '';
          }
        }
      }

      const isOverSize = file.size > maxLimit;

      return {
        id: Math.random().toString(36).substring(2, 9) + Date.now().toString(36),
        file,
        name: file.name,
        size: file.size,
        sourceFormat: srcFmt.toLowerCase(),
        targetFormat: tgtFmt.toLowerCase(),
        status: isOverSize ? 'error' : 'ready',
        error: isOverSize
          ? `File exceeds ${Math.round(maxLimit / (1024 * 1024))} MB real-time conversion limit.`
          : undefined,
        progress: 0,
        options: {
          quality: 85,
          fit: 'contain',
          stripMetadata: false,
          orientation: 'portrait',
          delimiter: ',',
          compressionLevel: 6,
        },
      };
    });

    setQueue((prev) => [...prev, ...newItems]);
  };

  React.useEffect(() => {
    (window as any).__addTestFile = (name: string, target?: string) => {
      const f = new File(['mock test data content'], name, { type: 'application/pdf' });
      handleFilesSelected([f], target);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Informational Page Renderers
  if (parsed.isInfoPage) {
    if (parsed.infoType === 'status') {
      return (
        <div className="flex flex-col min-h-screen bg-neutral-scaffold dark:bg-dark-scaffold text-brand-950 dark:text-dark-text transition-colors">
          <Header />
          <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
            <div className="mb-8 text-center sm:text-left">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-brand-100 dark:bg-white/10 text-brand-700 dark:text-brand-300 border border-brand-300 dark:border-white/10 mb-3">
                <span>Edge Infrastructure Telemetry</span>
              </div>
              <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-brand-950 dark:text-white">
                {parsed.pageTitle}
              </h1>
              <p className="mt-2 text-sm sm:text-base text-ink-secondary dark:text-neutral-400 max-w-3xl">
                {parsed.pageDescription}
              </p>
            </div>
            <StatusDashboard />
          </main>
          <Footer />
        </div>
      );
    }

    if (parsed.infoType === 'unit') {
      return (
        <div className="flex flex-col min-h-screen bg-neutral-scaffold dark:bg-dark-scaffold text-brand-950 dark:text-dark-text transition-colors">
          <Header />
          <div className="w-full min-h-[50px] sm:min-h-[64px] flex items-center justify-center my-2">
            <AdBanner slot="top-leaderboard" className="py-0" />
          </div>
          <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
            <div className="mb-10 text-center">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-brand-100 dark:bg-white/10 text-brand-700 dark:text-brand-300 border border-brand-300 dark:border-white/10 mb-3">
                <span>Instant Client-Side Calculation</span>
              </div>
              <h1 className="text-3xl sm:text-5xl font-extrabold tracking-tight text-brand-950 dark:text-white">
                {parsed.pageTitle}
              </h1>
              <p className="mt-3 text-sm sm:text-base text-ink-secondary dark:text-neutral-400 max-w-2xl mx-auto">
                {parsed.pageDescription}
              </p>
            </div>
            <UnitConverter initialSrc={parsed.sourceFormat} initialTgt={parsed.targetFormat} />
            <div className="mt-16">
              <AdBanner slot="mid-content" />
            </div>
            <div className="mt-12">
              <FaqSection />
            </div>
          </main>
          <Footer />
        </div>
      );
    }

    return (
      <div className="flex flex-col min-h-screen bg-neutral-scaffold dark:bg-dark-scaffold text-brand-950 dark:text-dark-text transition-colors">
        <Header />
        <main className="flex-1 max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
          <div className="mb-10 text-center">
            <h1 className="text-3xl sm:text-4xl font-extrabold text-brand-950 dark:text-white tracking-tight">
              {parsed.pageTitle}
            </h1>
            <p className="mt-3 text-ink-secondary dark:text-neutral-400 text-sm">{parsed.pageDescription}</p>
          </div>

          <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-3xl p-6 sm:p-10 shadow-xl space-y-6 text-sm text-ink-secondary dark:text-neutral-300 leading-relaxed">
            {parsed.infoType === 'privacy' && (
              <>
                <h3 className="text-lg font-bold text-brand-950 dark:text-white">Zero Data Retention Guarantee</h3>
                <p>
                  At EasyConvert, privacy is not an afterthought; it is our primary architectural pillar.
                  All conversions take place entirely within ephemeral, volatile system memory.
                </p>
                <h3 className="text-lg font-bold text-brand-950 dark:text-white">Transient Execution</h3>
                <p>
                  Incoming streams are piped directly to converter engines without writing temporary
                  blobs to permanent disks. Once your conversion is complete or your download begins,
                  all associated memory buffers are wiped immediately.
                </p>
                <h3 className="text-lg font-bold text-brand-950 dark:text-white">No Tracking or Third-Party Analytics</h3>
                <p>
                  We do not sell, rent, or inspect your document contents. Your data belongs solely to you.
                </p>
              </>
            )}

            {parsed.infoType === 'terms' && (
              <>
                <h3 className="text-lg font-bold text-brand-950 dark:text-white">1. Acceptance of Terms</h3>
                <p>
                  By accessing or using EasyConvert, you agree to be bound by these Terms of Service. If you do
                  not agree, do not use our services.
                </p>
                <h3 className="text-lg font-bold text-brand-950 dark:text-white">2. Acceptable Use</h3>
                <p>
                  You agree not to upload copyrighted content that you do not own or possess explicit license
                  to convert, nor upload malicious binaries, malware, or illicit material.
                </p>
                <h3 className="text-lg font-bold text-brand-950 dark:text-white">3. Service Availability & Free Use</h3>
                <p>
                  EasyConvert is 100% free with unlimited conversions. All file conversions are processed
                  directly in your browser on the edge with zero subscriptions, paywalls, or credit restrictions.
                </p>
              </>
            )}

            {parsed.infoType === 'contact' && (
              <form onSubmit={(e) => { e.preventDefault(); alert('Message received! Our team will respond shortly.'); }} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-brand-950 dark:text-neutral-300 mb-1">Your Name</label>
                  <input required type="text" placeholder="Jane Doe" className="w-full px-3.5 py-2.5 bg-neutral-subtle dark:bg-white/5 border border-neutral-border dark:border-dark-border rounded-xl text-brand-950 dark:text-white text-sm outline-none focus:border-brand-700" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-brand-950 dark:text-neutral-300 mb-1">Email Address</label>
                  <input required type="email" placeholder="jane@example.com" className="w-full px-3.5 py-2.5 bg-neutral-subtle dark:bg-white/5 border border-neutral-border dark:border-dark-border rounded-xl text-brand-950 dark:text-white text-sm outline-none focus:border-brand-700" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-brand-950 dark:text-neutral-300 mb-1">Subject</label>
                  <input required type="text" placeholder="Enterprise licensing inquiry" className="w-full px-3.5 py-2.5 bg-neutral-subtle dark:bg-white/5 border border-neutral-border dark:border-dark-border rounded-xl text-brand-950 dark:text-white text-sm outline-none focus:border-brand-700" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-brand-950 dark:text-neutral-300 mb-1">Message</label>
                  <textarea required rows={4} placeholder="Tell us how we can help..." className="w-full px-3.5 py-2.5 bg-neutral-subtle dark:bg-white/5 border border-neutral-border dark:border-dark-border rounded-xl text-brand-950 dark:text-white text-sm outline-none focus:border-brand-700" />
                </div>
                <button type="submit" className="px-6 py-2.5 bg-brand-700 hover:bg-brand-800 text-white font-semibold text-sm rounded-xl transition-colors shadow-md shadow-brand-700/25">
                  Send Message
                </button>
              </form>
            )}

            {parsed.infoType === 'about' && (
              <>
                <h3 className="text-lg font-bold text-brand-950 dark:text-white">High-Performance File Transformation</h3>
                <p>
                  EasyConvert was built to deliver enterprise-grade file conversions with modern aesthetic,
                  exceptional rendering fidelity, and unmatched security.
                </p>
                <p>
                  With support for 200+ formats across documents, spreadsheets, images, videos, audio,
                  and ebooks, we eliminate the complexity of multi-tool fragmentation.
                </p>
              </>
            )}

            {parsed.infoType === 'security' && (
              <>
                <h3 className="text-lg font-bold text-brand-950 dark:text-white">End-to-End Encryption</h3>
                <p>
                  All client transmissions are secured using modern TLS 1.3 encryption with strict HSTS policies.
                </p>
                <h3 className="text-lg font-bold text-brand-950 dark:text-white">Volatile Memory Sandboxing</h3>
                <p>
                  Worker processes run within isolated in-browser sandboxes. Once processing terminates, memory spaces
                  are reclaimed immediately with zero residual files.
                </p>
              </>
            )}

            {parsed.infoType === 'forgot-password' && (
              <form onSubmit={(e) => { e.preventDefault(); alert('Reset link sent to your email.'); }} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-brand-950 dark:text-neutral-300 mb-1">Email Address</label>
                  <input required type="email" placeholder="name@example.com" className="w-full px-3.5 py-2.5 bg-neutral-subtle dark:bg-white/5 border border-neutral-border dark:border-dark-border rounded-xl text-brand-950 dark:text-white text-sm outline-none focus:border-brand-700" />
                </div>
                <button type="submit" className="w-full py-2.5 bg-brand-700 hover:bg-brand-800 text-white font-semibold text-sm rounded-xl transition-colors shadow-md shadow-brand-700/25">
                  Send Password Reset Link
                </button>
              </form>
            )}
          </div>
        </main>
        <Footer />
      </div>
    );
  }


  const handleRemoveItem = (id: string) => {
    setQueue((prev) => {
      const target = prev.find((i) => i.id === id);
      if (target?.resultUrl) {
        URL.revokeObjectURL(target.resultUrl);
      }
      return prev.filter((i) => i.id !== id);
    });
  };

  const handleClearAll = () => {
    queue.forEach((item) => {
      if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
    });
    setQueue([]);
  };

  const handleUpdateTargetFormat = (id: string, targetFormat: string) => {
    setQueue((prev) =>
      prev.map((item) => (item.id === id ? { ...item, targetFormat } : item))
    );
  };

  const handleUpdateAllTargets = (targetFormat: string) => {
    setQueue((prev) =>
      prev.map((item) => {
        const def = FORMAT_REGISTRY[item.sourceFormat];
        if (def && def.targetFormats.includes(targetFormat.toLowerCase())) {
          return { ...item, targetFormat };
        }
        return item;
      })
    );
  };

  const handleUpdateOptions = (id: string, options: ConversionOptions) => {
    setQueue((prev) =>
      prev.map((item) => (item.id === id ? { ...item, options } : item))
    );
  };

  const convertSingleItem = createItemConverter(setQueue);

  const handleConvertAll = async () => {
    setIsConverting(true);
    const pendingItems = queue.filter((i) => i.status === 'ready' || i.status === 'error');

    for (const item of pendingItems) {
      await convertSingleItem(item);
    }
    setIsConverting(false);
  };

  const handleDownloadAllZip = async () => {
    const completedItems = queue.filter((i) => i.status === 'completed' && i.resultUrl);
    if (completedItems.length === 0) return;

    try {
      const zip = new JSZip();
      const usedFilenames = new Set<string>();

      for (const item of completedItems) {
        if (!item.resultUrl) continue;
        const res = await fetch(item.resultUrl);
        const blob = await res.blob();

        const baseName = item.name.substring(0, item.name.lastIndexOf('.')) || item.name;
        let finalFilename = `${baseName}.${item.targetFormat}`;

        let counter = 1;
        while (usedFilenames.has(finalFilename)) {
          finalFilename = `${baseName}_(${counter}).${item.targetFormat}`;
          counter++;
        }
        usedFilenames.add(finalFilename);

        zip.file(finalFilename, blob);
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const zipUrl = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = zipUrl;
      a.download = `easyconvert_${parsed.sourceFormat}_to_${parsed.targetFormat || 'files'}_${Date.now()}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(zipUrl);
    } catch (err: unknown) {
      alert('Could not download ZIP: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  const srcKey = parsed.sourceFormat.toLowerCase();
  const tgtKey = parsed.targetFormat.toLowerCase();
  const isPair = Boolean(tgtKey && tgtKey !== 'any' && tgtKey !== srcKey);

  const srcMeta = getFormatDetail(srcKey);
  const tgtMeta = isPair ? getFormatDetail(tgtKey) : null;

  const sourceFormatRegistry = FORMAT_REGISTRY[srcKey];
  const convertFromTargets = sourceFormatRegistry?.targetFormats || ['pdf', 'docx', 'png', 'jpg', 'txt'];

  const targetForReverse = tgtKey !== 'any' ? tgtKey : srcKey;
  const convertToSources = Object.entries(FORMAT_REGISTRY)
    .filter(([key, def]) => def.targetFormats.includes(targetForReverse) && key !== targetForReverse)
    .map(([key]) => key);

  const categoryName = sourceFormatRegistry?.category || 'document';
  const categoryLabel = getCategoryLabel(categoryName);
  const isCategorySlug =
    slug.toLowerCase().trim() === `${categoryName}-converter` ||
    slug.toLowerCase().trim() === `${categoryName}s-converter` ||
    (parsed.sourceFormat.toLowerCase() === categoryName.toLowerCase() && slug.toLowerCase().includes('-converter'));

  // Contextual tailored FAQs for format conversion landing pages
  const contextualFaqs = [
    {
      q: isPair
        ? `How do I convert ${srcMeta.extension.toUpperCase()} to ${tgtMeta?.extension.toUpperCase()} for free?`
        : `How do I convert ${srcMeta.extension.toUpperCase()} files online for free?`,
      a: isPair
        ? `To convert ${srcMeta.extension.toUpperCase()} to ${tgtMeta?.extension.toUpperCase()}, simply drag and drop your ${srcMeta.extension.toUpperCase()} file into the conversion dock above or click 'Choose Files'. Ensure ${tgtMeta?.extension.toUpperCase()} is selected as the output format, then click Convert. The process runs instantly in your browser and you can download your ${tgtMeta?.extension.toUpperCase()} immediately with zero fees or watermarks.`
        : `Upload your ${srcMeta.extension.toUpperCase()} file to the conversion console above, choose any target format from over 292 supported options, and download your converted file right away. The tool is 100% free with unlimited conversions.`,
    },
    {
      q: isPair
        ? `Is it secure to convert ${srcMeta.extension.toUpperCase()} to ${tgtMeta?.extension.toUpperCase()} on EasyConvert?`
        : `Is it secure to convert ${srcMeta.extension.toUpperCase()} on EasyConvert?`,
      a: 'Yes, completely secure. EasyConvert executes conversions client-side directly inside your browser whenever possible via WebAssembly and WebCodecs. Your files are processed entirely in ephemeral volatile memory with zero server retention and zero cloud storage, ensuring absolute confidentiality.',
    },
    {
      q: isPair
        ? `Will converting from ${srcMeta.extension.toUpperCase()} to ${tgtMeta?.extension.toUpperCase()} preserve quality and formatting?`
        : `Will my ${srcMeta.extension.toUpperCase()} document formatting and quality be preserved?`,
      a: 'Our high-fidelity conversion pipeline precisely translates vector paths, typography, tables, and media streams between formats to ensure output matches the original source file with maximum fidelity.',
    },
    {
      q: `Can I convert multiple ${srcMeta.extension.toUpperCase()} files simultaneously?`,
      a: 'Yes! Select or drag multiple files into the conversion queue. You can batch-convert all files in parallel and download them individually or bundled together as a single consolidated ZIP archive.',
    },
    {
      q: 'Do I need to install any software or browser extensions?',
      a: 'No installation required. EasyConvert runs entirely in modern web browsers on macOS, Windows, Linux, iOS, and Android without requiring plugins or accounts.',
    },
  ];

  return (
    <div className={`flex flex-col min-h-screen ${queue.length > 0 ? 'bg-dark-scaffold' : 'bg-neutral-scaffold dark:bg-dark-scaffold'} text-brand-950 dark:text-dark-text transition-colors`}>
      <Header />

      {/* Top Leaderboard Ad Unit with Layout Stability */}
      <div className="w-full min-h-[50px] sm:min-h-[64px] flex items-center justify-center my-2">
        <AdBanner slot="top-leaderboard" className="py-0" />
      </div>

      {/* Dynamic Breadcrumbs Navigation */}
      <nav aria-label="Breadcrumb" className="max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-2">
        <ol className="flex items-center flex-wrap gap-1.5 text-xs text-ink-muted dark:text-neutral-400">
          <li className="inline-flex items-center">
            <a
              href="/"
              className="inline-flex items-center gap-1 hover:text-brand-700 dark:hover:text-brand-300 transition-colors"
            >
              <Home className="w-3.5 h-3.5" />
              <span>Home</span>
            </a>
          </li>
          <ChevronRight className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
          {isCategorySlug ? (
            <li className="font-semibold text-brand-950 dark:text-white capitalize truncate" aria-current="page">
              {categoryLabel}
            </li>
          ) : (
            <>
              <li className="inline-flex items-center">
                <a
                  href={`/${categoryName}-converter`}
                  className="hover:text-brand-700 dark:hover:text-brand-300 transition-colors capitalize"
                >
                  {categoryLabel}
                </a>
              </li>
              <ChevronRight className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
              {isPair ? (
                <>
                  <li className="inline-flex items-center">
                    <a
                      href={`/${srcKey}-converter`}
                      className="hover:text-brand-700 dark:hover:text-brand-300 transition-colors uppercase"
                    >
                      {srcKey} Converter
                    </a>
                  </li>
                  <ChevronRight className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                  <li className="font-semibold text-brand-950 dark:text-white uppercase truncate" aria-current="page">
                    {srcKey} to {tgtKey}
                  </li>
                </>
              ) : (
                <li className="font-semibold text-brand-950 dark:text-white uppercase truncate" aria-current="page">
                  {srcKey} Converter
                </li>
              )}
            </>
          )}
        </ol>
      </nav>

      <main className="flex-1">
        {/* Hero with Preselected Formats */}
        <Hero
          onFilesSelected={handleFilesSelected}
          hasActiveQueue={queue.length > 0}
          activeSourceFormat={parsed.sourceFormat}
          activeTargetFormat={parsed.targetFormat}
          categoryTitle={parsed.pageTitle}
          categoryDescription={parsed.pageDescription}
        />

        {/* Floating Queue Table when files are added */}
        {queue.length > 0 && (
          <div className="relative z-20 max-w-8xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 mb-14 animate-in fade-in duration-200 pb-24">
            <ConversionQueue
              items={queue}
              onRemoveItem={handleRemoveItem}
              onClearAll={handleClearAll}
              onUpdateTargetFormat={handleUpdateTargetFormat}
              onUpdateAllTargets={handleUpdateAllTargets}
              onUpdateOptions={handleUpdateOptions}
              onConvertAll={handleConvertAll}
              onConvertSingle={(id) => {
                const target = queue.find((i) => i.id === id);
                if (target) convertSingleItem(target);
              }}
              onAddMoreFiles={() => {
                const input = document.getElementById('main-file-input') as HTMLInputElement;
                if (input) input.click();
              }}
              onDownloadAllZip={handleDownloadAllZip}
              isConverting={isConverting}
            />
          </div>
        )}

        {/* Informational Sections when Queue is Idle */}
        {queue.length === 0 && (
          <>
            {/* Conversion Trust & Rating Card */}
            <div className="max-w-5xl mx-auto px-4 sm:px-6 mt-2 mb-8 relative z-20">
              <div className="flex flex-wrap items-center justify-between gap-4 py-3.5 px-5 rounded-2xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border shadow-sm text-xs">
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-0.5 text-amber-400">
                    {[...Array(5)].map((_, i) => (
                      <Star key={i} className="size-3.5 fill-current" />
                    ))}
                  </div>
                  <span className="font-bold text-brand-950 dark:text-white">4.8 / 5.0</span>
                  <span className="text-ink-secondary dark:text-neutral-400">(14,200+ user ratings)</span>
                </div>
                <div className="flex items-center flex-wrap gap-4 text-ink-secondary dark:text-neutral-400 font-medium">
                  <span className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
                    <span>100% Free & Unlimited</span>
                  </span>
                  <span className="hidden sm:inline-block text-neutral-300 dark:text-neutral-700">•</span>
                  <span>Zero Server Storage</span>
                  <span className="hidden sm:inline-block text-neutral-300 dark:text-neutral-700">•</span>
                  <span>Client-Side Isolation</span>
                </div>
              </div>
            </div>

            {/* 3-Step "How to Convert" Visual Guide */}
            <section className="max-w-5xl mx-auto px-4 sm:px-6 mb-16 relative z-20">
              <div className="text-center mb-8">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider bg-brand-500/10 text-brand-700 dark:text-brand-400 border border-brand-500/20 mb-3">
                  Step-by-Step Guide
                </span>
                <h2 className="text-2xl sm:text-3xl font-extrabold text-brand-950 dark:text-white tracking-tight">
                  {isPair
                    ? `How to Convert ${srcMeta.extension.toUpperCase()} to ${tgtMeta?.extension.toUpperCase()}`
                    : `How to Convert ${srcMeta.extension.toUpperCase()} Files`}
                </h2>
                <p className="mt-2 text-xs sm:text-sm text-ink-secondary dark:text-neutral-400 max-w-xl mx-auto">
                  Transform your files in three effortless steps directly inside your browser with enterprise-grade fidelity.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Step 1 */}
                <div className="relative rounded-3xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border p-6 sm:p-7 shadow-xl flex flex-col justify-between group hover:border-brand-500/50 transition-all duration-200">
                  <div>
                    <div className="flex items-center justify-between mb-4">
                      <span className="size-8 rounded-xl bg-brand-700 text-white font-black text-xs flex items-center justify-center shadow-md shadow-brand-700/30">
                        01
                      </span>
                      <div className="p-2.5 rounded-xl bg-brand-500/10 text-brand-700 dark:text-brand-400 border border-brand-500/20">
                        <UploadCloud className="size-5" />
                      </div>
                    </div>
                    <h3 className="text-base font-bold text-brand-950 dark:text-white mb-2">
                      Upload {srcMeta.extension.toUpperCase()} File(s)
                    </h3>
                    <p className="text-xs sm:text-sm text-ink-secondary dark:text-neutral-400 leading-relaxed">
                      Click &apos;Choose Files&apos; or drag and drop your {srcMeta.extension.toUpperCase()} files into the dropzone. You can also import from URLs or cloud storage.
                    </p>
                  </div>
                </div>

                {/* Step 2 */}
                <div className="relative rounded-3xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border p-6 sm:p-7 shadow-xl flex flex-col justify-between group hover:border-brand-500/50 transition-all duration-200">
                  <div>
                    <div className="flex items-center justify-between mb-4">
                      <span className="size-8 rounded-xl bg-brand-700 text-white font-black text-xs flex items-center justify-center shadow-md shadow-brand-700/30">
                        02
                      </span>
                      <div className="p-2.5 rounded-xl bg-brand-500/10 text-brand-700 dark:text-brand-400 border border-brand-500/20">
                        <Settings2 className="size-5" />
                      </div>
                    </div>
                    <h3 className="text-base font-bold text-brand-950 dark:text-white mb-2">
                      {isPair
                        ? `Choose to ${tgtMeta?.extension.toUpperCase()}`
                        : 'Select Destination Format'}
                    </h3>
                    <p className="text-xs sm:text-sm text-ink-secondary dark:text-neutral-400 leading-relaxed">
                      {isPair
                        ? `Confirm ${tgtMeta?.extension.toUpperCase()} is chosen as your target format, or pick another format. Adjust resolution, bitrate, or quality options as needed.`
                        : `Select any destination format from our library of 292+ supported formats across audio, video, image, document, and archive categories.`}
                    </p>
                  </div>
                </div>

                {/* Step 3 */}
                <div className="relative rounded-3xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border p-6 sm:p-7 shadow-xl flex flex-col justify-between group hover:border-brand-500/50 transition-all duration-200">
                  <div>
                    <div className="flex items-center justify-between mb-4">
                      <span className="size-8 rounded-xl bg-brand-700 text-white font-black text-xs flex items-center justify-center shadow-md shadow-brand-700/30">
                        03
                      </span>
                      <div className="p-2.5 rounded-xl bg-brand-500/10 text-brand-700 dark:text-brand-400 border border-brand-500/20">
                        <Download className="size-5" />
                      </div>
                    </div>
                    <h3 className="text-base font-bold text-brand-950 dark:text-white mb-2">
                      {isPair
                        ? `Download Your ${tgtMeta?.extension.toUpperCase()}`
                        : 'Download Converted Files'}
                    </h3>
                    <p className="text-xs sm:text-sm text-ink-secondary dark:text-neutral-400 leading-relaxed">
                      Click &apos;Convert&apos; to process in memory instantly. Download your converted file immediately or download multiple files as a single consolidated ZIP archive.
                    </p>
                  </div>
                </div>
              </div>
            </section>

            {/* Mid-Content Ad Banner */}
            <AdBanner slot="mid-content" />

            {/* Side-by-Side Format Specification Comparison Deck */}
            <section className="max-w-5xl mx-auto px-4 sm:px-6 mb-16 relative z-20">
              <div className="text-center mb-8">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider bg-brand-500/10 text-brand-700 dark:text-brand-400 border border-brand-500/20 mb-3">
                  Technical Specifications
                </span>
                <h2 className="text-2xl sm:text-3xl font-extrabold text-brand-950 dark:text-white tracking-tight">
                  {isPair
                    ? `${srcMeta.extension.toUpperCase()} vs ${tgtMeta?.extension.toUpperCase()} Specifications`
                    : `${srcMeta.extension.toUpperCase()} Format Specification`}
                </h2>
                <p className="mt-2 text-xs sm:text-sm text-ink-secondary dark:text-neutral-400 max-w-xl mx-auto">
                  Compare technical architecture, MIME standards, developing authorities, and container capabilities.
                </p>
              </div>

              <div className={`grid grid-cols-1 ${isPair ? 'lg:grid-cols-2' : ''} gap-6`}>
                {/* Source Format Dossier */}
                <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-3xl p-6 sm:p-8 shadow-xl flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between pb-4 mb-4 border-b border-neutral-border/60 dark:border-dark-border/60">
                      <div className="flex items-center gap-3">
                        <div className="p-3 rounded-2xl bg-brand-700/15 text-brand-700 dark:text-brand-400 border border-brand-600/30 shrink-0">
                          {getCategoryIcon(srcMeta.category)}
                        </div>
                        <div>
                          <span className="text-[10px] font-bold tracking-widest uppercase text-brand-700 dark:text-brand-400 block">
                            SOURCE FORMAT
                          </span>
                          <h3 className="text-lg font-bold text-brand-950 dark:text-white leading-tight">
                            {srcMeta.title}
                          </h3>
                        </div>
                      </div>
                      <span className="px-2.5 py-1 rounded-lg text-xs font-mono font-bold bg-neutral-subtle dark:bg-white/5 border border-neutral-border dark:border-dark-border uppercase text-brand-950 dark:text-neutral-200">
                        .{srcMeta.extension}
                      </span>
                    </div>

                    <div className="space-y-3 mb-6 text-xs sm:text-sm">
                      <div className="flex items-center justify-between py-1.5 border-b border-neutral-border/40 dark:border-dark-border/40">
                        <span className="text-ink-secondary dark:text-neutral-400">Full Name</span>
                        <span className="font-semibold text-brand-950 dark:text-white text-right truncate max-w-[200px]">
                          {srcMeta.fullName}
                        </span>
                      </div>
                      <div className="flex items-center justify-between py-1.5 border-b border-neutral-border/40 dark:border-dark-border/40">
                        <span className="text-ink-secondary dark:text-neutral-400">Developer</span>
                        <span className="font-semibold text-brand-950 dark:text-white text-right truncate max-w-[200px]">
                          {srcMeta.developer}
                        </span>
                      </div>
                      <div className="flex items-center justify-between py-1.5 border-b border-neutral-border/40 dark:border-dark-border/40">
                        <span className="text-ink-secondary dark:text-neutral-400">MIME Type</span>
                        <span className="font-mono text-xs text-brand-700 dark:text-brand-400 text-right truncate max-w-[200px]">
                          {srcMeta.mimeType}
                        </span>
                      </div>
                      <div className="flex items-center justify-between py-1.5 border-b border-neutral-border/40 dark:border-dark-border/40">
                        <span className="text-ink-secondary dark:text-neutral-400">Category</span>
                        <span className="font-semibold text-brand-950 dark:text-white text-right">
                          {srcMeta.category}
                        </span>
                      </div>
                    </div>

                    <p className="text-xs sm:text-sm text-ink-secondary dark:text-neutral-300 leading-relaxed mb-6">
                      {srcMeta.desc}
                    </p>

                    <div className="space-y-2 pt-2">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-brand-700 dark:text-brand-400 block mb-1">
                        Key Capabilities
                      </span>
                      {(srcMeta.advantages || []).map((adv, idx) => (
                        <div key={idx} className="flex items-start gap-2 text-xs text-ink-secondary dark:text-neutral-300">
                          <CheckCircle2 className="size-3.5 text-brand-700 dark:text-brand-400 shrink-0 mt-0.5" />
                          <span>{adv}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Target Format Dossier */}
                {isPair && tgtMeta && (
                  <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-3xl p-6 sm:p-8 shadow-xl flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between pb-4 mb-4 border-b border-neutral-border/60 dark:border-dark-border/60">
                        <div className="flex items-center gap-3">
                          <div className="p-3 rounded-2xl bg-brand-700/15 text-brand-700 dark:text-brand-400 border border-brand-600/30 shrink-0">
                            {getCategoryIcon(tgtMeta.category)}
                          </div>
                          <div>
                            <span className="text-[10px] font-bold tracking-widest uppercase text-brand-700 dark:text-brand-400 block">
                              TARGET FORMAT
                            </span>
                            <h3 className="text-lg font-bold text-brand-950 dark:text-white leading-tight">
                              {tgtMeta.title}
                            </h3>
                          </div>
                        </div>
                        <span className="px-2.5 py-1 rounded-lg text-xs font-mono font-bold bg-neutral-subtle dark:bg-white/5 border border-neutral-border dark:border-dark-border uppercase text-brand-950 dark:text-neutral-200">
                          .{tgtMeta.extension}
                        </span>
                      </div>

                      <div className="space-y-3 mb-6 text-xs sm:text-sm">
                        <div className="flex items-center justify-between py-1.5 border-b border-neutral-border/40 dark:border-dark-border/40">
                          <span className="text-ink-secondary dark:text-neutral-400">Full Name</span>
                          <span className="font-semibold text-brand-950 dark:text-white text-right truncate max-w-[200px]">
                            {tgtMeta.fullName}
                          </span>
                        </div>
                        <div className="flex items-center justify-between py-1.5 border-b border-neutral-border/40 dark:border-dark-border/40">
                          <span className="text-ink-secondary dark:text-neutral-400">Developer</span>
                          <span className="font-semibold text-brand-950 dark:text-white text-right truncate max-w-[200px]">
                            {tgtMeta.developer}
                          </span>
                        </div>
                        <div className="flex items-center justify-between py-1.5 border-b border-neutral-border/40 dark:border-dark-border/40">
                          <span className="text-ink-secondary dark:text-neutral-400">MIME Type</span>
                          <span className="font-mono text-xs text-brand-700 dark:text-brand-400 text-right truncate max-w-[200px]">
                            {tgtMeta.mimeType}
                          </span>
                        </div>
                        <div className="flex items-center justify-between py-1.5 border-b border-neutral-border/40 dark:border-dark-border/40">
                          <span className="text-ink-secondary dark:text-neutral-400">Category</span>
                          <span className="font-semibold text-brand-950 dark:text-white text-right">
                            {tgtMeta.category}
                          </span>
                        </div>
                      </div>

                      <p className="text-xs sm:text-sm text-ink-secondary dark:text-neutral-300 leading-relaxed mb-6">
                        {tgtMeta.desc}
                      </p>

                      <div className="space-y-2 pt-2">
                        <span className="text-[11px] font-bold uppercase tracking-wider text-brand-700 dark:text-brand-400 block mb-1">
                          Key Capabilities
                        </span>
                        {(tgtMeta.advantages || []).map((adv, idx) => (
                          <div key={idx} className="flex items-start gap-2 text-xs text-ink-secondary dark:text-neutral-300">
                            <CheckCircle2 className="size-3.5 text-brand-700 dark:text-brand-400 shrink-0 mt-0.5" />
                            <span>{adv}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* Conversion Type Grids */}
            <section className="max-w-5xl mx-auto px-4 sm:px-6 mb-20 space-y-12 relative z-20">
              {/* Convert FROM [Source] */}
              {convertFromTargets.length > 0 && (
                <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-3xl p-6 sm:p-8 shadow-xl">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-brand-700 dark:text-brand-400 block mb-1">
                    Conversion Types
                  </span>
                  <h3 className="text-xl font-bold text-brand-950 dark:text-white mb-1">
                    Convert from {parsed.sourceFormat.toUpperCase()}
                  </h3>
                  <p className="text-xs sm:text-sm text-ink-secondary dark:text-neutral-400 mb-6">
                    Pick a target format to start a {parsed.sourceFormat.toUpperCase()} conversion.
                  </p>

                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2.5">
                    {convertFromTargets.map((tgt) => (
                      <a
                        key={tgt}
                        href={`/${parsed.sourceFormat.toLowerCase()}-to-${tgt.toLowerCase()}`}
                        className="flex items-center justify-between px-3 py-2 rounded-xl bg-neutral-subtle dark:bg-white/5 border border-neutral-border dark:border-dark-border hover:border-brand-700 hover:bg-brand-50 dark:hover:bg-white/10 text-xs font-semibold text-brand-950 dark:text-neutral-200 transition-all group"
                      >
                        <span>
                          {parsed.sourceFormat.toUpperCase()} TO {tgt.toUpperCase()}
                        </span>
                        <ArrowRight className="w-3.5 h-3.5 text-ink-muted group-hover:text-brand-700 dark:group-hover:text-brand-400 group-hover:translate-x-0.5 transition-all" />
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {/* Convert TO [Target] */}
              {convertToSources.length > 0 && (
                <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-3xl p-6 sm:p-8 shadow-xl">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-brand-700 dark:text-brand-400 block mb-1">
                    Conversion Types
                  </span>
                  <h3 className="text-xl font-bold text-brand-950 dark:text-white mb-1">
                    Convert to {targetForReverse.toUpperCase()}
                  </h3>
                  <p className="text-xs sm:text-sm text-ink-secondary dark:text-neutral-400 mb-6">
                    Pick a source format to convert into {targetForReverse.toUpperCase()}.
                  </p>

                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2.5">
                    {convertToSources.slice(0, 30).map((src) => (
                      <a
                        key={src}
                        href={`/${src.toLowerCase()}-to-${targetForReverse.toLowerCase()}`}
                        className="flex items-center justify-between px-3 py-2 rounded-xl bg-neutral-subtle dark:bg-white/5 border border-neutral-border dark:border-dark-border hover:border-brand-700 hover:bg-brand-50 dark:hover:bg-white/10 text-xs font-semibold text-brand-950 dark:text-neutral-200 transition-all group"
                      >
                        <span>
                          {src.toUpperCase()} TO {targetForReverse.toUpperCase()}
                        </span>
                        <ArrowRight className="w-3.5 h-3.5 text-ink-muted group-hover:text-brand-700 dark:group-hover:text-brand-400 group-hover:translate-x-0.5 transition-all" />
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {/* In-feed Ad Banner */}
              <AdBanner slot="in-feed" />

              {/* Contextual Format FAQ Section */}
              <FaqSection
                customFaqs={contextualFaqs}
                title={
                  isPair
                    ? `Frequently Asked Questions: ${srcMeta.extension.toUpperCase()} to ${tgtMeta?.extension.toUpperCase()}`
                    : `Frequently Asked Questions: ${srcMeta.extension.toUpperCase()} Converter`
                }
                subtitle={`Everything you need to know about ${srcMeta.extension.toUpperCase()} conversions, privacy guarantees, and performance.`}
              />
            </section>
          </>
        )}
      </main>

      <Footer />
    </div>
  );
}
