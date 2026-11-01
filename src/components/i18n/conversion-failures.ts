import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import type { ConversionFailure } from '@/lib/conversion-failure';
import { useServerErrorMessage } from './problems';

/** The sentence for a conversion that failed in the queue; a browser tier's own error follows it as the tier gave it. */
export function useConversionFailureMessage(): (failure: ConversionFailure) => string {
  const t = useTranslations('queue.failures');
  const serverErrorMessage = useServerErrorMessage();
  return useCallback(
    (failure: ConversionFailure) => {
      switch (failure.code) {
        case 'server':
          return serverErrorMessage(failure.problem, t('conversionFailed'));
        case 'clientOnlyBlocked': {
          const blocked = t('clientOnlyBlocked', { source: failure.source, target: failure.target });
          return failure.edgeFailure ? `${blocked} ${t('edgeTierFailed', { ...failure.edgeFailure })}` : blocked;
        }
        case 'clientEdgeFailed':
          return failure.reason ? `${t('clientEdgeFailed')} ${failure.reason}` : t('clientEdgeFailed');
        default:
          return t(failure.code);
      }
    },
    [t, serverErrorMessage]
  );
}
