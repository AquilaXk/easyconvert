'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Moon, Sun, ShieldCheck } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useThemeToggle } from '@/hooks/useThemeToggle';
import BrandLogo from './BrandLogo';
import { DIRECTORY_CATEGORIES, SECONDARY_LINKS } from './site-links';

export default function Footer() {
  const t = useTranslations('footer');
  const tLinks = useTranslations('siteLinks');
  const tTheme = useTranslations('theme');
  const { isDark, toggleDarkMode } = useThemeToggle();

  return (
    <footer className="bg-sunken text-ink-2 border-t border-rule mt-auto">
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-12 pb-8">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-4 xl:grid-cols-8 gap-x-6 gap-y-8">
          {DIRECTORY_CATEGORIES.map((category) => (
            <div key={category.key} className="flex flex-col min-w-0">
              <h2 className="text-ink font-semibold text-sm mb-3 tracking-tight font-sans">
                {t(`categories.${category.key}`)}
              </h2>
              <ul className="space-y-1 sm:space-y-2">
                {category.links.map((link) => (
                  <li key={`${category.key}-${link.key}`}>
                    <Link
                      href={link.href}
                      className="min-h-[44px] sm:min-h-0 inline-flex items-center text-ink-2 hover:text-accent-ink text-[13px] transition-colors leading-snug py-0.5"
                    >
                      {tLinks(link.key)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="pt-8 mt-10 border-t border-rule">
          <nav aria-label={t('secondaryNavLabel')} className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[13px]">
            {SECONDARY_LINKS.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                className={`min-h-[44px] sm:min-h-[36px] inline-flex items-center hover:text-ink transition-colors ${
                  'emphasized' in item ? 'text-ink font-bold' : 'text-ink-2 font-medium'
                }`}
              >
                {tLinks(item.key)}
              </Link>
            ))}
          </nav>
        </div>

        <div className="pt-6 mt-6 border-t border-rule flex flex-col sm:flex-row items-center justify-between gap-4">
          <Link href="/" className="inline-flex items-center gap-2.5 min-h-[44px] rounded-sm">
            <BrandLogo size="sm" />
          </Link>

          <div className="flex flex-wrap items-center justify-center gap-3 text-xs text-ink-3">
            <span>{t('copyright')}</span>
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-2">
              <ShieldCheck className="w-3.5 h-3.5 text-accent-ink shrink-0" />
              <span>{t('assurance')}</span>
            </div>
          </div>

          <button
            type="button"
            onClick={toggleDarkMode}
            aria-label={isDark ? tTheme('toLight') : tTheme('toDark')}
            className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-sm text-ink-2 hover:text-ink hover:bg-sunken transition-colors cursor-pointer"
          >
            {isDark ? (
              <Sun className="w-4 h-4" />
            ) : (
              <Moon className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>
    </footer>
  );
}
