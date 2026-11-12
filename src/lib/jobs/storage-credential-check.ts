import { credentialsVault } from '@/lib/storage/credentials-vault';
import type { TaskNode } from './graph';
import { storageKindOf, type StorageNodeProblem } from './storage-node-validation';

/**
 * The storage nodes of a graph whose saved credential `owner` cannot use: not found, expired, another account's, or of another
 * kind than the node's. They are one problem, so a caller learns nothing about credentials that are not theirs. The same check
 * runs again when the node runs; this one answers at submission, before a unit is reserved. Rejects when the vault is unreachable.
 */
export async function missingStorageCredentials(nodes: Readonly<Record<string, TaskNode>>, owner: string): Promise<StorageNodeProblem[]> {
  const problems: StorageNodeProblem[] = [];
  for (const [nodeId, node] of Object.entries(nodes)) {
    const kind = storageKindOf(node.op);
    if (kind === undefined || typeof node.credentialRef !== 'string') continue;
    const saved = await credentialsVault.get(node.credentialRef, owner);
    if (!saved || saved.type !== kind) {
      problems.push({
        path: `nodes.${nodeId}.credentialRef`,
        code: 'STORAGE_CREDENTIAL_NOT_FOUND',
        message: `The saved credential of node "${nodeId}" was not found, has expired, or is not a ${kind} credential of this account.`,
      });
    }
  }
  return problems;
}
