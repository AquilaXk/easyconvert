'use client';

import React, { useState, useEffect } from 'react';
import {
  Sun,
  Moon,
  ChevronDown,
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
  User,
  LogOut,
  Code2,
} from 'lucide-react';
import AuthModal from './AuthModal';

export default function Header() {
  const [isDark, setIsDark] = useState(false);
  const [isToolsOpen, setIsToolsOpen] = useState(false);
  const [isApiOpen, setIsApiOpen] = useState(false);
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
    { label: 'Audio Converter', desc: 'MP3, WAV, AAC, FLAC, OGG', icon: <Music className="w-4 h-4 text-brand-400" /> },
    { label: 'Video Converter', desc: 'MP4, WEBM, MKV, AVI, MOV', icon: <Video className="w-4 h-4 text-brand-400" /> },
    { label: 'Document Converter', desc: 'PDF, DOCX, TXT, HTML, MD', icon: <FileText className="w-4 h-4 text-brand-400" /> },
    { label: 'Ebook Converter', desc: 'EPUB, MOBI, AZW3, FB2', icon: <BookOpen className="w-4 h-4 text-brand-400" /> },
    { label: 'Spreadsheet Converter', desc: 'XLSX, CSV, TSV, JSON, XML', icon: <Database className="w-4 h-4 text-brand-400" /> },
    { label: 'Presentation Converter', desc: 'PPTX, PPT, ODP, KEY', icon: <Presentation className="w-4 h-4 text-brand-400" /> },
    { label: 'Image Converter', desc: 'PNG, JPG, WEBP, AVIF, SVG', icon: <FileImage className="w-4 h-4 text-brand-400" /> },
    { label: 'Archive Creator', desc: 'ZIP, TAR, 7Z, GZ packaging', icon: <Archive className="w-4 h-4 text-brand-400" /> },
  ];

  return (
    <header className="sticky top-0 z-50 backdrop-blur-md bg-neutral-900/90 border-b border-white/[0.08] text-white transition-colors">
      {/* Invisible backdrop to dismiss menus */}
      {(isToolsOpen || isApiOpen) && (
        <div
          className="fixed inset-0 z-30"
          onClick={() => {
            setIsToolsOpen(false);
            setIsApiOpen(false);
          }}
        />
      )}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between relative z-40">
        {/* Brand Logo & Navigation */}
        <div className="flex items-center gap-8">
          <a href="/" className="flex items-center gap-2.5 group">
            {/* Cloud Logo with circular arrow styling */}
            <div className="w-9 h-9 rounded-xl bg-brand-700 hover:bg-brand-600 flex items-center justify-center text-white shadow-md shadow-brand-700/30 transition-all">
              <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24">
                <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z" />
              </svg>
            </div>
            <span className="text-xl tracking-tight text-white font-sans lowercase">
              <span className="font-light">easy</span>
              <span className="font-bold">convert</span>
            </span>
          </a>

          {/* Desktop Navigation: Only Tools, API, Pricing */}
          <nav className="hidden md:flex items-center gap-1">
            {/* Tools Dropdown */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setIsToolsOpen(!isToolsOpen);
                  setIsApiOpen(false);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-neutral-300 hover:text-white rounded-lg hover:bg-white/5 transition-colors"
              >
                <span>Tools</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isToolsOpen ? 'rotate-180 text-brand-400' : ''}`} />
              </button>

              {isToolsOpen && (
                <div
                  onMouseLeave={() => setIsToolsOpen(false)}
                  className="absolute top-full left-0 mt-2 w-[460px] rounded-2xl bg-neutral-900 border border-white/10 shadow-2xl p-3 z-50 grid grid-cols-2 gap-1 animate-in fade-in slide-in-from-top-2 duration-150"
                >
                  {domainTools.map((tool, idx) => (
                    <a
                      key={idx}
                      href="#format-catalog"
                      onClick={() => setIsToolsOpen(false)}
                      className="flex items-start gap-2.5 p-2 rounded-xl hover:bg-white/5 text-white transition-colors"
                    >
                      <div className="p-1.5 rounded-lg bg-white/5 shrink-0 mt-0.5">
                        {tool.icon}
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-white">{tool.label}</div>
                        <div className="text-[10px] text-neutral-400 truncate">{tool.desc}</div>
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </div>

            {/* API Dropdown */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setIsApiOpen(!isApiOpen);
                  setIsToolsOpen(false);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-neutral-300 hover:text-white rounded-lg hover:bg-white/5 transition-colors"
              >
                <span>API</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isApiOpen ? 'rotate-180 text-brand-400' : ''}`} />
              </button>

              {isApiOpen && (
                <div
                  onMouseLeave={() => setIsApiOpen(false)}
                  className="absolute top-full left-0 mt-2 w-64 rounded-2xl bg-neutral-900 border border-white/10 shadow-2xl p-2 z-50 animate-in fade-in slide-in-from-top-2 duration-150"
                >
                  <a
                    href="#api-section"
                    onClick={() => setIsApiOpen(false)}
                    className="flex items-center gap-2.5 p-2.5 rounded-xl hover:bg-white/5 text-white text-xs font-semibold transition-colors"
                  >
                    <Code2 className="w-4 h-4 text-brand-400" />
                    <span>REST API Documentation</span>
                  </a>
                  <a
                    href="/api/formats"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2.5 p-2.5 rounded-xl hover:bg-white/5 text-neutral-300 hover:text-white text-xs transition-colors"
                  >
                    <Database className="w-4 h-4 text-brand-400" />
                    <span>Formats Capability JSON</span>
                  </a>
                </div>
              )}
            </div>

            {/* Pricing */}
            <a
              href="#pricing"
              className="px-3 py-1.5 text-sm font-medium text-neutral-300 hover:text-white rounded-lg hover:bg-white/5 transition-colors"
            >
              Pricing
            </a>
          </nav>
        </div>

        {/* Right Section: Sign In, Sign Up, Theme Toggle */}
        <div className="flex items-center gap-3">
          {userEmail ? (
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-white bg-white/10 px-2.5 py-1 rounded-lg border border-white/10 flex items-center gap-1.5">
                <User className="w-3.5 h-3.5 text-brand-400" />
                <span className="truncate max-w-[120px]">{userEmail}</span>
              </span>
              <button
                type="button"
                onClick={handleSignOut}
                title="Sign out"
                className="p-1.5 text-neutral-400 hover:text-red-400 rounded-lg transition-colors"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setAuthMode('signin');
                  setIsAuthOpen(true);
                }}
                className="hidden sm:inline-flex text-sm font-medium text-neutral-300 hover:text-white transition-colors"
              >
                Sign in
              </button>

              <button
                type="button"
                onClick={() => {
                  setAuthMode('signup');
                  setIsAuthOpen(true);
                }}
                className="inline-flex items-center justify-center px-4 py-1.5 text-sm font-bold text-white bg-brand-700 hover:bg-brand-800 active:bg-brand-900 rounded-md shadow-sm transition-all"
              >
                Sign up
              </button>
            </div>
          )}

          {/* Theme switch button */}
          <button
            type="button"
            onClick={toggleDarkMode}
            aria-label="Toggle dark mode"
            className="p-1.5 text-neutral-300 hover:text-white rounded-lg transition-colors"
          >
            {isDark ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-neutral-300" />}
          </button>

          {/* Mobile hamburger */}
          <button
            type="button"
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="md:hidden p-1.5 text-neutral-300 hover:text-white"
          >
            {isMobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Mobile Drawer */}
      {isMobileMenuOpen && (
        <div className="md:hidden bg-neutral-900 border-b border-white/10 px-4 py-4 space-y-2">
          <div className="font-semibold text-xs text-neutral-400 px-2 uppercase tracking-wider">Tools</div>
          <div className="grid grid-cols-2 gap-1 pb-3">
            {domainTools.map((tool, idx) => (
              <a
                key={idx}
                href="#format-catalog"
                onClick={() => setIsMobileMenuOpen(false)}
                className="p-2 text-xs text-white hover:bg-white/5 rounded-lg flex items-center gap-2"
              >
                {tool.icon}
                <span className="truncate">{tool.label}</span>
              </a>
            ))}
          </div>
          <div className="border-t border-white/10 pt-2 flex flex-col gap-1">
            <a
              href="#api-section"
              onClick={() => setIsMobileMenuOpen(false)}
              className="px-3 py-2 text-sm text-neutral-300 hover:text-white"
            >
              API
            </a>
            <a
              href="#pricing"
              onClick={() => setIsMobileMenuOpen(false)}
              className="px-3 py-2 text-sm text-neutral-300 hover:text-white"
            >
              Pricing
            </a>
          </div>
        </div>
      )}

      {/* Auth Modal */}
      {isAuthOpen && (
        <AuthModal
          onClose={() => setIsAuthOpen(false)}
          initialMode={authMode}
          onSuccess={handleAuthSuccess}
        />
      )}
    </header>
  );
}
