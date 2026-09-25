'use client';

import React, { useState, useEffect } from 'react';
import {
  Sun,
  Moon,
  ChevronDown,
  ArrowRightLeft,
  Menu,
  X,
  FileImage,
  FileText,
  Database,
  Archive,
  Music,
  Video,
  BookOpen,
  Presentation,
  Type,
  User,
  LogOut,
} from 'lucide-react';
import AuthModal from './AuthModal';

export default function Header() {
  const [isDark, setIsDark] = useState(false);
  const [isToolsOpen, setIsToolsOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [userEmail, setUserEmail] = useState<string | null>(null);

  useEffect(() => {
    const isDarkMode = document.documentElement.classList.contains('dark');
    setIsDark(isDarkMode);
    const saved = localStorage.getItem('easyconvert_user');
    if (saved) setUserEmail(saved);
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

  const handleAuthSuccess = (email: string) => {
    setUserEmail(email);
    localStorage.setItem('easyconvert_user', email);
  };

  const handleSignOut = () => {
    setUserEmail(null);
    localStorage.removeItem('easyconvert_user');
  };

  const domainTools = [
    {
      label: 'Audio Converter',
      desc: 'MP3, WAV, AAC, FLAC, OGG, M4A',
      icon: <Music className="w-4 h-4 text-brand-700 dark:text-brand-400" />,
      hash: '#format-directory',
    },
    {
      label: 'Video Converter',
      desc: 'MP4, WEBM, MKV, AVI, MOV, 3GP',
      icon: <Video className="w-4 h-4 text-brand-700 dark:text-brand-400" />,
      hash: '#format-directory',
    },
    {
      label: 'Document & PDF',
      desc: 'PDF, DOCX, DOC, TXT, MD, HTML',
      icon: <FileText className="w-4 h-4 text-brand-700 dark:text-brand-400" />,
      hash: '#format-directory',
    },
    {
      label: 'Ebook Converter',
      desc: 'EPUB, MOBI, AZW3, FB2, CBZ',
      icon: <BookOpen className="w-4 h-4 text-brand-700 dark:text-brand-400" />,
      hash: '#format-directory',
    },
    {
      label: 'Spreadsheet & Data',
      desc: 'XLSX, CSV, TSV, JSON, XML, ODS',
      icon: <Database className="w-4 h-4 text-brand-700 dark:text-brand-400" />,
      hash: '#format-directory',
    },
    {
      label: 'Presentation Converter',
      desc: 'PPTX, PPT, ODP, KEY',
      icon: <Presentation className="w-4 h-4 text-brand-700 dark:text-brand-400" />,
      hash: '#format-directory',
    },
    {
      label: 'Image Converter',
      desc: 'PNG, JPG, WEBP, AVIF, TIFF, SVG',
      icon: <FileImage className="w-4 h-4 text-brand-700 dark:text-brand-400" />,
      hash: '#format-directory',
    },
    {
      label: 'Archive Creator',
      desc: 'ZIP, TAR, 7Z, GZ packaging',
      icon: <Archive className="w-4 h-4 text-brand-700 dark:text-brand-400" />,
      hash: '#format-directory',
    },
    {
      label: 'Font & CAD Engine',
      desc: 'TTF, OTF, WOFF2, DWG, DXF',
      icon: <Type className="w-4 h-4 text-brand-700 dark:text-brand-400" />,
      hash: '#format-directory',
    },
  ];

  return (
    <header className="sticky top-0 z-50 backdrop-blur-md bg-white/95 dark:bg-dark-surface/95 border-b border-neutral-border dark:border-dark-border transition-colors">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Brand Logo (Zero AI Slop) */}
        <div className="flex items-center gap-8">
          <a href="/" className="flex items-center gap-2.5 group">
            <div className="w-8 h-8 rounded-lg bg-brand-700 flex items-center justify-center text-white shadow-sm transition-transform group-hover:scale-105">
              <ArrowRightLeft className="w-4 h-4 text-white" />
            </div>
            <span className="text-lg font-bold tracking-tight text-brand-950 dark:text-white">
              <span className="font-semibold text-brand-700 dark:text-brand-400">Easy</span>
              <span>Convert</span>
            </span>
          </a>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-1">
            {/* Tools Dropdown for 9 Domains */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setIsToolsOpen(!isToolsOpen)}
                onBlur={() => setTimeout(() => setIsToolsOpen(false), 200)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-ink-secondary dark:text-dark-muted hover:text-brand-700 dark:hover:text-brand-300 rounded-lg hover:bg-neutral-scaffold dark:hover:bg-dark-elevated transition-colors"
              >
                <span>Tools</span>
                <ChevronDown
                  className={`w-3.5 h-3.5 transition-transform duration-200 ${
                    isToolsOpen ? 'rotate-180 text-brand-700 dark:text-brand-400' : ''
                  }`}
                />
              </button>

              {isToolsOpen && (
                <div className="absolute top-full left-0 mt-1.5 w-[520px] rounded-2xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border shadow-2xl p-3 z-50 animate-in fade-in slide-in-from-top-2 duration-150 grid grid-cols-2 gap-1.5">
                  {domainTools.map((tool, idx) => (
                    <a
                      key={idx}
                      href={tool.hash}
                      className="flex items-start gap-2.5 p-2 rounded-xl hover:bg-neutral-scaffold dark:hover:bg-dark-elevated text-brand-950 dark:text-dark-text group transition-colors"
                    >
                      <div className="p-1.5 rounded-lg bg-brand-50 dark:bg-brand-950/60 shrink-0 mt-0.5">
                        {tool.icon}
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-bold leading-tight">{tool.label}</p>
                        <p className="text-[11px] text-ink-muted truncate">{tool.desc}</p>
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </div>

            <a
              href="#format-directory"
              className="px-3 py-1.5 text-xs font-semibold text-ink-secondary dark:text-dark-muted hover:text-brand-700 dark:hover:text-brand-300 rounded-lg hover:bg-neutral-scaffold dark:hover:bg-dark-elevated transition-colors"
            >
              Formats (200+)
            </a>

            <a
              href="#features"
              className="px-3 py-1.5 text-xs font-semibold text-ink-secondary dark:text-dark-muted hover:text-brand-700 dark:hover:text-brand-300 rounded-lg hover:bg-neutral-scaffold dark:hover:bg-dark-elevated transition-colors"
            >
              Architecture
            </a>

            <a
              href="/api/formats"
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 text-xs font-semibold text-ink-secondary dark:text-dark-muted hover:text-brand-700 dark:hover:text-brand-300 rounded-lg hover:bg-neutral-scaffold dark:hover:bg-dark-elevated transition-colors"
            >
              API
            </a>
          </nav>
        </div>

        {/* Right Section: Theme Toggle & Real Authentication */}
        <div className="flex items-center gap-2.5">
          {/* Theme switch button */}
          <button
            type="button"
            onClick={toggleDarkMode}
            aria-label="Toggle dark mode"
            className="p-2 rounded-lg text-ink-secondary dark:text-dark-muted hover:bg-neutral-scaffold dark:hover:bg-dark-elevated hover:text-brand-700 dark:hover:text-brand-300 transition-colors"
          >
            {isDark ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-brand-700" />}
          </button>

          {userEmail ? (
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-brand-950 dark:text-dark-text bg-brand-50 dark:bg-dark-elevated px-2.5 py-1 rounded-lg border border-brand-200 dark:border-brand-900 flex items-center gap-1.5">
                <User className="w-3.5 h-3.5 text-brand-700 dark:text-brand-400" />
                <span className="truncate max-w-[120px]">{userEmail}</span>
              </span>
              <button
                type="button"
                onClick={handleSignOut}
                title="Sign out"
                className="p-1.5 text-ink-muted hover:text-status-danger rounded-lg transition-colors"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setAuthMode('signin');
                  setIsAuthOpen(true);
                }}
                className="hidden sm:inline-flex px-3 py-1.5 text-xs font-semibold text-ink-secondary dark:text-dark-muted hover:text-brand-700 dark:hover:text-brand-300 hover:bg-neutral-scaffold dark:hover:bg-dark-elevated rounded-lg transition-colors"
              >
                Sign In
              </button>

              <button
                type="button"
                onClick={() => {
                  setAuthMode('signup');
                  setIsAuthOpen(true);
                }}
                className="inline-flex items-center justify-center px-3.5 py-1.5 text-xs font-bold text-white bg-brand-700 hover:bg-brand-800 active:bg-brand-900 rounded-lg shadow-sm shadow-brand-700/20 transition-all hover:scale-102"
              >
                Sign Up
              </button>
            </div>
          )}

          {/* Mobile hamburger */}
          <button
            type="button"
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="md:hidden p-1.5 text-ink-secondary dark:text-dark-muted hover:bg-neutral-scaffold dark:hover:bg-dark-elevated rounded-lg"
          >
            {isMobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Mobile Drawer */}
      {isMobileMenuOpen && (
        <div className="md:hidden border-t border-neutral-border dark:border-dark-border bg-white dark:bg-dark-surface p-4 space-y-2 animate-in slide-in-from-top-4 duration-200">
          <div className="grid grid-cols-2 gap-1 pb-3 border-b border-neutral-border dark:border-dark-border">
            {domainTools.map((tool, idx) => (
              <a
                key={idx}
                href={tool.hash}
                onClick={() => setIsMobileMenuOpen(false)}
                className="flex items-center gap-2 p-2 rounded-lg text-xs font-medium text-brand-950 dark:text-dark-text hover:bg-neutral-scaffold dark:hover:bg-dark-elevated"
              >
                {tool.icon}
                <span className="truncate">{tool.label}</span>
              </a>
            ))}
          </div>

          <a
            href="#format-directory"
            onClick={() => setIsMobileMenuOpen(false)}
            className="block px-3 py-2 rounded-lg font-semibold text-xs text-brand-950 dark:text-dark-text hover:bg-neutral-scaffold dark:hover:bg-dark-elevated"
          >
            Supported Formats (200+)
          </a>
          <a
            href="/api/formats"
            target="_blank"
            onClick={() => setIsMobileMenuOpen(false)}
            className="block px-3 py-2 rounded-lg font-semibold text-xs text-brand-950 dark:text-dark-text hover:bg-neutral-scaffold dark:hover:bg-dark-elevated"
          >
            Format Discovery API
          </a>
        </div>
      )}

      {/* Auth Modal */}
      {isAuthOpen && (
        <AuthModal
          initialMode={authMode}
          onClose={() => setIsAuthOpen(false)}
          onSuccess={handleAuthSuccess}
        />
      )}
    </header>
  );
}
