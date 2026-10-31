import { maxFileBytes, planOfCaller, type Plan } from './plan-limits';

const SESSION_ENDPOINT = '/api/auth/me';

/** The signed-in person the header names: the name and tier the session endpoint answered with. */
export interface ViewerAccount {
  name: string;
  tier: string;
}

let viewerPlan: Plan = 'anonymous';
let viewerAccount: ViewerAccount | null = null;
let refreshing: Promise<void> | undefined;
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

async function readSession(): Promise<void> {
  const res = await fetch(SESSION_ENDPOINT);
  if (!res.ok) {
    setViewer('anonymous', null);
    return;
  }
  const body = (await res.json()) as { success?: boolean; user?: { id?: string; name?: string; tier?: string } };
  const user = body.success ? body.user : undefined;
  if (!user) {
    setViewer('anonymous', null);
    return;
  }
  setViewer(planOfCaller(user), { name: user.name ?? '', tier: user.tier ?? '' });
}

/**
 * Asks the session endpoint who the viewer is and what plan the session has. Callers that overlap share one request. A network failure keeps
 * the plan the viewer already had, which starts as the anonymous one, the smallest limit.
 */
export function refreshViewerPlan(): Promise<void> {
  refreshing ??= readSession()
    .catch(() => undefined)
    .finally(() => {
      refreshing = undefined;
    });
  return refreshing;
}
