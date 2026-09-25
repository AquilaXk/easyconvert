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
    <section id="format-catalog" className="relative isolate mx-auto max-w-7xl px-6 lg:px-8 py-16 transition-colors">
      <div className="space-y-12">
        {/* ROW 1: Format Catalog (Left) + Data Security (Right) */}
        <div className="grid gap-12 lg:grid-cols-3 lg:gap-16 items-start">
          {/* Left Column: Format Catalog (2 cols on large screen) */}
          <div className="space-y-4 lg:col-span-2">
            <div className="flex items-center gap-2 text-lg font-semibold tracking-tight text-neutral-900 dark:text-white sm:text-xl">
              <svg className="size-3.5 text-[#5C6BC0]" viewBox="0 0 512 512" fill="currentColor">
                <path d="M256 0c11.2 0 21.7 5.9 27.4 15.5l96 160c5.9 9.9 6.1 22.2 .4 32.2S363.5 224 352 224l-192 0c-11.5 0-22.2-6.2-27.8-16.2s-5.5-22.3 .4-32.2l96-160C234.3 5.9 244.8 0 256 0zM128 272a112 112 0 1 1 0 224 112 112 0 1 1 0-224zm200 16l112 0c22.1 0 40 17.9 40 40l0 112c0 22.1-17.9 40-40 40l-112 0c-22.1 0-40-17.9-40-40l0-112c0-22.1 17.9-40 40-40z" />
              </svg>
              <span>Format Catalog</span>
            </div>

            <p className="mt-3 max-w-xl text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
              EasyConvert handles <span className="tabular-nums font-semibold">212</span> formats across 11 categories, from common office files to camera RAW, CAD drawings, archives, ebooks and production media.
            </p>

            {/* Category Buttons Grid: Clean Borderless Inline */}
            <div className="mt-5 flex flex-wrap gap-x-3 gap-y-1.5 pt-1">
              {categories.map((cat) => {
                const isSelected = selectedCategory === cat.id;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setSelectedCategory(cat.id)}
                    className={`group/g inline-flex items-center gap-1.5 py-1 text-left text-xs transition-colors cursor-pointer ${
                      isSelected
                        ? 'text-[#5C6BC0] dark:text-[#949FE8] font-semibold'
                        : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'
                    }`}
                  >
                    <span className={isSelected ? 'text-[#5C6BC0]' : 'text-neutral-400 dark:text-neutral-500 group-hover/g:text-neutral-300'}>
                      {cat.icon}
                    </span>
                    <span className="font-medium">{cat.name}</span>
                    <span className="font-mono text-[10px] tabular-nums text-neutral-400 dark:text-neutral-500">
                      {cat.count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Sub-panel: Formats listed + Common Conversion Types */}
            <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-800 grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Left Sub-column: Formats Listed */}
              <div>
                <div className="flex items-center justify-between text-[11px] font-mono uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-2.5">
                  <span>{activeCat.name} Formats</span>
                  <span className="tabular-nums">{activeCat.formats.length} listed</span>
                </div>
                <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto pr-1">
                  {activeCat.formats.map((fmt) => (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => {
                        onSelectPreset?.(fmt.toLowerCase(), 'pdf');
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                      className="inline-flex items-center bg-white dark:bg-[#212529] hover:bg-neutral-100 dark:hover:bg-neutral-800 border border-neutral-200 dark:border-neutral-700/80 hover:border-[#5C6BC0] dark:hover:border-[#5C6BC0] px-2 py-1 font-mono text-[11px] uppercase tracking-wide text-neutral-800 dark:text-neutral-200 hover:text-[#5C6BC0] dark:hover:text-[#949FE8] transition-colors rounded-sm"
                    >
                      {fmt}
                    </button>
                  ))}
                </div>
              </div>

              {/* Right Sub-column: Common Conversion Types */}
              <div className="border-t border-neutral-200 dark:border-neutral-800 pt-4 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
                <div className="text-[11px] font-mono uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-2.5">
                  Common conversion types
                </div>
                <div className="space-y-2.5">
                  {activeCat.commonConversions.map((conv, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => {
                        onSelectPreset?.(conv.from.toLowerCase(), conv.to.toLowerCase());
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                      className="block text-left text-neutral-600 dark:text-neutral-400 hover:text-[#5C6BC0] dark:hover:text-[#949FE8] transition-colors group w-full"
                    >
                      <div className="flex items-center gap-1.5 font-mono text-xs text-neutral-900 dark:text-white group-hover:text-[#5C6BC0] dark:group-hover:text-[#949FE8]">
                        <span>{conv.from}</span>
                        <ArrowRight className="size-3 text-neutral-400 group-hover:text-[#5C6BC0]" />
                        <span>{conv.to}</span>
                      </div>
                      <div className="text-[11px] text-neutral-500 dark:text-neutral-400 truncate mt-0.5">
                        {conv.desc}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Data Security (1 col on large screen) */}
          <div className="space-y-4 lg:col-span-1">
            <div className="flex items-center gap-2 text-lg font-semibold tracking-tight text-neutral-900 dark:text-white sm:text-xl">
              <svg className="size-3.5 text-[#5C6BC0]" viewBox="0 0 512 512" fill="currentColor">
                <path d="M256.1 0c4.6 0 9.2 1 13.3 2.9L457.8 82.8c22 9.3 38.4 31 38.3 57.2-.5 99.2-41.3 280.7-213.7 363.2-16.7 8-36.1 8-52.7 0-172.4-82.5-213.1-263.9-213.6-363.2-.1-26.2 16.3-47.9 38.3-57.2L242.7 2.9C246.8 1 251.4 0 256.1 0zm90.9 164.6c-10.7-7.8-25.7-5.4-33.5 5.3l-85.6 117.7-26.5-27.4c-9.2-9.5-24.4-9.8-33.9-.6-9.5 9.2-9.8 24.4-.6 33.9l46.4 48c4.9 5.1 11.8 7.8 18.9 7.3s13.6-4.1 17.8-9.8L352.3 198.1c7.8-10.7 5.4-25.7-5.3-33.5z" />
              </svg>
              <span>Data Security</span>
            </div>

            <p className="mt-3 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
              Files are processed for the conversion job you request, then removed after processing. The security model is documented and backed by certification.
            </p>

            <ul className="mt-5 space-y-3">
              <li className="flex items-start gap-3 text-sm text-neutral-600 dark:text-neutral-400">
                <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-[#5C6BC0]/10 text-[#5C6BC0]">
                  <Lock className="size-3.5" />
                </span>
                <span className="leading-snug">
                  <span className="font-medium text-neutral-900 dark:text-white">Certification:</span> information security management audited by independent assessors
                </span>
              </li>

              <li className="flex items-start gap-3 text-sm text-neutral-600 dark:text-neutral-400">
                <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-[#5C6BC0]/10 text-[#5C6BC0]">
                  <Trash2 className="size-3.5" />
                </span>
                <span className="leading-snug">
                  <span className="font-medium text-neutral-900 dark:text-white">Automatic deletion:</span> files are removed after processing according to the retention policy
                </span>
              </li>

              <li className="flex items-start gap-3 text-sm text-neutral-600 dark:text-neutral-400">
                <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-[#5C6BC0]/10 text-[#5C6BC0]">
                  <Handshake className="size-3.5" />
                </span>
                <span className="leading-snug">
                  <span className="font-medium text-neutral-900 dark:text-white">Business model:</span> EasyConvert does not sell customer file data nor mine any data from it
                </span>
              </li>
            </ul>

            <div className="pt-2">
              <a
                href="/security"
                className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-[#5C6BC0] hover:underline"
              >
                <span>Read the security overview</span>
                <ArrowRight className="size-3" />
              </a>
            </div>
          </div>
        </div>

        {/* Separator between rows */}
        <div className="mx-auto my-12 max-w-3xl px-2">
          <div className="h-px bg-gradient-to-r from-transparent via-neutral-300 dark:via-neutral-700/60 to-transparent" />
        </div>

        {/* ROW 2: API & Integrations (Left) + High-Quality Conversions (Right) */}
        <div id="api-section" className="grid gap-12 lg:grid-cols-3 lg:gap-16 items-start">
          {/* Left Column: API & Integrations */}
          <div className="space-y-4 lg:col-span-2">
            <div className="flex items-center gap-2 text-lg font-semibold tracking-tight text-neutral-900 dark:text-white sm:text-xl">
              <svg className="size-3.5 text-[#5C6BC0]" viewBox="0 0 512 512" fill="currentColor">
                <path d="M9.4 118.6c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0l160 160c12.5 12.5 12.5 32.8 0 45.3l-160 160c-12.5 12.5-32.8 12.5-45.3 0s-12.5-32.8 0-45.3L146.7 256 9.4 118.6zM224 384l256 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-256 0c-17.7 0-32-14.3-32-32s14.3-32 32-32z" />
              </svg>
              <span>API &amp; Integrations</span>
            </div>

            <p className="mt-3 max-w-xl text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
              Build jobs from import, convert and export tasks, then connect them to your own storage and application logic. Usage-based pricing and volume discounts are available for production workloads.{' '}
              <a
                href="/api/v2"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-[#5C6BC0] hover:underline"
              >
                <span>Explore the API</span>
                <ArrowRight className="size-3" />
              </a>
            </p>

            {/* Code Box for API integration */}
            <div className="relative my-5 group">
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(`{\n  "tasks": {\n    "import-1": {\n      "operation": "import/url",\n      "url": "https://example.com/file.pdf"\n    },\n    "convert-1": {\n      "operation": "convert",\n      "input": "import-1",\n      "output_format": "docx"\n    },\n    "export-1": {\n      "operation": "export/url",\n      "input": "convert-1"\n    }\n  }\n}`);
                }}
                title="Copy to clipboard"
                aria-label="Copy to clipboard"
                className="absolute top-2.5 right-2.5 inline-flex items-center rounded-md border border-neutral-200 dark:border-neutral-700 bg-white/90 dark:bg-neutral-800/90 px-2 py-1 text-xs text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white opacity-80 hover:opacity-100 transition shadow-xs cursor-pointer z-10"
              >
                <svg className="size-3.5 fill-current mr-1" viewBox="0 0 448 512">
                  <path d="M192 0c-35.3 0-64 28.7-64 64l0 256c0 35.3 28.7 64 64 64l192 0c35.3 0 64-28.7 64-64l0-200.6c0-17.4-7.1-34.1-19.7-46.2L370.6 17.8C358.7 6.4 342.8 0 326.3 0L192 0zM64 128c-35.3 0-64 28.7-64 64L0 448c0 35.3 28.7 64 64 64l192 0c35.3 0 64-28.7 64-64l0-16-64 0 0 16-192 0 0-256 16 0 0-64-16 0z" />
                </svg>
                Copy
              </button>
              <pre className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800 bg-[#f8f9fa] dark:bg-[#18191d] p-4 text-xs font-mono leading-relaxed text-neutral-800 dark:text-neutral-200">
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
          <div className="space-y-4 lg:col-span-1">
            <div className="flex items-center gap-2 text-lg font-semibold tracking-tight text-neutral-900 dark:text-white sm:text-xl">
              <svg className="size-3.5 text-[#5C6BC0]" viewBox="0 0 576 512" fill="currentColor">
                <path d="M96 0C60.7 0 32 28.7 32 64l0 384c0 35.3 28.7 64 64 64l180 0c-22.7-31.5-36-70.2-36-112 0-100.6 77.4-183.2 176-191.3l0-38.1c0-17.7-6.7-33.3-18.7-45.3L290.7 18.7C278.7 6.7 262.5 0 245.5 0L96 0zM357.5 176L264 176c-13.3 0-24-10.7-24-24L240 58.5 357.5 176zM576 400a144 144 0 1 0 -288 0 144 144 0 1 0 288 0zm-86.6-60.9c7.1 5.2 8.7 15.2 3.5 22.3l-64 88c-2.8 3.8-7 6.2-11.7 6.5s-9.3-1.3-12.6-4.6l-40-40c-6.2-6.2-6.2-16.4 0-22.6s16.4-6.2 22.6 0l26.8 26.8 53-72.9c5.2-7.1 15.2-8.7 22.4-3.5z" />
              </svg>
              <span>High-Quality Conversions</span>
            </div>

            <p className="mt-3 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
              The available options change with the selected operation, so image, document, video and audio jobs expose the controls that matter for that output.
            </p>

            <ul className="mt-5 space-y-3">
              <li className="flex items-start gap-3 text-sm text-neutral-600 dark:text-neutral-400">
                <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-[#5C6BC0]/10 text-[#5C6BC0]">
                  <Cpu className="size-3.5" />
                </span>
                <span className="leading-snug">
                  Vendor engines and open-source converters selected per file type
                </span>
              </li>

              <li className="flex items-start gap-3 text-sm text-neutral-600 dark:text-neutral-400">
                <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-[#5C6BC0]/10 text-[#5C6BC0]">
                  <Sliders className="size-3.5" />
                </span>
                <span className="leading-snug">
                  Per-conversion controls for codec, bitrate, resolution and quality
                </span>
              </li>

              <li className="flex items-start gap-3 text-sm text-neutral-600 dark:text-neutral-400">
                <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-[#5C6BC0]/10 text-[#5C6BC0]">
                  <CheckCircle2 className="size-3.5" />
                </span>
                <span className="leading-snug">
                  Color-accurate, font-faithful output for documents and images
                </span>
              </li>
            </ul>
          </div>
        </div>

        {/* ROW 3: Stats Header */}
        <header className="px-2 pt-8 text-center">
          <div className="mx-auto max-w-3xl">
            <div className="inline-flex items-center gap-3 text-[11px] font-medium uppercase tracking-[0.18em] text-neutral-400 dark:text-neutral-500">
              <span>Trusted since 2012</span>
            </div>
            <p className="mx-auto mt-2 max-w-xl text-base leading-relaxed text-neutral-600 dark:text-neutral-400">
              <strong className="font-semibold text-neutral-900 dark:text-white tabular-nums">2,420,185,920</strong> files converted — <strong className="font-semibold text-neutral-900 dark:text-white tabular-nums">19,425 TB</strong> of data processed — and counting.
            </p>
          </div>
          <div className="mx-auto mt-10 max-w-3xl">
            <div className="h-px bg-gradient-to-r from-transparent via-neutral-300 dark:via-neutral-700/60 to-transparent" />
          </div>
        </header>
      </div>
    </section>
  );
}
