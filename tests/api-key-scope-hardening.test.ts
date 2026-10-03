import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { isScopeAllowed, validateApiAccess } from '../src/lib/api-keys/guard';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import { POST as v1ConvertRoute } from '../src/app/api/v1/convert/route';
import { GET as listKeysRoute } from '../src/app/api/keys/route';
import { DELETE as revokeKeyRoute } from '../src/app/api/keys/[id]/route';
import { GET as keyUsageRoute } from '../src/app/api/keys/usage/route';
import { DELETE as clearDlqRoute } from '../src/app/api/webhooks/dlq/route';
import { DELETE as deleteDlqItemRoute } from '../src/app/api/webhooks/dlq/[id]/route';
import { POST as replayDlqRoute } from '../src/app/api/webhooks/dlq/[id]/replay/route';
import type { ApiKeyScope } from '../src/lib/api-keys/types';

const BASE_URL = 'http://localhost:3000';
const CSV_FIXTURE = 'name,role\nAlice,Engineer\nBob,Designer';

async function createUser(label: string) {
  const email = `${label}_${Date.now()}_${Math.random().toString(36).slice(2)}@scope.test`;
  const record = await userStore.createUser({ email, name: label, tier: 'pro' });
  return userStore.sanitizeUser(record);
}

async function createKey(userId: string, scopes: ApiKeyScope[]) {
  return redisKeyStore.generateApiKey(userId, `key ${scopes.join(',')}`, { scopes });
}

function bearer(path: string, secretKey: string, method = 'GET'): NextRequest {
  return new NextRequest(`${BASE_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${secretKey}` },
  });
}

