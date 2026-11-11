import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { POST as queueJobsPost } from '../src/app/api/queue/jobs/route';
import { POST as v1JobsPost } from '../src/app/api/v1/jobs/route';
import { POST as batchConvertPost } from '../src/app/api/convert/batch/route';
import { pipeStreamToStorageMultipart } from '../src/lib/streaming/large-payload-streamer';
import { validateJobGraph } from '../src/lib/jobs/graph';
import { encryptSecret, decryptSecret, needsSecretReencryption } from '../src/lib/api-keys/secret-encryption';
import { CredentialsVault } from '../src/lib/storage/credentials-vault';
import { signJwt, verifyJwt, deriveJwtKeyId, getPreviousJwtSecret } from '../src/lib/auth/jwt';
import { computeFingerprint, InMemoryIdempotencyStore, setIdempotencyStore } from '../src/lib/api/idempotency';
import { extractFingerprintData, respondOnce } from '../src/lib/api/with-idempotency';
import { storageProvider } from '../src/lib/storage';
import { OciObjectStorageService } from '../src/lib/storage/oci-storage';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { FileExtensionSpoofError } from '../src/lib/types';
import { buildCompoundFile, placeDirectory } from './helpers/cfb-craft';
import { fakeVaultRedis } from './helpers/fake-vault-redis';

const PE_HEADER = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00]);
const VALID_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'utf8');

function spoofedCfbBeyond64KiB(): Buffer {
  const hwpCfb = buildCompoundFile([
    { name: 'FileHeader', data: Buffer.alloc(64, 1) },
    { name: 'BodyText/Section0', data: Buffer.alloc(64, 2) },
  ]);
  return placeDirectory(hwpCfb, { directorySectors: [200] });
}

function bufferToStream(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}

