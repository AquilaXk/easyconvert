import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { S3StorageAdapter, S3_DEV_ENDPOINT_ALLOWLIST_ENV } from '../src/lib/storage/adapters/s3';
import { EMPTY_PAYLOAD_SHA256, signS3Request } from '../src/lib/storage/s3-sigv4';
import {
  isStrictOracleMode,
  missingRealS3ServerMessage,
  readRealS3Server,
  type RealS3Server,
} from './helpers/s3-test-server';

/**
 * Runs the adapter against an S3-compatible server that verifies SigV4 with its own implementation:
 * the one described by STORAGE_TEST_S3_* (tests/helpers/s3-test-server.ts), which CI starts.
 * Outside strict mode a local `minio` binary is a fallback; without either the suite is skipped
 * explicitly, and under ORACLE_STRICT_MODE=1 a missing server is a failure.
 */

const CONFIGURED_SERVER = readRealS3Server();
const STRICT = isStrictOracleMode();
const LOCAL_MINIO_AVAILABLE = !CONFIGURED_SERVER && !STRICT && spawnSync('minio', ['--version'], { stdio: 'ignore' }).status === 0;

const LOCAL_ACCESS_KEY = 'minioadmin-test';
const LOCAL_SECRET = 'minioadmin-test-secret';
const LOCAL_BUCKET = 'byos-integration';
const LOCAL_REGION = 'us-east-1';
const MIB = 1024 * 1024;
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 200;
const HTTP_OK = 200;
const HTTP_CONFLICT = 409;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** Creates the bucket with a signed PUT; 409 means it already exists and is ours. */
async function createBucket(server: RealS3Server): Promise<number | undefined> {
  const signed = signS3Request({
    method: 'PUT',
    origin: server.endpoint,
    path: `/${server.bucket}`,
    payloadHash: EMPTY_PAYLOAD_SHA256,
    credentials: { accessKeyId: server.accessKeyId, secretAccessKey: server.secretAccessKey },
    region: server.region,
  });
  const res = await fetch(signed.url, { method: 'PUT', headers: signed.headers }).catch(() => null);
  return res?.status;
}

describe.skipIf(!CONFIGURED_SERVER && !LOCAL_MINIO_AVAILABLE && !STRICT)('S3StorageAdapter against a real S3-compatible server', () => {
  if (!CONFIGURED_SERVER && !LOCAL_MINIO_AVAILABLE) {
    it('requires STORAGE_TEST_S3_ENDPOINT, STORAGE_TEST_S3_ACCESS_KEY_ID and STORAGE_TEST_S3_SECRET_ACCESS_KEY', () => {
      throw new Error(missingRealS3ServerMessage());
    });
    return;
  }

  let proc: ChildProcess | undefined;
  let dataDir: string | undefined;
  let server: RealS3Server;
  const prefix = `byos-${crypto.randomBytes(4).toString('hex')}/`;

  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'development');
    if (CONFIGURED_SERVER) {
      server = CONFIGURED_SERVER;
    } else {
      const port = await freePort();
      server = {
        endpoint: `http://127.0.0.1:${port}`,
        accessKeyId: LOCAL_ACCESS_KEY,
        secretAccessKey: LOCAL_SECRET,
        bucket: LOCAL_BUCKET,
        region: LOCAL_REGION,
      };
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minio-byos-'));
      proc = spawn('minio', ['server', dataDir, '--address', `127.0.0.1:${port}`, '--quiet'], {
        env: { ...process.env, MINIO_ROOT_USER: LOCAL_ACCESS_KEY, MINIO_ROOT_PASSWORD: LOCAL_SECRET },
        stdio: 'ignore',
      });
    }
    vi.stubEnv(S3_DEV_ENDPOINT_ALLOWLIST_ENV, new URL(server.endpoint).host);

    const deadline = Date.now() + READY_TIMEOUT_MS;
    let status = await createBucket(server);
    while (status !== HTTP_OK && status !== HTTP_CONFLICT && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
      status = await createBucket(server);
    }
    if (status !== HTTP_OK && status !== HTTP_CONFLICT) {
      throw new Error(`The S3 test server did not become ready or refused bucket creation (last status ${status})`);
    }
  }, READY_TIMEOUT_MS + 5_000);

  afterAll(async () => {
    if (CONFIGURED_SERVER && server) {
      const adapter = newAdapter();
      await adapter.delete(`${prefix}dir/small file.txt`).catch(() => false);
      await adapter.delete(`${prefix}dir/big.bin`).catch(() => false);
    }
    vi.unstubAllEnvs();
    proc?.kill();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function newAdapter(): S3StorageAdapter {
    return new S3StorageAdapter(
      {
        type: 's3',
        bucket: server.bucket,
        accessKeyId: server.accessKeyId,
        secretAccessKey: server.secretAccessKey,
        endpoint: server.endpoint,
        forcePathStyle: true,
      },
      { partSizeBytes: 5 * MIB }
    );
  }

  it('round-trips single-part and multipart objects', async () => {
    const s3 = newAdapter();
    const small = Buffer.from('small object body');
    await s3.uploadStream(`${prefix}dir/small file.txt`, Readable.from([small]), { size: small.length, contentType: 'text/plain' });
    const big = crypto.randomBytes(11 * MIB + 7);
    const result = await s3.uploadStream(`${prefix}dir/big.bin`, Readable.from([big]));
    expect(result.etag).toMatch(/-3$/);

    const chunks: Buffer[] = [];
    for await (const chunk of await s3.downloadStream(`${prefix}dir/big.bin`)) chunks.push(Buffer.from(chunk as Buffer));
    expect(crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex')).toBe(
      crypto.createHash('sha256').update(big).digest('hex')
    );
    expect(await s3.head(`${prefix}dir/small file.txt`)).toMatchObject({ size: small.length, contentType: 'text/plain' });
    expect(await s3.delete(`${prefix}dir/small file.txt`)).toBe(true);
    expect(await s3.head(`${prefix}dir/small file.txt`)).toBeNull();
  });
});
