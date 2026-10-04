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

/**
 * Optional: runs the adapter against a real MinIO server, which verifies SigV4 with its own
 * implementation. Skipped explicitly when the `minio` binary is not installed.
 */

const MINIO_AVAILABLE = spawnSync('minio', ['--version'], { stdio: 'ignore' }).status === 0;
const ACCESS_KEY = 'minioadmin-test';
const SECRET = 'minioadmin-test-secret';
const BUCKET = 'byos-integration';
const MIB = 1024 * 1024;
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 200;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

describe.skipIf(!MINIO_AVAILABLE)('S3StorageAdapter against MinIO', () => {
  let proc: ChildProcess;
  let dataDir: string;
  let endpoint: string;

  beforeAll(async () => {
    const port = await freePort();
    endpoint = `http://127.0.0.1:${port}`;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minio-byos-'));
    proc = spawn('minio', ['server', dataDir, '--address', `127.0.0.1:${port}`, '--quiet'], {
      env: { ...process.env, MINIO_ROOT_USER: ACCESS_KEY, MINIO_ROOT_PASSWORD: SECRET },
      stdio: 'ignore',
    });
    vi.stubEnv(S3_DEV_ENDPOINT_ALLOWLIST_ENV, `127.0.0.1:${port}`);

    const deadline = Date.now() + READY_TIMEOUT_MS;
    let created = false;
    while (!created && Date.now() < deadline) {
      const signed = signS3Request({
        method: 'PUT',
        origin: endpoint,
        path: `/${BUCKET}`,
        payloadHash: EMPTY_PAYLOAD_SHA256,
        credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET },
        region: 'us-east-1',
      });
      const res = await fetch(signed.url, { method: 'PUT', headers: signed.headers }).catch(() => null);
      created = res !== null && res.status === 200;
      if (!created) await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
    if (!created) throw new Error('MinIO did not become ready or refused bucket creation');
  }, READY_TIMEOUT_MS + 5_000);

  afterAll(() => {
    vi.unstubAllEnvs();
    proc?.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('round-trips single-part and multipart objects', async () => {
    const s3 = new S3StorageAdapter(
      { type: 's3', bucket: BUCKET, accessKeyId: ACCESS_KEY, secretAccessKey: SECRET, endpoint, forcePathStyle: true },
      { partSizeBytes: 5 * MIB }
    );
    const small = Buffer.from('small object body');
    await s3.uploadStream('dir/small file.txt', Readable.from([small]), { size: small.length, contentType: 'text/plain' });
    const big = crypto.randomBytes(11 * MIB + 7);
    const result = await s3.uploadStream('dir/big.bin', Readable.from([big]));
    expect(result.etag).toMatch(/-3$/);

    const chunks: Buffer[] = [];
    for await (const chunk of await s3.downloadStream('dir/big.bin')) chunks.push(Buffer.from(chunk as Buffer));
    expect(crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex')).toBe(
      crypto.createHash('sha256').update(big).digest('hex')
    );
    expect(await s3.head('dir/small file.txt')).toMatchObject({ size: small.length, contentType: 'text/plain' });
    expect(await s3.delete('dir/small file.txt')).toBe(true);
    expect(await s3.head('dir/small file.txt')).toBeNull();
  });
});
