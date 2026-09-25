'use client';

import React from 'react';
import { Layers, ShieldCheck, Zap, ScanText } from 'lucide-react';

export default function Features() {
  const features = [
    {
      icon: <Layers className="w-5 h-5 text-brand-700 dark:text-brand-400" />,
      title: '200+ Formats across 9 Domains',
      description:
        'Comprehensive conversion matrix covering Audio (MP3, WAV, FLAC), Video (MP4, MKV, WebM), Documents, Office, Ebooks, Spreadsheets, Presentations, Images, and Archives.',
    },
    {
      icon: <ShieldCheck className="w-5 h-5 text-brand-700 dark:text-brand-400" />,
      title: 'Zero-Retention In-Memory Pipeline',
      description:
        'Files are processed strictly in volatile memory or isolated ephemeral instances and erased immediately upon stream return. Zero cloud storage footprint, zero tracking, total privacy.',
    },
    {
      icon: <Zap className="w-5 h-5 text-brand-700 dark:text-brand-400" />,
      title: 'Real-Time Streaming Performance',
      description:
        'Eliminates external storage latency with direct buffer stream delivery. Enforces a 100 MB per-file safety threshold to ensure lightning-fast transformations without server congestion.',
    },
    {
      icon: <ScanText className="w-5 h-5 text-brand-700 dark:text-brand-400" />,
      title: 'Document Layout, Tables & OCR Engine',
      description:
        'Preserves typographic styling, font hierarchies, and complex table grids in Office documents, while optical character recognition (OCR) extracts text from scanned PDFs and bitmaps.',
    },
  ];

  return (
    <section id="features" className="py-14 border-t border-neutral-border dark:border-dark-border bg-neutral-scaffold/40 dark:bg-dark-scaffold/40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <h2 className="text-xl sm:text-2xl font-extrabold tracking-tight text-brand-950 dark:text-white mb-2">
            Engineered for Precision & Zero-Retention Privacy
          </h2>
          <p className="text-xs sm:text-sm text-ink-secondary dark:text-dark-muted">
            EasyConvert combines high-density performance with our calibrated lavender design system and instant streaming pipeline.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {features.map((feature, idx) => (
            <div
              key={idx}
              className="p-5 rounded-2xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border shadow-sm hover:border-brand-500 transition-colors"
            >
              <div className="p-2.5 rounded-xl bg-brand-50 dark:bg-dark-elevated w-fit mb-3">
                {feature.icon}
              </div>
              <h3 className="text-xs font-bold text-brand-950 dark:text-dark-text mb-1.5">{feature.title}</h3>
              <p className="text-[11px] text-ink-secondary dark:text-dark-muted leading-relaxed">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
