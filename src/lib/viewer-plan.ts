import { maxFileBytes, planOfCaller, type Plan } from './plan-limits';

const SESSION_ENDPOINT = '/api/auth/me';

/** The signed-in person the header names: the name and tier the session endpoint answered with. */
export interface ViewerAccount {
  name: string;
  tier: string;
}

let viewerPlan: Plan = 'anonymous';
let viewerAccount: ViewerAccount | null = null;
/** The newest read of the session that has not ended, which overlapping callers share. */
let reading: Promise<void> | undefined;
let latestRead = 0;
const listeners = new Set<() => void>();

export function getViewerPlan(): Plan {
  return viewerPlan;
}

function sameAccount(a: ViewerAccount | null, b: ViewerAccount | null): boolean {
  return a === b || (a !== null && b !== null && a.name === b.name && a.tier === b.tier);
}

function setViewer(plan: Plan, account: ViewerAccount | null): void {
  if (plan === viewerPlan && sameAccount(account, viewerAccount)) return;
  viewerPlan = plan;
  viewerAccount = account;
  for (const listener of listeners) listener();
}

export function setViewerPlan(next: Plan): void {
  setViewer(next, next === 'anonymous' ? null : viewerAccount);
}

/** The signed-in person, or null for a visitor without a session (and until the session endpoint answers). */
export function getViewerAccount(): ViewerAccount | null {
  return viewerAccount;
}

export function subscribeViewerPlan(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The most bytes one file may have for the viewer's plan: anonymous until the session answers. */
export function getViewerMaxFileBytes(): number {
  return maxFileBytes(viewerPlan);
}

/** The longest the page waits for the session endpoint; a read that takes longer ends and the viewer keeps what it had. */
const SESSION_READ_TIMEOUT_MS = 5000;
const HTTP_UNAUTHORIZED = 401;

interface Viewer {
  plan: Plan;
  account: ViewerAccount | null;
}

const SIGNED_OUT: Viewer = { plan: 'anonymous', account: null };

/**
 * Who the session endpoint says the viewer is: nobody on a 401 or an answer without a user. Undefined when it does not
 * say, as for a 429 or a server error: that answers nothing about the session, so the viewer keeps what it had.
 */
async function askSession(): Promise<Viewer | undefined> {
  const res = await fetch(SESSION_ENDPOINT, { signal: AbortSignal.timeout(SESSION_READ_TIMEOUT_MS) });
  if (res.status === HTTP_UNAUTHORIZED) return SIGNED_OUT;
  if (!res.ok) return undefined;
  const body = (await res.json()) as { success?: boolean; user?: { id?: string; name?: string; tier?: string } };
  const user = body.success ? body.user : undefined;
  return user ? { plan: planOfCaller(user), account: { name: user.name ?? '', tier: user.tier ?? '' } } : SIGNED_OUT;
}

export interface RefreshOptions {
  /** The session changed (a sign-in, a sign-out): read it anew, not from a read that began before the change. */
  afterSessionChange?: boolean;
}

/**
 * Asks the session endpoint who the viewer is and what plan the session has. Callers that overlap share one request; a
 * request that ended is not kept, so the next caller asks again: a component that mounts on a new page, and the sign-in
 * and sign-out that change the session. A read after such a change always starts its own request, and an older read
 * that answers later does not replace its answer. A network failure, a timeout or an answer that says nothing about the
 * session keeps the plan the viewer already had, which starts as the anonymous one, the smallest limit.
 */
export function refreshViewerPlan({ afterSessionChange = false }: RefreshOptions = {}): Promise<void> {
  if (reading && !afterSessionChange) return reading;
  const readId = ++latestRead;
  const read: Promise<void> = askSession()
    .then(
      (viewer) => {
        if (viewer && readId === latestRead) setViewer(viewer.plan, viewer.account);
      },
      () => undefined
    )
    .finally(() => {
      if (readId === latestRead) reading = undefined;
    });
  reading = read;
  return read;
}
