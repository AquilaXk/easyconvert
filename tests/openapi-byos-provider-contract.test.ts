import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as getOpenApiSpec } from '../src/app/api/openapi.json/route';
import { POST as credentialsPost } from '../src/app/api/v1/storage/credentials/route';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';

/**
 * The OpenAPI document must advertise exactly the providers the credentials endpoint accepts.
 * The oracle is the live route's response and a separately authored list of providers that
 * have a working adapter (s3 has a SigV4 client since WP-77).
 */

const REGISTRABLE_PROVIDERS = ['s3', 'gcs', 'azure-blob', 'sftp', 'webdav', 'http'];
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

  it('accepts s3 registration as advertised and answers with the documented 201 shape', async () => {
    const email = `byosdoc_${Date.now()}_${Math.random().toString(36).slice(2)}@byos.test`;
    const user = await userStore.createUser({ email, name: 'byosdoc', tier: 'pro' });
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'byosdoc', { scopes: ['convert:write'] });
    const res = await credentialsPost(
      new NextRequest(`http://localhost:3000${CREDENTIALS_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secretKey}` },
        body: JSON.stringify({
          providerType: 's3',
          credentials: { type: 's3', bucket: 'b-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'S' },
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
});
