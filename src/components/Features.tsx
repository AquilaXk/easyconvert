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
  Sparkles,
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
    <div className="space-y-16 py-12 md:py-16">
      {/* 1. Universal Core Advantages Grid */}
      <section className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-3xl mx-auto mb-12">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-brand-500/10 text-brand-700 dark:text-brand-300 border border-brand-400/20 mb-3">
            <Sparkles className="size-3.5" />
            <span>Modern In-Browser Conversion</span>
          </span>
          <h2 className="text-2xl sm:text-3xl lg:text-4xl font-black tracking-tight text-brand-950 dark:text-white">
            Why Choose EasyConvert?
          </h2>
          <p className="mt-3 text-sm sm:text-base text-ink-secondary dark:text-neutral-300 leading-relaxed">
            The fast, client-side conversion engine designed for universal file transformation with zero server retention.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {/* Advantage 1: 300+ Formats */}
          <div className="rounded-3xl border border-neutral-border dark:border-[#2B3556] bg-white dark:bg-[#151A2E] p-6 sm:p-7 shadow-sm hover:border-brand-400 dark:hover:border-brand-500/60 transition-all flex flex-col justify-between">
            <div>
              <div className="size-11 rounded-2xl bg-brand-50 dark:bg-brand-900/40 border border-brand-200/80 dark:border-brand-700/40 text-brand-700 dark:text-brand-300 flex items-center justify-center mb-5 shadow-sm">
                <FolderTree className="size-5" />
              </div>
              <h3 className="text-lg font-bold text-brand-950 dark:text-white">
                300+ Formats Supported
              </h3>
              <p className="mt-2 text-xs sm:text-sm text-ink-secondary dark:text-neutral-300 leading-relaxed">
                Universal conversion across audio, video, documents, images, ebooks, archives, presentations, CAD, and vector files.
              </p>
            </div>
            <div className="mt-4 pt-3 border-t border-neutral-100 dark:border-[#242C48] flex items-center gap-1.5 text-xs font-semibold text-brand-700 dark:text-brand-300">
              <CheckCircle2 className="size-3.5 text-emerald-500" />
              <span>Full cross-format matrix</span>
            </div>
          </div>

          {/* Advantage 2: 100% In-Browser Privacy */}
          <div className="rounded-3xl border border-neutral-border dark:border-[#2B3556] bg-white dark:bg-[#151A2E] p-6 sm:p-7 shadow-sm hover:border-brand-400 dark:hover:border-brand-500/60 transition-all flex flex-col justify-between">
            <div>
              <div className="size-11 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-700/40 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mb-5 shadow-sm">
                <ShieldCheck className="size-5" />
              </div>
              <h3 className="text-lg font-bold text-brand-950 dark:text-white">
                100% In-Browser Privacy
              </h3>
              <p className="mt-2 text-xs sm:text-sm text-ink-secondary dark:text-neutral-300 leading-relaxed">
                Zero server uploads. Conversions execute strictly inside your local browser sandbox via WebAssembly. Your files never leave your device.
              </p>
            </div>
            <div className="mt-4 pt-3 border-t border-neutral-100 dark:border-[#242C48] flex items-center gap-1.5 text-xs font-semibold text-brand-700 dark:text-brand-300">
              <CheckCircle2 className="size-3.5 text-emerald-500" />
              <span>Zero server retention guaranteed</span>
            </div>
          </div>

          {/* Advantage 3: Instant Local Processing */}
          <div className="rounded-3xl border border-neutral-border dark:border-[#2B3556] bg-white dark:bg-[#151A2E] p-6 sm:p-7 shadow-sm hover:border-brand-400 dark:hover:border-brand-500/60 transition-all flex flex-col justify-between">
            <div>
              <div className="size-11 rounded-2xl bg-brand-50 dark:bg-brand-900/40 border border-brand-200/80 dark:border-brand-700/40 text-brand-700 dark:text-brand-300 flex items-center justify-center mb-5 shadow-sm">
                <Cpu className="size-5" />
              </div>
              <h3 className="text-lg font-bold text-brand-950 dark:text-white">
                Blazing Fast Local Engine
              </h3>
              <p className="mt-2 text-xs sm:text-sm text-ink-secondary dark:text-neutral-300 leading-relaxed">
                Zero network upload delays or server waiting queues. Multi-threaded processing takes direct advantage of your hardware.
              </p>
            </div>
            <div className="mt-4 pt-3 border-t border-neutral-100 dark:border-[#242C48] flex items-center gap-1.5 text-xs font-semibold text-brand-700 dark:text-brand-300">
              <CheckCircle2 className="size-3.5 text-emerald-500" />
              <span>Hardware-accelerated speed</span>
            </div>
          </div>

          {/* Advantage 4: Custom Settings & Quality Tuning */}
          <div className="rounded-3xl border border-neutral-border dark:border-[#2B3556] bg-white dark:bg-[#151A2E] p-6 sm:p-7 shadow-sm hover:border-brand-400 dark:hover:border-brand-500/60 transition-all flex flex-col justify-between">
            <div>
              <div className="size-11 rounded-2xl bg-brand-50 dark:bg-brand-900/40 border border-brand-200/80 dark:border-brand-700/40 text-brand-700 dark:text-brand-300 flex items-center justify-center mb-5 shadow-sm">
                <Sliders className="size-5" />
              </div>
              <h3 className="text-lg font-bold text-brand-950 dark:text-white">
                Granular Custom Settings
              </h3>
              <p className="mt-2 text-xs sm:text-sm text-ink-secondary dark:text-neutral-300 leading-relaxed">
                Fine-tune output resolution, video codecs, audio bitrate, quality compression, delimiter formats, and OCR page ranges with ease.
              </p>
            </div>
            <div className="mt-4 pt-3 border-t border-neutral-100 dark:border-[#242C48] flex items-center gap-1.5 text-xs font-semibold text-brand-700 dark:text-brand-300">
              <CheckCircle2 className="size-3.5 text-emerald-500" />
              <span>Advanced conversion controls</span>
            </div>
          </div>

          {/* Advantage 5: Universal Device Compatibility */}
          <div className="rounded-3xl border border-neutral-border dark:border-[#2B3556] bg-white dark:bg-[#151A2E] p-6 sm:p-7 shadow-sm hover:border-brand-400 dark:hover:border-brand-500/60 transition-all flex flex-col justify-between">
            <div>
              <div className="size-11 rounded-2xl bg-brand-50 dark:bg-brand-900/40 border border-brand-200/80 dark:border-brand-700/40 text-brand-700 dark:text-brand-300 flex items-center justify-center mb-5 shadow-sm">
                <Compass className="size-5" />
              </div>
              <h3 className="text-lg font-bold text-brand-950 dark:text-white">
                All Devices Supported
              </h3>
              <p className="mt-2 text-xs sm:text-sm text-ink-secondary dark:text-neutral-300 leading-relaxed">
                Seamless operation on Chrome, Safari, Firefox, and Edge across macOS, Windows, Linux, iOS, and Android.
              </p>
            </div>
            <div className="mt-4 pt-3 border-t border-neutral-100 dark:border-[#242C48] flex items-center gap-1.5 text-xs font-semibold text-brand-700 dark:text-brand-300">
              <CheckCircle2 className="size-3.5 text-emerald-500" />
              <span>No plugins or installation required</span>
            </div>
          </div>

          {/* Advantage 6: 100% Free & Unlimited */}
          <div className="rounded-3xl border border-neutral-border dark:border-[#2B3556] bg-white dark:bg-[#151A2E] p-6 sm:p-7 shadow-sm hover:border-brand-400 dark:hover:border-brand-500/60 transition-all flex flex-col justify-between">
            <div>
              <div className="size-11 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-700/40 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mb-5 shadow-sm">
                <FileCheck2 className="size-5" />
              </div>
              <h3 className="text-lg font-bold text-brand-950 dark:text-white">
                Always Free &amp; Unlimited
              </h3>
              <p className="mt-2 text-xs sm:text-sm text-ink-secondary dark:text-neutral-300 leading-relaxed">
                Zero paywalls, daily conversion quotas, or credit limitations. Convert unlimited files with full privacy without creating an account.
              </p>
            </div>
            <div className="mt-4 pt-3 border-t border-neutral-100 dark:border-[#242C48] flex items-center gap-1.5 text-xs font-semibold text-brand-700 dark:text-brand-300">
              <CheckCircle2 className="size-3.5 text-emerald-500" />
              <span>No sign-up or credit card</span>
            </div>
          </div>
        </div>
      </section>

      {/* 2. Categorized Converter Directory */}
      <section id="format-catalog" className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pt-4">
        <div className="text-center max-w-3xl mx-auto mb-10">
          <span className="text-[11px] font-bold uppercase tracking-wider text-brand-700 dark:text-brand-400">
            Comprehensive Directory
          </span>
          <h2 className="text-2xl sm:text-3xl lg:text-4xl font-black tracking-tight text-brand-950 dark:text-white mt-1">
            Supported Formats &amp; Conversions
          </h2>
          <p className="mt-2.5 text-sm sm:text-base text-ink-secondary dark:text-neutral-300">
            EasyConvert supports <span className="font-semibold text-brand-950 dark:text-white">292</span> formats across 12 categories with instant browser-based processing.
          </p>

          {/* Category Tabs */}
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {categories.map((cat) => {
              const isSelected = selectedCategory === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setSelectedCategory(cat.id)}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-brand-700 text-white shadow-md shadow-brand-700/25 font-semibold'
                      : 'bg-white dark:bg-[#181D30] text-ink-secondary dark:text-neutral-300 border border-neutral-border dark:border-[#283252] hover:border-brand-400 hover:text-brand-700 dark:hover:text-white'
                  }`}
                >
                  <span>{cat.icon}</span>
                  <span>{cat.name}</span>
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full ${
                    isSelected ? 'bg-white/20 text-white' : 'bg-neutral-100 dark:bg-white/10 text-ink-muted dark:text-neutral-400'
                  }`}>
                    {cat.count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Selected Category Details Card */}
        <div className="rounded-3xl border border-neutral-border dark:border-[#2B3556] bg-white dark:bg-[#151A2E] p-6 sm:p-8 shadow-sm">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
            {/* Formats Grid */}
            <div className="lg:col-span-2 space-y-4">
              <div className="flex items-center justify-between border-b border-neutral-100 dark:border-[#252E4B] pb-3">
                <div className="flex items-center gap-2">
                  <span className="text-brand-700 dark:text-brand-300">{activeCat.icon}</span>
                  <h3 className="font-bold text-brand-950 dark:text-white text-base">
                    {activeCat.name} Formats ({activeCat.formats.length})
                  </h3>
                </div>
                <span className="text-xs text-ink-muted dark:text-neutral-400 font-medium">
                  Click format to start
                </span>
              </div>

              <div className="flex flex-wrap gap-2 pt-1 max-h-56 overflow-y-auto pr-1">
                {activeCat.formats.map((fmt) => (
                  <button
                    key={fmt}
                    type="button"
                    onClick={() => {
                      onSelectPreset?.(fmt.toLowerCase(), 'pdf');
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                    className="inline-flex items-center bg-neutral-50 dark:bg-[#181D30] hover:bg-brand-50 dark:hover:bg-brand-700/20 border border-neutral-border dark:border-[#283252] hover:border-brand-700 dark:hover:border-brand-400 px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-brand-950 dark:text-neutral-200 hover:text-brand-700 dark:hover:text-brand-300 transition-colors rounded-xl shadow-xs cursor-pointer"
                  >
                    {fmt}
                  </button>
                ))}
              </div>
            </div>

            {/* Popular Conversion Pairs for Active Category */}
            <div className="space-y-4 border-t lg:border-t-0 lg:border-l border-neutral-100 dark:border-[#252E4B] pt-6 lg:pt-0 lg:pl-8">
              <div className="border-b border-neutral-100 dark:border-[#252E4B] pb-3">
                <h4 className="font-bold text-brand-950 dark:text-white text-sm">
                  Popular {activeCat.name} Conversions
                </h4>
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
                    className="w-full text-left p-3 rounded-2xl bg-neutral-50 hover:bg-brand-50/70 dark:bg-[#181D30] dark:hover:bg-brand-900/30 border border-neutral-border dark:border-[#283252] hover:border-brand-300 dark:hover:border-brand-700 transition-all group cursor-pointer"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 font-mono font-bold text-xs text-brand-950 dark:text-white group-hover:text-brand-700 dark:group-hover:text-brand-300">
                        <span>{conv.from}</span>
                        <ArrowRight className="size-3 text-ink-muted group-hover:text-brand-700 dark:group-hover:text-brand-300" />
                        <span>{conv.to}</span>
                      </div>
                      <span className="text-[11px] font-semibold text-brand-700 dark:text-brand-400 opacity-0 group-hover:opacity-100 transition-opacity">
                        Convert &rarr;
                      </span>
                    </div>
                    <p className="text-[11px] text-ink-secondary dark:text-neutral-400 mt-1 truncate">
                      {conv.desc}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 3. Standardized 3-Step Conversion Workflow */}
      <section id="how-it-works" className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pt-4">
        <div className="text-center max-w-2xl mx-auto mb-10">
          <span className="text-[11px] font-bold uppercase tracking-wider text-brand-700 dark:text-brand-400">
            Effortless 3-Step Process
          </span>
          <h2 className="text-2xl sm:text-3xl font-black tracking-tight text-brand-950 dark:text-white mt-1">
            How to Convert Files with EasyConvert
          </h2>
          <p className="mt-2 text-sm text-ink-secondary dark:text-neutral-300">
            Convert your documents, media, and archives in seconds with zero complicated settings.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Step 1 */}
          <div className="rounded-3xl border border-neutral-border dark:border-[#2B3556] bg-white dark:bg-[#151A2E] p-6 sm:p-7 shadow-sm flex flex-col items-start gap-4 hover:border-brand-400 transition-all">
            <div className="size-11 rounded-2xl bg-brand-50 dark:bg-brand-900/40 border border-brand-200/80 dark:border-brand-700/40 text-brand-700 dark:text-brand-300 flex items-center justify-center font-black text-base shadow-sm">
              1
            </div>
            <div>
              <h3 className="text-base font-bold text-brand-950 dark:text-white">1. Choose Files</h3>
              <p className="mt-1.5 text-xs sm:text-sm text-ink-secondary dark:text-neutral-300 leading-relaxed">
                Select files from your device, drag &amp; drop them directly into the dropzone, or paste from your clipboard.
              </p>
            </div>
          </div>

          {/* Step 2 */}
          <div className="rounded-3xl border border-neutral-border dark:border-[#2B3556] bg-white dark:bg-[#151A2E] p-6 sm:p-7 shadow-sm flex flex-col items-start gap-4 hover:border-brand-400 transition-all">
            <div className="size-11 rounded-2xl bg-brand-50 dark:bg-brand-900/40 border border-brand-200/80 dark:border-brand-700/40 text-brand-700 dark:text-brand-300 flex items-center justify-center font-black text-base shadow-sm">
              2
            </div>
            <div>
              <h3 className="text-base font-bold text-brand-950 dark:text-white">2. Select Target Format</h3>
              <p className="mt-1.5 text-xs sm:text-sm text-ink-secondary dark:text-neutral-300 leading-relaxed">
                Choose your desired output format from 290+ standards. Optionally tune quality, bitrate, or page settings.
              </p>
            </div>
          </div>

          {/* Step 3 */}
          <div className="rounded-3xl border border-neutral-border dark:border-[#2B3556] bg-white dark:bg-[#151A2E] p-6 sm:p-7 shadow-sm flex flex-col items-start gap-4 hover:border-brand-400 transition-all">
            <div className="size-11 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-700/40 text-emerald-600 dark:text-emerald-400 flex items-center justify-center font-black text-base shadow-sm">
              3
            </div>
            <div>
              <h3 className="text-base font-bold text-brand-950 dark:text-white">3. Download Result</h3>
              <p className="mt-1.5 text-xs sm:text-sm text-ink-secondary dark:text-neutral-300 leading-relaxed">
                Click Convert and immediately download your converted file, or package all finished items into a single ZIP archive.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
