'use client';

import React, { createContext, useContext } from 'react';

const CaptureAvailabilityContext = createContext<boolean>(true);

/**
 * Provides runtime `CAPTURE_WEBSITE_ENABLED` state from `LocaleLayout` down to Header, MobileMenu, and page components
 * so turning capture off hides navigation links without threading props through every page view.
 */
export function CaptureAvailabilityProvider({
  enabled,
  children,
}: Readonly<{ enabled: boolean; children: React.ReactNode }>) {
  return (
    <CaptureAvailabilityContext.Provider value={enabled}>
      {children}
    </CaptureAvailabilityContext.Provider>
  );
}

export function useWebsiteCaptureEnabled(override?: boolean): boolean {
  const fromContext = useContext(CaptureAvailabilityContext);
  return override ?? fromContext;
}
