'use client';

import { useEffect } from 'react';
import { reportClientError } from './reporter';

/** Reports the error an error boundary of a page caught (`error.tsx`, `global-error.tsx`), once for each error the boundary is given. */
export function useReportBoundaryError(error: Error & { digest?: string }): void {
  useEffect(() => {
    reportClientError('boundary', error);
  }, [error]);
}
