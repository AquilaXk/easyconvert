'use client';

import React, { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations, type Messages } from 'next-intl';
import { Archive, ArrowRightLeft, ChevronDown, FileText, Globe, Minimize2, Moon, Sun, X } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useModalDialog } from '@/hooks/useModalDialog';
import { useThemeToggle } from '@/hooks/useThemeToggle';
import { useViewerAccount } from '@/hooks/useViewerPlan';
import type { SessionUser } from '@/lib/viewer-plan';
import BrandLogo from './BrandLogo';
import UserNav from './UserNav';
import LanguageSwitcher from './LanguageSwitcher';
import { API_LINKS, primaryLinksFor, toolGroupsFor, type SiteLink, type ToolGroup } from './site-links';
import { useWebsiteCaptureEnabled } from './CaptureAvailabilityProvider';

type LabelledLink = SiteLink & { key: keyof Messages['siteLinks'] };

const GROUP_ICONS: Readonly<Record<ToolGroup['key'], React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>>> = {
  converters: ArrowRightLeft,
  pdfTools: FileText,
  archives: Archive,
  compressImages: Minimize2,
  websiteCapture: Globe,
};

const FOCUSABLE = 'a[href], button:not([disabled]), select, input, [tabindex]:not([tabindex="-1"])';
const ROW_CLASS =
  'min-h-[44px] w-full px-3 inline-flex items-center rounded-sm text-base font-medium text-ink-2 hover:text-ink hover:bg-sunken transition-colors';

/** Keeps Tab and Shift+Tab inside `dialog`, and sends Escape to `onEscape`. */
function trapFocus(event: KeyboardEvent<HTMLDialogElement>, onEscape: () => void) {
  if (event.key === 'Escape') {
    event.preventDefault();
    onEscape();
    return;
  }
  if (event.key !== 'Tab') return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest('[hidden]'));
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !event.currentTarget.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

