import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A mount runs its effects at once, so calling the hook stands for a component that mounts.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: (effect: () => void) => effect(),
}));

function sessionAnswer(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const VISITOR = { success: false };
const SIGNED_IN = { success: true, user: { id: 'u1', name: 'Ada', tier: 'free' } };

/** Lets a read that started finish: its answer and its body arrive on later turns of the event loop. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function freshModules() {
  vi.resetModules();
  return {
    hooks: await import('../src/hooks/useViewerPlan'),
    plan: await import('../src/lib/viewer-plan'),
  };
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('the session read of a component that mounts', () => {
  it('reads the session again when the header of the next page mounts after a sign-in', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(sessionAnswer(VISITOR)).mockResolvedValueOnce(sessionAnswer(SIGNED_IN));
    vi.stubGlobal('fetch', fetchMock);
    const { hooks, plan } = await freshModules();

    hooks.useRefreshViewerPlan();
    await settle();
    expect(plan.getViewerAccount()).toBeNull();

    hooks.useRefreshViewerPlan();
    await vi.waitFor(() => expect(plan.getViewerAccount()).toEqual({ name: 'Ada', tier: 'free' }));
    expect(plan.getViewerPlan()).toBe('free');
  });

  it('asks again after a read that failed instead of keeping the failure for the page', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValue(sessionAnswer(SIGNED_IN));
    vi.stubGlobal('fetch', fetchMock);
    const { hooks, plan } = await freshModules();

    hooks.useRefreshViewerPlan();
    await settle();
    hooks.useRefreshViewerPlan();
    await vi.waitFor(() => expect(plan.getViewerAccount()).toEqual({ name: 'Ada', tier: 'free' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one request between components that mount together', async () => {
    const fetchMock = vi.fn(async () => sessionAnswer(SIGNED_IN));
    vi.stubGlobal('fetch', fetchMock);
    const { hooks, plan } = await freshModules();

    hooks.useRefreshViewerPlan();
    hooks.useRefreshViewerPlan();
    await plan.refreshViewerPlan();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
