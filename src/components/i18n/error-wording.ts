import { useCallback } from 'react';
import { useFormatter, useMessages, useTranslations, type Messages } from 'next-intl';
import type { ConversionFailure } from '@/lib/conversion-failure';
import { PLAN_MAX_FILE_BYTES, URL_IMPORT_MAX_BYTES, maxFileBytes, type Plan } from '@/lib/plan-limits';
import {
  AUTH_ERROR_CODES, CONVERSION_REFUSAL_CODES, DASHBOARD_REFUSAL_CODES, URL_IMPORT_ERROR_CODES, isCodeOf, problemNameOfType,
} from '@/lib/refusal-codes';
import { useViewerPlan } from '@/hooks/useViewerPlan';
import { useFileTooLargeMessage, useFormatBytes } from './format';

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

type StatusProblems = Readonly<Record<number, ProblemName>>;

/**
 * The problem a status names when an answer carries no `type`, for the statuses that have one cause on the routes of the web
 * application and in front of them (the proxy's burst limit is an untyped 429 that is not the daily quota, and its body limit
 * an untyped 413). Any other status stands for several causes: a 400 or 422 reads as "check what you entered", a 5xx as the
 * sentence of the action that failed. A caller that cannot tell the cause by status (the sign-in form) turns it off.
 */
const SINGLE_CAUSE_STATUS_PROBLEMS: StatusProblems = {
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not-found',
  405: 'method-not-allowed',
  413: 'payload-too-large',
  415: 'unsupported-media-type',
  429: 'rate-limited',
  503: 'service-unavailable',
};

/** The name of the problem an answer states: its own `type` when it has one, else the problem its status names, if read. */
function problemNameOf(answer: Answer, status: number, byStatus: boolean): string | undefined {
  const type = textField(answer, 'type');
  if (type === undefined) return byStatus ? SINGLE_CAUSE_STATUS_PROBLEMS[status] : undefined;
  return problemNameOfType(type);
}

interface LimitWords {
  /** The sentence `key` with the number in `field` of the answer, or undefined when the answer does not carry it. */
  limit: (key: LimitKey, answer: Answer, field: string, unit: 'bytes' | 'count') => string | undefined;
  fileTooLarge: (plan: Plan, sizeBytes: number) => string;
  /** The sentence of a job that needs `required` conversions when `left` are left today. */
  conversionsShort: (required: number, left: number) => string;
}

/**
 * The daily quota of a refused job: how many it needs and how many are left, when some are left but fewer than it needs,
 * else the day's limit, which is then used up.
 */
function quotaSentence(answer: Answer, { limit, conversionsShort }: LimitWords): string | undefined {
  const required = numberField(answer, 'requiredUnits');
  const left = numberField(answer, 'remaining');
  if (required !== undefined && left !== undefined && left > 0 && required > left) return conversionsShort(required, left);
  return limit('quota-exceeded', answer, 'dailyLimit', 'count');
}

/** The sentences that name the numbers a problem's answer carries, by problem name; without the number, the problem's own. */
const LIMIT_SENTENCES: Readonly<Partial<Record<ProblemName, (answer: Answer, words: LimitWords) => string | undefined>>> = {
  'payload-too-large': (answer, { limit, fileTooLarge }) => {
    const sizeBytes = numberField(answer, 'sizeBytes');
    if (isPlan(answer.plan) && sizeBytes !== undefined) return fileTooLarge(answer.plan, sizeBytes);
    return limit('payload-too-large', answer, 'maxRequestBytes', 'bytes');
  },
  'concurrency-limit': (answer, { limit }) => limit('concurrency-limit', answer, 'limit', 'count'),
  'quota-exceeded': quotaSentence,
  'upload-budget-exceeded': (answer, { limit }) => {
    if (answer.refusal === 'open-uploads') return limit('open-uploads', answer, 'limit', 'count');
    if (answer.refusal === 'larger-than-left') return limit('imports-larger-than-left', answer, 'leftBytes', 'bytes');
    if (answer.refusal !== 'daily-bytes') return undefined;
    const ofAccount = isPlan(answer.plan) && answer.plan !== 'anonymous';
    return limit(ofAccount ? 'daily-import-bytes' : 'daily-bytes', answer, 'limitBytes', 'bytes');
  },
};

export interface ProblemWordingOptions {
  /** Whether an answer without a `type` takes the problem its status names when the status has one cause (the default). */
  byStatus?: boolean;
  /**
   * How a refusal (4xx) with no problem reads: "check what you entered" for an action that sent input (the default), or the
   * sentence of the action for one that sent none, such as a read, a replay or the sign-in form, whose causes the status
   * cannot tell apart.
   */
  untypedRefusal?: 'checkInput' | 'action';
}

/**
 * The wording of any refused request (RFC 9457 practice): the sentence of its problem `type`, which is a stable key of a
 * sentence in the page's language, with the numbers that sentence names taken from the answer's fields. An answer without a
 * `type` takes the problem its status names when the status has one cause. Any other refusal (4xx) reads "check what you
 * entered", since "try again" would not help, or `fallback` for an action that sent nothing to check; any other failure reads
 * `fallback` (the sentence of the action that failed) or the sentence of its status class. The server's `detail` is written
 * for the developer of an API client, so no sentence of the interface carries it.
 */
export function useProblemWording({
  byStatus = true,
  untypedRefusal = 'checkInput',
}: ProblemWordingOptions = {}): (payload: unknown, status: number, fallback?: string) => string {
  const t = useTranslations('errors');
  const problems = useMessages().errors.problems;
  const format = useFormatter();
  const formatBytes = useFormatBytes();
  const fileTooLarge = useFileTooLargeMessage();
  return useCallback(
    (payload: unknown, status: number, fallback?: string) => {
      const answer = answerOf(payload);
      const name = problemNameOf(answer, status, byStatus);
      if (name !== undefined && isProblemName(problems, name)) {
        const limit: LimitWords['limit'] = (key, fields, field, unit) => {
          const value = numberField(fields, field);
          return value === undefined ? undefined : t(`limits.${key}`, { limit: unit === 'bytes' ? formatBytes(value) : format.number(value) });
        };
        const conversionsShort: LimitWords['conversionsShort'] = (required, left) => t('limits.quota-short', { required, left });
        const limitSentence = LIMIT_SENTENCES[name]?.(answer, { limit, fileTooLarge, conversionsShort });
        return limitSentence ?? t(`problems.${name}`);
      }
      if (isRefusal(status)) return untypedRefusal === 'action' && fallback ? fallback : t('generic.client');
      return fallback ?? t('generic.server');
    },
    [t, problems, format, formatBytes, fileTooLarge, byStatus, untypedRefusal]
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
  const problemWording = useProblemWording({ byStatus: false, untypedRefusal: 'action' });
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
 * A refusal of a dashboard route (files, API keys, failed webhooks), by its `code`; an answer without a code this build knows
 * is worded as `useProblemWording` words it, with `fallback` for a failure. A read or a replay sends nothing to check, so it
 * passes `untypedRefusal: 'action'` and an untyped refusal of it reads as its own sentence.
 */
export function useDashboardErrorWording(
  options: Pick<ProblemWordingOptions, 'untypedRefusal'> = {}
): (payload: unknown, status: number, fallback: string) => string {
  const t = useTranslations('errors.dashboard');
  const problemWording = useProblemWording({ untypedRefusal: options.untypedRefusal });
  return useCallback(
    (payload: unknown, status: number, fallback: string) => {
      const code = answerOf(payload).code;
      return isCodeOf(DASHBOARD_REFUSAL_CODES, code) ? t(code) : problemWording(payload, status, fallback);
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
