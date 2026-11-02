'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Sun, Moon, ChevronDown, Menu, X } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useModalDialog } from '@/hooks/useModalDialog';
import { useThemeToggle } from '@/hooks/useThemeToggle';
import BrandLogo from './BrandLogo';
import UserNav from './UserNav';
import LanguageSwitcher from './LanguageSwitcher';
import { PRIMARY_LINKS, TOOL_ROUTES } from './site-links';

function MobileMenuDialog({ onClose }: Readonly<{ onClose: () => void }>) {
  const t = useTranslations('header');
  const tLinks = useTranslations('siteLinks');
  const dialogRef = useRef<HTMLDialogElement>(null);

  useModalDialog(dialogRef, true, onClose);

  return (
    <dialog
      ref={dialogRef}
      aria-label={t('menuLabel')}
      className="w-[calc(100dvw-1.5rem)] max-w-sm rounded-md p-0 bg-surface text-ink border border-rule shadow-elev-2"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-rule">
        <BrandLogo size="sm" />
        <button
          type="button"
          onClick={onClose}
          aria-label={t('closeMenu')}
          className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-sm text-ink-2 hover:text-ink hover:bg-sunken transition-colors cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="p-4 space-y-4 overflow-y-auto max-h-[calc(100dvh-6rem)]">
        <nav aria-label={t('mobileNavLabel')} className="flex flex-col gap-1">
          {PRIMARY_LINKS.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              onClick={onClose}
              className="min-h-[44px] px-3 inline-flex items-center rounded-sm text-sm font-semibold text-ink hover:bg-sunken transition-colors"
            >
              {tLinks(item.key)}
            </Link>
          ))}
        </nav>

        <div className="pt-3 border-t border-rule">
          <p className="px-3 pb-1.5 text-xs font-semibold uppercase tracking-wider text-ink-3">
            {t('tools')}
          </p>
          <div className="grid grid-cols-1 gap-0.5">
            {TOOL_ROUTES.map((tool) => (
              <Link
                key={tool.key}
                href={tool.href}
                onClick={onClose}
                className="min-h-[44px] px-3 inline-flex items-center rounded-sm text-sm text-ink-2 hover:text-ink hover:bg-sunken transition-colors"
              >
                {tLinks(tool.key)}
              </Link>
            ))}
          </div>
        </div>

        <div className="pt-3 border-t border-rule">
          <LanguageSwitcher />
        </div>

        <div className="pt-3 border-t border-rule">
          <UserNav mobile onItemClick={onClose} />
        </div>
      </div>
    </dialog>
  );
}

export default function Header() {
  const t = useTranslations('header');
  const tLinks = useTranslations('siteLinks');
  const tTheme = useTranslations('theme');
  const { isDark, toggleDarkMode } = useThemeToggle();
  const [isToolsOpen, setIsToolsOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const toolsContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isToolsOpen) return;

    const handleOutsideClick = (event: MouseEvent) => {
      if (toolsContainerRef.current && !toolsContainerRef.current.contains(event.target as Node)) {
        setIsToolsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsToolsOpen(false);
    };

    document.addEventListener('mousedown', handleOutsideClick);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isToolsOpen]);

  return (
    <header className="bg-surface/80 backdrop-blur-xl text-ink border-b border-rule sticky top-0 z-40 h-[var(--header-height)]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-full flex items-center justify-between gap-4">
        <div className="flex items-center gap-6 min-w-0">
          <Link
            href="/"
            aria-label={t('homeLabel')}
            className="min-h-[44px] inline-flex items-center shrink-0 rounded-sm"
          >
            <BrandLogo size="md" />
          </Link>

          <nav aria-label={t('primaryNavLabel')} className="hidden lg:flex items-center gap-1 whitespace-nowrap">
            <div className="relative" ref={toolsContainerRef}>
              <button
                type="button"
                onClick={() => setIsToolsOpen((open) => !open)}
                aria-haspopup="true"
                aria-expanded={isToolsOpen}
                className={`min-h-[44px] px-3 inline-flex items-center gap-1.5 text-sm font-medium rounded-sm transition-colors cursor-pointer ${
                  isToolsOpen
                    ? 'text-ink'
                    : 'text-ink-2 hover:text-ink'
                }`}
              >
                <span>{t('tools')}</span>
                <ChevronDown
                  className={`w-3.5 h-3.5 transition-transform duration-150 ${
                    isToolsOpen ? 'rotate-180' : ''
                  }`}
                />
              </button>

              {isToolsOpen && (
                <div className="absolute top-full left-0 mt-2 max-w-[calc(100dvw-2rem)] w-[380px] rounded-md bg-surface text-ink border border-rule shadow-elev-1 p-3 z-50">
                  <div className="grid grid-cols-2 gap-1">
                    {TOOL_ROUTES.map((tool) => (
                      <Link
                        key={tool.key}
                        href={tool.href}
                        onClick={() => setIsToolsOpen(false)}
                        className="min-h-[44px] sm:min-h-[40px] px-2.5 py-2 rounded-sm text-xs font-medium text-ink-2 hover:text-ink hover:bg-sunken inline-flex items-center transition-colors"
                      >
                        {tLinks(tool.key)}
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {PRIMARY_LINKS.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                className="min-h-[44px] px-3 inline-flex items-center text-sm font-medium text-ink-2 hover:text-ink rounded-sm transition-colors"
              >
                {tLinks(item.key)}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <LanguageSwitcher className="hidden lg:block" />

          <button
            type="button"
            onClick={toggleDarkMode}
            aria-label={isDark ? tTheme('toLight') : tTheme('toDark')}
            className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-sm text-ink-2 hover:text-ink hover:bg-sunken transition-colors cursor-pointer"
          >
            {isDark ? (
              <Sun className="size-4 shrink-0" />
            ) : (
              <Moon className="size-4 shrink-0" />
            )}
          </button>

          <div className="hidden lg:flex items-center gap-1.5 whitespace-nowrap">
            <UserNav />
          </div>

          <button
            type="button"
            onClick={() => setIsMobileMenuOpen(true)}
            aria-label={t('openMenu')}
            aria-expanded={isMobileMenuOpen}
            className="lg:hidden min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-sm text-ink-2 hover:text-ink hover:bg-sunken transition-colors cursor-pointer"
          >
            <Menu className="w-5 h-5" />
          </button>
        </div>
      </div>

      {isMobileMenuOpen && <MobileMenuDialog onClose={() => setIsMobileMenuOpen(false)} />}
    </header>
  );
}
