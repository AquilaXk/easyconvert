'use client';

import ErrorPageView from '@/components/pages/ErrorPageView';
import { useReportBoundaryError } from '@/lib/client-errors/use-report-boundary-error';

/** The error boundary of every page under a locale: the layout above it stays, and `reset` renders the page again. The error is reported to this site (entry 384). */
export default function LocaleError({ error, reset }: Readonly<{ error: Error & { digest?: string }; reset: () => void }>) {
  useReportBoundaryError(error);
  return <ErrorPageView reset={reset} />;
}
