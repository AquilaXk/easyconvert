'use client';

import React, { useState, useEffect, useRef } from 'react';
import BrandLogo from './BrandLogo';
import { Globe, ChevronDown, Moon, Sun, ShieldCheck } from 'lucide-react';

interface DirectoryCategory {
  title: string;
  links: { label: string; href: string }[];
}

const DIRECTORY_CATEGORIES: DirectoryCategory[] = [
  {
    title: 'Video Converter',
    links: [
      { label: 'MP4 Converter', href: '/mp4-converter' },
      { label: 'Video to GIF', href: '/video-to-gif' },
      { label: 'MOV to MP4', href: '/mov-to-mp4' },
      { label: 'Video Converter', href: '/video-converter' },
    ],
  },
  {
    title: 'Audio Converter',
    links: [
      { label: 'MP3 Converter', href: '/mp3-converter' },
      { label: 'MP4 to MP3', href: '/mp4-to-mp3' },
      { label: 'Video to MP3', href: '/video-to-mp3' },
      { label: 'Audio Converter', href: '/audio-converter' },
    ],
  },
  {
    title: 'Image Converter',
    links: [
      { label: 'JPG to PDF', href: '/jpg-to-pdf' },
      { label: 'PDF to JPG', href: '/pdf-to-jpg' },
      { label: 'HEIC to JPG', href: '/heic-to-jpg' },
      { label: 'Image to PDF', href: '/image-to-pdf' },
      { label: 'Image Converter', href: '/image-converter' },
    ],
  },
  {
    title: 'Document & Ebook',
    links: [
      { label: 'PDF to WORD', href: '/pdf-to-docx' },
      { label: 'EPUB to PDF', href: '/epub-to-pdf' },
      { label: 'EPUB to MOBI', href: '/epub-to-mobi' },
      { label: 'Document Converter', href: '/document-converter' },
    ],
  },
  {
    title: 'Archive & Compression',
    links: [
      { label: 'RAR to Zip', href: '/rar-to-zip' },
      { label: '7Z to Zip', href: '/7z-to-zip' },
      { label: 'Compress PDF', href: '/compress-pdf' },
      { label: 'Archive Converter', href: '/archive-converter' },
    ],
  },
  {
    title: 'Data & Unit Tools',
    links: [
      { label: 'CSV to JSON', href: '/csv-to-json' },
      { label: 'JSON to CSV', href: '/json-to-csv' },
      { label: 'Lbs to Kg', href: '/lbs-to-kg' },
      { label: 'Unit Converter', href: '/unit-converter' },
    ],
  },
  {
    title: 'Web Apps',
    links: [
      { label: 'Save Website as PDF', href: '/save-website-as-pdf' },
      { label: 'Image Resizer', href: '/image-converter' },
      { label: 'Website Screenshot', href: '/website-png-screenshot' },
      { label: 'PDF OCR Studio', href: '/pdf-ocr' },
    ],
  },
  {
    title: 'Client & Edge Tools',
    links: [
      { label: 'In-Memory Muxer', href: '/mp4-converter' },
      { label: 'Lossless Optimizer', href: '/compress-png' },
      { label: 'Vector Graphic Studio', href: '/vector-converter' },
      { label: 'Zero-Retention Pipeline', href: '/security' },
    ],
  },
];


const AVAILABLE_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ko', label: '한국어' },
  { code: 'ja', label: '日本語' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
];

