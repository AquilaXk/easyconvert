'use client';

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { Sun, Moon, ChevronDown, Menu, X } from 'lucide-react';
import BrandLogo from './BrandLogo';
import UserNav from './UserNav';

interface ToolRoute {
  label: string;
  href: string;
}

const TOOL_ROUTES: readonly ToolRoute[] = [
  { label: 'PDF Converter', href: '/pdf-converter' },
  { label: 'Image Converter', href: '/image-converter' },
  { label: 'Video Converter', href: '/video-converter' },
  { label: 'Audio Converter', href: '/audio-converter' },
  { label: 'Archive Converter', href: '/archive-converter' },
  { label: 'Spreadsheet Converter', href: '/spreadsheet-converter' },
  { label: 'Unit Converter', href: '/unit-converter' },
  { label: 'PDF OCR', href: '/pdf-ocr' },
  { label: 'Compress PDF', href: '/compress-pdf' },
  { label: 'Merge PDF', href: '/merge-pdf' },
  { label: 'System Status', href: '/status' },
];

const PRIMARY_LINKS: readonly ToolRoute[] = [
  { label: 'Formats', href: '/#format-catalog' },
  { label: 'How It Works', href: '/#how-it-works' },
  { label: 'API Docs', href: '/api-docs' },
  { label: 'Dashboard', href: '/dashboard' },
];

interface ThemeEventDetail {
  theme?: string;
}

function MobileMenuDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && typeof dialog.showModal === 'function' && !dialog.open) {
      dialog.showModal();
    }
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-label="Navigation menu"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
      className="w-[calc(100dvw-1.5rem)] max-w-sm rounded-xl p-0 bg-white dark:bg-dark-surface text-brand-950 dark:text-white border border-neutral-border dark:border-dark-border shadow-2xl"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-border dark:border-dark-border">
        <BrandLogo size="sm" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close menu"
          className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-md text-ink-secondary dark:text-slate-300 hover:text-brand-950 dark:hover:text-white hover:bg-neutral-subtle dark:hover:bg-white/10 transition-colors cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="p-4 space-y-4 overflow-y-auto max-h-[calc(100dvh-6rem)]">
        <nav aria-label="Mobile primary" className="flex flex-col gap-1">
          {PRIMARY_LINKS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={onClose}
              className="min-h-[44px] px-3 inline-flex items-center rounded-md text-sm font-semibold text-brand-950 dark:text-white hover:bg-neutral-subtle dark:hover:bg-white/5 transition-colors"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="pt-3 border-t border-neutral-border dark:border-dark-border">
          <p className="px-3 pb-1.5 text-xs font-semibold uppercase tracking-wider text-ink-muted dark:text-dark-muted">
            Tools
          </p>
          <div className="grid grid-cols-1 gap-0.5">
            {TOOL_ROUTES.map((tool) => (
              <Link
                key={tool.href}
                href={tool.href}
                onClick={onClose}
                className="min-h-[44px] px-3 inline-flex items-center rounded-md text-sm text-ink-secondary dark:text-slate-300 hover:text-brand-950 dark:hover:text-white hover:bg-neutral-subtle dark:hover:bg-white/5 transition-colors"
              >
                {tool.label}
              </Link>
            ))}
          </div>
        </div>

        <div className="pt-3 border-t border-neutral-border dark:border-dark-border">
          <UserNav mobile onItemClick={onClose} />
        </div>
      </div>
    </dialog>
  );
}

