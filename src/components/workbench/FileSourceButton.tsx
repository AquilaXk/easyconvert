'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Globe, HardDrive, Upload } from 'lucide-react';
import UrlImportModal from '../UrlImportModal';

/** How the split button reads: the drop zone's primary "select file" or the file bar's secondary "add more files". */
const VARIANTS = {
  primary: {
    main: 'btn-primary min-h-[48px] px-6 text-base sm:text-lg font-medium rounded-l-xs',
    toggle: 'btn-primary min-h-[48px] w-12 border-l border-on-accent/25 rounded-r-xs',
    menu: 'top-full mt-2',
  },
  secondary: {
    main: 'min-h-[44px] md:min-h-[40px] px-3.5 text-sm font-medium rounded-l-xs border border-rule bg-canvas text-ink hover:border-rule-strong',
    toggle: 'min-h-[44px] md:min-h-[40px] w-11 border border-l-0 border-rule bg-canvas text-ink rounded-r-xs hover:border-rule-strong',
    menu: 'bottom-full mb-2',
  },
} as const;

interface FileSourceButtonProps {
  label: string;
  variant: keyof typeof VARIANTS;
  disabled?: boolean;
  /** Opens the device file picker. */
  onPickDevice: () => void;
  /** Receives a file imported from a link. */
  onImportFile: (file: File) => void;
  className?: string;
}

/** Where focus lands when the menu opens: its first item from a click, Enter, Space or Down, its last from Up. */
type MenuState = 'closed' | 'first' | 'last';

const itemIndexFor = (state: Exclude<MenuState, 'closed'>, count: number) => (state === 'first' ? 0 : count - 1);

/** The item a key moves focus to within the menu, by the menu button pattern of the WAI-ARIA Authoring Practices. */
function nextItemIndex(key: string, current: number, count: number): number | null {
  switch (key) {
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * A split button: the device picker on the main part, and a menu of the other file sources (device, link) on the chevron,
 * which follows the menu button pattern: opening it moves focus to an item, the arrows, Home and End move within it, Escape
 * and a choice return focus to the chevron, and Tab or a pointer press outside closes it. It never closes on a blur, since
 * WebKit blurs the focused item on a mouse press without focusing what was pressed.
 */
export default function FileSourceButton({
  label, variant, disabled = false, onPickDevice, onImportFile, className = '',
}: Readonly<FileSourceButtonProps>) {
  const t = useTranslations('hero.dropzone');
  const [menu, setMenu] = useState<MenuState>('closed');
  const [isUrlModalOpen, setIsUrlModalOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef<HTMLButtonElement[]>([]);
  const styles = VARIANTS[variant];
  const isMenuOpen = menu !== 'closed';

  useEffect(() => {
    if (menu === 'closed') return;
    const items = itemsRef.current;
    items[itemIndexFor(menu, items.length)]?.focus();
    const handleOutside = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setMenu('closed');
    };
    document.addEventListener('pointerdown', handleOutside);
    return () => document.removeEventListener('pointerdown', handleOutside);
  }, [menu]);

  const closeToToggle = () => {
    setMenu('closed');
    toggleRef.current?.focus();
  };

  const handleToggleKey = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && isMenuOpen) {
      event.preventDefault();
      setMenu('closed');
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const next = event.key === 'ArrowDown' ? 'first' : 'last';
    if (isMenuOpen) itemsRef.current[itemIndexFor(next, itemsRef.current.length)]?.focus();
    else setMenu(next);
  };

  const handleMenuKey = (event: React.KeyboardEvent) => {
    if (event.key === 'Tab') {
      setMenu('closed');
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeToToggle();
      return;
    }
    const items = itemsRef.current;
    const next = nextItemIndex(event.key, items.indexOf(document.activeElement as HTMLButtonElement), items.length);
    if (next === null) return;
    event.preventDefault();
    items[next].focus();
  };

  const choose = (action: () => void) => () => {
    closeToToggle();
    action();
  };

  const menuItemClass =
    'min-h-[44px] w-full px-3 rounded-xs text-sm font-medium text-ink hover:bg-sunken flex items-center gap-2.5 transition-colors cursor-pointer';
  const menuItems = [
    { key: 'device', Icon: HardDrive, text: t('fromDevice'), action: onPickDevice },
    { key: 'url', Icon: Globe, text: t('fromUrl'), action: () => setIsUrlModalOpen(true) },
  ];

  return (
    <div ref={rootRef} className={`relative inline-flex items-stretch ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={onPickDevice}
        className={`${styles.main} flex-1 inline-flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        <Upload aria-hidden="true" className="size-4 shrink-0" />
        <span>{label}</span>
      </button>
      <button
        ref={toggleRef}
        type="button"
        disabled={disabled}
        onClick={() => setMenu(isMenuOpen ? 'closed' : 'first')}
        onKeyDown={handleToggleKey}
        aria-label={t('moreSources')}
        aria-haspopup="menu"
        aria-expanded={isMenuOpen}
        className={`${styles.toggle} inline-flex items-center justify-center transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        <ChevronDown aria-hidden="true" className={`size-4 transition-transform duration-200 ${isMenuOpen ? 'rotate-180' : ''}`} />
      </button>

      {isMenuOpen && (
        <div
          role="menu"
          aria-label={t('sourcesMenu')}
          onKeyDown={handleMenuKey}
          onMouseDown={(event) => event.preventDefault()}
          className={`absolute right-0 ${styles.menu} w-52 max-w-[calc(100dvw-2rem)] rounded-sm bg-surface border border-rule shadow-elev-1 p-1.5 z-40 text-left`}
        >
          {menuItems.map(({ key, Icon, text, action }, index) => (
            <button
              key={key}
              ref={(node) => {
                if (node) itemsRef.current[index] = node;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={choose(action)}
              className={menuItemClass}
            >
              <Icon aria-hidden="true" className="size-4 text-ink-3 shrink-0" />
              <span>{text}</span>
            </button>
          ))}
        </div>
      )}

      {isUrlModalOpen && (
        <UrlImportModal isOpen onAddFile={onImportFile} onClose={() => setIsUrlModalOpen(false)} />
      )}
    </div>
  );
}
