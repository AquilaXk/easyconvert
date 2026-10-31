import { describe, expect, it } from 'vitest';
import { Semaphore } from '../src/lib/workers/semaphore';

/** A task that runs until `release` is called, and the promise of its end. */
function holdSlot(semaphore: Semaphore): { release: () => void; ended: Promise<void> } {
  let release = (): void => undefined;
  const ended = semaphore.run(() => new Promise<void>((resolve) => (release = resolve)));
  return { release: () => release(), ended };
}

describe('Semaphore', () => {
  it('runs at most `limit` tasks at once and releases waiting tasks in order', async () => {
    const semaphore = new Semaphore(2);
    const order: number[] = [];
    let active = 0;
    let peak = 0;
    const task = (id: number) =>
      semaphore.run(async () => {
        active++;
        peak = Math.max(peak, active);
        order.push(id);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
      });
    await Promise.all([1, 2, 3, 4, 5].map(task));
    expect(peak).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it('frees its slot when a task fails', async () => {
    const semaphore = new Semaphore(1);
    await expect(semaphore.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(semaphore.run(async () => 'next')).resolves.toBe('next');
  });

  it('lets any number of tasks wait when it has no queue bound', async () => {
    const semaphore = new Semaphore(1);
    const held = holdSlot(semaphore);
    const waiting = Array.from({ length: 200 }, (_, index) => semaphore.run(async () => index));
    held.release();
    await held.ended;
    expect(await Promise.all(waiting)).toEqual(Array.from({ length: 200 }, (_, index) => index));
  });

  it('refuses a task past the queue bound with the error the queue names, and runs the ones inside it', async () => {
    const semaphore = new Semaphore(1, { maxQueued: 1, onSaturated: () => new Error('queue is full') });
    const held = holdSlot(semaphore);
    const queued = semaphore.run(async () => 'queued');
    await expect(semaphore.run(async () => 'refused')).rejects.toThrow('queue is full');
    held.release();
    await held.ended;
    await expect(queued).resolves.toBe('queued');
  });

  it('ends a wait when its signal aborts, with the reason, and hands the slot to the next task still waiting', async () => {
    const semaphore = new Semaphore(1);
    const held = holdSlot(semaphore);
    const cancel = new AbortController();
    const cancelled = semaphore.run(async () => 'never', cancel.signal);
    const next = semaphore.run(async () => 'next');
    cancel.abort(new Error('cancelled'));
    await expect(cancelled).rejects.toThrow('cancelled');
    held.release();
    await held.ended;
    await expect(next).resolves.toBe('next');
    await expect(semaphore.run(async () => 'free')).resolves.toBe('free');
  });

  it('ends a wait at once when its signal has already aborted, without taking a slot', async () => {
    const semaphore = new Semaphore(1);
    const held = holdSlot(semaphore);
    const aborted = AbortSignal.abort(new Error('already cancelled'));
    await expect(semaphore.run(async () => 'never', aborted)).rejects.toThrow('already cancelled');
    held.release();
    await held.ended;
    await expect(semaphore.run(async () => 'free')).resolves.toBe('free');
  });

  it('ends a wait at the time limit of a timeout signal', async () => {
    const semaphore = new Semaphore(1);
    const held = holdSlot(semaphore);
    const error = await semaphore.run(async () => 'never', AbortSignal.timeout(30)).catch((err: unknown) => err);
    expect(error).toMatchObject({ name: 'TimeoutError' });
    held.release();
    await held.ended;
  });

  it('does not run a task that stopped waiting before the slot reached it', async () => {
    const semaphore = new Semaphore(1);
    const held = holdSlot(semaphore);
    const cancel = new AbortController();
    let ran = false;
    const waiting = semaphore.run(async () => { ran = true; }, cancel.signal);
    held.release();
    cancel.abort(new Error('cancelled late'));
    await held.ended;
    await expect(waiting).rejects.toThrow('cancelled late');
    expect(ran).toBe(false);
    await expect(semaphore.run(async () => 'free')).resolves.toBe('free');
  });

  it('keeps every slot for later tasks after waiters have left the queue', async () => {
    const semaphore = new Semaphore(2);
    const first = holdSlot(semaphore);
    const second = holdSlot(semaphore);
    const cancel = new AbortController();
    const left = Array.from({ length: 5 }, () => semaphore.run(async () => 'never', cancel.signal));
    cancel.abort(new Error('gone'));
    await Promise.all(left.map((wait) => expect(wait).rejects.toThrow('gone')));
    first.release();
    second.release();
    await Promise.all([first.ended, second.ended]);
    let running = 0;
    let peak = 0;
    const task = () => semaphore.run(async () => { peak = Math.max(peak, ++running); await new Promise((resolve) => setTimeout(resolve, 10)); running--; });
    await Promise.all([task(), task(), task(), task()]);
    expect(peak).toBe(2);
  });
});
