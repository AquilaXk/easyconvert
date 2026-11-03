'use client';

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

export interface PopoverDismissOptions {
  isOpen: boolean;
  /** The button that opened the popover, where focus returns. */
  triggerRef: RefObject<HTMLElement | null>;
  /** The elements a pointer press inside of leaves the popover open: the popover itself and its trigger. */
  insideRefs: ReadonlyArray<RefObject<HTMLElement | null>>;
  /** Whether this Tab moves focus out of the popover. */
  leavesOnTab: (event: KeyboardEvent) => boolean;
  onClose: () => void;
}

/**
 * Closes a popover the way the menu button and dialog patterns of the WAI-ARIA Authoring Practices do. Escape closes it and
 * returns focus to its trigger, scrolling to it if it is off screen (the page's scroll padding keeps it clear of the sticky
 * header). A Tab out of it first puts focus on the trigger, so a forward Tab moves on from the trigger, as if the popover sat
 * right after it, and a backward Tab stays on it. A pointer press outside closes it and leaves focus where the press lands,
 * and so does focus moving outside without one, as a screen reader's click does. It never closes on a blur, since WebKit
 * blurs the focused element on a mouse press without focusing what was pressed.
 */
export function usePopoverDismiss(options: PopoverDismissOptions): void {
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const { isOpen } = options;

  useEffect(() => {
    if (!isOpen) return;
    const closeToTrigger = () => {
      const { triggerRef, onClose } = latest.current;
      triggerRef.current?.focus();
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeToTrigger();
        return;
      }
      if (event.key !== 'Tab' || !latest.current.leavesOnTab(event)) return;
      if (event.shiftKey) event.preventDefault();
      closeToTrigger();
    };
    const closeOnOutside = (event: Event) => {
      const target = event.target as Node | null;
      if (!target || latest.current.insideRefs.some((ref) => ref.current?.contains(target))) return;
      latest.current.onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('focusin', closeOnOutside);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('focusin', closeOnOutside);
    };
  }, [isOpen]);
}
