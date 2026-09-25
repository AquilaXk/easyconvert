'use client';

import React, { useState, useEffect } from 'react';
import {
  Sun,
  Moon,
  ChevronDown,
  Menu,
  X,
  FileText,
  User,
  LogOut,
  RefreshCw,
  Sparkles,
  Layers,
  Globe,
  Archive,
  Code2,
  BookOpen,
  Cpu,
  Sliders,
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

  return (
    <header className="sticky top-0 z-50 backdrop-blur-md bg-neutral-900/95 border-b border-white/[0.08] text-white transition-colors">
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
            {/* Cloud Logo matching CloudConvert styling */}
            <div className="w-9 h-9 rounded-xl bg-[#5C6BC0] hover:bg-[#4d5cb5] flex items-center justify-center text-white shadow-md shadow-[#5C6BC0]/30 transition-all">
              <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24">
                <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z" />
              </svg>
            </div>
            <span className="text-xl tracking-tight text-white font-sans lowercase">
              <span className="font-normal">easy</span>
              <span className="font-bold">convert</span>
            </span>
          </a>

          {/* Desktop Navigation: Only Tools, API, Pricing */}
          <nav className="hidden md:flex items-center gap-1">
            {/* Tools Mega-Menu */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setIsToolsOpen(!isToolsOpen);
                  setIsApiOpen(false);
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                  isToolsOpen ? 'text-white bg-white/10' : 'text-neutral-300 hover:text-white hover:bg-white/5'
                }`}
              >
                <span>Tools</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isToolsOpen ? 'rotate-180 text-[#5C6BC0]' : ''}`} />
              </button>

              {isToolsOpen && (
                <div
                  className="absolute top-full left-0 mt-2 w-[720px] rounded-xl bg-[#212529] border border-neutral-700/80 shadow-2xl p-6 z-50 grid grid-cols-3 gap-6 animate-in fade-in slide-in-from-top-2 duration-150"
                >
                  {/* Column 1: Convert Files (part 1 & 2) */}
                  <div className="col-span-2 space-y-4">
                    <div>
                      <div className="flex items-center gap-2 text-xs font-bold text-neutral-100 uppercase tracking-wider mb-2.5 pb-1 border-b border-neutral-800">
                        <RefreshCw className="w-3.5 h-3.5 text-[#5C6BC0]" />
                        <span>Convert Files</span>
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-neutral-300">
                        <a href="/archive-converter" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors py-0.5">Archive Converter</a>
                        <a href="/audio-converter" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors py-0.5">Audio Converter</a>
                        <a href="/cad-converter" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors py-0.5">CAD Converter</a>
                        <a href="/document-converter" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors py-0.5">Document Converter</a>
                        <a href="/ebook-converter" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors py-0.5">Ebook Converter</a>
                        <a href="/font-converter" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors py-0.5">Font Converter</a>
                        <a href="/image-converter" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors py-0.5">Image Converter</a>
                        <a href="/presentation-converter" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors py-0.5">Presentation Converter</a>
                        <a href="/spreadsheet-converter" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors py-0.5">Spreadsheet Converter</a>
                        <a href="/vector-converter" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors py-0.5">Vector Converter</a>
                        <a href="/video-converter" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors py-0.5">Video Converter</a>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4 pt-2 border-t border-neutral-800">
                      <div>
                        <div className="flex items-center gap-2 text-xs font-bold text-neutral-100 uppercase tracking-wider mb-2">
                          <Layers className="w-3.5 h-3.5 text-[#5C6BC0]" />
                          <span>Merge Files</span>
                        </div>
                        <div className="space-y-1 text-xs text-neutral-300">
                          <a href="/merge-pdf" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Merge PDF</a>
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center gap-2 text-xs font-bold text-neutral-100 uppercase tracking-wider mb-2">
                          <Archive className="w-3.5 h-3.5 text-[#5C6BC0]" />
                          <span>Archives</span>
                        </div>
                        <div className="space-y-1 text-xs text-neutral-300">
                          <a href="/create-archive" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Create Archive</a>
                          <a href="/extract-archive" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Extract Archive</a>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Column 2: Optimize & Capture */}
                  <div className="space-y-5 border-l border-neutral-800 pl-4">
                    <div>
                      <div className="flex items-center gap-2 text-xs font-bold text-neutral-100 uppercase tracking-wider mb-2.5 pb-1 border-b border-neutral-800">
                        <Sparkles className="w-3.5 h-3.5 text-[#5C6BC0]" />
                        <span>Optimize Files</span>
                      </div>
                      <div className="space-y-1.5 text-xs text-neutral-300">
                        <a href="/compress-pdf" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Compress PDF</a>
                        <a href="/compress-png" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Compress PNG</a>
                        <a href="/compress-jpg" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Compress JPG</a>
                        <a href="/pdf-ocr" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">PDF OCR</a>
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center gap-2 text-xs font-bold text-neutral-100 uppercase tracking-wider mb-2.5 pb-1 border-b border-neutral-800">
                        <Globe className="w-3.5 h-3.5 text-[#5C6BC0]" />
                        <span>Capture Websites</span>
                      </div>
                      <div className="space-y-1.5 text-xs text-neutral-300">
                        <a href="/save-website-as-pdf" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Save Website as PDF</a>
                        <a href="/website-png-screenshot" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Website PNG Screenshot</a>
                        <a href="/website-jpg-screenshot" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Website JPG Screenshot</a>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* API Mega-Menu */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setIsApiOpen(!isApiOpen);
                  setIsToolsOpen(false);
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                  isApiOpen ? 'text-white bg-white/10' : 'text-neutral-300 hover:text-white hover:bg-white/5'
                }`}
              >
                <span>API</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isApiOpen ? 'rotate-180 text-[#5C6BC0]' : ''}`} />
              </button>

              {isApiOpen && (
                <div
                  className="absolute top-full left-0 mt-2 w-[720px] rounded-xl bg-[#212529] border border-neutral-700/80 shadow-2xl p-6 z-50 grid grid-cols-3 gap-6 animate-in fade-in slide-in-from-top-2 duration-150"
                >
                  {/* Left Column: Convert Files */}
                  <div>
                    <div className="flex items-center gap-2 text-xs font-bold text-neutral-100 uppercase tracking-wider mb-2.5 pb-1 border-b border-neutral-800">
                      <RefreshCw className="w-3.5 h-3.5 text-[#5C6BC0]" />
                      <span>Convert Files</span>
                    </div>
                    <div className="space-y-1.5 text-xs text-neutral-300">
                      <a href="/api/v2#convert-files" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">File Conversion API</a>
                      <a href="/api/v2#office-pdf" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Office to PDF API</a>
                      <a href="/api/v2#iwork-pdf" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">iWork to PDF API</a>
                      <a href="/api/v2#pdf-office" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">PDF to Office API</a>
                      <a href="/api/v2#video-encoding" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Video Encoding API</a>
                      <a href="/api/v2#markdown-llms" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Markdown for LLMs</a>
                    </div>

                    <div className="mt-5">
                      <div className="flex items-center gap-2 text-xs font-bold text-neutral-100 uppercase tracking-wider mb-2 pb-1 border-b border-neutral-800">
                        <Globe className="w-3.5 h-3.5 text-[#5C6BC0]" />
                        <span>Capture Websites</span>
                      </div>
                      <div className="space-y-1.5 text-xs text-neutral-300">
                        <a href="/api/v2#html-pdf" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">HTML to PDF API</a>
                        <a href="/api/v2#screenshot" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Website Screenshot API</a>
                      </div>
                    </div>
                  </div>

                  {/* Middle Column: Optimize & Other APIs */}
                  <div>
                    <div className="flex items-center gap-2 text-xs font-bold text-neutral-100 uppercase tracking-wider mb-2.5 pb-1 border-b border-neutral-800">
                      <Sparkles className="w-3.5 h-3.5 text-[#5C6BC0]" />
                      <span>Optimize Files</span>
                    </div>
                    <div className="space-y-1.5 text-xs text-neutral-300">
                      <a href="/api/v2#compress-pdf" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Compress PDF API</a>
                      <a href="/api/v2#compress-images" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Compress Images API</a>
                    </div>

                    <div className="mt-6">
                      <div className="flex items-center gap-2 text-xs font-bold text-neutral-100 uppercase tracking-wider mb-2 pb-1 border-b border-neutral-800">
                        <Layers className="w-3.5 h-3.5 text-[#5C6BC0]" />
                        <span>Other APIs</span>
                      </div>
                      <div className="space-y-1.5 text-xs text-neutral-300">
                        <a href="/api/v2#merge-pdf" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Merge PDF API</a>
                        <a href="/api/v2#thumbnails" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Thumbnail API</a>
                        <a href="/api/v2#watermark" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Watermark API</a>
                      </div>
                    </div>
                  </div>

                  {/* Right Column: Integrations & Documentation */}
                  <div className="border-l border-neutral-800 pl-4">
                    <div className="flex items-center gap-2 text-xs font-bold text-neutral-100 uppercase tracking-wider mb-2.5 pb-1 border-b border-neutral-800">
                      <Cpu className="w-3.5 h-3.5 text-[#5C6BC0]" />
                      <span>Integrations</span>
                    </div>
                    <div className="space-y-1.5 text-xs text-neutral-300">
                      <a href="/api/v2#integrations" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">No-Code Automation</a>
                      <a href="/api/v2#mcp-server" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">MCP Server</a>
                    </div>

                    <div className="mt-6">
                      <div className="flex items-center gap-2 text-xs font-bold text-neutral-100 uppercase tracking-wider mb-2 pb-1 border-b border-neutral-800">
                        <BookOpen className="w-3.5 h-3.5 text-[#5C6BC0]" />
                        <span>Documentation</span>
                      </div>
                      <div className="space-y-1.5 text-xs text-neutral-300">
                        <a href="/api/v2" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">API Documentation</a>
                        <a href="/api/v2#quickstart" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Quickstart Guide</a>
                        <a href="/api/v2#job-builder" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Job Builder</a>
                        <a href="/api/formats" target="_blank" rel="noopener noreferrer" className="hover:text-white hover:underline transition-colors block py-0.5 text-neutral-400">Capability Matrix JSON</a>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Pricing */}
            <a
              href="/pricing"
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
                <User className="w-3.5 h-3.5 text-[#5C6BC0]" />
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
              <a
                href="/login"
                className="hidden sm:inline-flex text-sm font-medium text-neutral-300 hover:text-white transition-colors"
              >
                Sign in
              </a>

              <a
                href="/register"
                className="inline-flex items-center justify-center px-4 py-1.5 text-sm font-bold text-white bg-[#5C6BC0] hover:bg-[#4d5cb5] active:bg-[#3f4ea3] rounded-md shadow-sm transition-all"
              >
                Sign up
              </a>
            </div>
          )}

          {/* Theme switch button */}
          <button
            type="button"
            onClick={toggleDarkMode}
            aria-label="Switch to dark mode"
            className="p-1.5 text-neutral-300 hover:text-white rounded-md transition-colors"
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
        <div className="md:hidden bg-neutral-900 border-b border-white/10 px-4 py-4 space-y-3">
          <div className="font-semibold text-xs text-neutral-400 uppercase tracking-wider">Tools</div>
          <div className="grid grid-cols-2 gap-2 text-xs text-neutral-300 pb-2">
            <a href="/pdf-converter" onClick={() => setIsMobileMenuOpen(false)} className="hover:text-white">PDF Converter</a>
            <a href="/video-converter" onClick={() => setIsMobileMenuOpen(false)} className="hover:text-white">Video Converter</a>
            <a href="/merge-pdf" onClick={() => setIsMobileMenuOpen(false)} className="hover:text-white">Merge PDF</a>
            <a href="/compress-pdf" onClick={() => setIsMobileMenuOpen(false)} className="hover:text-white">Compress PDF</a>
          </div>
          <div className="border-t border-white/10 pt-2 flex flex-col gap-1">
            <a
              href="/api/v2"
              onClick={() => setIsMobileMenuOpen(false)}
              className="px-2 py-1 text-sm text-neutral-300 hover:text-white"
            >
              API
            </a>
            <a
              href="/pricing"
              onClick={() => setIsMobileMenuOpen(false)}
              className="px-2 py-1 text-sm text-neutral-300 hover:text-white"
            >
              Pricing
            </a>
            <a
              href="/login"
              onClick={() => setIsMobileMenuOpen(false)}
              className="px-2 py-1 text-sm text-neutral-300 hover:text-white"
            >
              Sign in
            </a>
            <a
              href="/register"
              onClick={() => setIsMobileMenuOpen(false)}
              className="px-2 py-1 text-sm text-[#5C6BC0] hover:text-[#4d5cb5] font-semibold"
            >
              Sign up
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
