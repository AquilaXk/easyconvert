import { useCallback } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

const SECONDS_PER_MINUTE = 60;

/** How long a stored file stays, in the largest sensible unit ("Deleted in 23 hours"); under a minute it reads as soon. */
export function useRetentionLabel(): (remainingSeconds: number) => string {
  const t = useTranslations('dashboard.files');
  const format = useFormatter();
  return useCallback(
    (remainingSeconds: number) =>
      remainingSeconds < SECONDS_PER_MINUTE ? t('expiresSoon') : t('expiresIn', { when: format.relativeTime(remainingSeconds * 1000, 0) }),
    [t, format]
  );
}
