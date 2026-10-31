'use client';

import React from 'react';
import Link from 'next/link';
import { Moon, Sun, ShieldCheck } from 'lucide-react';
import { useThemeToggle } from '@/hooks/useThemeToggle';
import BrandLogo from './BrandLogo';

interface DirectoryCategory {
  title: string;
  links: { label: string; href: string }[];
}

const DIRECTORY_CATEGORIES: readonly DirectoryCategory[] = [
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
      { label: 'PDF to Word', href: '/pdf-to-docx' },
      { label: 'EPUB to PDF', href: '/epub-to-pdf' },
      { label: 'Document Converter', href: '/document-converter' },
    ],
  },
  {
    title: 'Archive & Compression',
    links: [
      { label: 'RAR to ZIP', href: '/rar-to-zip' },
      { label: '7Z to ZIP', href: '/7z-to-zip' },
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
      { label: 'PDF OCR', href: '/pdf-ocr' },
    ],
  },
  {
    title: 'Client & Edge Tools',
    links: [
      { label: 'MP4 Remuxer', href: '/mp4-converter' },
      { label: 'Lossless PNG', href: '/compress-png' },
      { label: 'Vector Converter', href: '/vector-converter' },
      { label: 'Security Architecture', href: '/security' },
    ],
  },
];

const SECONDARY_LINKS: readonly { label: string; href: string }[] = [
  { label: 'About Us', href: '/about' },
  { label: 'How It Works', href: '/#how-it-works' },
  { label: 'Formats', href: '/#format-catalog' },
  { label: 'API Docs', href: '/api-docs' },
  { label: 'Privacy', href: '/privacy' },
  { label: 'Terms', href: '/terms' },
  { label: 'Security', href: '/security' },
  { label: 'Accessibility', href: '/accessibility' },
  { label: 'Contact', href: '/contact' },
  { label: 'Status', href: '/status' },
];

export default function Footer() {
  const { isDark, toggleDarkMode } = useThemeToggle();

  return (
    <footer className="bg-white dark:bg-[#0E111D] text-ink-secondary dark:text-slate-300 border-t border-neutral-border dark:border-dark-border transition-colors mt-auto font-sans">
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-12 pb-8">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-4 xl:grid-cols-8 gap-x-6 gap-y-8">
          {DIRECTORY_CATEGORIES.map((category) => (
            <div key={category.title} className="flex flex-col min-w-0">
              <h2 className="text-brand-950 dark:text-white font-semibold text-sm mb-3 tracking-tight">
                {category.title}
              </h2>
              <ul className="space-y-1 sm:space-y-2">
                {category.links.map((link) => (
                  <li key={`${category.title}-${link.label}`}>
                    <Link
                      href={link.href}
                      className="min-h-[44px] sm:min-h-0 inline-flex items-center text-ink-secondary hover:text-brand-700 dark:text-slate-400 dark:hover:text-white text-[13px] transition-colors leading-snug py-0.5"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="pt-8 mt-10 border-t border-neutral-border dark:border-dark-border">
          <nav aria-label="Footer secondary" className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[13px]">
            {SECONDARY_LINKS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="min-h-[44px] sm:min-h-[36px] inline-flex items-center text-ink-secondary hover:text-brand-950 dark:text-slate-400 dark:hover:text-white transition-colors font-medium"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="pt-6 mt-6 border-t border-neutral-border/80 dark:border-dark-border flex flex-col sm:flex-row items-center justify-between gap-4">
          <Link href="/" className="inline-flex items-center gap-2.5 min-h-[44px] rounded-md">
            <BrandLogo size="sm" textClassName="text-brand-950 dark:text-white" />
          </Link>

          <div className="flex flex-wrap items-center justify-center gap-3 text-xs text-ink-muted dark:text-slate-400">
            <span>© 2026 EasyConvert.com</span>
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-neutral-subtle dark:bg-dark-surface border border-neutral-border dark:border-dark-border text-ink-secondary dark:text-slate-300">
              <ShieldCheck className="w-3.5 h-3.5 text-brand-700 dark:text-brand-400 shrink-0" />
              <span>Encrypted Transfer &amp; Ephemeral Processing</span>
            </div>
          </div>

          <button
            type="button"
            onClick={toggleDarkMode}
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            className="min-w-[44px] sm:min-w-[36px] min-h-[44px] sm:min-h-[36px] inline-flex items-center justify-center rounded-md text-ink-secondary hover:text-brand-950 bg-neutral-subtle hover:bg-neutral-border/60 border border-neutral-border dark:bg-dark-surface dark:border-dark-border dark:text-slate-300 dark:hover:text-white transition-colors cursor-pointer"
          >
            {isDark ? (
              <Sun className="w-4 h-4 text-amber-400" />
            ) : (
              <Moon className="w-4 h-4 text-ink-secondary" />
            )}
          </button>
        </div>
      </div>
    </footer>
  );
}
