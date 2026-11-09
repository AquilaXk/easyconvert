import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localFsStorage } from '../src/lib/storage';
import { InMemoryTusSessionStore, TusEngine, setTusSessionStore } from '../src/lib/storage/tus-engine';

/**
 * A finished upload is stored under its key and recorded; the file it was staged in would only occupy the disk a second time. The
 * record of the session (`<id>.info`) stays until the session expires, and so do the files of an upload nobody finishes: the
 * sweep of the storage directory does not look in the staging directory, so the engine removes what has expired.
 */

const BODY = Buffer.from('plain text of a finished upload\n');
const HOUR_MS = 3_600_000;
let tusDir: string;
let engine: TusEngine;

beforeEach(() => {
  tusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tus-staged-'));
  setTusSessionStore(new InMemoryTusSessionStore());
  engine = new TusEngine({ tusDir, defaultTtlSeconds: 86_400 });
});
afterEach(() => {
  setTusSessionStore(null);
  fs.rmSync(tusDir, { recursive: true, force: true });
});

const filesOf = (): string[] => fs.readdirSync(tusDir).sort();

describe('the staging directory of the uploads', () => {
  it('holds no copy of an upload that was stored, only the record of its session', async () => {
    const session = await engine.createSession({ uploadLength: BODY.length, metadataHeader: 'filename dGV4dC50eHQ=,filetype dGV4dC9wbGFpbg==' });
    const result = await engine.appendChunk(session.id, 0, Readable.from([BODY]));
    expect(result.isComplete).toBe(true);
    expect(filesOf()).toEqual([`${session.id}.info`]);
    // The stored object is the whole upload, and the session still answers as a finished one.
    expect(fs.readFileSync(localFsStorage.getPathsForKey(session.key).binPath)).toEqual(BODY);
    expect(await engine.getSession(session.id)).toMatchObject({ completed: true, uploadOffset: BODY.length });
    await localFsStorage.delete(session.key);
  });

  it('keeps the staged file of an upload that is not finished', async () => {
    const session = await engine.createSession({ uploadLength: BODY.length * 2 });
    await engine.appendChunk(session.id, 0, Readable.from([BODY]));
    expect(filesOf()).toEqual([`${session.id}.bin`, `${session.id}.info`]);
  });

  it('removes the files of the sessions that expired, and only those', async () => {
    const live = await engine.createSession({ uploadLength: 10 });
    const expired = await engine.createSession({ uploadLength: 10, ttlSeconds: 60 });
    const removed = await engine.sweepExpired(Date.now() + HOUR_MS);
    expect(removed).toBe(1);
    expect(filesOf()).toEqual([`${live.id}.bin`, `${live.id}.info`]);
    expect(await engine.getSession(expired.id)).toBeNull();
  });

  it('removes a staged file whose record is gone once its id is older than a session lives', async () => {
    const young = await engine.createSession({ uploadLength: 10 });
    fs.rmSync(path.join(tusDir, `${young.id}.info`));
    fs.writeFileSync(path.join(tusDir, `tus_${Date.now() - 3 * 86_400_000}_0123456789abcdef.bin`), 'left behind');
    fs.writeFileSync(path.join(tusDir, 'notes.txt'), 'not an upload');
    expect(await engine.sweepExpired()).toBe(1);
    expect(filesOf()).toEqual(['notes.txt', `${young.id}.bin`]);
  });

  it('sweeps when an upload is created, at most once in ten minutes', async () => {
    const stale = path.join(tusDir, `tus_${Date.now() - 3 * 86_400_000}_0123456789abcdef.bin`);
    fs.writeFileSync(stale, 'left behind');
    await engine.createSession({ uploadLength: 10 });
    await vi.waitFor(() => expect(fs.existsSync(stale)).toBe(false));
    fs.writeFileSync(stale, 'left behind again');
    await engine.createSession({ uploadLength: 10 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.existsSync(stale)).toBe(true);
  });
});
