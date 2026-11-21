import {
  CLIENT_ERROR_PATH,
  CLIENT_ERROR_REPORTS_PER_PAGE_LOAD,
  MAX_MESSAGE_CHARS,
  MAX_NAME_CHARS,
  MAX_PATH_CHARS,
  MAX_STACK_CHARS,
  type ClientErrorKind,
  type ClientErrorReport,
} from './report';
import { getUnhandledRejectionError } from './rejection-reason';

/**
 * The part of the crash report that runs in the browser (entry 384 of docs/policy-decisions.md). It listens for what the page throws
 * and does not catch (`error`, `unhandledrejection`) and takes the errors the error boundaries of the pages catch, sends each distinct
 * one to this site's own endpoint (at most five a page load) and does nothing else: no breadcrumbs, no storage, no page content, and a
 * failure to send changes nothing on the page. The two window handlers follow the global handlers of the Sentry browser SDK
 * (rejection-reason.ts); what the SDK sends to its server is left out.
 */

const NON_ERROR_NAME = 'NonError';
const FALLBACK_NAME = 'Error';

/** What the browser raises that no script of ours caused or can fix, which the Sentry SDK leaves out by default as well. */
const IGNORED_MESSAGE = /^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/;
const IGNORED_ERROR_NAMES: ReadonlySet<string> = new Set(['AbortError']);
const HIDDEN_CROSS_ORIGIN_MESSAGE = 'Script error.';

interface ErrorFacts {
  name: string;
  message: string;
  stack?: string;
  digest?: string;
}

/** An error by its fields, so that an error of another frame (not an `Error` of this one) is read too. A value that is not an error is named by its type, and its content is never read. */
function factsOf(error: unknown): ErrorFacts {
  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
    const { name, message, stack, digest } = error as { name?: unknown; message: string; stack?: unknown; digest?: unknown };
    return {
      name: typeof name === 'string' && name ? name.slice(0, MAX_NAME_CHARS) : FALLBACK_NAME,
      message: message.slice(0, MAX_MESSAGE_CHARS),
      stack: typeof stack === 'string' ? stack.slice(0, MAX_STACK_CHARS) : undefined,
      digest: typeof digest === 'string' ? digest : undefined,
    };
  }
  return { name: NON_ERROR_NAME, message: `A value of type ${error === null ? 'null' : typeof error} was thrown.` };
}

export interface ReporterEnvironment {
  /** Sends the JSON of one report. A failure is the reporter's to swallow. */
  send(body: string): void;
  /** The path of the page now, without query string or fragment. */
  pagePath(): string;
  /** The origin of this site: an error raised by a script of another origin is not ours to report. */
  ownOrigin: string;
  /** The commit the build was made from, when the build knows it. */
  release: string | undefined;
}

export interface ClientErrorReporter {
  report(kind: ClientErrorKind, error: unknown): void;
  /** Starts listening on `target` (a second call does nothing) and returns the function that stops it. */
  install(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void;
}

export function createClientErrorReporter(environment: ReporterEnvironment): ClientErrorReporter {
  const seen = new Set<string>();
  let installed = false;

  function report(kind: ClientErrorKind, error: unknown): void {
    try {
      const facts = factsOf(error);
      if (IGNORED_ERROR_NAMES.has(facts.name) || IGNORED_MESSAGE.test(facts.message)) return;
      const fingerprint = `${kind}|${facts.name}|${facts.message}|${facts.stack?.split('\n', 2).join('|') ?? ''}`;
      if (seen.has(fingerprint) || seen.size >= CLIENT_ERROR_REPORTS_PER_PAGE_LOAD) return;
      seen.add(fingerprint);

      const body: ClientErrorReport = {
        kind,
        name: facts.name,
        message: facts.message,
        ...(facts.stack ? { stack: facts.stack } : {}),
        ...(facts.digest ? { digest: facts.digest } : {}),
        path: environment.pagePath().slice(0, MAX_PATH_CHARS),
        ...(environment.release ? { release: environment.release } : {}),
      };
      environment.send(JSON.stringify(body));
    } catch {
      // A report that cannot be made or sent is lost; the page goes on.
    }
  }

  function onError(event: ErrorEvent): void {
    const hidden = !event.error && (event.message === HIDDEN_CROSS_ORIGIN_MESSAGE || !event.filename);
    const foreign = event.filename && !event.filename.startsWith(environment.ownOrigin);
    if (hidden || foreign) return;
    report('error', event.error ?? new Error(event.message));
  }

  function onUnhandledRejection(event: Event): void {
    report('unhandledrejection', getUnhandledRejectionError(event));
  }

  return {
    report,
    install(target) {
      if (installed) return () => undefined;
      installed = true;
      target.addEventListener('error', onError);
      target.addEventListener('unhandledrejection', onUnhandledRejection);
      return () => {
        target.removeEventListener('error', onError);
        target.removeEventListener('unhandledrejection', onUnhandledRejection);
        installed = false;
      };
    },
  };
}

/** The request of a report: a same-origin POST that outlives the page, without cookies; its failure is swallowed. */
function sendFromBrowser(body: string): void {
  void fetch(CLIENT_ERROR_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
    credentials: 'omit',
  }).catch(() => undefined);
}

let pageReporter: ClientErrorReporter | undefined;

/** The reporter of this page, made when it is first asked for: `window` is not there on a server. */
function browserReporter(): ClientErrorReporter {
  pageReporter ??= createClientErrorReporter({
    send: sendFromBrowser,
    pagePath: () => window.location.pathname,
    ownOrigin: window.location.origin,
    release: process.env.NEXT_PUBLIC_RELEASE_SHA,
  });
  return pageReporter;
}

export function installClientErrorReporting(): void {
  browserReporter().install(window);
}

export function reportClientError(kind: ClientErrorKind, error: unknown): void {
  browserReporter().report(kind, error);
}