export default function Header() {
  const [isDark, setIsDark] = useState(false);
  const [isToolsOpen, setIsToolsOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const toolsContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains('dark'));

    const handleThemeChange: EventListener = (event) => {
      const custom = event as CustomEvent<ThemeEventDetail>;
      if (custom.detail?.theme) {
        setIsDark(custom.detail.theme === 'dark');
      }
    };

    window.addEventListener('easyconvert-theme-change', handleThemeChange);
    return () => {
      window.removeEventListener('easyconvert-theme-change', handleThemeChange);
    };
  }, []);

  useEffect(() => {
    if (!isToolsOpen) return;

    const handleOutsideClick = (event: MouseEvent) => {
      if (toolsContainerRef.current && !toolsContainerRef.current.contains(event.target as Node)) {
        setIsToolsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsToolsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isToolsOpen]);

  const toggleDarkMode = () => {
    const nextTheme = isDark ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', nextTheme === 'dark');
    localStorage.theme = nextTheme;
    setIsDark(nextTheme === 'dark');
    window.dispatchEvent(new CustomEvent('easyconvert-theme-change', { detail: { theme: nextTheme } }));
  };

  return (
    <header className="bg-brand-950 dark:bg-[#111526] text-white border-b border-white/10 sticky top-0 z-40 h-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-full flex items-center justify-between gap-4">
        <div className="flex items-center gap-6 min-w-0">
          <Link
            href="/"
            aria-label="EasyConvert Home"
            className="min-h-[44px] inline-flex items-center shrink-0 rounded-md"
          >
            <BrandLogo size="md" textClassName="text-white" />
          </Link>

          <nav aria-label="Primary" className="hidden lg:flex items-center gap-1 whitespace-nowrap">
            <div className="relative" ref={toolsContainerRef}>
              <button
                type="button"
                onClick={() => setIsToolsOpen((open) => !open)}
                aria-haspopup="true"
                aria-expanded={isToolsOpen}
                className={`min-h-[44px] px-3 inline-flex items-center gap-1.5 text-sm font-medium rounded-md transition-colors cursor-pointer ${
                  isToolsOpen
                    ? 'bg-white/15 text-white'
                    : 'text-slate-200 hover:text-white hover:bg-white/10'
                }`}
              >
                <span>Tools</span>
                <ChevronDown
                  className={`w-3.5 h-3.5 transition-transform duration-150 ${
                    isToolsOpen ? 'rotate-180 text-white' : 'text-slate-300'
                  }`}
                />
              </button>

              {isToolsOpen && (
                <div className="absolute top-full left-0 mt-2 max-w-[calc(100dvw-2rem)] w-[380px] rounded-xl bg-white dark:bg-dark-surface text-brand-950 dark:text-white border border-neutral-border dark:border-dark-border shadow-xl p-3 z-50">
                  <div className="grid grid-cols-2 gap-1">
                    {TOOL_ROUTES.map((tool) => (
                      <Link
                        key={tool.href}
                        href={tool.href}
                        onClick={() => setIsToolsOpen(false)}
                        className="min-h-[40px] px-2.5 py-2 rounded-md text-xs font-medium text-ink-secondary dark:text-slate-300 hover:text-brand-950 dark:hover:text-white hover:bg-neutral-subtle dark:hover:bg-white/10 inline-flex items-center transition-colors"
                      >
                        {tool.label}
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {PRIMARY_LINKS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="min-h-[44px] px-3 inline-flex items-center text-sm font-medium text-slate-200 hover:text-white hover:bg-white/10 rounded-md transition-colors"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={toggleDarkMode}
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-md text-slate-200 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
          >
            {isDark ? (
              <Sun className="size-4 shrink-0 text-amber-300" />
            ) : (
              <Moon className="size-4 shrink-0 text-slate-200" />
            )}
          </button>

          <div className="hidden lg:flex items-center gap-1.5 whitespace-nowrap">
            <UserNav />
          </div>

          <button
            type="button"
            onClick={() => setIsMobileMenuOpen(true)}
            aria-label="Open menu"
            aria-expanded={isMobileMenuOpen}
            className="lg:hidden min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-md text-slate-200 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
          >
            <Menu className="w-5 h-5" />
          </button>
        </div>
      </div>

      {isMobileMenuOpen && <MobileMenuDialog onClose={() => setIsMobileMenuOpen(false)} />}
    </header>
  );
}
