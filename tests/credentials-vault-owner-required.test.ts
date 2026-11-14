import { beforeEach, describe, expect, it } from 'vitest';
import { credentialsVault } from '../src/lib/storage/credentials-vault';
import { missingStorageCredentials } from '../src/lib/jobs/storage-credential-check';
import type { TaskNode } from '../src/lib/jobs/graph';

/**
 * A saved credential opens for its owner only: a read that names no owner opens nothing, where it once skipped the tenant check and
 * opened any account's credential from its reference.
 */

const S3 = { type: 's3' as const, bucket: 'b', accessKeyId: 'AKIAEXAMPLE0000000000', secretAccessKey: 'secret-access-key-0123456789abcdef' };
const OWNER = 'user_owner_required';

describe('credentialsVault.get without an owner', () => {
  beforeEach(() => credentialsVault.clear());

  it('opens a credential for its owner', async () => {
    const ref = await credentialsVault.store(OWNER, S3, { name: 'mine' });

    expect(await credentialsVault.get(ref, OWNER)).toEqual(S3);
  });

  it('opens nothing for an empty or a missing owner', async () => {
    const ref = await credentialsVault.store(OWNER, S3, { name: 'mine' });

    expect(await credentialsVault.get(ref, '')).toBeNull();
    expect(await credentialsVault.get(ref, undefined)).toBeNull();
  });
});

describe('missingStorageCredentials with an empty owner', () => {
  beforeEach(() => credentialsVault.clear());

  it('reports the saved credential of a node as not found', async () => {
    const ref = await credentialsVault.store(OWNER, S3, { name: 'mine' });
    const nodes = { out: { id: 'out', op: 'export.s3', credentialRef: ref } } as unknown as Record<string, TaskNode>;

    const missing = await missingStorageCredentials(nodes, '');

    expect(missing.map((problem) => problem.code)).toEqual(['STORAGE_CREDENTIAL_NOT_FOUND']);
  });
});