function MobileToolSubgroup({
  groupKey,
  label,
  prependHomeLabel,
  links,
  onNavigate,
}: Readonly<{
  groupKey: ToolGroup['key'];
  label: string;
  prependHomeLabel?: string;
  links: readonly SiteLink[];
  onNavigate: () => void;
}>) {
  const tLinks = useTranslations('siteLinks');
  const Icon = GROUP_ICONS[groupKey];
  return (
    <div>
      <div className="min-h-[36px] w-full px-2.5 inline-flex items-center gap-2 text-sm font-semibold text-ink">
        <Icon aria-hidden={true} className="size-4 text-ink-3 shrink-0" />
        <span className="truncate">{label}</span>
      </div>
      <ul className="ms-[18px] border-s border-rule ps-3 py-0.5">
        {prependHomeLabel && (
          <li>
            <Link
              href="/"
              onClick={onNavigate}
              className="min-h-[44px] w-full px-2.5 inline-flex items-center rounded-xs text-sm font-medium text-ink-3 hover:text-ink hover:bg-sunken transition-colors"
            >
              {prependHomeLabel}
            </Link>
          </li>
        )}
        {links.map((link) => (
          <li key={link.key}>
            <Link
              href={link.href}
              onClick={onNavigate}
              className="min-h-[44px] w-full px-2.5 inline-flex items-center rounded-xs text-sm font-medium text-ink-3 hover:text-ink hover:bg-sunken transition-colors"
            >
              {tLinks(link.key as keyof Messages['siteLinks'])}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CollapsibleToolGroups({
  id,
  label,
  captureEnabled,
  onNavigate,
}: Readonly<{ id: string; label: string; captureEnabled: boolean; onNavigate: () => void }>) {
  const tHeader = useTranslations('header');
  const tGroups = useTranslations('header.toolGroups');
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className={`${ROW_CLASS} justify-between cursor-pointer ${open ? 'text-ink' : ''}`}
      >
        <span>{label}</span>
        <ChevronDown aria-hidden="true" className={`size-5 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>
      <div id={id} hidden={!open} className="ms-3.5 border-s border-rule ps-2 space-y-1 py-1">
        {toolGroupsFor(captureEnabled).map((group, idx) => (
          <MobileToolSubgroup
            key={group.key}
            groupKey={group.key}
            label={tGroups(group.key)}
            prependHomeLabel={idx === 0 ? tHeader('fileConverterTitle') : undefined}
            links={group.links}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </div>
  );
}
function CollapsibleLinks({
  id,
  label,
  links,
  onNavigate,
}: Readonly<{ id: string; label: string; links: readonly LabelledLink[]; onNavigate: () => void }>) {
  const tLinks = useTranslations('siteLinks');
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className={`${ROW_CLASS} justify-between cursor-pointer`}
      >
        <span>{label}</span>
        <ChevronDown aria-hidden="true" className={`size-5 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>
      <ul id={id} hidden={!open} className="ms-3 border-s border-rule ps-2">
        {links.map((link) => (
          <li key={link.key}>
            <Link href={link.href} onClick={onNavigate} className={`${ROW_CLASS} text-sm`}>
              {tLinks(link.key)}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The full-screen sheet of the mobile menu: a modal dialog that traps focus and closes on Escape. */
export default function MobileMenu({
  onClose,
  initialUser,
  websiteCaptureEnabled: websiteCaptureOverride,
}: Readonly<{ onClose: () => void; initialUser?: SessionUser; websiteCaptureEnabled?: boolean }>) {
  const t = useTranslations('header');
  const tLinks = useTranslations('siteLinks');
  const tTheme = useTranslations('theme');
  const { isDark, toggleDarkMode } = useThemeToggle();
  const signedIn = useViewerAccount(initialUser) !== null;
  const captureEnabled = useWebsiteCaptureEnabled(websiteCaptureOverride);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useModalDialog(dialogRef, true, onClose);
  // showModal() focuses the first link (the logo), and touch browsers then draw its focus ring. The sheet itself takes focus
  // instead, as the HTML dialog guidance advises for a dialog that opens on a large region; Tab still reaches every item.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const iconButton =
    'min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-sm text-ink-2 hover:text-ink hover:bg-sunken transition-colors cursor-pointer';

  return (
    <dialog
      ref={dialogRef}
      aria-label={t('menuLabel')}
      tabIndex={-1}
      onKeyDown={(event) => trapFocus(event, onClose)}
      className="!m-0 !outline-none !shadow-none h-dvh !max-h-none w-dvw !max-w-none overflow-y-auto rounded-none border-0 p-0 bg-canvas text-ink"
    >
      <div className="flex items-center justify-between px-4 h-[var(--header-height)] border-b border-rule">
        <Link href="/" onClick={onClose} aria-label={t('homeLabel')} className="min-h-[44px] inline-flex items-center shrink-0 rounded-sm">
          <BrandLogo size="md" />
        </Link>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={toggleDarkMode}
            aria-label={isDark ? tTheme('toLight') : tTheme('toDark')}
            className={iconButton}
          >
            {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
          <button type="button" onClick={onClose} aria-label={t('closeMenu')} className={iconButton}>
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      <div className="px-4 py-4 space-y-4">
        <nav aria-label={t('mobileNavLabel')} className="flex flex-col gap-0.5">
          <CollapsibleToolGroups id="mobile-menu-tools" label={t('tools')} captureEnabled={captureEnabled} onNavigate={onClose} />
          <CollapsibleLinks id="mobile-menu-api" label={t('api')} links={API_LINKS} onNavigate={onClose} />
          {primaryLinksFor(signedIn).filter((item) => item.key !== 'apiDocs').map((item) => (
            <Link key={item.key} href={item.href} onClick={onClose} className={ROW_CLASS}>
              {tLinks(item.key)}
            </Link>
          ))}
        </nav>

        <div className="pt-4 border-t border-rule">
          <UserNav mobile onItemClick={onClose} initialUser={initialUser} />
        </div>

        <div className="pt-4 border-t border-rule">
          <LanguageSwitcher />
        </div>
      </div>
    </dialog>
  );
}
