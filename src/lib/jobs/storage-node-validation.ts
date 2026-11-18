import { StorageAdapterError } from '@/lib/storage/adapters/adapter-interface';
import { createStorageAdapter, validateExternalEndpointUrl } from '@/lib/storage/adapters';
import { MAX_STORAGE_IMPORT_OBJECTS } from '@/lib/storage/customer-storage-limits';
import { remotePathProblem } from '@/lib/storage/customer-storage-paths';
import type { CustomerStorageCredentials } from '@/lib/storage/credentials-vault';
import { STORAGE_EXPORT_OPERATIONS, STORAGE_IMPORT_OPERATIONS } from './graph-operations';

/**
 * The shape of the nodes that read from or write to the customer's own store (`import.{s3,gcs,azure-blob,sftp,webdav}`,
 * `export.{s3,gcs,azure-blob,sftp,webdav}`), checked at submission with nothing sent to the store.
 */

export interface StorageNodeProblem {
  path: string;
  message: string;
  code: string;
}

/** The saved credential references the API accepts: `cred_` and 32 hex characters, as the vault makes them. */
export const CREDENTIAL_REF_PATTERN = /^cred_[a-f0-9]{32}$/;

export type StorageKind = 's3' | 'gcs' | 'azure-blob' | 'sftp' | 'webdav';

const KEY_PREFIX_KINDS: ReadonlySet<StorageKind> = new Set(['s3', 'gcs', 'azure-blob']);

const STORAGE_KIND_BY_OP: Readonly<Record<string, StorageKind>> = {
  'import.s3': 's3',
  'export.s3': 's3',
  'import.gcs': 'gcs',
  'export.gcs': 'gcs',
  'import.azure-blob': 'azure-blob',
  'export.azure-blob': 'azure-blob',
  'import.sftp': 'sftp',
  'export.sftp': 'sftp',
  'import.webdav': 'webdav',
  'export.webdav': 'webdav',
};

const INLINE_FIELDS: Readonly<Record<StorageKind, Readonly<Record<string, 'string' | 'number' | 'boolean'>>>> = {
  s3: { bucket: 'string', accessKeyId: 'string', secretAccessKey: 'string', sessionToken: 'string', region: 'string', endpoint: 'string', forcePathStyle: 'boolean' },
  gcs: { bucket: 'string', projectId: 'string', clientEmail: 'string', privateKey: 'string', serviceAccountKeyJson: 'string', endpoint: 'string' },
  'azure-blob': { storageAccount: 'string', containerName: 'string', accountKey: 'string', sasToken: 'string', connectionString: 'string', customEndpoint: 'string' },
  sftp: { host: 'string', port: 'number', username: 'string', password: 'string', privateKey: 'string', passphrase: 'string', hostKey: 'string', basePath: 'string' },
  webdav: { url: 'string', username: 'string', password: 'string', basePath: 'string' },
};

export function storageKindOf(op: string | undefined): StorageKind | undefined {
  if (op === undefined || !(STORAGE_IMPORT_OPERATIONS.has(op) || STORAGE_EXPORT_OPERATIONS.has(op))) return undefined;
  return STORAGE_KIND_BY_OP[op];
}

function inlineCredentialProblems(at: string, kind: StorageKind, credentials: Record<string, unknown>): StorageNodeProblem[] {
  const problems: StorageNodeProblem[] = [];
  const fields = INLINE_FIELDS[kind];
  for (const [name, value] of Object.entries(credentials)) {
    const type = Object.hasOwn(fields, name) ? fields[name] : undefined;
    if (type === undefined) {
      problems.push({ path: `${at}.${name.slice(0, 48)}`, code: 'INVALID_STORAGE_CREDENTIALS', message: `The credentials of a ${kind} node do not take "${name.slice(0, 48)}".` });
    } else if (typeof value !== type) {
      problems.push({ path: `${at}.${name}`, code: 'INVALID_STORAGE_CREDENTIALS', message: `Credential field "${name}" must be a ${type}.` });
    }
  }
  if (problems.length > 0) return problems;
  if (kind === 'sftp' && typeof credentials.privateKey !== 'string') {
    return [{ path: `${at}.privateKey`, code: 'INVALID_STORAGE_CREDENTIALS', message: 'An SFTP node signs in with a private key ("privateKey"); password sign-in is not supported.' }];
  }
  try {
    const creds = { type: kind, ...credentials } as unknown as CustomerStorageCredentials;
    createStorageAdapter(creds);
    if (creds.type === 'webdav') {
      validateExternalEndpointUrl(creds.url, 'webdav');
    }
  } catch (err) {
    if (!(err instanceof StorageAdapterError)) throw err;
    // the adapter's message names the endpoint with userinfo and query masked, and holds no key
    return [{ path: at, code: 'INVALID_STORAGE_CREDENTIALS', message: err.message }];
  }
  return [];
}

