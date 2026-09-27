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
      count: 40,
      icon: <FileText className="w-3.5 h-3.5" />,
      formats: [
        'ABW', 'AZW4', 'DJVU', 'DOC', 'DOCM', 'DOCX', 'DOT', 'DOTX', 'EPUB', 'HTML', 'HWP', 'HWPX',
        'LWP', 'MD', 'ODT', 'PAGES', 'PDF', 'RST', 'RTF', 'SDW', 'TEX', 'TXT', 'WPD', 'WPS', 'XPS', 'ZABW',
      ],
      commonConversions: [
        { from: 'PDF', to: 'DOCX', desc: 'editable Word document' },
        { from: 'DOCX', to: 'PDF', desc: 'print-ready PDF' },
        { from: 'HWP', to: 'PDF', desc: 'Korean office document' },
      ],
    },
    {
      id: 'images',
      name: 'Images',
      count: 49,
      icon: <FileImage className="w-3.5 h-3.5" />,
      formats: [
        '3FR', 'ARW', 'AVIF', 'BMP', 'CR2', 'CRW', 'DNG', 'EPS', 'GIF', 'HEIC', 'ICO', 'ICNS',
        'JPEG', 'JPG', 'NEF', 'PNG', 'PSD', 'RAF', 'RAW', 'RW2', 'SVG', 'TIF', 'TIFF', 'WEBP',
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
      count: 38,
      icon: <Video className="w-3.5 h-3.5" />,
      formats: [
        '3GP', 'AVI', 'FLV', 'M4V', 'MKV', 'MOV', 'MP4', 'MPEG', 'OGV', 'TS', 'VOB', 'WEBM', 'WMV',
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
      count: 29,
      icon: <Music className="w-3.5 h-3.5" />,
      formats: [
        'AAC', 'AC3', 'AIFF', 'AMR', 'FLAC', 'M4A', 'MID', 'MP3', 'OGG', 'OPUS', 'WAV', 'WMA',
      ],
      commonConversions: [
        { from: 'WAV', to: 'MP3', desc: 'compressed 320 kbps stream' },
        { from: 'FLAC', to: 'MP3', desc: 'lossless to universal audio' },
        { from: 'M4A', to: 'WAV', desc: 'uncompressed audio stream' },
      ],
    },
    {
      id: 'spreadsheets',
      name: 'Spreadsheets',
      count: 18,
      icon: <Database className="w-3.5 h-3.5" />,
      formats: ['CSV', 'ET', 'JSON', 'NUMBERS', 'ODS', 'TSV', 'XLS', 'XLSB', 'XLSM', 'XLSX', 'XML'],
      commonConversions: [
        { from: 'XLSX', to: 'CSV', desc: 'comma-delimited data' },
        { from: 'CSV', to: 'JSON', desc: 'structured records' },
        { from: 'XLSX', to: 'PDF', desc: 'formatted report' },
      ],
    },
    {
      id: 'slides',
      name: 'Slides',
      count: 18,
      icon: <Presentation className="w-3.5 h-3.5" />,
      formats: ['DPS', 'KEY', 'ODP', 'POT', 'POTX', 'PPS', 'PPSX', 'PPT', 'PPTX', 'SXI', 'VSDX'],
      commonConversions: [
        { from: 'PPTX', to: 'PDF', desc: 'printable slide deck' },
        { from: 'PPTX', to: 'HTML', desc: 'interactive presentation' },
        { from: 'ODP', to: 'PPTX', desc: 'PowerPoint compatibility' },
      ],
    },
    {
      id: 'ebooks',
      name: 'E-books',
      count: 24,
      icon: <BookOpen className="w-3.5 h-3.5" />,
      formats: ['AZW', 'AZW3', 'CBZ', 'CBR', 'EPUB', 'FB2', 'LIT', 'LRF', 'MOBI', 'PDB', 'TCR'],
      commonConversions: [
        { from: 'EPUB', to: 'PDF', desc: 'printable book pages' },
        { from: 'MOBI', to: 'EPUB', desc: 'open standard reader' },
        { from: 'FB2', to: 'TXT', desc: 'plain text transcript' },
      ],
    },
    {
      id: 'archives',
      name: 'Archives',
      count: 41,
      icon: <Archive className="w-3.5 h-3.5" />,
      formats: ['7Z', 'ACE', 'ARJ', 'BZ2', 'CAB', 'GZ', 'ISO', 'RAR', 'TAR', 'TBZ2', 'TGZ', 'XZ', 'Z', 'ZIP'],
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
      count: 9,
      icon: <Compass className="w-3.5 h-3.5" />,
      formats: ['DGN', 'DWF', 'DWG', 'DXF', 'IGES', 'OBJ', 'PLY', 'STEP', 'STL'],
      commonConversions: [
        { from: 'DWG', to: 'PDF', desc: 'printable technical drawing' },
        { from: 'STEP', to: 'STL', desc: '3D printing mesh' },
        { from: 'DXF', to: 'SVG', desc: 'scalable CAD vector' },
      ],
    },
    {
      id: 'fonts',
      name: 'Fonts',
      count: 10,
      icon: <Type className="w-3.5 h-3.5" />,
      formats: ['EOT', 'OTF', 'PFA', 'PFB', 'SVG', 'TTF', 'WOFF', 'WOFF2'],
      commonConversions: [
        { from: 'TTF', to: 'WOFF2', desc: 'modern optimized web font' },
        { from: 'OTF', to: 'TTF', desc: 'TrueType desktop font' },
      ],
    },
    {
      id: 'data',
      name: 'Data',
      count: 9,
      icon: <Database className="w-3.5 h-3.5" />,
      formats: ['CSV', 'JSON', 'JSONL', 'NDJSON', 'PLIST', 'SQL', 'TOML', 'TSV', 'YAML'],
      commonConversions: [
        { from: 'CSV', to: 'JSON', desc: 'structured records' },
        { from: 'YAML', to: 'JSON', desc: 'parse config data' },
        { from: 'JSON', to: 'CSV', desc: 'tabular export' },
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
              EasyConvert handles <span className="tabular-nums font-semibold">292</span> formats across 12 categories, from common office files to camera RAW, CAD drawings, archives, ebooks and production media.
            </p>

            {/* Category Buttons Grid: Clean Tactile Inline */}
            <div className="mt-5 flex flex-wrap gap-2 pt-1">
              {categories.map((cat) => {
                const isSelected = selectedCategory === cat.id;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setSelectedCategory(cat.id)}
                    className={`group/g inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-left text-xs transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-brand-700/15 text-brand-700 dark:text-brand-300 font-semibold border border-brand-500/30 shadow-sm'
                        : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-white/[0.04]'
                    }`}
                  >
                    <span className={isSelected ? 'text-brand-700 dark:text-brand-300' : 'text-neutral-400 dark:text-neutral-500 group-hover/g:text-neutral-300'}>
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
                      className="inline-flex items-center bg-white dark:bg-[#1A2035] hover:bg-brand-50 dark:hover:bg-brand-700/20 border border-neutral-200 dark:border-[#2B3556] hover:border-brand-700 dark:hover:border-brand-400 px-2.5 py-1 font-mono text-[11px] uppercase tracking-wide text-neutral-800 dark:text-neutral-200 hover:text-brand-700 dark:hover:text-brand-300 transition-colors rounded-lg shadow-sm"
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

        {/* ROW 2: How It Works (3 Steps) */}
        <div id="how-it-works" className="space-y-8 pt-4">
          <div className="text-center max-w-2xl mx-auto">
            <span className="text-[11px] font-bold uppercase tracking-wider text-[#5C6BC0] dark:text-[#949FE8]">
              Simple &amp; Fast Process
            </span>
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-neutral-900 dark:text-white mt-1">
              How to Convert Files in 3 Steps
            </h2>
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
              Convert your documents, media, and archives in seconds with zero complicated settings.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Step 1 */}
            <div className="rounded-3xl border border-neutral-border dark:border-[#2B3556] bg-white dark:bg-[#151A2E] p-6 sm:p-7 shadow-sm flex flex-col items-start gap-4">
              <div className="size-10 rounded-xl bg-[#5C6BC0]/10 text-[#5C6BC0] flex items-center justify-center font-bold text-base">
                1
              </div>
              <div>
                <h3 className="text-base font-bold text-neutral-900 dark:text-white">Choose Files</h3>
                <p className="mt-1.5 text-xs sm:text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed">
                  Select files from your device, drag and drop into the dropzone, or import directly from URL and cloud drives.
                </p>
              </div>
            </div>

            {/* Step 2 */}
            <div className="rounded-3xl border border-neutral-border dark:border-[#2B3556] bg-white dark:bg-[#151A2E] p-6 sm:p-7 shadow-sm flex flex-col items-start gap-4">
              <div className="size-10 rounded-xl bg-[#5C6BC0]/10 text-[#5C6BC0] flex items-center justify-center font-bold text-base">
                2
              </div>
              <div>
                <h3 className="text-base font-bold text-neutral-900 dark:text-white">Select Format</h3>
                <p className="mt-1.5 text-xs sm:text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed">
                  Pick your desired output format from 290+ supported standards. Customize optional quality or resolution settings.
                </p>
              </div>
            </div>

            {/* Step 3 */}
            <div className="rounded-3xl border border-neutral-border dark:border-[#2B3556] bg-white dark:bg-[#151A2E] p-6 sm:p-7 shadow-sm flex flex-col items-start gap-4">
              <div className="size-10 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center font-bold text-base">
                3
              </div>
              <div>
                <h3 className="text-base font-bold text-neutral-900 dark:text-white">Download Result</h3>
                <p className="mt-1.5 text-xs sm:text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed">
                  Click Convert and download your converted files immediately or save all items together as a clean ZIP package.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Separator between rows */}
        <div className="mx-auto my-12 max-w-3xl px-2">
          <div className="h-px bg-gradient-to-r from-transparent via-neutral-300 dark:via-neutral-700/60 to-transparent" />
        </div>

        {/* ROW 3: High-Quality Conversions & Zero-Retention Security Highlights */}
        <div id="features" className="grid gap-8 md:grid-cols-2 lg:gap-12 items-start">
          <div className="rounded-3xl border border-neutral-border dark:border-[#2B3556] bg-white dark:bg-[#151A2E] p-6 sm:p-8 shadow-sm space-y-4">
            <div className="flex items-center gap-2 text-lg font-semibold tracking-tight text-neutral-900 dark:text-white">
              <svg className="size-4 text-[#5C6BC0]" viewBox="0 0 576 512" fill="currentColor">
                <path d="M96 0C60.7 0 32 28.7 32 64l0 384c0 35.3 28.7 64 64 64l180 0c-22.7-31.5-36-70.2-36-112 0-100.6 77.4-183.2 176-191.3l0-38.1c0-17.7-6.7-33.3-18.7-45.3L290.7 18.7C278.7 6.7 262.5 0 245.5 0L96 0zM357.5 176L264 176c-13.3 0-24-10.7-24-24L240 58.5 357.5 176zM576 400a144 144 0 1 0 -288 0 144 144 0 1 0 288 0zm-86.6-60.9c7.1 5.2 8.7 15.2 3.5 22.3l-64 88c-2.8 3.8-7 6.2-11.7 6.5s-9.3-1.3-12.6-4.6l-40-40c-6.2-6.2-6.2-16.4 0-22.6s16.4-6.2 22.6 0l26.8 26.8 53-72.9c5.2-7.1 15.2-8.7 22.4-3.5z" />
              </svg>
              <span>High-Fidelity Engine</span>
            </div>
            <p className="text-xs sm:text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed">
              Every conversion is processed using high-precision encoders to guarantee font accuracy, correct color matrices, vector clarity, and exact table formatting.
            </p>
            <ul className="space-y-2 text-xs sm:text-sm text-neutral-600 dark:text-neutral-400">
              <li className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-emerald-500 shrink-0" />
                <span>Lossless and high-bitrate media transcoding</span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-emerald-500 shrink-0" />
                <span>Preserves complex OpenXML layouts and formulas</span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-emerald-500 shrink-0" />
                <span>Multi-lingual OCR recognition and sandwich PDFs</span>
              </li>
            </ul>
          </div>

          <div className="rounded-3xl border border-neutral-border dark:border-[#2B3556] bg-white dark:bg-[#151A2E] p-6 sm:p-8 shadow-sm space-y-4">
            <div className="flex items-center gap-2 text-lg font-semibold tracking-tight text-neutral-900 dark:text-white">
              <ShieldCheck className="size-4 text-emerald-500" />
              <span>100% Free &amp; Private</span>
            </div>
            <p className="text-xs sm:text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed">
              No credit cards, subscription fees, or hidden payment walls. EasyConvert runs directly in your browser with complete privacy.
            </p>
            <ul className="space-y-2 text-xs sm:text-sm text-neutral-600 dark:text-neutral-400">
              <li className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-emerald-500 shrink-0" />
                <span>Zero server file retention &amp; memory-only processing</span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-emerald-500 shrink-0" />
                <span>Unlimited free conversions for all users</span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-emerald-500 shrink-0" />
                <span>No registration or personal information required</span>
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
