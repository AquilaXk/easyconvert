import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import type { ConversionFailure } from '@/lib/conversion-failure';

const PROBLEM_TYPE_PREFIX = 'https://api.easyconvert.io/problems/';

/**
 * Problem types (RFC 9457) the interface words in the page's language; any other answer reads as the server wrote it.
 * `facts` marks a type whose `detail` names the facts of this refusal (a size, a limit, a count, the value refused), so
 * the server's detail follows the translated sentence; the other types' details only restate it.
 */
const TRANSLATED_PROBLEMS = {
  'bad-request': { key: 'badRequest', facts: true },
  unauthorized: { key: 'unauthorized', facts: false },
  forbidden: { key: 'forbidden', facts: false },
  'payload-too-large': { key: 'payloadTooLarge', facts: true },
  'length-required': { key: 'lengthRequired', facts: false },
  'unsupported-media-type': { key: 'unsupportedMediaType', facts: true },
  'rate-limited': { key: 'rateLimited', facts: false },
  'concurrency-limit': { key: 'concurrencyLimit', facts: true },
  'quota-exceeded': { key: 'quotaExceeded', facts: true },
  'upload-budget-exceeded': { key: 'uploadBudgetExceeded', facts: true },
  'storage-full': { key: 'storageFull', facts: false },
  'service-unavailable': { key: 'serviceUnavailable', facts: false },
  'client-ip-trust-unconfigured': { key: 'serviceUnavailable', facts: false },
  'internal-server-error': { key: 'internalError', facts: false },
} as const;

type TranslatedProblem = (typeof TRANSLATED_PROBLEMS)[keyof typeof TRANSLATED_PROBLEMS];

function textField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function translatedProblem(record: Record<string, unknown>): TranslatedProblem | undefined {
  const type = textField(record, 'type');
  if (!type?.startsWith(PROBLEM_TYPE_PREFIX)) return undefined;
  const slug = type.slice(PROBLEM_TYPE_PREFIX.length);
  return Object.hasOwn(TRANSLATED_PROBLEMS, slug) ? TRANSLATED_PROBLEMS[slug as keyof typeof TRANSLATED_PROBLEMS] : undefined;
}

/**
 * The sentence to show for a refused API call: a known problem type in the page's language (followed by the server's
 * detail when it names facts), else the server's own text (`error`, `detail` or `message`), else `fallback`.
 */
export function useServerErrorMessage(): (payload: unknown, fallback: string) => string {
  const t = useTranslations('problems');
  return useCallback(
    (payload: unknown, fallback: string) => {
      if (!payload || typeof payload !== 'object') return fallback;
      const record = payload as Record<string, unknown>;
      const problem = translatedProblem(record);
      if (problem) {
        const detail = problem.facts ? textField(record, 'detail') : undefined;
        return detail ? `${t(problem.key)} ${detail}` : t(problem.key);
      }
      return textField(record, 'error') ?? textField(record, 'detail') ?? textField(record, 'message') ?? fallback;
    },
    [t]
  );
}

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