describe('Row 35: spoof check at creation across streaming, queue/jobs, v1/jobs, and multi-node graphs', () => {
  let secretKey: string;

  beforeEach(async () => {
    const user = await userStore.createUser({
      name: 'Row35 Tester',
      email: `row35_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
      tier: 'pro',
    });
    const key = await redisKeyStore.generateApiKey(user.id, 'Row35 Key', {
      scopes: ['convert:write', 'convert:read'],
    });
    secretKey = key.secretKey;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('pipeStreamToStorageMultipart verifies CFBF directory streams after upload and deletes spoofed objects', async () => {
    const spoofedSdw = spoofedCfbBeyond64KiB();
    const ociBackend = new OciObjectStorageService();
    const deleteSpy = vi.spyOn(ociBackend, 'deleteObject');

    await expect(
      pipeStreamToStorageMultipart(bufferToStream(spoofedSdw), {
        filename: 'fake.sdw',
        mimeType: 'application/vnd.stardivision.writer',
        expectedTotalSize: spoofedSdw.length,
        sourceExtension: 'sdw',
        storage: ociBackend,
      })
    ).rejects.toBeInstanceOf(FileExtensionSpoofError);

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    const deletedKey = deleteSpy.mock.calls[0][0];
    expect(ociBackend.openReadStream(deletedKey)).toBeNull();
  });

  it('POST /api/queue/jobs refuses a spoofed multipart file before storing it', async () => {
    const initSpy = vi.spyOn(storageProvider, 'initiateMultipartUpload');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(PE_HEADER)], { type: 'application/pdf' }), 'fake.pdf');
    form.append('targetFormat', 'png');

    const res = await queueJobsPost(
      new NextRequest('http://localhost/api/queue/jobs', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}` },
        body: form,
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('File spoofing rejected');
    expect(initSpy).not.toHaveBeenCalled();
  });

  it('POST /api/queue/jobs refuses a spoofed inputBufferBase64 payload and a spoofed storageKey', async () => {
    const base64Res = await queueJobsPost(
      new NextRequest('http://localhost/api/queue/jobs', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originalFilename: 'fake.pdf',
          sourceFormat: 'pdf',
          targetFormat: 'png',
          fileSize: PE_HEADER.length,
          inputBufferBase64: PE_HEADER.toString('base64'),
        }),
      })
    );
    expect(base64Res.status).toBe(400);
    expect((await base64Res.json()).error).toContain('File spoofing rejected');

    const key = `uploads/test_spoof_${Date.now()}_fake.pdf`;
    await storageProvider.saveObject(key, PE_HEADER, 'application/pdf', 'fake.pdf');
    const storageRes = await queueJobsPost(
      new NextRequest('http://localhost/api/queue/jobs', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originalFilename: 'fake.pdf',
          sourceFormat: 'pdf',
          targetFormat: 'png',
          fileSize: PE_HEADER.length,
          storageKey: key,
        }),
      })
    );
    expect(storageRes.status).toBe(400);
    expect((await storageRes.json()).error).toContain('File spoofing rejected');
  });

  it('POST /api/v1/jobs checks every import.upload node in a multi-node DAG and refuses a spoofed secondary input', async () => {
    const validKey = `uploads/test_dag_valid_${Date.now()}_first.pdf`;
    const spoofedKey = `uploads/test_dag_spoof_${Date.now()}_second.pdf`;
    await storageProvider.saveObject(validKey, VALID_PDF, 'application/pdf', 'first.pdf');
    await storageProvider.saveObject(spoofedKey, PE_HEADER, 'application/pdf', 'second.pdf');

    const res = await v1JobsPost(
      new NextRequest('http://localhost/api/v1/jobs', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originalFilename: 'first.pdf',
          sourceFormat: 'pdf',
          targetFormat: 'pdf',
          storageKey: validKey,
          graph: {
            nodes: {
              u1: { id: 'u1', op: 'import.upload', storageKey: validKey },
              u2: { id: 'u2', op: 'import.upload', storageKey: spoofedKey },
              m1: { id: 'm1', op: 'merge', input: ['u1', 'u2'], targetFormat: 'pdf' },
              e1: { id: 'e1', op: 'export.url', input: 'm1' },
            },
          },
        }),
      })
    );

    expect(res.status).toBe(400);
    const problem = await res.json();
    expect(problem.title).toBe('File Spoofing Detected');
    expect(problem.detail).toContain('second.pdf');
  });

  it('validateJobGraph resolves each import.upload node format from its own storageKey extension before sourceFilename', () => {
    const result = validateJobGraph(
      {
        nodes: {
          u1: { id: 'u1', op: 'import.upload', storageKey: 'uploads/1_doc.pdf' },
          u2: { id: 'u2', op: 'import.upload', storageKey: 'uploads/2_cover.png' },
          c2: { id: 'c2', op: 'convert', input: 'u2', targetFormat: 'pdf' },
          m1: { id: 'm1', op: 'merge', input: ['u1', 'c2'], targetFormat: 'pdf' },
          e1: { id: 'e1', op: 'export.url', input: 'm1' },
        },
      },
      { sourceFormat: 'pdf', sourceFilename: 'doc.pdf' }
    );
    expect(result.valid).toBe(true);
    expect(result.inferredOutputFormats?.u1).toBe('pdf');
    expect(result.inferredOutputFormats?.u2).toBe('png');
    expect(result.inferredOutputFormats?.c2).toBe('pdf');
  });
});