export default function Footer() {
  const [isDark, setIsDark] = useState(true);
  const [currentLang, setCurrentLang] = useState('English');
  const [isLangOpen, setIsLangOpen] = useState(false);
  const langRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const isDarkMode = document.documentElement.classList.contains('dark');
    setIsDark(isDarkMode);

    const savedLang = localStorage.getItem('easyconvert_lang');
    if (savedLang) setCurrentLang(savedLang);

    const handleThemeChange = (e: CustomEvent) => {
      if (e.detail?.theme) {
        setIsDark(e.detail.theme === 'dark');
      }
    };
    window.addEventListener('easyconvert-theme-change' as any, handleThemeChange);

    const handleClickOutside = (event: MouseEvent) => {
      if (langRef.current && !langRef.current.contains(event.target as Node)) {
        setIsLangOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      window.removeEventListener('easyconvert-theme-change' as any, handleThemeChange);
      document.removeEventListener('mousedown', handleClickOutside);
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
    <footer className="bg-[#0B0F19] text-slate-300 border-t border-[#1E2640] transition-colors mt-auto font-sans">
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-14 pb-10">
        {/* Categorized Converter Directory Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-4 xl:grid-cols-8 gap-x-8 gap-y-10">
          {DIRECTORY_CATEGORIES.map((category) => (
            <div key={category.title} className="flex flex-col">
              <h3 className="text-white font-semibold text-[15px] mb-3.5 tracking-tight">
                {category.title}
              </h3>
              <ul className="space-y-2.5">
                {category.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      className="text-slate-400 hover:text-[#8E9CE6] text-[13.5px] transition-colors duration-150 block leading-snug"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Secondary Navigation Row */}
        <div className="pt-10 mt-10 border-t border-[#1E2640]">
          <nav className="flex flex-wrap items-center gap-x-7 gap-y-3 text-[13.5px]">
            <a href="/about" className="text-slate-400 hover:text-white transition-colors duration-150 font-medium">About Us</a>
            <a href="/#how-it-works" className="text-slate-400 hover:text-white transition-colors duration-150 font-medium">How It Works</a>
            <a href="/#format-catalog" className="text-slate-400 hover:text-white transition-colors duration-150 font-medium">Formats</a>
            <a href="/privacy" className="text-slate-400 hover:text-white transition-colors duration-150 font-medium">Privacy</a>
            <a href="/terms" className="text-slate-400 hover:text-white transition-colors duration-150 font-medium">Terms</a>
            <a href="/security" className="text-slate-400 hover:text-white transition-colors duration-150 font-medium">Security</a>
            <a href="/contact" className="text-slate-400 hover:text-white transition-colors duration-150 font-medium">Contact</a>
            <a href="/status" className="text-slate-400 hover:text-white transition-colors duration-150 font-medium">Status</a>
          </nav>
        </div>

        {/* Bottom Bar: Brand, Privacy Badge, Copyright, Language, Theme */}
        <div className="pt-8 mt-6 border-t border-[#1E2640]/80 flex flex-col md:flex-row items-center justify-between gap-5">
          {/* Brand & Identity */}
          <div className="flex items-center gap-3">
            <a href="/" className="flex items-center gap-2.5 group">
              <BrandLogo size="sm" textClassName="text-white" />
            </a>
          </div>

          {/* Privacy Badge & Copyright */}
          <div className="flex flex-wrap items-center justify-center gap-3 text-[13px] text-slate-400">
            <span>© 2026 EasyConvert.com v2.30 All rights reserved.</span>
            <span className="hidden sm:inline-block text-slate-600">•</span>
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-[#131726] border border-[#2A3558] text-[#8E9CE6] shadow-sm">
              <ShieldCheck className="w-3.5 h-3.5 text-[#5C6BC0]" />
              <span>100% Client-Side & Zero-Server Retention</span>
            </div>
          </div>

          {/* Controls: Language Selector & Theme Toggle */}
          <div className="flex items-center gap-3">
            {/* Language Selector Dropdown */}
            <div className="relative" ref={langRef}>
              <button
                type="button"
                onClick={() => setIsLangOpen(!isLangOpen)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-300 hover:text-white bg-[#131726] border border-[#1E2640] hover:border-[#2A3558] transition-colors cursor-pointer"
                aria-label="Select Language"
              >
                <Globe className="w-3.5 h-3.5 text-slate-400" />
                <span>{currentLang}</span>
                <ChevronDown
                  className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-150 ${
                    isLangOpen ? 'rotate-180' : ''
                  }`}
                />
              </button>

              {isLangOpen && (
                <div className="absolute right-0 bottom-full mb-2 w-36 rounded-lg bg-[#181E30] border border-[#2A3558] shadow-xl py-1 z-50 animate-in fade-in duration-100">
                  {AVAILABLE_LANGUAGES.map((lang) => (
                    <button
                      key={lang.code}
                      type="button"
                      onClick={() => {
                        setCurrentLang(lang.label);
                        localStorage.setItem('easyconvert_lang', lang.label);
                        setIsLangOpen(false);
                      }}
                      className={`w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center justify-between ${
                        currentLang === lang.label
                          ? 'text-[#8E9CE6] font-semibold bg-[#202740]'
                          : 'text-slate-300 hover:text-white hover:bg-[#202740]/60'
                      }`}
                    >
                      {lang.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Dark / Light Mode Switch */}
            <button
              type="button"
              onClick={toggleDarkMode}
              aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white bg-[#131726] border border-[#1E2640] hover:border-[#2A3558] transition-colors cursor-pointer"
            >
              {isDark ? (
                <Sun className="w-4 h-4 text-amber-400" />
              ) : (
                <Moon className="w-4 h-4 text-slate-300" />
              )}
            </button>
          </div>
        </div>
      </div>
    </footer>
  );
}


