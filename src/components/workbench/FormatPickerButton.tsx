'use client';

import React, { useEffect, useRef, useState } from 'react';
import FormatSelector, { type FormatChoiceProps } from '../FormatSelector';

interface FormatPickerButtonProps extends FormatChoiceProps {
  /** What the button shows: the current format, or a prompt to choose one. */
  children: React.ReactNode;
  className: string;
  ariaLabel?: string;
  disabled?: boolean;
  testId?: string;
}

/**
 * A button that opens the format picker under itself. It owns the picker's open state, so a press anywhere outside, a
 * Tab out of it or Escape closes it, and opening another picker on the page closes this one by the same press.
 */
export default function FormatPickerButton({
  children, className, ariaLabel, disabled = false, testId, ...picker
}: Readonly<FormatPickerButtonProps>) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const open = isOpen && !disabled;
  useEffect(() => {
    if (disabled) setIsOpen(false);
  }, [disabled]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid={testId}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setIsOpen((current) => !current)}
        className={className}
      >
        {children}
      </button>
      {open && <FormatSelector {...picker} triggerRef={triggerRef} onClose={() => setIsOpen(false)} />}
    </>
  );
}
