import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import type { ConversionFailure } from '@/lib/conversion-failure';
import { useServerErrorMessage } from './problems';

/** The sentence for a conversion that failed in the queue. */
export function useConversionFailureMessage(): (failure: ConversionFailure) => string {
  const t = useTranslations('queue.failures');
  const serverErrorMessage = useServerErrorMessage();
  return useCallback(
    (failure: ConversionFailure) => {
      if (failure.code === 'server') return serverErrorMessage(failure.problem, t('conversionFailed'));
      if (failure.code === 'clientOnlyBlocked') return t('clientOnlyBlocked', { source: failure.source, target: failure.target });
      return t(failure.code);
    },
    [t, serverErrorMessage]
  );
}
