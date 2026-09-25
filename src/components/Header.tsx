'use client';

import React, { useState, useEffect } from 'react';
import Image from 'next/image';
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
  BookOpen,
  Cpu,
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
    <header className="sticky top-0 z-50 backdrop-blur-sm bg-neutral-900/95 border-b border-white/[0.08] text-white transition-colors">
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
          <a aria-label="EasyConvert" href="/" className="flex items-center gap-1.5 outline-none group shrink-0">
            <div className="flex items-center gap-3 md:text-2xl w-auto shrink-0">
              <Image
                src="/logo.svg"
                width={43}
                height={28}
                className="h-7 w-auto md:h-8 transition-transform duration-200 group-hover:scale-105"
                alt="EasyConvert Logo"
              />
              <span className="lowercase font-sans tracking-wide text-xl md:text-2xl text-white">
                <span className="font-normal">easy</span>
                <span className="font-bold">convert</span>
              </span>
            </div>
          </a>

          {/* Desktop Navigation: Tools, API, Pricing */}
          <nav className="hidden lg:flex items-center gap-1">
            {/* Tools Mega-Menu */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setIsToolsOpen(!isToolsOpen);
                  setIsApiOpen(false);
                }}
                className={`group relative flex items-center gap-1.5 px-2.5 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  isToolsOpen ? 'text-white bg-white/10' : 'text-neutral-300 hover:text-white hover:bg-white/5'
                }`}
              >
                <span>Tools</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isToolsOpen ? 'rotate-180 text-white' : 'text-neutral-400'}`} />
              </button>

              {isToolsOpen && (
                <div
                  className="absolute top-full left-0 mt-2 w-[820px] max-w-4xl rounded-xl bg-[#212529] border border-neutral-700/80 shadow-2xl p-6 z-50 animate-in fade-in slide-in-from-top-2 duration-150"
                >
                  {/* Top section: Convert Files (2 cols) & Optimize Files (1 col) */}
                  <div className="grid grid-cols-3 gap-6">
                    {/* Convert Files */}
                    <div className="col-span-2 space-y-2">
                      <div className="flex items-center gap-2 text-sm font-semibold text-neutral-300 mb-2">
                        <RefreshCw className="w-4 h-4 text-neutral-400" />
                        <span>Convert Files</span>
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-neutral-300 pt-1">
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

                    {/* Optimize Files */}
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-sm font-semibold text-neutral-300 mb-2">
                        <Sparkles className="w-4 h-4 text-neutral-400" />
                        <span>Optimize Files</span>
                      </div>
                      <div className="space-y-1.5 text-xs text-neutral-300 pt-1">
                        <a href="/compress-pdf" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Compress PDF</a>
                        <a href="/compress-png" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Compress PNG</a>
                        <a href="/compress-jpg" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Compress JPG</a>
                        <a href="/pdf-ocr" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">PDF OCR</a>
                      </div>
                    </div>
                  </div>

                  {/* Horizontal Divider */}
                  <div className="border-t border-neutral-700/60 my-5" />

                  {/* Bottom section: Merge Files, Capture Websites, Archives */}
                  <div className="grid grid-cols-3 gap-6">
                    <div>
                      <div className="flex items-center gap-2 text-sm font-semibold text-neutral-300 mb-2">
                        <Layers className="w-4 h-4 text-neutral-400" />
                        <span>Merge Files</span>
                      </div>
                      <div className="space-y-1 text-xs text-neutral-300">
                        <a href="/merge-pdf" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Merge PDF</a>
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center gap-2 text-sm font-semibold text-neutral-300 mb-2">
                        <Globe className="w-4 h-4 text-neutral-400" />
                        <span>Capture Websites</span>
                      </div>
                      <div className="space-y-1 text-xs text-neutral-300">
                        <a href="/save-website-as-pdf" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Save Website as PDF</a>
                        <a href="/website-png-screenshot" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Website PNG Screenshot</a>
                        <a href="/website-jpg-screenshot" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Website JPG Screenshot</a>
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center gap-2 text-sm font-semibold text-neutral-300 mb-2">
                        <Archive className="w-4 h-4 text-neutral-400" />
                        <span>Archives</span>
                      </div>
                      <div className="space-y-1 text-xs text-neutral-300">
                        <a href="/create-archive" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Create Archive</a>
                        <a href="/extract-archive" onClick={() => setIsToolsOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Extract Archive</a>
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
                className={`group relative flex items-center gap-1.5 px-2.5 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  isApiOpen ? 'text-white bg-white/10' : 'text-neutral-300 hover:text-white hover:bg-white/5'
                }`}
              >
                <span>API</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isApiOpen ? 'rotate-180 text-white' : 'text-neutral-400'}`} />
              </button>

              {isApiOpen && (
                <div
                  className="absolute top-full left-0 mt-2 w-[820px] max-w-4xl rounded-xl bg-[#212529] border border-neutral-700/80 shadow-2xl p-6 z-50 animate-in fade-in slide-in-from-top-2 duration-150"
                >
                  {/* Top Row: Convert Files, Capture Websites, Optimize Files */}
                  <div className="grid grid-cols-3 gap-6">
                    <div>
                      <div className="flex items-center gap-2 text-sm font-semibold text-neutral-300 mb-2">
                        <RefreshCw className="w-4 h-4 text-neutral-400" />
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
                    </div>

                    <div>
                      <div className="flex items-center gap-2 text-sm font-semibold text-neutral-300 mb-2">
                        <Globe className="w-4 h-4 text-neutral-400" />
                        <span>Capture Websites</span>
                      </div>
                      <div className="space-y-1.5 text-xs text-neutral-300">
                        <a href="/api/v2#html-pdf" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">HTML to PDF API</a>
                        <a href="/api/v2#screenshot" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Website Screenshot API</a>
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center gap-2 text-sm font-semibold text-neutral-300 mb-2">
                        <Sparkles className="w-4 h-4 text-neutral-400" />
                        <span>Optimize Files</span>
                      </div>
                      <div className="space-y-1.5 text-xs text-neutral-300">
                        <a href="/api/v2#compress-pdf" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Compress PDF API</a>
                        <a href="/api/v2#compress-images" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Compress Images API</a>
                      </div>
                    </div>
                  </div>

                  {/* Horizontal Split Line */}
                  <div className="border-t border-neutral-700/60 my-5" />

                  {/* Bottom Row: Other APIs, Integrations, Documentation */}
                  <div className="grid grid-cols-3 gap-6">
                    <div>
                      <div className="flex items-center gap-2 text-sm font-semibold text-neutral-300 mb-2.5 pb-1 border-b border-neutral-800">
                        <Layers className="w-4 h-4 text-neutral-400" />
                        <span>Other APIs</span>
                      </div>
                      <div className="space-y-1.5 text-xs text-neutral-300">
                        <a href="/api/v2#merge-pdf" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Merge PDF API</a>
                        <a href="/api/v2#thumbnails" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Thumbnail API</a>
                        <a href="/api/v2#watermark" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">Watermark API</a>
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center gap-2 text-sm font-semibold text-neutral-300 mb-2.5 pb-1 border-b border-neutral-800">
                        <Cpu className="w-4 h-4 text-neutral-400" />
                        <span>Integrations</span>
                      </div>
                      <div className="space-y-1.5 text-xs text-neutral-300">
                        <a href="/api/v2#integrations" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">No-Code Automation</a>
                        <a href="/api/v2#mcp-server" onClick={() => setIsApiOpen(false)} className="hover:text-white hover:underline transition-colors block py-0.5">MCP Server</a>
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center gap-2 text-sm font-semibold text-neutral-300 mb-2.5 pb-1 border-b border-neutral-800">
                        <BookOpen className="w-4 h-4 text-neutral-400" />
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
              className="px-2.5 py-1.5 text-sm font-medium text-neutral-300 hover:text-white rounded-md hover:bg-white/5 transition-colors"
            >
              Pricing
            </a>
          </nav>
        </div>

        {/* Right Section: Sign In, Sign Up, Theme Toggle */}
        <div className="flex items-center gap-2">
          {userEmail ? (
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-white bg-white/10 px-2.5 py-1.5 rounded-md border border-white/10 flex items-center gap-1.5">
                <User className="w-3.5 h-3.5 text-[#d9383a]" />
                <span className="truncate max-w-[120px]">{userEmail}</span>
              </span>
              <button
                type="button"
                onClick={handleSignOut}
                title="Sign out"
                className="p-1.5 text-neutral-400 hover:text-red-400 rounded-md transition-colors"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <a
                href="/login"
                className="hidden lg:inline-flex text-sm font-medium text-neutral-300 hover:text-white px-2.5 py-1.5 rounded-md hover:bg-white/5 transition-colors"
              >
                Sign in
              </a>

              <a
                href="/register"
                className="hidden lg:inline-flex items-center justify-center px-3 py-1.5 text-sm font-medium text-white bg-[#d9383a] hover:bg-[#c22e30] active:bg-[#a82325] rounded-md shadow-sm transition-all"
              >
                Sign up
              </a>
            </div>
          )}

          {/* Theme switch button */}
          <button
            type="button"
            onClick={toggleDarkMode}
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
            className="p-1.5 text-neutral-300 hover:text-white rounded-md hover:bg-white/5 transition-colors"
          >
            {isDark ? (
              <svg className="size-4 shrink-0 text-neutral-300 hover:text-white" viewBox="0 0 512 512" fill="currentColor">
                <path d="M256 0C114.6 0 0 114.6 0 256S114.6 512 256 512c68.8 0 131.3-27.2 177.3-71.4 7.3-7 9.4-17.9 5.3-27.1s-13.7-14.9-23.8-14.1c-4.9 .4-9.8 .6-14.8 .6-101.6 0-184-82.4-184-184 0-72.1 41.5-134.6 102.1-164.8 9.1-4.5 14.3-14.3 13.1-24.4S322.6 8.5 312.7 6.3C294.4 2.2 275.4 0 256 0z" />
              </svg>
            ) : (
              <svg className="size-4 shrink-0 text-neutral-300 hover:text-white" viewBox="0 0 512 512" fill="currentColor">
                <path d="M232 488c0 13.3 10.7 24 24 24s24-10.7 24-24l0-56c0-13.3-10.7-24-24-24s-24 10.7-24 24l0 56zm0-408c0 13.3 10.7 24 24 24s24-10.7 24-24l0-56c0-13.3-10.7-24-24-24s-24 10.7-24 24l0 56zM75 75c-9.4 9.4-9.4 24.6 0 33.9l39.6 39.6c9.4 9.4 24.6 9.4 33.9 0s9.4-24.6 0-33.9L108.9 75c-9.4-9.4-24.6-9.4-33.9 0zM363.5 363.5c-9.4 9.4-9.4 24.6 0 33.9L403.1 437c9.4 9.4 24.6 9.4 33.9 0s9.4-24.6 0-33.9l-39.6-39.6c-9.4-9.4-24.6-9.4-33.9 0zM0 256c0 13.3 10.7 24 24 24l56 0c13.3 0 24-10.7 24-24s-10.7-24-24-24l-56 0c-13.3 0-24 10.7-24 24zm408 0c0 13.3 10.7 24 24 24l56 0c13.3 0 24-10.7 24-24s-10.7-24-24-24l-56 0c-13.3 0-24 10.7-24 24zM75 437c9.4 9.4 24.6 9.4 33.9 0l39.6-39.6c9.4-9.4 9.4-24.6 0-33.9s-24.6-9.4-33.9 0L75 403.1c-9.4 9.4-9.4 24.6 0 33.9zM363.5 148.5c9.4 9.4 24.6 9.4 33.9 0L437 108.9c9.4-9.4 9.4-24.6 0-33.9s-24.6-9.4-33.9 0l-39.6 39.6c-9.4 9.4-9.4 24.6 0 33.9zM256 368a112 112 0 1 0 0-224 112 112 0 1 0 0 224z" />
              </svg>
            )}
          </button>

          {/* Mobile hamburger */}
          <button
            type="button"
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            aria-label="Open menu"
            className="lg:hidden p-1.5 text-neutral-300 hover:text-white"
          >
            {isMobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Mobile Drawer */}
      {isMobileMenuOpen && (
        <div className="lg:hidden bg-neutral-900 border-b border-white/10 px-4 py-4 space-y-3">
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
              className="px-2 py-1 text-sm text-[#d9383a] hover:text-[#c22e30] font-semibold"
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
