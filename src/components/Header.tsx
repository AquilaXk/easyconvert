'use client';

import React, { useState, useEffect } from 'react';
import {
  Sun,
  Moon,
  ChevronDown,
  Layers,
  FileCode,
  Sparkles,
  Menu,
  X,
  FileImage,
  FileText,
  Database,
  Archive,
} from 'lucide-react';

export default function Header() {
  const [isDark, setIsDark] = useState(false);
  const [isToolsOpen, setIsToolsOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  useEffect(() => {
    const isDarkMode = document.documentElement.classList.contains('dark');
    setIsDark(isDarkMode);
  }, []);

  const toggleDarkMode = () => {
    if (isDark) {
      document.documentElement.classList.remove('dark');
      localStorage.theme = 'light';
      setIsDark(false);
    } else {
      document.documentElement.classList.add('dark');
      localStorage.theme = 'dark';
      setIsDark(true);
    }
  };

  return (
    <header className="sticky top-0 z-50 backdrop-blur-md bg-white/90 dark:bg-dark-surface/90 border-b border-neutral-border dark:border-dark-border transition-colors">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Logo */}
        <div className="flex items-center gap-8">
          <a href="/" className="flex items-center gap-2.5 group">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-tr from-brand-700 to-brand-500 flex items-center justify-center text-white shadow-md shadow-brand-500/20 group-hover:scale-105 transition-transform">
              <Sparkles className="w-5 h-5 text-brand-100" />
            </div>
            <span className="text-xl font-bold tracking-tight text-brand-950 dark:text-white">
              <span className="font-normal text-brand-700 dark:text-brand-400">Easy</span>
              <span>Convert</span>
            </span>
          </a>

          {/* Desktop Nav */}
          <nav className="hidden md:flex items-center gap-1">
            {/* Tools Dropdown */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setIsToolsOpen(!isToolsOpen)}
                onBlur={() => setTimeout(() => setIsToolsOpen(false), 200)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-ink-secondary dark:text-dark-muted hover:text-brand-700 dark:hover:text-brand-300 rounded-md hover:bg-brand-50 dark:hover:bg-dark-elevated transition-colors"
              >
                <span>Tools</span>
                <ChevronDown
                  className={`w-4 h-4 transition-transform duration-200 ${
                    isToolsOpen ? 'rotate-180 text-brand-700 dark:text-brand-400' : ''
                  }`}
                />
              </button>

              {isToolsOpen && (
                <div className="absolute top-full left-0 mt-2 w-64 rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border shadow-xl p-2 z-50 animate-in fade-in slide-in-from-top-2 duration-150">
                  <a
                    href="#image-converter"
                    className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-brand-50 dark:hover:bg-dark-elevated text-brand-950 dark:text-dark-text group"
                  >
                    <div className="p-2 rounded-md bg-brand-100 dark:bg-brand-950 text-brand-700 dark:text-brand-400">
                      <FileImage className="w-4 h-4" />
                    </div>
                    <div>
                      <p className="text-xs font-semibold">Image Converter</p>
                      <p className="text-[11px] text-ink-muted">PNG, JPG, WebP, AVIF, TIFF</p>
                    </div>
                  </a>
                  <a
                    href="#document-converter"
                    className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-brand-50 dark:hover:bg-dark-elevated text-brand-950 dark:text-dark-text group"
                  >
                    <div className="p-2 rounded-md bg-brand-100 dark:bg-brand-950 text-brand-700 dark:text-brand-400">
                      <FileText className="w-4 h-4" />
                    </div>
                    <div>
                      <p className="text-xs font-semibold">Document & PDF Converter</p>
                      <p className="text-[11px] text-ink-muted">PDF, Markdown, HTML, TXT</p>
                    </div>
                  </a>
                  <a
                    href="#data-converter"
                    className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-brand-50 dark:hover:bg-dark-elevated text-brand-950 dark:text-dark-text group"
                  >
                    <div className="p-2 rounded-md bg-brand-100 dark:bg-brand-950 text-brand-700 dark:text-brand-400">
                      <Database className="w-4 h-4" />
                    </div>
                    <div>
                      <p className="text-xs font-semibold">Data & Spreadsheet</p>
                      <p className="text-[11px] text-ink-muted">CSV, JSON, TSV, XML, YAML</p>
                    </div>
                  </a>
                  <a
                    href="#archive-converter"
                    className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-brand-50 dark:hover:bg-dark-elevated text-brand-950 dark:text-dark-text group"
                  >
                    <div className="p-2 rounded-md bg-brand-100 dark:bg-brand-950 text-brand-700 dark:text-brand-400">
                      <Archive className="w-4 h-4" />
                    </div>
                    <div>
                      <p className="text-xs font-semibold">Archive Creator</p>
                      <p className="text-[11px] text-ink-muted">ZIP, TAR compression</p>
                    </div>
                  </a>
                </div>
              )}
            </div>

            <a
              href="#api"
              className="px-3 py-1.5 text-sm font-medium text-ink-secondary dark:text-dark-muted hover:text-brand-700 dark:hover:text-brand-300 rounded-md hover:bg-brand-50 dark:hover:bg-dark-elevated transition-colors"
            >
              API
            </a>
            <a
              href="#pricing"
              className="px-3 py-1.5 text-sm font-medium text-ink-secondary dark:text-dark-muted hover:text-brand-700 dark:hover:text-brand-300 rounded-md hover:bg-brand-50 dark:hover:bg-dark-elevated transition-colors"
            >
              Pricing
            </a>
          </nav>
        </div>

        {/* Right Section: Theme Toggle & Actions */}
        <div className="flex items-center gap-3">
          {/* Theme switch button */}
          <button
            type="button"
            onClick={toggleDarkMode}
            aria-label="Toggle dark mode"
            className="p-2 rounded-lg text-ink-secondary dark:text-dark-muted hover:bg-brand-100 dark:hover:bg-dark-elevated hover:text-brand-700 dark:hover:text-brand-300 transition-colors"
          >
            {isDark ? <Sun className="w-5 h-5 text-amber-400" /> : <Moon className="w-5 h-5 text-brand-700" />}
          </button>

          <a
            href="#login"
            className="hidden sm:inline-flex px-3.5 py-1.5 text-sm font-medium text-ink-secondary dark:text-dark-muted hover:text-brand-700 dark:hover:text-brand-300 hover:bg-brand-50 dark:hover:bg-dark-elevated rounded-lg transition-colors"
          >
            Sign in
          </a>

          <a
            href="#signup"
            className="inline-flex items-center justify-center px-4 py-1.5 text-sm font-medium text-white bg-brand-700 hover:bg-brand-800 active:bg-brand-900 rounded-lg shadow-sm shadow-brand-700/30 transition-all hover:scale-[1.02]"
          >
            Sign up
          </a>

          {/* Mobile hamburger */}
          <button
            type="button"
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="md:hidden p-2 text-ink-secondary dark:text-dark-muted hover:bg-brand-50 dark:hover:bg-dark-elevated rounded-lg"
          >
            {isMobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>
      </div>

      {/* Mobile drawer */}
      {isMobileMenuOpen && (
        <div className="md:hidden border-t border-neutral-border dark:border-dark-border bg-white dark:bg-dark-surface p-4 space-y-3 animate-in slide-in-from-top-4 duration-200">
          <a
            href="#image-converter"
            onClick={() => setIsMobileMenuOpen(false)}
            className="block px-3 py-2 rounded-lg font-medium text-sm text-brand-950 dark:text-dark-text hover:bg-brand-50 dark:hover:bg-dark-elevated"
          >
            Image Converter
          </a>
          <a
            href="#document-converter"
            onClick={() => setIsMobileMenuOpen(false)}
            className="block px-3 py-2 rounded-lg font-medium text-sm text-brand-950 dark:text-dark-text hover:bg-brand-50 dark:hover:bg-dark-elevated"
          >
            Document & PDF Converter
          </a>
          <a
            href="#data-converter"
            onClick={() => setIsMobileMenuOpen(false)}
            className="block px-3 py-2 rounded-lg font-medium text-sm text-brand-950 dark:text-dark-text hover:bg-brand-50 dark:hover:bg-dark-elevated"
          >
            Data & Spreadsheet
          </a>
          <a
            href="#api"
            onClick={() => setIsMobileMenuOpen(false)}
            className="block px-3 py-2 rounded-lg font-medium text-sm text-brand-950 dark:text-dark-text hover:bg-brand-50 dark:hover:bg-dark-elevated"
          >
            API Documentation
          </a>
          <a
            href="#pricing"
            onClick={() => setIsMobileMenuOpen(false)}
            className="block px-3 py-2 rounded-lg font-medium text-sm text-brand-950 dark:text-dark-text hover:bg-brand-50 dark:hover:bg-dark-elevated"
          >
            Pricing
          </a>
        </div>
      )}
    </header>
  );
}
