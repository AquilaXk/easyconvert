import { useCallback } from 'react';
import { useFormatter, useMessages, useTranslations, type Messages } from 'next-intl';
import type { ConversionFailure } from '@/lib/conversion-failure';
import { PLAN_MAX_FILE_BYTES, URL_IMPORT_MAX_BYTES, maxFileBytes, type Plan } from '@/lib/plan-limits';
import { AUTH_ERROR_CODES, CONVERSION_REFUSAL_CODES, PROBLEM_TYPE_BASE, URL_IMPORT_ERROR_CODES, isCodeOf } from '@/lib/refusal-codes';
import { useViewerPlan } from '@/hooks/useViewerPlan';
import { useFileTooLargeMessage, useFormatBytes } from './format';

/**
 * How the interface words a refused request or a failed conversion (RFC 9457 practice): a stable `code` or problem `type`
 * is the key of a sentence in the page's language, and the numbers that sentence names come from the answer's fields. The
 * server's `detail` is written for the developer of an API client, so no sentence of the interface carries it.
 */

type Answer = Readonly<Record<string, unknown>>;
type ProblemName = keyof Messages['errors']['problems'];
type LimitKey = keyof Messages['errors']['limits'];

const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_SERVER_ERROR_MIN = 500;

function textField(answer: Answer, field: string): string | undefined {
  const value = answer[field];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function numberField(answer: Answer, field: string): number | undefined {
  const value = answer[field];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function answerOf(payload: unknown): Answer {
  return payload && typeof payload === 'object' ? (payload as Answer) : {};
}

const isRefusal = (status: number): boolean => status >= HTTP_CLIENT_ERROR_MIN && status < HTTP_SERVER_ERROR_MIN;

const isPlan = (value: unknown): value is Plan => typeof value === 'string' && Object.hasOwn(PLAN_MAX_FILE_BYTES, value);

/** A problem name the messages have a sentence for: an own key of `errors.problems`, never an inherited property. */
const isProblemName = (problems: Messages['errors']['problems'], name: string): name is ProblemName => Object.hasOwn(problems, name);

interface LimitWords {
  /** The sentence `key` with the number in `field` of the answer, or undefined when the answer does not carry it. */
  limit: (key: LimitKey, answer: Answer, field: string, unit: 'bytes' | 'count') => string | undefined;
  fileTooLarge: (plan: Plan, sizeBytes: number) => string;
}

/** The sentences that name the numbers a problem's answer carries, by problem name; without the number, the problem's own. */
const LIMIT_SENTENCES: Readonly<Partial<Record<ProblemName, (answer: Answer, words: LimitWords) => string | undefined>>> = {
  'payload-too-large': (answer, { limit, fileTooLarge }) => {
    const sizeBytes = numberField(answer, 'sizeBytes');
    if (isPlan(answer.plan) && sizeBytes !== undefined) return fileTooLarge(answer.plan, sizeBytes);
    return limit('payload-too-large', answer, 'maxRequestBytes', 'bytes');
  },
  'concurrency-limit': (answer, { limit }) => limit('concurrency-limit', answer, 'limit', 'count'),
  'quota-exceeded': (answer, { limit }) => limit('quota-exceeded', answer, 'dailyLimit', 'count'),
  'upload-budget-exceeded': (answer, { limit }) => {
    if (answer.refusal === 'open-uploads') return limit('open-uploads', answer, 'limit', 'count');
    return answer.refusal === 'daily-bytes' ? limit('daily-bytes', answer, 'limitBytes', 'bytes') : undefined;
  },
};

/**
 * The wording of any refused request: the sentence of its problem type, else `fallback` (the sentence of the action that
 * failed) or the sentence of its status class.
 */
export function useProblemWording(): (payload: unknown, status: number, fallback?: string) => string {
  const t = useTranslations('errors');
  const problems = useMessages().errors.problems;
  const format = useFormatter();
  const formatBytes = useFormatBytes();
  const fileTooLarge = useFileTooLargeMessage();
  return useCallback(
    (payload: unknown, status: number, fallback?: string) => {
      const answer = answerOf(payload);
      const type = textField(answer, 'type');
      const name = type?.startsWith(PROBLEM_TYPE_BASE) ? type.slice(PROBLEM_TYPE_BASE.length) : undefined;
      if (name !== undefined && isProblemName(problems, name)) {
        const limit: LimitWords['limit'] = (key, fields, field, unit) => {
          const value = numberField(fields, field);
          return value === undefined ? undefined : t(`limits.${key}`, { limit: unit === 'bytes' ? formatBytes(value) : format.number(value) });
        };
        const limitSentence = LIMIT_SENTENCES[name]?.(answer, { limit, fileTooLarge });
        return limitSentence ?? t(`problems.${name}`);
      }
      return fallback ?? (isRefusal(status) ? t('generic.client') : t('generic.server'));
    },
    [t, problems, format, formatBytes, fileTooLarge]
  );
}

/** A refusal of `/api/fetch-url`, by its `code`; an answer without a code this build words as `useProblemWording` words it. */
export function useUrlImportErrorWording(): (payload: unknown, status: number) => string {
  const t = useTranslations('errors.urlImport');
  const problemWording = useProblemWording();
  const formatBytes = useFormatBytes();
  const plan = useViewerPlan();
  return useCallback(
    (payload: unknown, status: number) => {
      const answer = answerOf(payload);
      const code = answer.code;
      if (!isCodeOf(URL_IMPORT_ERROR_CODES, code)) return problemWording(answer, status);
      if (code === 'file_too_large') return t(code, { limit: formatBytes(URL_IMPORT_MAX_BYTES), planLimit: formatBytes(maxFileBytes(plan)) });
      return t(code);
    },
    [t, problemWording, formatBytes, plan]
  );
}

/** A refusal of `/api/auth/login` or `/api/auth/register`, by its `code`; never by its status alone. */
export function useAuthErrorWording(): (payload: unknown, status: number) => string {
  const t = useTranslations('errors.auth');
  const problemWording = useProblemWording();
  return useCallback(
    (payload: unknown, status: number) => {
      const answer = answerOf(payload);
      const code = answer.code;
      if (!isCodeOf(AUTH_ERROR_CODES, code)) return problemWording(answer, status, t('failed'));
      if (code === 'login_locked') return t(code, { seconds: numberField(answer, 'retryAfterSeconds') ?? 0 });
      return t(code);
    },
    [t, problemWording]
  );
}

/**
 * The wording of a conversion that failed in the queue: a server refusal by its `code` or problem type, a failed job by the
 * refusal code its worker recorded, else as a failed job.
 */
export function useConversionFailureWording(): (failure: ConversionFailure) => string {
  const t = useTranslations('errors');
  const problemWording = useProblemWording();
  return useCallback(
    (failure: ConversionFailure) => {
      const conversionSentence = (code: unknown) => (isCodeOf(CONVERSION_REFUSAL_CODES, code) ? t(`conversion.${code}`) : undefined);
      switch (failure.code) {
        case 'server': {
          const status = numberField(failure.problem, 'status') ?? HTTP_SERVER_ERROR_MIN;
          return conversionSentence(failure.problem.code) ?? problemWording(failure.problem, status);
        }
        case 'jobFailed':
          return conversionSentence(failure.refusalCode) ?? t('queue.jobFailed');
        case 'jobTimedOut':
          return t('conversion.timeout');
        case 'clientOnlyBlocked': {
          const blocked = t('queue.clientOnlyBlocked', { source: failure.source, target: failure.target });
          return failure.edgeFailed ? `${blocked} ${t('queue.edgeFailedFirst')}` : blocked;
        }
        case 'clientEdgeFailed':
          return t('queue.clientEdgeFailed');
        case 'conversionFailed':
          return t('queue.conversionFailed');
      }
    },
    [t, problemWording]
  );
}
