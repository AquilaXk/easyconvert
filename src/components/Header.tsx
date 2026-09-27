'use client';

import React, { useState, useEffect } from 'react';
import BrandLogo from './BrandLogo';
import UserNav from './UserNav';
import {
  Sun,
  Moon,
  ChevronDown,
  Menu,
  X,
  RefreshCw,
  Sparkles,
  Layers,
  Globe,
  Archive,
  Calculator,
  Activity,
  Key,
} from 'lucide-react';

export default function Header() {
  const [isDark, setIsDark] = useState(false);
  const [isToolsOpen, setIsToolsOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  useEffect(() => {
    const isDarkMode = document.documentElement.classList.contains('dark');
    setIsDark(isDarkMode);

    const handleThemeChange = (e: CustomEvent) => {
      if (e.detail?.theme) {
        setIsDark(e.detail.theme === 'dark');
      }
    };
    window.addEventListener('easyconvert-theme-change' as any, handleThemeChange);
    return () => {
      window.removeEventListener('easyconvert-theme-change' as any, handleThemeChange);
    };
  }, []);

  const toggleDarkMode = () => {
    const nextTheme = isDark ? 'light' : 'dark';
    if (nextTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.theme = nextTheme;
    setIsDark(!isDark);
    window.dispatchEvent(new CustomEvent('easyconvert-theme-change', { detail: { theme: nextTheme } }));
  };

  return (
    <header className="sticky top-0 z-50 backdrop-blur-md bg-white/95 dark:bg-dark-surface/95 border-b border-neutral-border dark:border-dark-border text-brand-950 dark:text-white transition-colors duration-150">
      {/* Invisible backdrop to dismiss menus */}
      {isToolsOpen && (
        <div
          className="fixed inset-0 z-30"
          onClick={() => {
            setIsToolsOpen(false);
          }}
        />
      )}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between relative z-40">
        {/* Brand Logo & Navigation */}
        <div className="flex items-center gap-8">
          <a aria-label="EasyConvert Home" href="/" className="outline-none group shrink-0">
            <BrandLogo size="md" />
          </a>

          {/* Desktop Navigation: Tools dropdown, Formats, How It Works, 100% Free badge */}
          <nav className="hidden lg:flex items-center gap-1.5">
            {/* Tools Mega-Menu */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setIsToolsOpen(!isToolsOpen);
                }}
                aria-expanded={isToolsOpen}
                aria-haspopup="true"
                className={`group relative flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                  isToolsOpen
                    ? 'text-brand-900 bg-brand-100 dark:text-white dark:bg-white/10'
                    : 'text-ink-secondary hover:text-brand-950 hover:bg-brand-100/70 dark:text-neutral-300 dark:hover:text-white dark:hover:bg-white/5'
                }`}
              >
                <span>Tools</span>
                <ChevronDown
                  className={`w-3.5 h-3.5 transition-transform duration-200 ${
                    isToolsOpen ? 'rotate-180 text-brand-700 dark:text-white' : 'text-ink-muted dark:text-neutral-400'
                  }`}
                />
              </button>

              {isToolsOpen && (
                <div
                  className="absolute top-full left-0 mt-2 w-[840px] max-w-4xl rounded-2xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border shadow-2xl p-6 z-50 animate-in fade-in slide-in-from-top-2 duration-150"
                >
                  {/* Top section: Convert Files (2 cols) & Optimize Files (1 col) */}
                  <div className="grid grid-cols-3 gap-6">
                    {/* Convert Files */}
                    <div className="col-span-2 space-y-2">
                      <div className="flex items-center gap-2 text-sm font-bold text-brand-950 dark:text-white mb-2">
                        <RefreshCw className="w-4 h-4 text-brand-700 dark:text-brand-400" />
                        <span>Convert Files</span>
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-ink-secondary dark:text-neutral-300 pt-1">
                        <a href="/unit-converter" onClick={() => setIsToolsOpen(false)} className="hover:text-brand-700 dark:hover:text-brand-400 font-semibold flex items-center gap-1.5 py-0.5 text-brand-700 dark:text-brand-300">
                          <Calculator className="w-3.5 h-3.5" />
                          <span>Unit Converter</span>
                        </a>
                        <a href="/archive-converter" onClick={() => setIsToolsOpen(false)} className="hover:text-brand-700 dark:hover:text-white transition-colors py-0.5">Archive Converter</a>
                        <a href="/audio-converter" onClick={() => setIsToolsOpen(false)} className="hover:text-brand-700 dark:hover:text-white transition-colors py-0.5">Audio Converter</a>
                        <a href="/cad-converter" onClick={() => setIsToolsOpen(false)} className="hover:text-brand-700 dark:hover:text-white transition-colors py-0.5">CAD Converter</a>
                        <a href="/document-converter" onClick={() => setIsToolsOpen(false)} className="hover:text-brand-700 dark:hover:text-white transition-colors py-0.5">Document Converter</a>
                        <a href="/ebook-converter" onClick={() => setIsToolsOpen(false)} className="hover:text-brand-700 dark:hover:text-white transition-colors py-0.5">Ebook Converter</a>
                        <a href="/font-converter" onClick={() => setIsToolsOpen(false)} className="hover:text-brand-700 dark:hover:text-white transition-colors py-0.5">Font Converter</a>
                        <a href="/image-converter" onClick={() => setIsToolsOpen(false)} className="hover:text-brand-700 dark:hover:text-white transition-colors py-0.5">Image Converter</a>
                        <a href="/presentation-converter" onClick={() => setIsToolsOpen(false)} className="hover:text-brand-700 dark:hover:text-white transition-colors py-0.5">Presentation Converter</a>
                        <a href="/spreadsheet-converter" onClick={() => setIsToolsOpen(false)} className="hover:text-brand-700 dark:hover:text-white transition-colors py-0.5">Spreadsheet Converter</a>
                        <a href="/vector-converter" onClick={() => setIsToolsOpen(false)} className="hover:text-brand-700 dark:hover:text-white transition-colors py-0.5">Vector Converter</a>
                        <a href="/video-converter" onClick={() => setIsToolsOpen(false)} className="hover:text-brand-700 dark:hover:text-white transition-colors py-0.5">Video Converter</a>
                      </div>
                    </div>

                    {/* Optimize Files */}
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-sm font-bold text-brand-950 dark:text-white mb-2">
                        <Sparkles className="w-4 h-4 text-brand-700 dark:text-brand-400" />
                        <span>Optimize Files</span>
                      </div>
                      <div className="space-y-1.5 text-xs text-ink-secondary dark:text-neutral-300 pt-1">
                        <a href="/compress-pdf" onClick={() => setIsToolsOpen(false)} className="hover:text-brand-700 dark:hover:text-white transition-colors block py-0.5">Compress PDF</a>
                        <a href="/compress-png" onClick={() => setIsToolsOpen(false)} className="hover:text-brand-700 dark:hover:text-white transition-colors block py-0.5">Compress PNG</a>
                        <a href="/compress-jpg" onClick={() => setIsToolsOpen(false)} className="hover:text-brand-700 dark:hover:text-white transition-colors block py-0.5">Compress JPG</a>
                        <a href="/pdf-ocr" onClick={() => setIsToolsOpen(false)} className="hover:text-brand-700 dark:hover:text-white transition-colors block py-0.5">PDF OCR</a>
                      </div>
                    </div>
                  </div>

                  {/* Decorative Brand Divider */}
                  <div className="border-t border-brand-300/60 dark:border-dark-border my-5" />

                  {/* Bottom section: Merge Files, Capture Websites, Archives */}
                  <div className="grid grid-cols-3 gap-6">
                    <div>
                      <div className="flex items-center gap-2 text-sm font-bold text-brand-950 dark:text-white mb-2">
                        <Layers className="w-4 h-4 text-brand-700 dark:text-brand-400" />
                        <span>Merge Files</span>
                      </div>
                      <div className="space-y-1 text-xs text-ink-secondary dark:text-neutral-300">
                        <a href="/merge-pdf" onClick={() => setIsToolsOpen(false)} className="hover:text-brand-700 dark:hover:text-white transition-colors block py-0.5">Merge PDF</a>
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center gap-2 text-sm font-bold text-brand-950 dark:text-white mb-2">
                        <Globe className="w-4 h-4 text-brand-700 dark:text-brand-400" />
                        <span>Capture Websites</span>
                      </div>
                      <div className="space-y-1 text-xs text-ink-secondary dark:text-neutral-300">
                        <a href="/save-website-as-pdf" onClick={() => setIsToolsOpen(false)} className="hover:text-brand-700 dark:hover:text-white transition-colors block py-0.5">Save Website as PDF</a>
                        <a href="/website-png-screenshot" onClick={() => setIsToolsOpen(false)} className="hover:text-brand-700 dark:hover:text-white transition-colors block py-0.5">Website PNG Screenshot</a>
                        <a href="/website-jpg-screenshot" onClick={() => setIsToolsOpen(false)} className="hover:text-brand-700 dark:hover:text-white transition-colors block py-0.5">Website JPG Screenshot</a>
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center gap-2 text-sm font-bold text-brand-950 dark:text-white mb-2">
                        <Archive className="w-4 h-4 text-brand-700 dark:text-brand-400" />
                        <span>Archives</span>
                      </div>
                      <div className="space-y-1 text-xs text-ink-secondary dark:text-neutral-300">
                        <a href="/create-archive" onClick={() => setIsToolsOpen(false)} className="hover:text-brand-700 dark:hover:text-white transition-colors block py-0.5">Create Archive</a>
                        <a href="/extract-archive" onClick={() => setIsToolsOpen(false)} className="hover:text-brand-700 dark:hover:text-white transition-colors block py-0.5">Extract Archive</a>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Supported Formats */}
            <a
              href="/#format-catalog"
              className="px-3 py-1.5 text-sm font-medium text-ink-secondary hover:text-brand-950 hover:bg-brand-100/70 dark:text-neutral-300 dark:hover:text-white dark:hover:bg-white/5 rounded-lg transition-colors"
            >
              Formats
            </a>

            {/* How It Works */}
            <a
              href="/#how-it-works"
              className="px-3 py-1.5 text-sm font-medium text-ink-secondary hover:text-brand-950 hover:bg-brand-100/70 dark:text-neutral-300 dark:hover:text-white dark:hover:bg-white/5 rounded-lg transition-colors"
            >
              How It Works
            </a>

            {/* Developer API & Dashboard */}
            <a
              href="/dashboard"
              className="px-3 py-1.5 text-sm font-medium text-ink-secondary hover:text-brand-950 hover:bg-brand-100/70 dark:text-neutral-300 dark:hover:text-white dark:hover:bg-white/5 rounded-lg transition-colors"
            >
              API
            </a>

            {/* 100% Free Static Edge Badge */}
            <span className="ml-2 inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold tracking-wide uppercase bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20">
              <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
              100% Free
            </span>
          </nav>
        </div>

        {/* Right Section: Auth State, Theme Toggle & Mobile Menu */}
        <div className="flex items-center gap-2">
          {/* User Auth Buttons (Desktop) */}
          <div className="hidden sm:flex items-center gap-2 mr-1">
            <UserNav />
          </div>

          {/* Theme switch button */}
          <button
            type="button"
            onClick={toggleDarkMode}
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
            className="p-2 rounded-lg text-ink-secondary hover:text-brand-950 dark:text-neutral-300 dark:hover:text-white hover:bg-brand-100/70 dark:hover:bg-white/5 transition-colors"
          >
            {isDark ? (
              <Sun className="size-4 shrink-0 text-amber-400" />
            ) : (
              <Moon className="size-4 shrink-0 text-brand-700" />
            )}
          </button>

          {/* Mobile hamburger */}
          <button
            type="button"
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            aria-label={isMobileMenuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={isMobileMenuOpen}
            className="lg:hidden p-2 text-ink-secondary hover:text-brand-950 dark:text-neutral-300 dark:hover:text-white rounded-lg hover:bg-brand-100/70 dark:hover:bg-white/5 transition-colors"
          >
            {isMobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Mobile Drawer */}
      {isMobileMenuOpen && (
        <div className="lg:hidden bg-brand-50 dark:bg-dark-surface border-b border-neutral-border dark:border-dark-border px-4 py-4 space-y-3">
          <div className="font-bold text-xs text-brand-700 dark:text-brand-400 uppercase tracking-wider">Quick Tools</div>
          <div className="grid grid-cols-2 gap-2 text-xs text-ink-secondary dark:text-neutral-300 pb-2">
            <a href="/unit-converter" onClick={() => setIsMobileMenuOpen(false)} className="hover:text-brand-700 dark:hover:text-white font-medium flex items-center gap-1 text-brand-700 dark:text-brand-300">
              <Calculator className="w-3.5 h-3.5" />
              <span>Unit Converter</span>
            </a>
            <a href="/pdf-converter" onClick={() => setIsMobileMenuOpen(false)} className="hover:text-brand-700 dark:hover:text-white">PDF Converter</a>
            <a href="/video-converter" onClick={() => setIsMobileMenuOpen(false)} className="hover:text-brand-700 dark:hover:text-white">Video Converter</a>
            <a href="/merge-pdf" onClick={() => setIsMobileMenuOpen(false)} className="hover:text-brand-700 dark:hover:text-white">Merge PDF</a>
            <a href="/compress-pdf" onClick={() => setIsMobileMenuOpen(false)} className="hover:text-brand-700 dark:hover:text-white">Compress PDF</a>
            <a href="/status" onClick={() => setIsMobileMenuOpen(false)} className="hover:text-brand-700 dark:hover:text-white flex items-center gap-1">
              <Activity className="w-3.5 h-3.5 text-emerald-500" />
              <span>Edge Status</span>
            </a>
          </div>
          <div className="border-t border-brand-300/60 dark:border-dark-border pt-2 flex flex-col gap-1">
            <a
              href="/#format-catalog"
              onClick={() => setIsMobileMenuOpen(false)}
              className="px-2 py-1.5 text-sm text-ink-secondary dark:text-neutral-300 hover:text-brand-950 dark:hover:text-white"
            >
              Formats
            </a>
            <a
              href="/#how-it-works"
              onClick={() => setIsMobileMenuOpen(false)}
              className="px-2 py-1.5 text-sm text-ink-secondary dark:text-neutral-300 hover:text-brand-950 dark:hover:text-white"
            >
              How It Works
            </a>
            <a
              href="/dashboard"
              onClick={() => setIsMobileMenuOpen(false)}
              className="px-2 py-1.5 text-sm text-brand-700 dark:text-brand-300 font-semibold flex items-center gap-1.5"
            >
              <Key className="w-3.5 h-3.5" />
              <span>Developer API & Dashboard</span>
            </a>

            {/* Mobile Auth actions */}
            <div className="pt-2 border-t border-brand-300/60 dark:border-dark-border">
              <UserNav mobile onItemClick={() => setIsMobileMenuOpen(false)} />
            </div>

            <div className="pt-2 flex items-center justify-between px-2">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold tracking-wide uppercase bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20">
                <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
                100% Free • Zero-Server
              </span>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
