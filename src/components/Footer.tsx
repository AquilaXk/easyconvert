'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Moon, Sun } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useThemeToggle } from '@/hooks/useThemeToggle';
import { FOOTER_COLUMNS } from './site-links';

export default function Footer() {
  const t = useTranslations('footer');
  const tLinks = useTranslations('siteLinks');
  const tTheme = useTranslations('theme');
  const { isDark, toggleDarkMode } = useThemeToggle();

  return (
    <footer className="bg-sunken text-ink border-t border-rule mt-auto">
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 lg:flex lg:items-start lg:justify-between lg:gap-x-3">
        <div className="mt-8 flex flex-col items-center text-sm lg:mt-0 lg:flex-1 lg:items-start lg:order-1">
          <span>{t('copyright')}</span>
        </div>

        <nav
          aria-label={t('navLabel')}
          className="mt-8 grid grid-cols-2 gap-8 md:grid-flow-col md:auto-cols-fr lg:mt-0 lg:order-2"
        >
          {FOOTER_COLUMNS.map((column) => (
            <div key={column.key}>
              <h2 className="text-sm font-semibold">{t(`columns.${column.key}`)}</h2>
              <ul className="mt-4 space-y-4">
                {column.links.map((link) => (
                  <li key={link.key}>
                    <Link
                      href={link.href}
                      className="inline-flex items-center rounded-xs text-sm font-medium text-accent-ink hover:underline transition-colors"
                    >
                      {tLinks(link.key)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="mt-8 flex items-center justify-center lg:mt-0 lg:flex-1 lg:justify-end lg:order-3">
          <button
            type="button"
            onClick={toggleDarkMode}
            aria-label={isDark ? tTheme('toLight') : tTheme('toDark')}
            className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-xs text-ink-2 hover:text-ink hover:bg-canvas/60 transition-colors cursor-pointer"
          >
            {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </div>
      </div>
    </footer>
  );
}
