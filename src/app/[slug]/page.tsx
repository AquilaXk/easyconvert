'use client';

import React, { useState } from 'react';
import Header from '@/components/Header';
import Hero from '@/components/Hero';
import ConversionQueue from '@/components/ConversionQueue';
import Footer from '@/components/Footer';
import JSZip from 'jszip';
import { ConversionQueueItem, ConversionOptions } from '@/lib/types';
import { detectFormatFromFilename, FORMAT_REGISTRY } from '@/lib/registry';
import {
  FileText,
  ShieldCheck,
  ArrowRight,
  Send,
  Lock,
  Mail,
  Shield,
  Clock,
  Sparkles,
  Globe,
  Database,
} from 'lucide-react';

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

import { parseConverterSlug } from '@/lib/slug-parser';

const FORMAT_DESCRIPTIONS: Record<string, { title: string; desc: string }> = {
  pdf: {
    title: 'PDF — Portable Document Format',
    desc: 'PDF is a document file format that contains text, images, data etc. This document type is Operating System independent. It is an open standard that compresses a document and vector graphics. It can be viewed in web browsers if the PDF plug-in is installed on the browser.',
  },
  docx: {
    title: 'DOCX — Microsoft Word Document',
    desc: 'DOCX is an XML-based document format developed by Microsoft. It contains rich formatted text, embedded images, tables, charts, and styles, and is supported by modern word processors.',
  },
  mp4: {
    title: 'MP4 — MPEG-4 Part 14 Video',
    desc: 'MP4 is a universal multimedia container format used to store video, audio, and subtitles. It is compatible with all modern web browsers, smartphones, televisions, and streaming platforms.',
  },
  mp3: {
    title: 'MP3 — MPEG Audio Layer III',
    desc: 'MP3 is an industry-standard lossy audio coding format that drastically reduces file size while retaining excellent audio quality, playable on almost every digital audio device.',
  },
  png: {
    title: 'PNG — Portable Network Graphics',
    desc: 'PNG is a raster graphics file format that supports lossless data compression and full alpha transparency, ideal for web icons, logos, screenshots, and graphics.',
  },
  jpg: {
    title: 'JPG / JPEG — Joint Photographic Experts Group',
    desc: 'JPG is a widely used lossy compressed image format optimized for continuous-tone photographic images with balanced file sizes.',
  },
  zip: {
    title: 'ZIP — Compressed Archive Format',
    desc: 'ZIP is an archive format that supports lossless compression of one or multiple files and folders, making data transmission and backup compact and efficient.',
  },
  epub: {
    title: 'EPUB — Electronic Publication',
    desc: 'EPUB is an open XML-based ebook standard that supports reflowable text, typography adjustments, and fixed layouts across digital readers and mobile apps.',
  },
};

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

  // Informational Page Renderers
  if (parsed.isInfoPage) {
    return (
      <div className="flex flex-col min-h-screen bg-[#141414] text-white">
        <Header />
        <main className="flex-1 max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
          <div className="mb-10 text-center">
            <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
              {parsed.pageTitle}
            </h1>
            <p className="mt-3 text-neutral-400 text-sm">{parsed.pageDescription}</p>
          </div>

          <div className="bg-[#1e1e1e] border border-neutral-800 rounded-2xl p-6 sm:p-10 shadow-2xl space-y-6 text-sm text-neutral-300 leading-relaxed">
            {parsed.infoType === 'privacy' && (
              <>
                <h3 className="text-lg font-bold text-white">Zero Data Retention Guarantee</h3>
                <p>
                  At EasyConvert, privacy is not an afterthought; it is our primary architectural pillar.
                  All conversions take place entirely within ephemeral, volatile system memory.
                </p>
                <h3 className="text-lg font-bold text-white">Transient Execution</h3>
                <p>
                  Incoming streams are piped directly to converter engines without writing temporary
                  blobs to permanent disks. Once your conversion is complete or your download begins,
                  all associated memory buffers are wiped immediately.
                </p>
                <h3 className="text-lg font-bold text-white">No Tracking or Third-Party Analytics</h3>
                <p>
                  We do not sell, rent, or inspect your document contents. Your data belongs solely to you.
                </p>
              </>
            )}

            {parsed.infoType === 'terms' && (
              <>
                <h3 className="text-lg font-bold text-white">1. Acceptance of Terms</h3>
                <p>
                  By accessing or using EasyConvert, you agree to be bound by these Terms of Service. If you do
                  not agree, do not use our services.
                </p>
                <h3 className="text-lg font-bold text-white">2. Acceptable Use</h3>
                <p>
                  You agree not to upload copyrighted content that you do not own or possess explicit license
                  to convert, nor upload malicious binaries, malware, or illicit material.
                </p>
                <h3 className="text-lg font-bold text-white">3. Service Availability & Limits</h3>
                <p>
                  Free accounts receive 10 daily conversions. Paid packages and subscriptions provide
                  credits with prioritized throughput.
                </p>
              </>
            )}

            {parsed.infoType === 'contact' && (
              <form onSubmit={(e) => { e.preventDefault(); alert('Message received! Our team will respond shortly.'); }} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-neutral-300 mb-1">Your Name</label>
                  <input required type="text" placeholder="Jane Doe" className="w-full px-3.5 py-2.5 bg-neutral-900 border border-neutral-700 rounded-xl text-white text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-neutral-300 mb-1">Email Address</label>
                  <input required type="email" placeholder="jane@example.com" className="w-full px-3.5 py-2.5 bg-neutral-900 border border-neutral-700 rounded-xl text-white text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-neutral-300 mb-1">Subject</label>
                  <input required type="text" placeholder="Enterprise licensing inquiry" className="w-full px-3.5 py-2.5 bg-neutral-900 border border-neutral-700 rounded-xl text-white text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-neutral-300 mb-1">Message</label>
                  <textarea required rows={4} placeholder="Tell us how we can help..." className="w-full px-3.5 py-2.5 bg-neutral-900 border border-neutral-700 rounded-xl text-white text-sm" />
                </div>
                <button type="submit" className="px-6 py-2.5 bg-[#d9383a] hover:bg-[#c22e30] text-white font-semibold text-sm rounded-xl transition-colors shadow-md">
                  Send Message
                </button>
              </form>
            )}

            {parsed.infoType === 'about' && (
              <>
                <h3 className="text-lg font-bold text-white">High-Performance File Transformation</h3>
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
                <h3 className="text-lg font-bold text-white">End-to-End Encryption</h3>
                <p>
                  All client transmissions are secured using modern TLS 1.3 encryption with strict HSTS policies.
                </p>
                <h3 className="text-lg font-bold text-white">Volatile Memory Sandboxing</h3>
                <p>
                  Worker processes run within isolated Linux sandboxes. Once processing terminates, memory spaces
                  are reclaimed immediately with zero residual files.
                </p>
              </>
            )}

            {parsed.infoType === 'forgot-password' && (
              <form onSubmit={(e) => { e.preventDefault(); alert('Reset link sent to your email.'); }} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-neutral-300 mb-1">Email Address</label>
                  <input required type="email" placeholder="name@example.com" className="w-full px-3.5 py-2.5 bg-neutral-900 border border-neutral-700 rounded-xl text-white text-sm" />
                </div>
                <button type="submit" className="w-full py-2.5 bg-[#d9383a] hover:bg-[#c22e30] text-white font-semibold text-sm rounded-xl transition-colors shadow-md">
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

  // File Queue Handler
  const handleFilesSelected = (files: File[], defaultTarget?: string) => {
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

      const isOverSize = file.size > MAX_FILE_SIZE;

      return {
        id: Math.random().toString(36).substring(2, 9) + Date.now().toString(36),
        file,
        name: file.name,
        size: file.size,
        sourceFormat: srcFmt,
        targetFormat: tgtFmt,
        status: isOverSize ? 'error' : 'ready',
        error: isOverSize ? 'File exceeds 100 MB real-time conversion limit.' : undefined,
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

  const handleRemoveItem = (id: string) => {
    setQueue((prev) => {
      const target = prev.find((i) => i.id === id);
      if (target?.resultUrl) URL.revokeObjectURL(target.resultUrl);
      return prev.filter((i) => i.id !== id);
    });
  };

  const handleClearAll = () => {
    queue.forEach((item) => {
      if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
    });
    setQueue([]);
  };

  const handleUpdateTargetFormat = (id: string, newTarget: string) => {
    setQueue((prev) =>
      prev.map((item) => (item.id === id ? { ...item, targetFormat: newTarget } : item))
    );
  };

  const handleUpdateAllTargets = (newTarget: string) => {
    setQueue((prev) =>
      prev.map((item) => {
        const def = FORMAT_REGISTRY[item.sourceFormat];
        if (def && def.targetFormats.includes(newTarget.toLowerCase())) {
          return { ...item, targetFormat: newTarget };
        }
        return item;
      })
    );
  };

  const handleUpdateOptions = (id: string, options: ConversionOptions) => {
    setQueue((prev) => prev.map((item) => (item.id === id ? { ...item, options } : item)));
  };

  const convertSingleItem = async (item: ConversionQueueItem): Promise<void> => {
    if (item.file.size > MAX_FILE_SIZE) {
      setQueue((prev) =>
        prev.map((i) =>
          i.id === item.id ? { ...i, status: 'error', error: 'File size exceeds 100 MB limit.' } : i
        )
      );
      return;
    }

    setQueue((prev) =>
      prev.map((i) =>
        i.id === item.id ? { ...i, status: 'converting', progress: 30, error: undefined } : i
      )
    );

    try {
      const formData = new FormData();
      formData.append('file', item.file);
      formData.append('targetFormat', item.targetFormat);
      formData.append('options', JSON.stringify(item.options));

      const timer = setTimeout(() => {
        setQueue((prev) =>
          prev.map((i) =>
            i.id === item.id && i.status === 'converting' ? { ...i, progress: 75 } : i
          )
        );
      }, 350);

      const res = await fetch('/api/convert', {
        method: 'POST',
        body: formData,
      });

      clearTimeout(timer);

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({ error: 'Conversion failed' }));
        throw new Error(errJson.error || `Server error (${res.status})`);
      }

      const blob = await res.blob();
      const resultUrl = URL.createObjectURL(blob);

      setQueue((prev) =>
        prev.map((i) =>
          i.id === item.id
            ? { ...i, status: 'completed', progress: 100, resultUrl, resultSize: blob.size }
            : i
        )
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Conversion failed';
      setQueue((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, status: 'error', error: msg, progress: 0 } : i))
      );
    }
  };

  const handleConvertAll = async () => {
    setIsConverting(true);
    const pending = queue.filter((i) => i.status === 'ready' || i.status === 'error');
    for (const item of pending) {
      await convertSingleItem(item);
    }
    setIsConverting(false);
  };

  const handleDownloadAllZip = async () => {
    const completedItems = queue.filter((i) => i.status === 'completed' && i.resultUrl);
    if (completedItems.length === 0) return;

    try {
      const zip = new JSZip();
      for (const item of completedItems) {
        if (!item.resultUrl) continue;
        const res = await fetch(item.resultUrl);
        const blob = await res.blob();
        const baseName = item.name.substring(0, item.name.lastIndexOf('.')) || item.name;
        zip.file(`${baseName}.${item.targetFormat}`, blob);
      }
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const zipUrl = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = zipUrl;
      a.download = `easyconvert_${parsed.sourceFormat}_bundle.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(zipUrl);
    } catch (err: unknown) {
      alert('Could not download ZIP: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  const formatMeta =
    FORMAT_DESCRIPTIONS[parsed.sourceFormat] || {
      title: `${parsed.sourceFormat.toUpperCase()} — File Format`,
      desc:
        FORMAT_REGISTRY[parsed.sourceFormat]?.description ||
        `Universal file conversion format with full support across EasyConvert engines.`,
    };

  // Target formats available for converting FROM source format
  const sourceFormatRegistry = FORMAT_REGISTRY[parsed.sourceFormat];
  const convertFromTargets = sourceFormatRegistry?.targetFormats || ['pdf', 'docx', 'png', 'jpg', 'txt'];

  // Source formats available for converting TO target format (or to source format if target is any)
  const targetForReverse = parsed.targetFormat !== 'any' ? parsed.targetFormat : parsed.sourceFormat;
  const convertToSources = Object.entries(FORMAT_REGISTRY)
    .filter(([srcKey, def]) => def.targetFormats.includes(targetForReverse.toLowerCase()) && srcKey !== targetForReverse.toLowerCase())
    .map(([srcKey]) => srcKey);

  return (
    <div className="flex flex-col min-h-screen bg-[#141414] text-white">
      <Header />

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

        {/* 1:1 Format Information Card below Hero (Matching live CloudConvert subpage) */}
        {queue.length === 0 && (
          <section className="max-w-5xl mx-auto px-4 sm:px-6 -mt-16 mb-16 relative z-20">
            <div className="bg-[#1e1e1e] border border-neutral-800 rounded-2xl p-6 sm:p-8 flex items-start gap-5 shadow-2xl">
              <div className="p-3 rounded-xl bg-[#d9383a]/20 text-[#d9383a] border border-[#d9383a]/30 shrink-0">
                <FileText className="w-7 h-7" />
              </div>
              <div className="space-y-2">
                <h3 className="text-base sm:text-lg font-bold text-white tracking-tight">
                  {formatMeta.title}
                </h3>
                <p className="text-xs sm:text-sm text-neutral-400 leading-relaxed">
                  {formatMeta.desc}
                </p>
              </div>
            </div>
          </section>
        )}

        {/* 1:1 CONVERSION TYPES Grids matching CloudConvert */}
        {queue.length === 0 && (
          <section className="max-w-5xl mx-auto px-4 sm:px-6 mb-20 space-y-12">
            {/* Convert FROM [Source] */}
            {convertFromTargets.length > 0 && (
              <div className="bg-[#1a1a1a] border border-neutral-800 rounded-2xl p-6 sm:p-8 shadow-xl">
                <span className="text-[11px] font-bold uppercase tracking-wider text-[#d9383a] block mb-1">
                  Conversion Types
                </span>
                <h3 className="text-xl font-bold text-white mb-1">
                  Convert from {parsed.sourceFormat.toUpperCase()}
                </h3>
                <p className="text-xs sm:text-sm text-neutral-400 mb-6">
                  Pick a target format to start a {parsed.sourceFormat.toUpperCase()} conversion.
                </p>

                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2.5">
                  {convertFromTargets.map((tgt) => (
                    <a
                      key={tgt}
                      href={`/${parsed.sourceFormat.toLowerCase()}-to-${tgt.toLowerCase()}`}
                      className="flex items-center justify-between px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800 hover:border-[#d9383a]/70 hover:bg-[#d9383a]/10 text-xs font-semibold text-neutral-200 hover:text-white transition-all group"
                    >
                      <span>
                        {parsed.sourceFormat.toUpperCase()} TO {tgt.toUpperCase()}
                      </span>
                      <ArrowRight className="w-3.5 h-3.5 text-neutral-500 group-hover:text-[#d9383a] group-hover:translate-x-0.5 transition-all" />
                    </a>
                  ))}
                </div>
              </div>
            )}

            {/* Convert TO [Target] */}
            {convertToSources.length > 0 && (
              <div className="bg-[#1a1a1a] border border-neutral-800 rounded-2xl p-6 sm:p-8 shadow-xl">
                <span className="text-[11px] font-bold uppercase tracking-wider text-[#d9383a] block mb-1">
                  Conversion Types
                </span>
                <h3 className="text-xl font-bold text-white mb-1">
                  Convert to {targetForReverse.toUpperCase()}
                </h3>
                <p className="text-xs sm:text-sm text-neutral-400 mb-6">
                  Pick a source format to convert into {targetForReverse.toUpperCase()}.
                </p>

                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2.5">
                  {convertToSources.slice(0, 30).map((src) => (
                    <a
                      key={src}
                      href={`/${src.toLowerCase()}-to-${targetForReverse.toLowerCase()}`}
                      className="flex items-center justify-between px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800 hover:border-[#d9383a]/70 hover:bg-[#d9383a]/10 text-xs font-semibold text-neutral-200 hover:text-white transition-all group"
                    >
                      <span>
                        {src.toUpperCase()} TO {targetForReverse.toUpperCase()}
                      </span>
                      <ArrowRight className="w-3.5 h-3.5 text-neutral-500 group-hover:text-[#d9383a] group-hover:translate-x-0.5 transition-all" />
                    </a>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}
      </main>

      <Footer />
    </div>
  );
}
