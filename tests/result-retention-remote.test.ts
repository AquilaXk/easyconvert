import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RemoteStorageBackend } from '../src/lib/storage/remote-storage-backend';
import { S3ObjectClient } from '../src/lib/storage/s3-object-client';
import { FileRetentionLedger, setRetentionLedger } from '../src/lib/storage/retention-ledger';
import { restoreIsolatedRetentionLedger } from './helpers/isolated-retention-ledger';
import { recordServed, registerResult, resultAvailability, sweepRetention } from '../src/lib/storage/retention-service';
import { resolveRetentionPolicy } from '../src/lib/storage/result-retention';
import { startS3StubServer, type S3StubServer } from './helpers/s3-stub-server';

/**
 * The retention rule is enforced by the application through IStorageBackend, not by the bucket: on the
 * object-store drivers (oci, s3) an object is deleted by the sweep after its delivery, and a lifecycle rule of
 * the bucket (whole days at best) is only a backstop.
 */

const BUCKET = 'internal-objects';
const ACCESS_KEY = 'AKIASTUBEXAMPLE00001';
const SECRET = 'stub/Secret+Key/EXAMPLEKEY0000000000000';
const POLICY = resolveRetentionPolicy({});
const SECOND_MS = 1000;
const BODY = Buffer.from('0123456789', 'ascii');

describe('delete on delivery on an S3-compatible object store', () => {
  let server: S3StubServer;
  let backend: RemoteStorageBackend;
  let ledgerDir: string;
  let scratchDir: string;

  beforeAll(async () => {
    server = await startS3StubServer({ bucket: BUCKET, credentials: { [ACCESS_KEY]: SECRET } });
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.objects.clear();
    ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-retention-remote-ledger-'));
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-retention-remote-scratch-'));
    setRetentionLedger(new FileRetentionLedger(ledgerDir));
    const client = new S3ObjectClient({
      endpoint: server.url,
      region: 'ap-seoul-1',
      bucket: BUCKET,
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET,
      providerName: 'oci',
      retryBaseDelayMs: 0,
      requestTimeoutMs: 10_000,
    });
    backend = new RemoteStorageBackend(client, { signingSecret: 'remote-retention-test-signing-secret-01', scratchDir });
  });

  afterEach(() => {
    restoreIsolatedRetentionLedger();
    fs.rmSync(ledgerDir, { recursive: true, force: true });
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  async function storeResult(key: string): Promise<void> {
    await backend.saveObject(key, BODY, 'application/octet-stream', 'result.bin', POLICY.undeliveredTtlMs);
    await registerResult(key);
  }

  it('removes the object from the bucket after its delivery and the grace period, and not before', async () => {
    const key = 'conversions/user-remote/1_result.bin';
    await storeResult(key);
    await recordServed(key, { first: 0, last: BODY.length - 1, size: BODY.length });

    expect(await sweepRetention(backend, Date.now() + POLICY.deliveredGraceMs - SECOND_MS)).toBe(0);
    expect(await backend.stat(key)).not.toBeNull();

    expect(await sweepRetention(backend, Date.now() + POLICY.deliveredGraceMs + SECOND_MS)).toBe(1);
    expect(await backend.stat(key)).toBeNull();
    expect(server.objects.size).toBe(0);
    expect(await resultAvailability(key, Date.now() + POLICY.deliveredGraceMs + SECOND_MS)).toMatchObject({
      state: 'deleted',
      reason: 'delivered',
    });
  });

  it('removes an object nobody fetched once the undelivered time has passed', async () => {
    const key = 'conversions/user-remote/2_unfetched.bin';
    await storeResult(key);

    expect(await sweepRetention(backend, Date.now() + POLICY.undeliveredTtlMs - SECOND_MS)).toBe(0);
    expect(await sweepRetention(backend, Date.now() + POLICY.undeliveredTtlMs + SECOND_MS)).toBe(1);

    expect(await backend.stat(key)).toBeNull();
    expect(await resultAvailability(key, Date.now() + POLICY.undeliveredTtlMs + SECOND_MS)).toMatchObject({
      state: 'deleted',
      reason: 'expired',
    });
  });
});
