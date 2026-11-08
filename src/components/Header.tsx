'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Sun, Moon, ChevronDown, Menu } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useThemeToggle } from '@/hooks/useThemeToggle';
import BrandLogo from './BrandLogo';
import UserNav from './UserNav';
import MobileMenu from './MobileMenu';
import LanguageSwitcher from './LanguageSwitcher';
import { PRIMARY_LINKS, TOOL_ROUTES } from './site-links';

export default function Header() {
  const t = useTranslations('header');
  const tLinks = useTranslations('siteLinks');
  const tTheme = useTranslations('theme');
  const { isDark, toggleDarkMode } = useThemeToggle();
  const [isToolsOpen, setIsToolsOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const toolsContainerRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const menuWasOpen = useRef(false);

  // The sheet is a modal dialog that makes the page inert while it stands, so focus goes back to the menu button once it is gone.
  useEffect(() => {
    if (menuWasOpen.current && !isMobileMenuOpen) menuButtonRef.current?.focus();
    menuWasOpen.current = isMobileMenuOpen;
  }, [isMobileMenuOpen]);

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
    <header data-sticky-header className="bg-surface/80 backdrop-blur-xl text-ink border-b border-rule sticky top-0 z-40 h-[var(--header-height)]">
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
                className={`px-2.5 py-1.5 inline-flex items-center gap-1.5 text-sm font-medium rounded-xs transition-colors cursor-pointer hover:text-ink hover:bg-sunken/50 ${
                  isToolsOpen ? 'text-ink bg-sunken/50' : 'text-ink-2'
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
                        className="min-h-[44px] sm:min-h-[40px] px-2.5 py-2 rounded-xs text-xs font-medium text-ink-2 hover:text-ink hover:bg-sunken/50 inline-flex items-center transition-colors"
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
                className="px-2.5 py-1.5 inline-flex items-center text-sm font-medium text-ink-2 hover:text-ink hover:bg-sunken/50 rounded-xs transition-colors"
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
            className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-xs text-ink-2 hover:text-ink hover:bg-sunken/50 transition-colors cursor-pointer"
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
            ref={menuButtonRef}
            type="button"
            onClick={() => setIsMobileMenuOpen(true)}
            aria-label={t('openMenu')}
            aria-expanded={isMobileMenuOpen}
            className="lg:hidden min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-xs text-ink-2 hover:text-ink hover:bg-sunken/50 transition-colors cursor-pointer"
          >
            <Menu className="w-5 h-5" />
          </button>
        </div>
      </div>

      {isMobileMenuOpen && <MobileMenu onClose={() => setIsMobileMenuOpen(false)} />}
    </header>
  );
}
