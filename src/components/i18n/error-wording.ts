import { useCallback } from 'react';
import { useFormatter, useTranslations, type Messages } from 'next-intl';
import type { ConversionFailure } from '@/lib/conversion-failure';
import { PLAN_MAX_FILE_BYTES, URL_IMPORT_MAX_BYTES, maxFileBytes, type Plan } from '@/lib/plan-limits';
import {
  AUTH_ERROR_CODES,
  CONVERSION_REFUSAL_CODES,
  URL_IMPORT_ERROR_CODES,
  conversionRefusalCodeOf,
  knownCode,
} from '@/lib/refusal-codes';
import { useViewerPlan } from '@/hooks/useViewerPlan';
import { useFileTooLargeMessage, useFormatBytes } from './format';

/**
 * How the interface words a refused request or a failed conversion (RFC 9457 practice): a stable `code` or problem `type`
 * is the key of a sentence in the page's language, the numbers that sentence names come from the answer's fields, and the
 * server's English text is never part of the sentence. An answer the interface does not know reads as one sentence for its
 * status class, with the English text kept as `technical` for the "technical details" disclosure.
 */
export interface ErrorWording {
  readonly message: string;
  readonly technical?: string;
}

type Answer = Readonly<Record<string, unknown>>;

/** The values a sentence names, formatted for the page's locale; `none` picks the sentence without the number. */
type Facts = Record<string, string>;

interface Formatters {
  bytes: (value: number) => string;
  number: (value: number) => string;
  fileTooLarge: (plan: Plan, sizeBytes: number) => string;
}

const PROBLEM_TYPE_PREFIX = 'https://api.easyconvert.io/problems/';
const NONE = 'none';
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

/** The server's English text of an answer: what "technical details" shows. */
function serverText(answer: Answer): string | undefined {
  return textField(answer, 'detail') ?? textField(answer, 'error') ?? textField(answer, 'message');
}

const isPlan = (value: unknown): value is Plan => typeof value === 'string' && Object.hasOwn(PLAN_MAX_FILE_BYTES, value);

/** A number field as a fact, or `none` when the answer does not carry it. */
const numberFact = (answer: Answer, field: string, format: (value: number) => string): string => {
  const value = numberField(answer, field);
  return value === undefined ? NONE : format(value);
};

type ProblemKey = keyof Messages['errors']['problems'];

interface ProblemRule {
  readonly key: ProblemKey;
  readonly facts?: (answer: Answer, format: Formatters) => Facts;
}

/** The problem types the interface words, by the name after `PROBLEM_TYPE_PREFIX`, and the fields their sentences name. */
const PROBLEM_TYPES: Readonly<Record<string, ProblemRule>> = {
  'bad-request': { key: 'badRequest' },
  unauthorized: { key: 'unauthorized' },
  forbidden: { key: 'forbidden' },
  'not-found': { key: 'notFound' },
  'method-not-allowed': { key: 'methodNotAllowed' },
  'payload-too-large': { key: 'payloadTooLarge', facts: (answer, format) => ({ limit: numberFact(answer, 'maxRequestBytes', format.bytes) }) },
  'length-required': { key: 'lengthRequired' },
  'unsupported-media-type': { key: 'unsupportedMediaType' },
  'rate-limited': { key: 'rateLimited' },
  'concurrency-limit': { key: 'concurrencyLimit', facts: (answer, format) => ({ limit: numberFact(answer, 'limit', format.number) }) },
  'quota-exceeded': { key: 'quotaExceeded', facts: (answer, format) => ({ limit: numberFact(answer, 'dailyLimit', format.number) }) },
  'upload-budget-exceeded': {
    key: 'uploadBudgetExceeded',
    facts: (answer, format) => {
      if (answer.refusal === 'open-uploads') return { refusal: 'openUploads', limit: numberFact(answer, 'limit', format.number) };
      if (answer.refusal === 'daily-bytes') return { refusal: 'dailyBytes', limit: numberFact(answer, 'limitBytes', format.bytes) };
      return { refusal: NONE, limit: NONE };
    },
  },
  'storage-full': { key: 'storageFull' },
  'service-unavailable': { key: 'serviceUnavailable' },
  'client-ip-trust-unconfigured': { key: 'serviceUnavailable' },
  'internal-server-error': { key: 'internalError' },
  'unprocessable-entity': { key: 'unprocessable' },
  'engine-unavailable': { key: 'engineUnavailable' },
  'job-timeout': { key: 'jobTimeout' },
  'client-closed-request': { key: 'clientClosed' },
  'pdf-postprocess-failed': { key: 'pdfPostprocessFailed' },
  'pdfa-validation-failed': { key: 'pdfaValidationFailed' },
  'option-not-supported': { key: 'optionNotSupported' },
  'unknown-format': { key: 'unknownFormat' },
  'invalid-archive': { key: 'invalidArchive' },
  'missing-archive-volume': { key: 'missingArchiveVolume' },
  'archive-encrypted-header': { key: 'archiveEncryptedHeader' },
  'job-state-corrupt': { key: 'jobStateCorrupt' },
  'part-in-flight': { key: 'partInFlight' },
  'idempotency-key-reused': { key: 'idempotencyKeyReused' },
  'idempotency-key-in-flight': { key: 'idempotencyKeyInFlight' },
};

function problemRuleOf(answer: Answer): ProblemRule | undefined {
  const type = textField(answer, 'type');
  if (!type?.startsWith(PROBLEM_TYPE_PREFIX)) return undefined;
  const name = type.slice(PROBLEM_TYPE_PREFIX.length);
  return Object.hasOwn(PROBLEM_TYPES, name) ? PROBLEM_TYPES[name] : undefined;
}

