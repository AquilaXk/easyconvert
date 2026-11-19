'use client';

import ErrorPageView from '@/components/pages/ErrorPageView';

/** The error boundary of every page under a locale: the layout above it stays, and `reset` renders the page again. */
export default function LocaleError({ reset }: Readonly<{ reset: () => void }>) {
  return <ErrorPageView reset={reset} />;
}