function credentialProblems(at: string, kind: StorageKind, node: { credentialRef?: unknown; credentials?: unknown }): StorageNodeProblem[] {
  const { credentialRef, credentials } = node;
  if (credentialRef === undefined && credentials === undefined) {
    return [{ path: `${at}.credentialRef`, code: 'MISSING_STORAGE_CREDENTIALS', message: 'Name a saved credential in "credentialRef", or send "credentials".' }];
  }
  if (credentialRef !== undefined && credentials !== undefined) {
    return [{ path: `${at}.credentials`, code: 'CONFLICTING_STORAGE_CREDENTIALS', message: 'Send "credentialRef" or "credentials", not both.' }];
  }
  if (credentialRef !== undefined) {
    return typeof credentialRef === 'string' && CREDENTIAL_REF_PATTERN.test(credentialRef)
      ? []
      : [{ path: `${at}.credentialRef`, code: 'INVALID_CREDENTIAL_REF', message: '"credentialRef" must be a reference from POST /api/v1/storage/credentials (cred_ and 32 hex characters).' }];
  }
  if (typeof credentials !== 'object' || credentials === null || Array.isArray(credentials)) {
    return [{ path: `${at}.credentials`, code: 'INVALID_STORAGE_CREDENTIALS', message: '"credentials" must be an object.' }];
  }
  return inlineCredentialProblems(`${at}.credentials`, kind, credentials as Record<string, unknown>);
}

function pathProblem(at: string, field: string, value: unknown, allowEmpty: boolean): StorageNodeProblem[] {
  const problem = remotePathProblem(value, { allowEmpty });
  return problem ? [{ path: `${at}.${field}`, code: 'INVALID_STORAGE_PATH', message: `"${field}" ${problem}.` }] : [];
}

/** `single` names one file and `listed` a prefix or directory of them; an import names exactly one of the two. */
function importPathProblems(at: string, node: Record<string, unknown>, single: string, listed: string): StorageNodeProblem[] {
  const hasSingle = node[single] !== undefined;
  const hasListed = node[listed] !== undefined;
  if (hasSingle === hasListed) {
    const code = hasSingle ? 'CONFLICTING_STORAGE_PATH' : 'MISSING_STORAGE_PATH';
    return [{ path: `${at}.${single}`, code, message: `Name one file in "${single}", or the files of one folder in "${listed}", not ${hasSingle ? 'both' : 'neither'}.` }];
  }
  const problems = hasSingle ? pathProblem(at, single, node[single], false) : pathProblem(at, listed, node[listed], listed === 'prefix');
  const max = node.maxObjects;
  if (max !== undefined && (hasSingle || !Number.isInteger(max) || (max as number) < 1 || (max as number) > MAX_STORAGE_IMPORT_OBJECTS)) {
    problems.push({
      path: `${at}.maxObjects`,
      code: 'INVALID_MAX_OBJECTS',
      message: hasSingle ? `"maxObjects" applies to "${listed}", not to "${single}".` : `"maxObjects" must be a whole number from 1 to ${MAX_STORAGE_IMPORT_OBJECTS}.`,
    });
  }
  return problems;
}

/** The problems of a storage node, by its path in the request (`nodes.<id>`); none for any other operation. */
export function storageNodeProblems(at: string, op: string | undefined, node: Record<string, unknown>): StorageNodeProblem[] {
  const kind = storageKindOf(op);
  if (kind === undefined || op === undefined) return [];
  const problems = credentialProblems(at, kind, node);
  if (STORAGE_IMPORT_OPERATIONS.has(op)) {
    return KEY_PREFIX_KINDS.has(kind)
      ? [...problems, ...importPathProblems(at, node, 'key', 'prefix')]
      : [...problems, ...importPathProblems(at, node, 'path', 'directory')];
  }
  const destination = KEY_PREFIX_KINDS.has(kind) ? 'prefix' : 'directory';
  return node[destination] === undefined ? problems : [...problems, ...pathProblem(at, destination, node[destination], true)];
}

/** The key or path a single-file storage import names, which gives the job its source format and file name; none for another node or a prefix. */
export function storageImportFileName(node: { op?: string; key?: unknown; path?: unknown }): string | undefined {
  const kind = storageKindOf(node.op);
  if (kind === undefined || !node.op || !STORAGE_IMPORT_OPERATIONS.has(node.op)) return undefined;
  const name = KEY_PREFIX_KINDS.has(kind) ? node.key : node.path;
  return typeof name === 'string' && name !== '' ? name : undefined;
}

/** Whether a graph reads a file from somewhere it names (a link, or the customer's store) and so needs no input in the request. */
export function hasRemoteImport(nodes: Readonly<Record<string, { op?: string }>>): boolean {
  return Object.values(nodes).some((node) => node.op === 'import.url' || STORAGE_IMPORT_OPERATIONS.has(String(node.op)));
}

/** The path of the first remote import that names a file (the path of a link, or the key or path in the customer's store), whose extension is the source format. */
export function remoteImportPath(nodes: Readonly<Record<string, { op?: string; url?: unknown; key?: unknown; path?: unknown }>>): string | undefined {
  for (const node of Object.values(nodes)) {
    const name = node.op === 'import.url' ? linkPath(node.url) : storageImportFileName(node);
    if (name) return name;
  }
  return undefined;
}

function linkPath(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}
