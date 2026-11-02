import { useCallback } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

const MS_PER_SECOND = 1000;
const UNITS = [
  { unit: 'day', seconds: 86_400 },
  { unit: 'hour', seconds: 3_600 },
  { unit: 'minute', seconds: 60 },
] as const;

/**
 * How long a stored file stays, in the largest unit it fills, counted whole ("Deleted in 1 hour" for 1 h 30 m, never
 * "in 2 hours" or "in 60 minutes"); under a minute it reads as soon.
 */
export function useRetentionLabel(): (remainingSeconds: number) => string {
  const t = useTranslations('dashboard.files');
  const format = useFormatter();
  return useCallback(
    (remainingSeconds: number) => {
      const fitted = UNITS.find(({ seconds }) => remainingSeconds >= seconds);
      if (!fitted) return t('expiresSoon');
      const whole = Math.floor(remainingSeconds / fitted.seconds);
      return t('expiresIn', { when: format.relativeTime(whole * fitted.seconds * MS_PER_SECOND, { now: 0, unit: fitted.unit }) });
    },
    [t, format]
  );
}
