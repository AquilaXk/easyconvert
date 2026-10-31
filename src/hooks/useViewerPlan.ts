'use client';

import { useEffect, useSyncExternalStore } from 'react';
import type { Plan } from '@/lib/plan-limits';
import {
  getViewerAccount,
  getViewerPlan,
  refreshViewerPlan,
  subscribeViewerPlan,
  type ViewerAccount,
} from '@/lib/viewer-plan';

const SERVER_PLAN: Plan = 'anonymous';

/** Reads the session once when the component that owns the page's plan mounts: the queue, and the header's account menu. */
export function useRefreshViewerPlan(): void {
  useEffect(() => {
    void refreshViewerPlan();
  }, []);
}

/** The plan of the person using the page: anonymous at first, the plan of the session once `/api/auth/me` answers. */
export function useViewerPlan(): Plan {
  return useSyncExternalStore(subscribeViewerPlan, getViewerPlan, () => SERVER_PLAN);
}

/** The signed-in person of the page, from the same session read as `useViewerPlan`; null for a visitor. */
export function useViewerAccount(): ViewerAccount | null {
  useRefreshViewerPlan();
  return useSyncExternalStore(subscribeViewerPlan, getViewerAccount, () => null);
}