function convertRequest(secretKey: string): NextRequest {
  const formData = new FormData();
  formData.append('file', new File([CSV_FIXTURE], 'team.csv', { type: 'text/csv' }));
  formData.append('targetFormat', 'json');
  return new NextRequest(`${BASE_URL}/api/v1/convert`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}` },
    body: formData,
  });
}

describe('API key scope hardening (#242)', () => {
  let userId: string;

  beforeEach(async () => {
    userId = (await createUser('scope_owner')).id;
  });

  describe('isScopeAllowed matching rules', () => {
    it('rejects every cross-namespace alias that previously escalated privileges', () => {
      const aliasCases: Array<[string[], string]> = [
        [['convert:read'], 'convert'],
        [['convert:write'], 'convert'],
        [['convert'], 'convert:write'],
        [['convert'], 'convert:read'],
        [['jobs:write'], 'convert:write'],
        [['jobs:read'], 'convert:read'],
        [['convert:write'], 'jobs:write'],
        [['convert:read'], 'jobs:read'],
        [['convert'], 'jobs:write'],
        [['convert'], 'jobs:read'],
        [['convert:read'], 'convert:write'],
      ];
      const escalations = aliasCases
        .filter(([granted, required]) => isScopeAllowed(granted, required))
        .map(([granted, required]) => `${granted.join(',')} -> ${required}`);
      expect(escalations).toEqual([]);
    });

    it('allows exact match, root wildcard, same-namespace wildcard, and legacy unscoped keys only', () => {
      const allowedCases: Array<[string[] | undefined, string]> = [
        [['convert:write'], 'convert:write'],
        [['*'], 'convert:write'],
        [['convert:*'], 'convert:write'],
        [['convert:*'], 'convert:read'],
        [undefined, 'convert:write'],
      ];
      const denied = allowedCases
        .filter(([granted, required]) => !isScopeAllowed(granted, required))
        .map(([granted, required]) => `${String(granted)} -> ${required}`);
      expect(denied).toEqual([]);

      // Explicit empty scopes grant NO permissions (least privilege)
      expect(isScopeAllowed([], 'convert:write')).toBe(false);
      expect(isScopeAllowed([], 'convert:read')).toBe(false);
      expect(isScopeAllowed([], 'storage:download')).toBe(false);
      expect(isScopeAllowed(['storage:*'], 'convert:read')).toBe(false);
      expect(isScopeAllowed(['convert:*'], 'storage:download')).toBe(false);
    });
  });

  describe('POST /api/v1/convert requires convert:write', () => {
    it('rejects a convert:read key with 403 and consumes no quota', async () => {
      const readKey = await createKey(userId, ['convert:read']);

      const guardResult = await validateApiAccess(bearer('/api/v1/convert', readKey.secretKey, 'POST'), {
        requiredUnits: 0,
        requiredScope: 'convert:write',
      });
      expect(guardResult.authorized).toBe(false);
      expect(guardResult.status).toBe(403);
      expect(guardResult.error).toBe("Forbidden: API key lacks required scope 'convert:write'");

      const res = await v1ConvertRoute(convertRequest(readKey.secretKey));
      expect(res.status).toBe(403);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      const body = await res.json();
      expect(body.detail).toBe("Forbidden: API key lacks required scope 'convert:write'");

      const quota = await redisKeyStore.getQuotaUsage(userId);
      expect(quota.usedToday).toBe(0);
    });

    it('still converts with a convert:write key', async () => {
      const writeKey = await createKey(userId, ['convert:write']);
      const res = await v1ConvertRoute(convertRequest(writeKey.secretKey));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.fileName).toBe('team.json');
      expect(body.targetFormat).toBe('json');
    });
  });

  describe('key management routes require the * scope for API-key callers', () => {
    it('GET /api/keys rejects convert:read and convert:write keys with 403', async () => {
      for (const scopes of [['convert:read'], ['convert:write']] as ApiKeyScope[][]) {
        const key = await createKey(userId, scopes);
        const res = await listKeysRoute(bearer('/api/keys', key.secretKey));
        expect(res.status, `scopes ${scopes.join(',')}`).toBe(403);
        const body = await res.json();
        expect(body.keys).toBeUndefined();
        expect(body.error).toContain('Forbidden');
      }
    });

    it('GET /api/keys lists keys for a * key and for a session caller', async () => {
      const adminKey = await createKey(userId, ['*']);
      const adminRes = await listKeysRoute(bearer('/api/keys', adminKey.secretKey));
      expect(adminRes.status).toBe(200);
      const adminBody = await adminRes.json();
      expect(adminBody.keys.map((k: { id: string }) => k.id)).toContain(adminKey.key.id);

      const user = await userStore.findById(userId);
      const token = createSessionToken(userStore.sanitizeUser(user!));
      const sessionRes = await listKeysRoute(
        new NextRequest(`${BASE_URL}/api/keys`, { headers: { Cookie: `easyconvert_session=${token}` } })
      );
      expect(sessionRes.status).toBe(200);
      const sessionBody = await sessionRes.json();
      expect(sessionBody.keys.map((k: { id: string }) => k.id)).toContain(adminKey.key.id);
    });

    it('DELETE /api/keys/[id] rejects convert:read and convert:write keys and leaves the target active', async () => {
      const target = await createKey(userId, ['convert:read']);
      for (const scopes of [['convert:read'], ['convert:write']] as ApiKeyScope[][]) {
        const key = await createKey(userId, scopes);
        const res = await revokeKeyRoute(bearer(`/api/keys/${target.key.id}`, key.secretKey, 'DELETE'), {
          params: { id: target.key.id },
        });
        expect(res.status, `scopes ${scopes.join(',')}`).toBe(403);
      }
      const keys = await redisKeyStore.listApiKeys(userId);
      expect(keys.find((k) => k.id === target.key.id)?.status).toBe('active');
    });

    it('GET /api/keys/usage stays available to any authenticated key', async () => {
      const readKey = await createKey(userId, ['convert:read']);
      const res = await keyUsageRoute(bearer('/api/keys/usage', readKey.secretKey));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.usage.tier).toBe('pro');
      expect(body.usage.dailyLimit).toBe(500);
    });
  });

  describe('DLQ mutations reject non-admin API keys', () => {
    it('rejects convert:read and convert:write keys on clear, delete, and replay with 403', async () => {
      for (const scopes of [['convert:read'], ['convert:write']] as ApiKeyScope[][]) {
        const key = await createKey(userId, scopes);
        const label = `scopes ${scopes.join(',')}`;

        const clearRes = await clearDlqRoute(bearer('/api/webhooks/dlq', key.secretKey, 'DELETE'));
        expect(clearRes.status, label).toBe(403);

        const deleteRes = await deleteDlqItemRoute(
          bearer('/api/webhooks/dlq/dlq_any', key.secretKey, 'DELETE'),
          { params: { id: 'dlq_any' } }
        );
        expect(deleteRes.status, label).toBe(403);

        const replayRes = await replayDlqRoute(
          bearer('/api/webhooks/dlq/dlq_any/replay', key.secretKey, 'POST'),
          { params: { id: 'dlq_any' } }
        );
        expect(replayRes.status, label).toBe(403);
      }
    });
  });
});
