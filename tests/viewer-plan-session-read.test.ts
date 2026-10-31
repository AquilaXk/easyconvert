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

describe('a session change the page made itself', () => {
  const ADA = { id: 'u1', name: 'Ada', tier: 'pro' };

  it('names the signed-in person from the sign-in answer without reading the session endpoint', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('no read expected')));
    vi.stubGlobal('fetch', fetchMock);
    const { plan } = await freshModules();

    plan.applySessionChange(ADA);

    expect(plan.getViewerAccount()).toEqual({ name: 'Ada', tier: 'pro' });
    expect(plan.getViewerPlan()).toBe('pro');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('signs the viewer out at once, and a session endpoint that then answers 503 does not bring the account back', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(sessionAnswer(SIGNED_IN)).mockResolvedValueOnce(new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const { plan } = await freshModules();
    await plan.refreshViewerPlan();
    expect(plan.getViewerAccount()).toEqual({ name: 'Ada', tier: 'free' });

    plan.applySessionChange(null);
    await plan.refreshViewerPlan();

    expect(plan.getViewerAccount()).toBeNull();
    expect(plan.getViewerPlan()).toBe('anonymous');
  });

  it('drops a read that began before a sign-in, whichever order the answers arrive in', async () => {
    const answers: Array<(response: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => answers.push(resolve))));
    const { plan } = await freshModules();
    const mountRead = plan.refreshViewerPlan();

    plan.applySessionChange(ADA);
    answers[0](sessionAnswer(VISITOR));
    await mountRead;

    expect(plan.getViewerAccount()).toEqual({ name: 'Ada', tier: 'pro' });
  });

  it('drops a read that began before a sign-out, so the account it saw does not come back', async () => {
    const answers: Array<(response: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => answers.push(resolve))));
    const { plan } = await freshModules();
    const mountRead = plan.refreshViewerPlan();

    plan.applySessionChange(null);
    answers[0](sessionAnswer(SIGNED_IN));
    await mountRead;

    expect(plan.getViewerAccount()).toBeNull();
    expect(plan.getViewerPlan()).toBe('anonymous');
  });

  it('starts a new read for the component that mounts after the change instead of joining the older one', async () => {
    const answers: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => answers.push(resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const { plan } = await freshModules();
    void plan.refreshViewerPlan();

    plan.applySessionChange(ADA);
    const afterChange = plan.refreshViewerPlan();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    answers[1](sessionAnswer({ success: true, user: { ...ADA, tier: 'enterprise' } }));
    await afterChange;
    expect(plan.getViewerPlan()).toBe('enterprise');
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

    const read = plan.refreshViewerPlan();
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
