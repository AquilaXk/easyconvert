import { describe, it, expect, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as getOpenApiSpec } from '../src/app/api/openapi.json/route';
import { POST as credentialsPost } from '../src/app/api/v1/storage/credentials/route';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { S3_DEV_ENDPOINT_ALLOWLIST_ENV } from '../src/lib/storage';

/**
 * The OpenAPI document must advertise exactly the providers the credentials endpoint accepts and
 * document only problem types the route can return. The oracle is the live route's response and a
 * separately authored list of providers that have a working adapter (s3 has a SigV4 client since
 * WP-77, so no provider can return byos-provider-unavailable any more).
 */

const REGISTRABLE_PROVIDERS = ['s3', 'gcs', 'azure-blob', 'sftp', 'webdav', 'http'];
const CREDENTIALS_PATH = '/api/v1/storage/credentials';

async function registerOperation() {
  const spec = await (await getOpenApiSpec()).json();
  return spec.paths[CREDENTIALS_PATH].post;
}

/** A dev-allowlisted local endpoint keeps registration free of real DNS lookups. */
const LOCAL_ENDPOINT_HOST = '127.0.0.1:9000';

describe('OpenAPI storage credentials contract', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('advertises only providers that can be registered', async () => {
    const schema = (await registerOperation()).requestBody.content['application/json'].schema;
    expect([...schema.properties.providerType.enum].sort()).toEqual([...REGISTRABLE_PROVIDERS].sort());
    expect([...schema.properties.credentials.properties.type.enum].sort()).toEqual(
      [...REGISTRABLE_PROVIDERS].sort()
    );
  });

  it('accepts s3 registration as advertised and answers with the documented 201 shape', async () => {
    const email = `byosdoc_${Date.now()}_${Math.random().toString(36).slice(2)}@byos.test`;
    const user = await userStore.createUser({ email, name: 'byosdoc', tier: 'pro' });
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'byosdoc', { scopes: ['convert:write'] });
    vi.stubEnv(S3_DEV_ENDPOINT_ALLOWLIST_ENV, LOCAL_ENDPOINT_HOST);
    const res = await credentialsPost(
      new NextRequest(`http://localhost:3000${CREDENTIALS_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secretKey}` },
        body: JSON.stringify({
          providerType: 's3',
          credentials: {
            type: 's3',
            bucket: 'b-bucket',
            accessKeyId: 'AKIA_X',
            secretAccessKey: 'S',
            endpoint: `http://${LOCAL_ENDPOINT_HOST}`,
          },
        }),
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();

    const created = (await registerOperation()).responses['201'].content['application/json'].schema;
    expect(Object.keys(body).sort()).toEqual(
      Object.keys(body).filter((key) => key in created.properties).sort()
    );
    expect(body).toMatchObject({ success: true, providerType: 's3' });
    expect(body.credentialRef).toMatch(new RegExp(created.properties.credentialRef.pattern));
  });

  it('documents the invalid-endpoint problem the route returns and no unreachable problem type', async () => {
    const email = `byosdoc_${Date.now()}_${Math.random().toString(36).slice(2)}@byos.test`;
    const user = await userStore.createUser({ email, name: 'byosdoc', tier: 'pro' });
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'byosdoc', { scopes: ['convert:write'] });
    const res = await credentialsPost(
      new NextRequest(`http://localhost:3000${CREDENTIALS_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secretKey}` },
        body: JSON.stringify({
          providerType: 's3',
          credentials: { type: 's3', bucket: 'b-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'S', endpoint: 'https://169.254.169.254' },
        }),
      })
    );
    expect(res.status).toBe(400);
    const routeProblem = await res.json();

    const badRequest = (await registerOperation()).responses['400'];
    const examples = Object.values(badRequest.content['application/problem+json'].examples ?? {}) as Array<{
      value: { type: string; status: number; title: string };
    }>;
    expect(examples.map((example) => example.value.type)).toEqual([routeProblem.type]);
    expect(examples[0].value).toMatchObject({ type: routeProblem.type, status: 400, title: routeProblem.title });
    expect(JSON.stringify(badRequest)).not.toContain('byos-provider-unavailable');
  });
});
