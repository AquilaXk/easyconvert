import { describe, it, expect } from 'vitest';
import { refuseUnavailableStorageProvider } from '../src/lib/api/byos-provider-guard';
import { UNAVAILABLE_STORAGE_PROVIDERS } from '../src/lib/storage';

/**
 * The provider-availability guard stays as the mechanism for disabling a BYOS provider that has
 * no working client, even though every provider has one today. Oracle: a test-local set of
 * unavailable providers injected into the guard, and the problem response it produces.
 */

const INSTANCE = '/api/v1/storage/credentials';

describe('BYOS provider availability guard', () => {
  it('refuses a provider in the injected unavailable set with a typed problem', async () => {
    const res = refuseUnavailableStorageProvider('gcs', INSTANCE, new Set(['gcs']));
    expect(res?.status).toBe(400);
    expect(res?.headers.get('content-type')).toContain('application/problem+json');
    expect(await res?.json()).toMatchObject({
      type: 'https://api.easyconvert.io/problems/byos-provider-unavailable',
      title: 'Storage Provider Unavailable',
      status: 400,
      instance: INSTANCE,
    });
  });

  it('lets providers outside the injected set through', () => {
    expect(refuseUnavailableStorageProvider('s3', INSTANCE, new Set(['gcs']))).toBeNull();
  });

  it('currently has no unavailable provider, so s3 passes the production set', () => {
    expect([...UNAVAILABLE_STORAGE_PROVIDERS]).toEqual([]);
    expect(refuseUnavailableStorageProvider('s3', INSTANCE)).toBeNull();
  });
});
