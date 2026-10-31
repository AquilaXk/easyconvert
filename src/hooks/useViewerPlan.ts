'use client';

import { useEffect, useSyncExternalStore } from 'react';
import type { Plan } from '@/lib/plan-limits';
import { getViewerPlan, refreshViewerPlan, subscribeViewerPlan } from '@/lib/viewer-plan';

const SERVER_PLAN: Plan = 'anonymous';

/** The plan of the person using the page: anonymous at first, the plan of the session once `/api/auth/me` answers. */
export function useViewerPlan(): Plan {
  useEffect(() => {
    void refreshViewerPlan();
  }, []);
  return useSyncExternalStore(subscribeViewerPlan, getViewerPlan, () => SERVER_PLAN);
}
