import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useViewerPlan } from '@/hooks/useViewerPlan';
import { URL_IMPORT_MAX_BYTES, maxFileBytes } from '@/lib/plan-limits';
import { urlImportErrorCode } from '@/lib/url-import-errors';
import { useFormatBytes } from './format';
import { useServerErrorMessage } from './problems';

/** The sentence for a refused import from a link: its `code` in the page's language, else as `useServerErrorMessage` words it. */
export function useUrlImportErrorMessage(): (payload: unknown, status: number) => string {
  const t = useTranslations('urlImport');
  const serverErrorMessage = useServerErrorMessage();
  const formatBytes = useFormatBytes();
  const plan = useViewerPlan();
  return useCallback(
    (payload: unknown, status: number) => {
      const code = urlImportErrorCode(payload);
      if (code === 'file_too_large') {
        return t('errors.file_too_large', { limit: formatBytes(URL_IMPORT_MAX_BYTES), planLimit: formatBytes(maxFileBytes(plan)) });
      }
      return code ? t(`errors.${code}`) : serverErrorMessage(payload, t('fetchFailed', { status }));
    },
    [t, serverErrorMessage, formatBytes, plan]
  );
}
