import { maxFileBytes, planOfCaller, type Plan } from './plan-limits';

const SESSION_ENDPOINT = '/api/auth/me';

let viewerPlan: Plan = 'anonymous';
let refreshing: Promise<void> | undefined;
const listeners = new Set<() => void>();

export function getViewerPlan(): Plan {
  return viewerPlan;
}

export function setViewerPlan(next: Plan): void {
  if (next === viewerPlan) return;
  viewerPlan = next;
  for (const listener of listeners) listener();
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

async function readSessionPlan(): Promise<void> {
  const res = await fetch(SESSION_ENDPOINT);
  if (!res.ok) {
    setViewerPlan('anonymous');
    return;
  }
  const body = (await res.json()) as { success?: boolean; user?: { id?: string; tier?: string } };
  setViewerPlan(body.success ? planOfCaller(body.user) : 'anonymous');
}

/**
 * Asks the session endpoint for the viewer's plan. Callers that overlap share one request. A network failure keeps
 * the plan the viewer already had, which starts as the anonymous one, the smallest limit.
 */
export function refreshViewerPlan(): Promise<void> {
  refreshing ??= readSessionPlan()
    .catch(() => undefined)
    .finally(() => {
      refreshing = undefined;
    });
  return refreshing;
}