/** A 413 for a file over its plan names the plan and the size; the sentence is the one the drop zone shows. */
function planLimitSentence(answer: Answer, format: Formatters): string | undefined {
  const sizeBytes = numberField(answer, 'sizeBytes');
  return isPlan(answer.plan) && sizeBytes !== undefined ? format.fileTooLarge(answer.plan, sizeBytes) : undefined;
}

function useFormatters(): Formatters {
  const format = useFormatter();
  const bytes = useFormatBytes();
  const fileTooLarge = useFileTooLargeMessage();
  return { bytes, number: (value) => format.number(value), fileTooLarge };
}

/**
 * The wording of any refused request: a problem type this table knows, else `fallback` (the sentence of the action that
 * failed) or the sentence of the status class, with the server's text as technical details.
 */
export function useProblemWording(): (payload: unknown, status: number, fallback?: string) => ErrorWording {
  const t = useTranslations('errors');
  const format = useFormatters();
  return useCallback(
    (payload: unknown, status: number, fallback?: string) => {
      const answer = answerOf(payload);
      const planLimit = planLimitSentence(answer, format);
      if (planLimit) return { message: planLimit };
      const rule = problemRuleOf(answer);
      if (rule) return { message: t(`problems.${rule.key}`, rule.facts?.(answer, format)) };
      const generic = status >= HTTP_CLIENT_ERROR_MIN && status < HTTP_SERVER_ERROR_MIN ? t('generic.client') : t('generic.server');
      return { message: fallback ?? generic, technical: serverText(answer) };
    },
    [t, format]
  );
}

/** A refusal of `/api/fetch-url`, by its `code`; an answer without a known code as `useProblemWording` words it. */
export function useUrlImportErrorWording(): (payload: unknown, status: number) => ErrorWording {
  const t = useTranslations('errors.urlImport');
  const problemWording = useProblemWording();
  const formatBytes = useFormatBytes();
  const plan = useViewerPlan();
  return useCallback(
    (payload: unknown, status: number) => {
      const answer = answerOf(payload);
      const code = knownCode(URL_IMPORT_ERROR_CODES, answer);
      if (!code) return problemWording(answer, status);
      if (code === 'file_too_large') {
        return { message: t(code, { limit: formatBytes(URL_IMPORT_MAX_BYTES), planLimit: formatBytes(maxFileBytes(plan)) }) };
      }
      if (code === 'remote_error') {
        const remoteStatus = numberField(answer, 'remoteStatus');
        return { message: t(code, { status: remoteStatus === undefined ? NONE : String(remoteStatus) }) };
      }
      return { message: t(code) };
    },
    [t, problemWording, formatBytes, plan]
  );
}

/** A refusal of `/api/auth/login` or `/api/auth/register`, by its `code`; never by its status alone. */
export function useAuthErrorWording(): (payload: unknown, status: number) => ErrorWording {
  const t = useTranslations('errors.auth');
  const problemWording = useProblemWording();
  return useCallback(
    (payload: unknown, status: number) => {
      const answer = answerOf(payload);
      const code = knownCode(AUTH_ERROR_CODES, answer);
      if (code === 'login_locked') return { message: t('login_locked', { seconds: numberField(answer, 'retryAfterSeconds') ?? 0 }) };
      if (code) return { message: t(code) };
      return problemWording(answer, status, t('failed'));
    },
    [t, problemWording]
  );
}

/**
 * The wording of a conversion that failed in the queue. A server refusal is worded by its `code` or problem type, and its
 * English text always stays under technical details, since a conversion's own reason helps support; a failed job by the
 * code its worker recorded, else as a failed job.
 */
export function useConversionFailureWording(): (failure: ConversionFailure) => ErrorWording {
  const t = useTranslations('errors');
  const problemWording = useProblemWording();
  return useCallback(
    (failure: ConversionFailure) => {
      switch (failure.code) {
        case 'server': {
          const code = knownCode(CONVERSION_REFUSAL_CODES, failure.problem);
          const technical = serverText(failure.problem);
          const status = numberField(failure.problem, 'status') ?? HTTP_SERVER_ERROR_MIN;
          return code ? { message: t(`conversion.${code}`), technical } : { ...problemWording(failure.problem, status), technical };
        }
        case 'jobFailed': {
          const code = conversionRefusalCodeOf(failure.failedCode);
          return { message: code ? t(`conversion.${code}`) : t('queue.jobFailed'), technical: failure.reason };
        }
        case 'jobTimedOut':
          return { message: t('conversion.timeout') };
        case 'clientOnlyBlocked':
          return {
            message: t('queue.clientOnlyBlocked', { source: failure.source, target: failure.target, tier: failure.edgeFailure?.tier ?? NONE }),
            technical: failure.edgeFailure?.reason,
          };
        case 'clientEdgeFailed':
          return { message: t('queue.clientEdgeFailed'), technical: failure.reason };
        case 'conversionFailed':
          return { message: t('queue.conversionFailed') };
      }
    },
    [t, problemWording]
  );
}

/** A ZIP bundle that could not be built, with the archiver's reason as technical details. */
export function useZipFailureWording(): (detail: string) => ErrorWording {
  const t = useTranslations('errors.queue');
  return useCallback((detail: string) => ({ message: t('zipFailed'), technical: detail || undefined }), [t]);
}
