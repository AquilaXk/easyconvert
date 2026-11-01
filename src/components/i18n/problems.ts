import { useCallback } from 'react';
import { useTranslations } from 'next-intl';

const PROBLEM_TYPE_PREFIX = 'https://api.easyconvert.io/problems/';

/** Problem types (RFC 9457) the interface words in the page's language; any other answer reads as the server wrote it. */
const TRANSLATED_PROBLEMS = {
  'bad-request': 'badRequest',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  'payload-too-large': 'payloadTooLarge',
  'length-required': 'lengthRequired',
  'unsupported-media-type': 'unsupportedMediaType',
  'rate-limited': 'rateLimited',
  'concurrency-limit': 'concurrencyLimit',
  'quota-exceeded': 'quotaExceeded',
  'upload-budget-exceeded': 'uploadBudgetExceeded',
  'storage-full': 'storageFull',
  'service-unavailable': 'serviceUnavailable',
  'client-ip-trust-unconfigured': 'serviceUnavailable',
  'internal-server-error': 'internalError',
} as const;

type ProblemKey = (typeof TRANSLATED_PROBLEMS)[keyof typeof TRANSLATED_PROBLEMS];

function textField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function translatedProblem(record: Record<string, unknown>): ProblemKey | undefined {
  const type = textField(record, 'type');
  if (!type?.startsWith(PROBLEM_TYPE_PREFIX)) return undefined;
  const slug = type.slice(PROBLEM_TYPE_PREFIX.length);
  return Object.hasOwn(TRANSLATED_PROBLEMS, slug) ? TRANSLATED_PROBLEMS[slug as keyof typeof TRANSLATED_PROBLEMS] : undefined;
}

/**
 * The sentence to show for a refused API call: a known problem type in the page's language, else the server's own text
 * (`error`, `detail` or `message`), else `fallback`.
 */
export function useServerErrorMessage(): (payload: unknown, fallback: string) => string {
  const t = useTranslations('problems');
  return useCallback(
    (payload: unknown, fallback: string) => {
      if (!payload || typeof payload !== 'object') return fallback;
      const record = payload as Record<string, unknown>;
      const problem = translatedProblem(record);
      if (problem) return t(problem);
      return textField(record, 'error') ?? textField(record, 'detail') ?? textField(record, 'message') ?? fallback;
    },
    [t]
  );
}
