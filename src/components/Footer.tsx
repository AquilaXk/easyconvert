'use client';

import React from 'react';
import { Sparkles, Github, Shield, Heart } from 'lucide-react';

export default function Footer() {
  return (
    <footer className="border-t border-neutral-border dark:border-dark-border bg-white dark:bg-dark-surface transition-colors mt-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 md:py-16">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-12">
          {/* Brand Info */}
          <div className="space-y-4 md:col-span-1">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-brand-700 flex items-center justify-center text-white shadow-sm">
                <Sparkles className="w-4 h-4 text-brand-100" />
              </div>
              <span className="text-lg font-bold tracking-tight text-brand-950 dark:text-white">
                <span className="font-normal text-brand-700 dark:text-brand-400">Easy</span>
                <span>Convert</span>
              </span>
            </div>
            <p className="text-xs text-ink-secondary dark:text-dark-muted leading-relaxed">
              Universal file conversion service supporting over 200+ formats across images, documents, structured
              tables, and archives with our signature lavender aesthetic.
            </p>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-status-successSoft text-status-success">
                <span className="w-1.5 h-1.5 rounded-full bg-status-success animate-pulse" />
                <span>All Systems Operational</span>
              </span>
            </div>
          </div>

          {/* Tools */}
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-brand-950 dark:text-dark-text mb-4">
              Conversion Tools
            </h4>
            <ul className="space-y-2.5 text-xs text-ink-secondary dark:text-dark-muted">
              <li>
                <a href="#format-directory" className="hover:text-brand-700 dark:hover:text-brand-400 transition-colors">
                  Image Converter (PNG, WebP, JPG)
                </a>
              </li>
              <li>
                <a href="#format-directory" className="hover:text-brand-700 dark:hover:text-brand-400 transition-colors">
                  Document & PDF Converter
                </a>
              </li>
              <li>
                <a href="#format-directory" className="hover:text-brand-700 dark:hover:text-brand-400 transition-colors">
                  Data & Table Converter (CSV, JSON)
                </a>
              </li>
              <li>
                <a href="#format-directory" className="hover:text-brand-700 dark:hover:text-brand-400 transition-colors">
                  ZIP Archive Creator
                </a>
              </li>
            </ul>
          </div>

          {/* Developer Resources */}
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-brand-950 dark:text-dark-text mb-4">
              Developer & API
            </h4>
            <ul className="space-y-2.5 text-xs text-ink-secondary dark:text-dark-muted">
              <li>
                <a href="/api/formats" target="_blank" className="hover:text-brand-700 dark:hover:text-brand-400 transition-colors">
                  Format Registry API (/api/formats)
                </a>
              </li>
              <li>
                <a href="/api/health" target="_blank" className="hover:text-brand-700 dark:hover:text-brand-400 transition-colors">
                  Health Check API (/api/health)
                </a>
              </li>
              <li>
                <a href="https://github.com/AquilaXk/easyconvert" target="_blank" rel="noopener noreferrer" className="hover:text-brand-700 dark:hover:text-brand-400 transition-colors">
                  GitHub Repository
                </a>
              </li>
              <li>
                <a href="#docs" className="hover:text-brand-700 dark:hover:text-brand-400 transition-colors">
                  REST API Documentation
                </a>
              </li>
            </ul>
          </div>

          {/* Security & Trust */}
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-brand-950 dark:text-dark-text mb-4">
              Security & Privacy
            </h4>
            <ul className="space-y-2.5 text-xs text-ink-secondary dark:text-dark-muted">
              <li className="flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5 text-status-success" />
                <span>Zero Data Retention</span>
              </li>
              <li>Ephemeral Processing Sandboxes</li>
              <li>256-bit TLS In-Transit Encryption</li>
              <li>Fail-Closed Integrity Checks</li>
            </ul>
          </div>
        </div>

        {/* Bottom copyright */}
        <div className="pt-8 border-t border-neutral-border dark:border-dark-border flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-ink-muted">
          <p>&copy; {new Date().getFullYear()} EasyConvert. All rights reserved.</p>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/AquilaXk/easyconvert"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 hover:text-brand-700 dark:hover:text-brand-400 transition-colors"
            >
              <Github className="w-4 h-4" />
              <span>AquilaXk/easyconvert</span>
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
