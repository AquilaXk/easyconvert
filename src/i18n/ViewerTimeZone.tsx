'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
import { NextIntlClientProvider, useLocale } from 'next-intl';

/** The time zone of the browser the page runs in. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const noSubscription = () => () => undefined;
const unknownOnServer = (): string | undefined => undefined;

/** Formats the dates of `children` in `timeZone`; without one they keep the zone of the provider above. */
export function ViewerTimeZoneProvider({ timeZone, children }: Readonly<{ timeZone: string | undefined; children: ReactNode }>) {
  return (
    <NextIntlClientProvider locale={useLocale()} timeZone={timeZone}>
      {children}
    </NextIntlClientProvider>
  );
}

/**
 * The server provider hands its own time zone to the client components (UTC on the build host of a prerendered page). Dates
 * formatted in the browser read in the viewer's zone instead: the server render and the first client render keep the
 * server's zone, so hydration matches, and the browser's zone follows right after.
 */
export default function ViewerTimeZone({ children }: Readonly<{ children: ReactNode }>) {
  const timeZone = useSyncExternalStore(noSubscription, browserTimeZone, unknownOnServer);
  return <ViewerTimeZoneProvider timeZone={timeZone}>{children}</ViewerTimeZoneProvider>;
}
