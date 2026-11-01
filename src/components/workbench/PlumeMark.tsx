import React from 'react';

/** The drop-zone mark: a small quill whose barbs part around an upward stroke. */
export function PlumeMark({ className = '' }: Readonly<{ className?: string }>) {
  return (
    <svg viewBox="0 0 44 44" fill="none" stroke="currentColor" aria-hidden="true" focusable="false" className={className}>
      <path strokeWidth="1" d="M12 38 C 18 28 24 16 34 6" />
      <path
        strokeWidth="0.8"
        d="M16 32 q8 0 14 -9M19 27 q8 0 13 -9M22 22 q7 -1 11 -9M25 17 q6 -1 9 -8M16 32 q-3 -6 -1 -13M19 27 q-3 -6 0 -12M22 22 q-2 -5 1 -11"
      />
      <path strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" d="M30 40v-9m-3.5 3.5L30 31l3.5 3.5" />
    </svg>
  );
}
