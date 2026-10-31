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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

describe('a read after the session changed', () => {
  it('starts a new read instead of joining one that began before the sign-in, and the older answer does not overwrite it', async () => {
    const answers: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => answers.push(resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const { plan } = await freshModules();

    const mountRead = plan.refreshViewerPlan();
    const afterSignIn = plan.refreshViewerPlan({ afterSessionChange: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    answers[1](sessionAnswer(SIGNED_IN));
    await afterSignIn;
    expect(plan.getViewerAccount()).toEqual({ name: 'Ada', tier: 'free' });

    answers[0](sessionAnswer(VISITOR));
    await mountRead;
    expect(plan.getViewerAccount()).toEqual({ name: 'Ada', tier: 'free' });
    expect(plan.getViewerPlan()).toBe('free');
  });

  it('lets a component that mounts meanwhile join the read after the change', async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    const { plan } = await freshModules();

    void plan.refreshViewerPlan({ afterSessionChange: true });
    void plan.refreshViewerPlan();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('a session endpoint that does not answer or does not say', () => {
  it('stops waiting after a bound, so the viewer keeps the plan it had', async () => {
    const bounds: number[] = [];
    const expired = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      bounds.push(ms);
      return expired.signal;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
      )
    );
    const { plan } = await freshModules();

    const read = plan.refreshViewerPlan({ afterSessionChange: true });
    expired.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    await read;

    expect(bounds).toHaveLength(1);
    expect(bounds[0]).toBeGreaterThan(0);
    expect(bounds[0]).toBeLessThanOrEqual(10_000);
    expect(plan.getViewerPlan()).toBe('anonymous');
  });

  it.each([429, 500, 503])('keeps the signed-in viewer when the endpoint answers %i, and signs out only on 401', async (status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sessionAnswer(SIGNED_IN))
      .mockResolvedValueOnce(new Response('{}', { status }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const { plan } = await freshModules();

    await plan.refreshViewerPlan();
    await plan.refreshViewerPlan();
    expect(plan.getViewerAccount()).toEqual({ name: 'Ada', tier: 'free' });

    await plan.refreshViewerPlan();
    expect(plan.getViewerAccount()).toBeNull();
  });

  it('takes an answer without a user as signed out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(sessionAnswer(SIGNED_IN)).mockResolvedValueOnce(sessionAnswer(VISITOR)));
    const { plan } = await freshModules();

    await plan.refreshViewerPlan();
    await plan.refreshViewerPlan();

    expect(plan.getViewerAccount()).toBeNull();
    expect(plan.getViewerPlan()).toBe('anonymous');
  });
});
