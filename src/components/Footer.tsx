'use client';

import React from 'react';
import { ArrowRightLeft, Github, Shield } from 'lucide-react';

export default function Footer() {
  return (
    <footer className="border-t border-neutral-border dark:border-dark-border bg-white dark:bg-dark-surface transition-colors mt-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 md:py-14">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-10">
          {/* Brand Info */}
          <div className="space-y-3 md:col-span-1">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-brand-700 flex items-center justify-center text-white shadow-sm">
                <ArrowRightLeft className="w-3.5 h-3.5 text-white" />
              </div>
              <span className="text-base font-bold tracking-tight text-brand-950 dark:text-white">
                <span className="font-semibold text-brand-700 dark:text-brand-400">Easy</span>
                <span>Convert</span>
              </span>
            </div>
            <p className="text-xs text-ink-secondary dark:text-dark-muted leading-relaxed">
              High-performance file conversion across 9 domains and 200+ formats with our signature lavender palette,
              instant in-memory stream processing, and 100% zero data retention.
            </p>
          </div>

          {/* Supported Domains */}
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-brand-950 dark:text-dark-text mb-3">
              Supported Domains
            </h4>
            <ul className="space-y-2 text-xs text-ink-secondary dark:text-dark-muted">
              <li>
                <a href="#format-directory" className="hover:text-brand-700 dark:hover:text-brand-400 transition-colors">
                  Audio & Video (MP3, WAV, MP4, WebM)
                </a>
              </li>
              <li>
                <a href="#format-directory" className="hover:text-brand-700 dark:hover:text-brand-400 transition-colors">
                  Office Documents (DOCX, PDF, RTF)
                </a>
              </li>
              <li>
                <a href="#format-directory" className="hover:text-brand-700 dark:hover:text-brand-400 transition-colors">
                  Spreadsheets (XLSX, CSV, TSV)
                </a>
              </li>
              <li>
                <a href="#format-directory" className="hover:text-brand-700 dark:hover:text-brand-400 transition-colors">
                  Ebooks & Archives (EPUB, MOBI, ZIP)
                </a>
              </li>
            </ul>
          </div>

          {/* Developer & APIs */}
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-brand-950 dark:text-dark-text mb-3">
              Developer APIs
            </h4>
            <ul className="space-y-2 text-xs text-ink-secondary dark:text-dark-muted">
              <li>
                <a href="/api/formats" target="_blank" rel="noopener noreferrer" className="hover:text-brand-700 dark:hover:text-brand-400 transition-colors">
                  Format Registry API (/api/formats)
                </a>
              </li>
              <li>
                <a href="/api/health" target="_blank" rel="noopener noreferrer" className="hover:text-brand-700 dark:hover:text-brand-400 transition-colors">
                  Health Diagnostic API (/api/health)
                </a>
              </li>
              <li>
                <a href="https://github.com/AquilaXk/easyconvert" target="_blank" rel="noopener noreferrer" className="hover:text-brand-700 dark:hover:text-brand-400 transition-colors">
                  GitHub Repository
                </a>
              </li>
            </ul>
          </div>

          {/* Security & Infrastructure */}
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-brand-950 dark:text-dark-text mb-3">
              Privacy & Zero Retention
            </h4>
            <ul className="space-y-2 text-xs text-ink-secondary dark:text-dark-muted">
              <li className="flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5 text-status-success" />
                <span>100% Zero Data Retention</span>
              </li>
              <li>In-Memory Volatile Processing</li>
              <li>Zero External Cloud Storage</li>
              <li>Strict 100 MB Safety Threshold</li>
            </ul>
          </div>
        </div>

        {/* Bottom copyright */}
        <div className="pt-6 border-t border-neutral-border dark:border-dark-border flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-ink-muted">
          <p>&copy; {new Date().getFullYear()} EasyConvert. High-Density Universal File Conversion.</p>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/AquilaXk/easyconvert"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 hover:text-brand-700 dark:hover:text-brand-400 transition-colors"
            >
              <Github className="w-3.5 h-3.5" />
              <span>AquilaXk/easyconvert</span>
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
