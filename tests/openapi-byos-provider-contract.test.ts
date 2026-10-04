import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as getOpenApiSpec } from '../src/app/api/openapi.json/route';
import { POST as credentialsPost } from '../src/app/api/v1/storage/credentials/route';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';

/**
 * The credentials endpoint refuses s3 with a byos-provider-unavailable problem, but the OpenAPI
 * document still advertised s3 and did not describe that problem. The oracle is the live route's
 * response and a separately authored list of providers that have a working adapter.
 */

const REGISTRABLE_PROVIDERS = ['gcs', 'azure-blob', 'sftp', 'webdav', 'http'];
const CREDENTIALS_PATH = '/api/v1/storage/credentials';

async function registerOperation() {
  const spec = await (await getOpenApiSpec()).json();
  return spec.paths[CREDENTIALS_PATH].post;
}

describe('OpenAPI storage credentials contract', () => {
  it('advertises only providers that can be registered', async () => {
    const schema = (await registerOperation()).requestBody.content['application/json'].schema;
    expect([...schema.properties.providerType.enum].sort()).toEqual([...REGISTRABLE_PROVIDERS].sort());
    expect([...schema.properties.credentials.properties.type.enum].sort()).toEqual(
      [...REGISTRABLE_PROVIDERS].sort()
    );
  });

  it('documents the problem type the route returns for an unavailable provider', async () => {
    const email = `byosdoc_${Date.now()}_${Math.random().toString(36).slice(2)}@byos.test`;
    const user = await userStore.createUser({ email, name: 'byosdoc', tier: 'pro' });
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'byosdoc', { scopes: ['convert:write'] });
    const res = await credentialsPost(
      new NextRequest(`http://localhost:3000${CREDENTIALS_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secretKey}` },
        body: JSON.stringify({
          providerType: 's3',
          credentials: { type: 's3', bucket: 'b', accessKeyId: 'AKIA_X', secretAccessKey: 'S' },
        }),
      })
    );
    expect(res.status).toBe(400);
    const routeProblem = await res.json();

    const badRequest = (await registerOperation()).responses['400'];
    const examples = Object.values(badRequest.content['application/problem+json'].examples ?? {}) as Array<{
      value: { type: string; status: number; title: string };
    }>;
    const documented = examples.find((example) => example.value.type === routeProblem.type);
    expect(documented?.value).toMatchObject({ type: routeProblem.type, status: 400, title: routeProblem.title });
  });
});
