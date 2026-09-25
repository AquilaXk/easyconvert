'use client';

import React, { useState } from 'react';
import {
  ShieldCheck,
  FolderTree,
  Terminal,
  FileCheck2,
  FileText,
  FileImage,
  Video,
  Music,
  Database,
  Presentation,
  BookOpen,
  Archive,
  ArrowRight,
  Lock,
  Trash2,
  Handshake,
  Cpu,
  Sliders,
  CheckCircle2,
  Type,
  Compass,
} from 'lucide-react';

interface FeaturesProps {
  onSelectPreset?: (source: string, target: string) => void;
}

interface CategoryData {
  id: string;
  name: string;
  count: number;
  icon: React.ReactNode;
  formats: string[];
  commonConversions: Array<{ from: string; to: string; desc: string }>;
}

export default function Features({ onSelectPreset }: FeaturesProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>('documents');

  const categories: CategoryData[] = [
    {
      id: 'documents',
      name: 'Documents',
      count: 23,
      icon: <FileText className="w-3.5 h-3.5" />,
      formats: [
        'ABW', 'DJVU', 'DOC', 'DOCM', 'DOCX', 'DOT', 'DOTX', 'HTML', 'HWP', 'HWPX',
        'LWP', 'MD', 'ODT', 'PAGES', 'PDF', 'RST', 'RTF', 'SDW', 'TEX', 'TXT', 'WPD', 'WPS', 'ZABW',
      ],
      commonConversions: [
        { from: 'PDF', to: 'DOCX', desc: 'editable Word document' },
        { from: 'DOCX', to: 'PDF', desc: 'print-ready PDF' },
        { from: 'HTML', to: 'TXT', desc: 'plain text export' },
      ],
    },
    {
      id: 'images',
      name: 'Images',
      count: 42,
      icon: <FileImage className="w-3.5 h-3.5" />,
      formats: [
        'AVIF', 'BMP', 'CR2', 'DNG', 'EPS', 'GIF', 'HEIC', 'ICO', 'JPEG', 'JPG',
        'NEF', 'PNG', 'PSD', 'RAW', 'SVG', 'TIF', 'TIFF', 'WEBP',
      ],
      commonConversions: [
        { from: 'PNG', to: 'WEBP', desc: 'next-gen lightweight web image' },
        { from: 'HEIC', to: 'JPG', desc: 'universal photo format' },
        { from: 'SVG', to: 'PNG', desc: 'rasterized high-DPI graphic' },
      ],
    },
    {
      id: 'video',
      name: 'Video',
      count: 28,
      icon: <Video className="w-3.5 h-3.5" />,
      formats: [
        '3GP', 'AVI', 'FLV', 'MKV', 'MOV', 'MP4', 'MPEG', 'OGV', 'TS', 'VOB', 'WEBM', 'WMV',
      ],
      commonConversions: [
        { from: 'MP4', to: 'MP3', desc: 'extract audio track' },
        { from: 'MKV', to: 'MP4', desc: 'universal streaming playback' },
        { from: 'MOV', to: 'MP4', desc: 'cross-platform web compatibility' },
      ],
    },
    {
      id: 'audio',
      name: 'Audio',
      count: 21,
      icon: <Music className="w-3.5 h-3.5" />,
      formats: [
        'AAC', 'AIFF', 'FLAC', 'M4A', 'MP3', 'OGG', 'OPUS', 'WAV', 'WMA',
      ],
      commonConversions: [
        { from: 'WAV', to: 'MP3', desc: 'compressed 320 kbps stream' },
        { from: 'M4A', to: 'MP3', desc: 'broad podcast compatibility' },
        { from: 'FLAC', to: 'WAV', desc: 'lossless uncompressed audio' },
      ],
    },
    {
      id: 'spreadsheets',
      name: 'Spreadsheets',
      count: 8,
      icon: <Database className="w-3.5 h-3.5" />,
      formats: ['CSV', 'JSON', 'NUMBERS', 'ODS', 'TSV', 'XLS', 'XLSX', 'XML'],
      commonConversions: [
        { from: 'XLSX', to: 'CSV', desc: 'comma-delimited data' },
        { from: 'CSV', to: 'JSON', desc: 'structured records' },
        { from: 'XLSX', to: 'PDF', desc: 'formatted report' },
      ],
    },
    {
      id: 'slides',
      name: 'Slides',
      count: 11,
      icon: <Presentation className="w-3.5 h-3.5" />,
      formats: ['KEY', 'ODP', 'PPS', 'PPSX', 'PPT', 'PPTX', 'SXI'],
      commonConversions: [
        { from: 'PPTX', to: 'PDF', desc: 'printable slide deck' },
        { from: 'PPTX', to: 'HTML', desc: 'interactive presentation' },
        { from: 'ODP', to: 'PPTX', desc: 'PowerPoint compatibility' },
      ],
    },
    {
      id: 'ebooks',
      name: 'E-books',
      count: 22,
      icon: <BookOpen className="w-3.5 h-3.5" />,
      formats: ['AZW3', 'EPUB', 'FB2', 'LIT', 'MOBI', 'PDB', 'TCR'],
      commonConversions: [
        { from: 'EPUB', to: 'PDF', desc: 'printable book pages' },
        { from: 'MOBI', to: 'EPUB', desc: 'open standard reader' },
        { from: 'FB2', to: 'TXT', desc: 'plain text transcript' },
      ],
    },
    {
      id: 'archives',
      name: 'Archives',
      count: 39,
      icon: <Archive className="w-3.5 h-3.5" />,
      formats: ['7Z', 'ACE', 'BZ2', 'GZ', 'ISO', 'RAR', 'TAR', 'XZ', 'ZIP'],
      commonConversions: [
        { from: 'RAR', to: 'ZIP', desc: 'open standard bundle' },
        { from: 'TAR', to: 'ZIP', desc: 'compressed folder' },
        { from: '7Z', to: 'ZIP', desc: 'standard extraction' },
      ],
    },
    {
      id: 'vector',
      name: 'Vector',
      count: 10,
      icon: <Compass className="w-3.5 h-3.5" />,
      formats: ['AI', 'CDR', 'CGM', 'DXF', 'EMF', 'EPS', 'SK', 'SK1', 'SVG', 'WMF'],
      commonConversions: [
        { from: 'SVG', to: 'PNG', desc: 'rasterized graphic' },
        { from: 'AI', to: 'PDF', desc: 'vector document' },
        { from: 'EPS', to: 'SVG', desc: 'scalable web vector' },
      ],
    },
    {
      id: 'cad',
      name: 'CAD',
      count: 3,
      icon: <Compass className="w-3.5 h-3.5" />,
      formats: ['DWG', 'DXF', 'DGN'],
      commonConversions: [
        { from: 'DWG', to: 'PDF', desc: 'printable technical drawing' },
        { from: 'DXF', to: 'SVG', desc: 'scalable CAD vector' },
      ],
    },
    {
      id: 'fonts',
      name: 'Fonts',
      count: 5,
      icon: <Type className="w-3.5 h-3.5" />,
      formats: ['EOT', 'OTF', 'TTF', 'WOFF', 'WOFF2'],
      commonConversions: [
        { from: 'TTF', to: 'WOFF2', desc: 'modern optimized web font' },
        { from: 'OTF', to: 'TTF', desc: 'TrueType desktop font' },
      ],
    },
  ];

  const activeCat = categories.find((c) => c.id === selectedCategory) || categories[0];

  return (
    <section id="format-catalog" className="py-16 bg-neutral-100/60 dark:bg-neutral-900/40 border-t border-neutral-200 dark:border-white/5 transition-colors">
      <div className="max-w-7xl mx-auto px-6 lg:px-8 space-y-16">
        {/* ROW 1: Format Catalog (Left) + Data Security (Right) */}
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16 items-start">
          {/* Left Column: Format Catalog */}
          <div className="space-y-4">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-lg bg-[#5C6BC0]/10 text-[#5C6BC0]">
                <FolderTree className="w-5 h-5" />
              </div>
              <h2 className="text-2xl font-bold tracking-tight text-neutral-900 dark:text-white">
                Format Catalog
              </h2>
            </div>

            <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
              EasyConvert handles 212 formats across 11 categories, from common office files to camera RAW,
              CAD drawings, archives, ebooks and production media.
            </p>

            {/* Category Badges Grid */}
            <div className="flex flex-wrap gap-2 pt-1">
              {categories.map((cat) => {
                const isSelected = selectedCategory === cat.id;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setSelectedCategory(cat.id)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-[#5C6BC0] text-white border-[#5C6BC0] shadow-sm'
                        : 'bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 border-neutral-200 dark:border-white/10 hover:border-[#5C6BC0] hover:text-[#5C6BC0] dark:hover:text-[#7986CB]'
                    }`}
                  >
                    <span>{cat.name}</span>
                    <span
                      className={`text-[11px] font-bold ${
                        isSelected ? 'text-white/80' : 'text-neutral-400 dark:text-neutral-500'
                      }`}
                    >
                      {cat.count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Sub-panel: Formats listed + Common Conversion Types */}
            <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-white/10 grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Left Sub-column: Formats Listed */}
              <div>
                <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-2.5">
                  <span>{activeCat.name} Formats</span>
                  <span>{activeCat.formats.length} listed</span>
                </div>
                <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto pr-1">
                  {activeCat.formats.map((fmt) => (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => {
                        onSelectPreset?.(fmt.toLowerCase(), 'pdf');
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                      className="px-2 py-0.5 rounded text-[11px] font-mono font-medium uppercase bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-white/10 text-neutral-700 dark:text-neutral-300 hover:border-[#5C6BC0] hover:text-[#5C6BC0] dark:hover:text-[#7986CB] transition-colors"
                    >
                      {fmt}
                    </button>
                  ))}
                </div>
              </div>

              {/* Right Sub-column: Common Conversion Types */}
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-2.5">
                  Common Conversion Types
                </div>
                <div className="space-y-2">
                  {activeCat.commonConversions.map((conv, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => {
                        onSelectPreset?.(conv.from.toLowerCase(), conv.to.toLowerCase());
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                      className="w-full text-left p-2 rounded-lg bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-white/10 hover:border-[#5C6BC0] transition-colors group"
                    >
                      <div className="flex items-center gap-1.5 text-xs font-bold text-neutral-900 dark:text-white group-hover:text-[#5C6BC0] dark:group-hover:text-[#7986CB]">
                        <span>{conv.from}</span>
                        <ArrowRight className="w-3 h-3 text-neutral-400 group-hover:text-[#5C6BC0] dark:group-hover:text-[#7986CB]" />
                        <span>{conv.to}</span>
                      </div>
                      <div className="text-[11px] text-neutral-500 dark:text-neutral-400 truncate">
                        {conv.desc}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Data Security */}
          <div className="space-y-4">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-lg bg-[#5C6BC0]/10 text-[#5C6BC0]">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <h2 className="text-2xl font-bold tracking-tight text-neutral-900 dark:text-white">
                Data Security
              </h2>
            </div>

            <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
              Files are processed for the conversion job you request, then removed after processing.
              The security model is documented and backed by certification.
            </p>

            {/* 3 Pillars List layout */}
            <ul className="space-y-3.5 pt-2">
              <li className="flex items-start gap-3">
                <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#5C6BC0]/10 text-[#5C6BC0] border border-[#5C6BC0]/20">
                  <Lock className="w-4 h-4" />
                </span>
                <div className="text-sm leading-snug">
                  <strong className="font-semibold text-neutral-900 dark:text-white">
                    Certification:
                  </strong>{' '}
                  <span className="text-neutral-600 dark:text-neutral-400">
                    information security management audited by independent assessors with strict zero-footprint controls.
                  </span>
                </div>
              </li>

              <li className="flex items-start gap-3">
                <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#5C6BC0]/10 text-[#5C6BC0] border border-[#5C6BC0]/20">
                  <Trash2 className="w-4 h-4" />
                </span>
                <div className="text-sm leading-snug">
                  <strong className="font-semibold text-neutral-900 dark:text-white">
                    Automatic deletion:
                  </strong>{' '}
                  <span className="text-neutral-600 dark:text-neutral-400">
                    files are removed strictly after processing according to volatile memory zero-retention policy.
                  </span>
                </div>
              </li>

              <li className="flex items-start gap-3">
                <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#5C6BC0]/10 text-[#5C6BC0] border border-[#5C6BC0]/20">
                  <Handshake className="w-4 h-4" />
                </span>
                <div className="text-sm leading-snug">
                  <strong className="font-semibold text-neutral-900 dark:text-white">
                    Business model:
                  </strong>{' '}
                  <span className="text-neutral-600 dark:text-neutral-400">
                    EasyConvert does not sell customer file data nor mine any data from your private documents.
                  </span>
                </div>
              </li>
            </ul>

            <div className="pt-2">
              <a
                href="#security"
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#5C6BC0] dark:text-[#7986CB] hover:underline"
              >
                <span>Read the security overview</span>
                <ArrowRight className="w-4 h-4" />
              </a>
            </div>
          </div>
        </div>

        {/* ROW 2: API & Integrations (Left) + High-Quality Conversions (Right) */}
        <div id="api-section" className="pt-12 border-t border-neutral-200 dark:border-white/10 grid gap-12 lg:grid-cols-2 lg:gap-16 items-start">
          {/* Left Column: API & Integrations */}
          <div className="space-y-4">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-lg bg-[#5C6BC0]/10 text-[#5C6BC0]">
                <Terminal className="w-5 h-5" />
              </div>
              <h3 className="text-xl sm:text-2xl font-bold tracking-tight text-neutral-900 dark:text-white">
                API &amp; Integrations
              </h3>
            </div>

            <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
              Build jobs from import, convert and export tasks, then connect them to your own storage and
              application logic. Usage-based pricing and volume discounts are available for production workloads.{' '}
              <a
                href="/api/formats"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-semibold text-[#5C6BC0] dark:text-[#7986CB] hover:underline"
              >
                <span>Explore the API</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </a>
            </p>

            {/* Code Box */}
            <div className="overflow-hidden rounded-xl border border-neutral-300 dark:border-white/10 bg-neutral-900 shadow-sm font-mono text-xs text-neutral-300">
              <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-3.5 py-2 text-[11px] text-neutral-400 uppercase tracking-wider">
                <span>POST /v2/jobs</span>
                <span className="text-[10px] text-neutral-500">JSON</span>
              </div>
              <pre className="overflow-x-auto p-4 leading-relaxed text-neutral-300">
                <code>{`{
  "tasks": {
    "import-1": {
      "operation": "import/url",
      "url": "https://example.com/file.pdf"
    },
    "convert-1": {
      "operation": "convert",
      "input": "import-1",
      "output_format": "docx"
    },
    "export-1": {
      "operation": "export/url",
      "input": "convert-1"
    }
  }
}`}</code>
              </pre>
            </div>
          </div>

          {/* Right Column: High-Quality Conversions */}
          <div className="space-y-4">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-lg bg-[#5C6BC0]/10 text-[#5C6BC0]">
                <FileCheck2 className="w-5 h-5" />
              </div>
              <h3 className="text-xl sm:text-2xl font-bold tracking-tight text-neutral-900 dark:text-white">
                High-Quality Conversions
              </h3>
            </div>

            <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
              The available options change with the selected operation, so image, document, video and audio
              jobs expose the controls that matter for that output.
            </p>

            <ul className="space-y-3.5 pt-2">
              <li className="flex items-start gap-3 text-sm text-neutral-700 dark:text-neutral-300">
                <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#5C6BC0]/10 text-[#5C6BC0] border border-[#5C6BC0]/20">
                  <Cpu className="w-4 h-4" />
                </span>
                <span className="leading-snug">
                  Vendor engines and open-source converters selected per file type
                </span>
              </li>

              <li className="flex items-start gap-3 text-sm text-neutral-700 dark:text-neutral-300">
                <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#5C6BC0]/10 text-[#5C6BC0] border border-[#5C6BC0]/20">
                  <Sliders className="w-4 h-4" />
                </span>
                <span className="leading-snug">
                  Per-conversion controls for codec, bitrate, resolution and quality
                </span>
              </li>

              <li className="flex items-start gap-3 text-sm text-neutral-700 dark:text-neutral-300">
                <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#5C6BC0]/10 text-[#5C6BC0] border border-[#5C6BC0]/20">
                  <CheckCircle2 className="w-4 h-4" />
                </span>
                <span className="leading-snug">
                  Color-accurate, font-faithful output for documents and images
                </span>
              </li>
            </ul>
          </div>
        </div>

        {/* ROW 3: Stats Banner */}
        <div className="pt-10 pb-4 border-t border-neutral-200 dark:border-white/10 text-center">
          <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-neutral-400 dark:text-neutral-500">
            <span>Trusted since 2026</span>
          </div>
          <p className="mt-2 text-base font-medium text-neutral-600 dark:text-neutral-400">
            Files converted — of data processed — and counting.
          </p>
        </div>
      </div>
    </section>
  );
}
