'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Sun, Moon, ChevronDown, Menu, RefreshCw, ArrowRightLeft, FileText, Archive, Minimize2 } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useThemeToggle } from '@/hooks/useThemeToggle';
import BrandLogo from './BrandLogo';
import UserNav from './UserNav';
import MobileMenu from './MobileMenu';
import LanguageSwitcher from './LanguageSwitcher';
import { primaryLinksFor, TOOL_GROUPS, type SiteLink, type ToolGroup } from './site-links';
import { useViewerAccount } from '@/hooks/useViewerPlan';
import type { SessionUser } from '@/lib/viewer-plan';

const GROUP_ICONS: Readonly<Record<ToolGroup['key'], React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>>> = {
  converters: ArrowRightLeft,
  pdfTools: FileText,
  archives: Archive,
  compressImages: Minimize2,
};

function ToolMenuSection({
  groupKey,
  links,
  columns = 1,
  onSelect,
}: Readonly<{
  groupKey: ToolGroup['key'];
  links: readonly SiteLink[];
  columns?: 1 | 2;
  onSelect: () => void;
}>) {
  const tGroups = useTranslations('header.toolGroups');
  const tLinks = useTranslations('siteLinks');
  const Icon = GROUP_ICONS[groupKey];
  return (
    <div className="flex flex-col min-w-0">
      <div className="flex items-center gap-2.5 mb-1.5">
        <Icon aria-hidden={true} className="size-4 text-ink-3 shrink-0" />
        <span className="flex-1 pb-2 border-b border-rule text-sm font-medium text-ink truncate">{tGroups(groupKey)}</span>
      </div>
      <ul className={columns === 2 ? 'ps-[26px] grid grid-cols-2 gap-x-5 gap-y-0.5' : 'ps-[26px] flex flex-col gap-0.5'}>
        {links.map((tool) => (
          <li key={tool.key} className="min-w-0">
            <Link
              href={tool.href}
              onClick={onSelect}
              className="w-full min-h-[32px] px-2 -mx-2 py-1.5 rounded-xs text-sm font-medium text-ink-2 hover:text-ink hover:bg-sunken/50 inline-flex items-center transition-colors"
            >
              {tLinks(tool.key as Parameters<typeof tLinks>[0])}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Header({ initialUser }: Readonly<{ initialUser?: SessionUser }> = {}) {
  const t = useTranslations('header');
  const tLinks = useTranslations('siteLinks');
  const tTheme = useTranslations('theme');
  const { isDark, toggleDarkMode } = useThemeToggle();
  const signedIn = useViewerAccount(initialUser) !== null;
  const [isToolsOpen, setIsToolsOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const toolsContainerRef = useRef<HTMLDivElement>(null);
  const toolsButtonRef = useRef<HTMLButtonElement>(null);
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
    // Tab out of the last tool, or any other move of focus out of the menu, closes it as a click outside does.
    const handleFocusIn = (event: FocusEvent) => {
      if (toolsContainerRef.current && !toolsContainerRef.current.contains(event.target as Node)) {
        setIsToolsOpen(false);
      }
    };
    // Escape from inside the menu gives focus back to the button that opened it, since the item that had it is gone.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (toolsContainerRef.current?.contains(document.activeElement)) toolsButtonRef.current?.focus();
      setIsToolsOpen(false);
    };

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('focusin', handleFocusIn);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('focusin', handleFocusIn);
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
                ref={toolsButtonRef}
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
                <div className="absolute top-full left-0 mt-2 max-w-[calc(100dvw-2rem)] w-[920px] rounded-xs bg-surface text-ink border border-rule shadow-elev-2 p-5 z-50 whitespace-normal">
                  <div className="grid grid-cols-12 gap-7">
                    <div className="col-span-4 min-w-0">
                      <Link
                        href="/"
                        onClick={() => setIsToolsOpen(false)}
                        className="rounded-xs border border-rule bg-sunken/40 hover:bg-sunken p-4 flex items-start gap-3.5 transition-colors"
                      >
                        <RefreshCw aria-hidden={true} className="size-5 text-ink-3 shrink-0 mt-0.5" />
                        <div className="min-w-0">
                          <span className="block text-sm font-semibold text-ink">{t('fileConverterTitle')}</span>
                          <span className="mt-1 block text-xs leading-relaxed text-ink-3">{t('fileConverterDescription')}</span>
                        </div>
                      </Link>
                    </div>
                    <div className="col-span-3 flex flex-col gap-6 min-w-0">
                      <ToolMenuSection
                        groupKey={TOOL_GROUPS[0].key}
                        links={TOOL_GROUPS[0].links}
                        onSelect={() => setIsToolsOpen(false)}
                      />
                      <ToolMenuSection
                        groupKey={TOOL_GROUPS[2].key}
                        links={TOOL_GROUPS[2].links}
                        onSelect={() => setIsToolsOpen(false)}
                      />
                    </div>
                    <div className="col-span-5 flex flex-col gap-6 min-w-0">
                      <ToolMenuSection
                        groupKey={TOOL_GROUPS[1].key}
                        links={TOOL_GROUPS[1].links}
                        columns={2}
                        onSelect={() => setIsToolsOpen(false)}
                      />
                      <ToolMenuSection
                        groupKey={TOOL_GROUPS[3].key}
                        links={TOOL_GROUPS[3].links}
                        onSelect={() => setIsToolsOpen(false)}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {primaryLinksFor(signedIn).map((item) => (
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
            <UserNav initialUser={initialUser} />
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

      {isMobileMenuOpen && <MobileMenu onClose={() => setIsMobileMenuOpen(false)} initialUser={initialUser} />}
    </header>
  );
}