describe('Row 44: POST /api/convert/batch auth before body parse and multipart content-type guard', () => {
  let secretKey: string;

  beforeEach(async () => {
    const user = await userStore.createUser({
      name: 'Row44 Tester',
      email: `row44_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
      tier: 'pro',
    });
    const key = await redisKeyStore.generateApiKey(user.id, 'Row44 Key', {
      scopes: ['convert:write', 'convert:read'],
    });
    secretKey = key.secretKey;
  });

  it('rejects an invalid Bearer token with 401 before checking or parsing the request body', async () => {
    const res = await batchConvertPost(
      new NextRequest('http://localhost/api/convert/batch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ec_live_invalid_token_value',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ not: 'multipart' }),
      })
    );
    expect(res.status).toBe(401);
  });

  it('returns 415 Unsupported Media Type when Content-Type is not multipart/form-data', async () => {
    const res = await batchConvertPost(
      new NextRequest('http://localhost/api/convert/batch', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ files: [] }),
      })
    );
    expect(res.status).toBe(415);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const problem = await res.json();
    expect(problem.status).toBe(415);
    expect(problem.detail).toContain('multipart/form-data');
  });

  it('returns 400 Bad Request problem when multipart/form-data body is malformed', async () => {
    const res = await batchConvertPost(
      new NextRequest('http://localhost/api/convert/batch', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'multipart/form-data; boundary=---broken',
        },
        body: '---broken\r\nContent-Disposition: form-data; name="files"\r\n\r\nunterminated',
      })
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });
});

describe('Row 45: separate encryption keys in production and JWT kid + JWT_SECRET_PREVIOUS rotation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('requires explicit KEY_ENCRYPTION_KEY in production for encryptSecret while decrypting legacy fallback ciphertexts', () => {
    const legacyPepper = 'legacy-pepper-0123456789abcdef0123456789';
    const dedicatedKek = 'dedicated-kek-0123456789abcdef0123456789';

    // Encrypt under legacy fallback in non-production
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('KEY_ENCRYPTION_KEY', '');
    vi.stubEnv('KEY_HASH_PEPPER', legacyPepper);
    const legacyCiphertext = encryptSecret('whsec_legacy_secret');

    // In production without KEY_ENCRYPTION_KEY, encryptSecret must fail closed even when KEY_HASH_PEPPER and JWT_SECRET are present
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('JWT_SECRET', 'production-jwt-secret-0123456789abcdef');
    expect(() => encryptSecret('whsec_new')).toThrow(/KEY_ENCRYPTION_KEY/);

    // Once KEY_ENCRYPTION_KEY is configured in production, legacy ciphertext still decrypts and is flagged for re-encryption
    vi.stubEnv('KEY_ENCRYPTION_KEY', dedicatedKek);
    expect(decryptSecret(legacyCiphertext)).toBe('whsec_legacy_secret');
    expect(needsSecretReencryption(legacyCiphertext)).toBe(true);

    const freshCiphertext = encryptSecret('whsec_legacy_secret');
    expect(needsSecretReencryption(freshCiphertext)).toBe(false);
  });

  it('requires explicit STORAGE_VAULT_KEY in production for CredentialsVault.store and rotates legacy vault records', async () => {
    const legacyKek = 'legacy-kek-for-vault-0123456789abcdef012';
    const dedicatedVaultKey = 'dedicated-vault-key-0123456789abcdef0123';

    const fakeRedis = fakeVaultRedis().client;
    const vault = new CredentialsVault(fakeRedis as never);
    const creds = {
      type: 's3' as const,
      bucket: 'b',
      accessKeyId: 'AKIA1234567890123456',
      secretAccessKey: 'secret-access-key-0123456789abcdef',
    };

    // Store under legacy KEY_ENCRYPTION_KEY fallback in non-production
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('STORAGE_VAULT_KEY', '');
    vi.stubEnv('KEY_ENCRYPTION_KEY', legacyKek);
    const ref = await vault.store('user_vault', creds);

    // Switch to production without STORAGE_VAULT_KEY: store() must fail closed even with KEY_ENCRYPTION_KEY and JWT_SECRET set
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('JWT_SECRET', 'production-jwt-secret-0123456789abcdef');
    await expect(vault.store('user_vault', creds)).rejects.toThrow(/STORAGE_VAULT_KEY/);

    // Configure STORAGE_VAULT_KEY: get() decrypts via legacy fallback key, and rotate() re-encrypts under STORAGE_VAULT_KEY
    vi.stubEnv('STORAGE_VAULT_KEY', dedicatedVaultKey);
    expect(await vault.get(ref, 'user_vault')).toEqual(creds);
    expect(await vault.rotate('user_vault')).toBe(true);
    expect(await vault.rotate('user_vault')).toBe(false);

    // After removing legacy KEY_ENCRYPTION_KEY, the rotated record still decrypts under STORAGE_VAULT_KEY alone
    vi.stubEnv('KEY_ENCRYPTION_KEY', '');
    vi.stubEnv('JWT_SECRET', '');
    expect(await vault.get(ref, 'user_vault')).toEqual(creds);
  });

  it('includes kid in signed JWT headers and verifies tokens across JWT_SECRET_PREVIOUS rotation', () => {
    const oldSecret = 'old-jwt-secret-value-at-least-32-bytes!!';
    const newSecret = 'new-jwt-secret-value-at-least-32-bytes!!';

    vi.stubEnv('JWT_SECRET', oldSecret);
    const tokenFromOld = signJwt({ sub: 'u_rot', email: 'u@example.com', tier: 'pro' });
    const [headerB64] = tokenFromOld.split('.');
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    expect(header.kid).toBe(deriveJwtKeyId(oldSecret));

    // Rotate to newSecret while keeping oldSecret in JWT_SECRET_PREVIOUS
    vi.stubEnv('JWT_SECRET', newSecret);
    vi.stubEnv('JWT_SECRET_PREVIOUS', oldSecret);

    const verifiedOld = verifyJwt(tokenFromOld);
    expect(verifiedOld?.sub).toBe('u_rot');

    const tokenFromNew = signJwt({ sub: 'u_new', email: 'n@example.com', tier: 'free' });
    expect(verifyJwt(tokenFromNew)?.sub).toBe('u_new');

    // Unknown secret still fails
    const tokenFromUnknown = signJwt({ sub: 'u_bad' }, 'unknown-secret-value-at-least-32-bytes!!');
    expect(verifyJwt(tokenFromUnknown)).toBeNull();

    // Short JWT_SECRET_PREVIOUS is rejected
    vi.stubEnv('JWT_SECRET_PREVIOUS', 'too-short');
    expect(() => getPreviousJwtSecret()).toThrow(/JWT_SECRET_PREVIOUS/);
  });
});

describe('Row 90: prototype-safe FormData and JSON idempotency fingerprinting', () => {
  let store: InMemoryIdempotencyStore;

  beforeEach(() => {
    store = new InMemoryIdempotencyStore();
    setIdempotencyStore(store);
  });

  afterEach(() => {
    setIdempotencyStore(null);
  });

  it('computes distinct, deterministic fingerprints for FormData and JSON bodies with __proto__, constructor, and toString fields', async () => {
    const formA1 = new FormData();
    formA1.append('__proto__', 'alpha');
    formA1.append('constructor', 'beta');
    formA1.append('toString', 'gamma');

    const formA2 = new FormData();
    formA2.append('__proto__', 'changed-proto');
    formA2.append('constructor', 'beta');
    formA2.append('toString', 'gamma');

    const formB = new FormData();
    formB.append('__proto__', 'alpha');
    formB.append('constructor', 'beta');
    formB.append('toString', 'delta');

    const dataFormA1 = await extractFingerprintData(
      new NextRequest('http://localhost/api/v1/convert', { method: 'POST', body: formA1 })
    );
    const dataFormA2 = await extractFingerprintData(
      new NextRequest('http://localhost/api/v1/convert', { method: 'POST', body: formA2 })
    );
    const dataFormB = await extractFingerprintData(
      new NextRequest('http://localhost/api/v1/convert', { method: 'POST', body: formB })
    );

    expect(Object.getPrototypeOf(dataFormA1.bodyWithoutFile)).toBeNull();
    expect((dataFormA1.bodyWithoutFile as Record<string, unknown>)['__proto__']).toBe('alpha');
    expect((dataFormA1.bodyWithoutFile as Record<string, unknown>)['constructor']).toBe('beta');
    expect((dataFormA1.bodyWithoutFile as Record<string, unknown>)['toString']).toBe('gamma');

    const fpFormA1 = computeFingerprint('POST', '/api/v1/convert', dataFormA1.bodyWithoutFile, dataFormA1.fileSha256);
    const fpFormA2 = computeFingerprint('POST', '/api/v1/convert', dataFormA2.bodyWithoutFile, dataFormA2.fileSha256);
    const fpFormB = computeFingerprint('POST', '/api/v1/convert', dataFormB.bodyWithoutFile, dataFormB.fileSha256);
    expect(fpFormA1).toMatch(/^[0-9a-f]{64}$/);
    expect(fpFormA1).not.toBe(fpFormA2);
    expect(fpFormA1).not.toBe(fpFormB);
    expect(({} as Record<string, unknown>).alpha).toBeUndefined();

    const jsonA = '{"__proto__":"alpha","constructor":"beta","toString":"gamma"}';
    const jsonB = '{"__proto__":"changed-proto","constructor":"beta","toString":"gamma"}';
    const reqJsonA = new NextRequest('http://localhost/api/v1/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-proto-key-1' },
      body: jsonA,
    });
    const reqJsonB = new NextRequest('http://localhost/api/v1/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-proto-key-1' },
      body: jsonB,
    });

    const first = await respondOnce(reqJsonA, 'u1', '/api/v1/jobs', async () => NextResponse.json({ ok: true }), {
      afterFailedRecord: 'release',
    });
    expect(first.status).toBe(200);

    const conflict = await respondOnce(reqJsonB, 'u1', '/api/v1/jobs', async () => NextResponse.json({ ok: true }), {
      afterFailedRecord: 'release',
    });
    expect(conflict.status).toBe(422);
  });
});
