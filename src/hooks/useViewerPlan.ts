'use client';

import { useEffect, useSyncExternalStore } from 'react';
import type { Plan } from '@/lib/plan-limits';
import {
  applySessionChange,
  getViewerAccount,
  getViewerPlan,
  hasViewerSessionState,
  refreshViewerPlan,
  subscribeViewerPlan,
  viewerAccountOf,
  type SessionUser,
  type ViewerAccount,
} from '@/lib/viewer-plan';

const SERVER_PLAN: Plan = 'anonymous';

/** Reads the session when a component that needs the page's plan mounts (the queue, the header's account menu). */
export function useRefreshViewerPlan(initialUser?: SessionUser): void {
  useEffect(() => {
    if (initialUser) {
      applySessionChange(initialUser);
      return;
    }
    void refreshViewerPlan();
  }, [initialUser]);
}

/** The plan of the person using the page: anonymous at first, the plan of the session once `/api/auth/me` answers. */
export function useViewerPlan(): Plan {
  return useSyncExternalStore(subscribeViewerPlan, getViewerPlan, () => SERVER_PLAN);
}

/** The signed-in person of the page, from the same session read as `useViewerPlan`; null for a visitor. */
export function useViewerAccount(initialUser?: SessionUser): ViewerAccount | null {
  useRefreshViewerPlan(initialUser);
  return useSyncExternalStore(
    subscribeViewerPlan,
    () => (hasViewerSessionState() || !initialUser ? getViewerAccount() : viewerAccountOf(initialUser)),
    () => (initialUser ? viewerAccountOf(initialUser) : null)
  );
}
