import { StorageConfigError } from './errors';
import { SigV4SigningError, assertValidBucketName, type BucketNameRules } from './s3-sigv4';

/**
 * Storage driver selection and credentials for internal object storage.
 *
 *   STORAGE_DRIVER=oci     OCI Object Storage through its S3-compatible endpoint
 *                          https://<namespace>.compat.objectstorage.<region>.oraclecloud.com
 *     OCI_NAMESPACE, OCI_REGION, OCI_BUCKET (or OCI_BUCKET_NAME),
 *     OCI_ACCESS_KEY_ID, OCI_SECRET_ACCESS_KEY      required
 *     OCI_ENDPOINT                                  optional override (private endpoint, test server)
 *   STORAGE_DRIVER=s3      any other S3-compatible service
 *     S3_ENDPOINT, S3_REGION, S3_BUCKET (or S3_BUCKET_NAME),
 *     S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY        required
 *     S3_FORCE_PATH_STYLE                           "false" selects virtual-hosted addressing
 *   STORAGE_DRIVER=local   objects stay on local disk; for development, tests and single-node use
 *
 * An explicitly selected remote driver must be fully configured, in every environment: a missing
 * value throws a StorageConfigError instead of falling back to local disk. In production the
 * driver itself must be chosen. `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` and
 * `AWS_BUCKET_NAME` are still read as a deprecated fallback and log one warning.
 *
 * `S3_*` for customer-owned storage (BYOS) is unrelated: it comes from the credentials vault.
 */

export type StorageDriver = 'oci' | 's3' | 'local';

/**
 * The configuration of a remote driver. `secretAccessKey` is a read-only, non-enumerable property:
 * it is absent from JSON, `Object.keys`, spreads and `util.inspect`, so logging or serializing the
 * config cannot leak it; code that needs it reads it by name.
 */
export interface RemoteStorageConfig {
  driver: 'oci' | 's3';
  /** Origin of the S3-compatible endpoint. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** OCI Object Storage namespace; present for the `oci` driver only. */
  namespace?: string;
}

export interface LocalStorageConfig {
  driver: 'local';
}

export type StorageConfig = RemoteStorageConfig | LocalStorageConfig;

/**
 * Local-emulation URLs are served and verified by this application with its signing secret, so
 * their SigV4 credential scope is a label that carries no authority: it is not an object store
 * credential, and such URLs never leave the application's own origin.
 */
export const LOCAL_EMULATION_ACCESS_KEY_ID = 'local-emulation';
export const LOCAL_EMULATION_REGION = 'local';
/** Route that receives parts of a local multipart session. */
export const LOCAL_DIRECT_PART_PATH = '/api/v1/uploads/direct/part';

const STORAGE_DRIVERS: ReadonlySet<string> = new Set<StorageDriver>(['oci', 's3', 'local']);
const PRODUCTION = 'production';
const PRODUCTION_BUILD_PHASE = 'phase-production-build';
const DEFAULT_DEV_APP_URL = 'http://localhost:3000';
/** A namespace becomes a DNS label of the endpoint host, so anything else could redirect the request. */
const DNS_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const REGION_PATTERN = /^[a-z0-9-]{1,64}$/;

type Env = Readonly<Record<string, string | undefined>>;

interface CredentialVariables {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: readonly string[];
}

const OCI_VARIABLES: CredentialVariables = {
  accessKeyId: 'OCI_ACCESS_KEY_ID',
  secretAccessKey: 'OCI_SECRET_ACCESS_KEY',
  region: 'OCI_REGION',
  bucket: ['OCI_BUCKET', 'OCI_BUCKET_NAME'],
};

const S3_VARIABLES: CredentialVariables = {
  accessKeyId: 'S3_ACCESS_KEY_ID',
  secretAccessKey: 'S3_SECRET_ACCESS_KEY',
  region: 'S3_REGION',
  bucket: ['S3_BUCKET', 'S3_BUCKET_NAME'],
};

/** Deprecated names, read only when the driver's own variable is absent. */
const AWS_FALLBACK_VARIABLES: CredentialVariables = {
  accessKeyId: 'AWS_ACCESS_KEY_ID',
  secretAccessKey: 'AWS_SECRET_ACCESS_KEY',
  region: 'AWS_REGION',
  bucket: ['AWS_BUCKET_NAME'],
};

/**
 * Variables that may hold the signing secret, in order of precedence. Every backend reads them in
 * this one order, so an API instance and a worker of one deployment always sign and verify with the
 * same secret.
 */
export const SIGNING_SECRET_VARIABLES: readonly string[] = [
  'STORAGE_SIGNING_SECRET',
  'S3_SIGNING_SECRET',
  'OCI_SIGNING_SECRET',
];

let awsFallbackWarned = false;
let localInProductionWarned = false;

/** Clears the once-per-process warnings; for tests. */
export function resetStorageConfigWarnings(): void {
  awsFallbackWarned = false;
  localInProductionWarned = false;
}

/** A non-empty, trimmed value; compose files and shells set unused variables to the empty string. */
function readVar(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function firstVar(env: Env, names: readonly string[]): { name: string; value: string } | undefined {
  for (const name of names) {
    const value = readVar(env, name);
    if (value !== undefined) return { name, value };
  }
  return undefined;
}

/** `next build` imports route modules without a runtime environment, so nothing may be enforced then. */
export function isProductionBuildPhase(env: Env = process.env): boolean {
  return env.NEXT_PHASE === PRODUCTION_BUILD_PHASE;
}

/** True when running production code (not during `next build`). */
export function isProductionRuntime(env: Env = process.env): boolean {
  return env.NODE_ENV === PRODUCTION && !isProductionBuildPhase(env);
}

/**
 * Signing secrets that are published in the repository (the docker-compose development defaults).
 * Anyone can read them, so production refuses to sign with one.
 */
export const KNOWN_PUBLIC_SIGNING_SECRETS: ReadonlySet<string> = new Set(['easyconvert-local-dev-signing-secret']);
/** The shortest signing secret production accepts, in bytes (the size of the HMAC-SHA-256 key). */
export const MIN_PRODUCTION_SIGNING_SECRET_BYTES = 32;

/**
 * The secret that signs capability URLs served by this application (local emulation and upload
 * tokens). It is distinct from the object store credentials. Returns undefined when none is set;
 * callers must refuse to sign then, never invent a secret. In production the secret must not be a
 * known public one and must be at least MIN_PRODUCTION_SIGNING_SECRET_BYTES long; this is the one
 * place every backend reads it, so the rule holds for every driver.
 */
export function resolveSigningSecret(env: Env = process.env): string | undefined {
  const found = firstVar(env, SIGNING_SECRET_VARIABLES);
  if (found === undefined) return undefined;
  if (isProductionRuntime(env)) {
    if (KNOWN_PUBLIC_SIGNING_SECRETS.has(found.value)) {
      throw new StorageConfigError(
        `${found.name} is a publicly known development secret and cannot be used in production.`,
        [found.name]
      );
    }
    if (Buffer.byteLength(found.value, 'utf-8') < MIN_PRODUCTION_SIGNING_SECRET_BYTES) {
      throw new StorageConfigError(
        `${found.name} must be at least ${MIN_PRODUCTION_SIGNING_SECRET_BYTES} bytes long in production.`,
        [found.name]
      );
    }
  }
  return found.value;
}

/**
 * Startup check for every driver: in production a signing secret must be configured and pass the
 * policy of resolveSigningSecret. Outside production nothing is required.
 */
export function assertSigningSecretConfigured(env: Env = process.env): void {
  if (!isProductionRuntime(env)) return;
  if (resolveSigningSecret(env) === undefined) {
    throw new StorageConfigError(
      'STORAGE_SIGNING_SECRET is required in production to sign upload and download URLs.',
      ['STORAGE_SIGNING_SECRET']
    );
  }
}

/**
 * Public origin of this application, used to build URLs that point back at it. Required in
 * production; development falls back to the local dev server.
 */
export function resolveAppBaseUrl(env: Env = process.env): string {
  const configured = readVar(env, 'APP_URL');
  if (configured === undefined) {
    if (isProductionRuntime(env)) {
      throw new StorageConfigError('APP_URL is required in production to build application URLs.', ['APP_URL']);
    }
    return DEFAULT_DEV_APP_URL;
  }
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new StorageConfigError('APP_URL is not a valid URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new StorageConfigError('APP_URL must use http or https.');
  }
  return `${parsed.protocol}//${parsed.host}`;
}

export function resolveStorageDriver(env: Env = process.env): StorageDriver {
  const raw = readVar(env, 'STORAGE_DRIVER');
  if (raw === undefined) {
    if (isProductionRuntime(env)) {
      throw new StorageConfigError(
        'STORAGE_DRIVER is required in production: set it to "oci", "s3" or "local".',
        ['STORAGE_DRIVER']
      );
    }
    return 'local';
  }
  const driver = raw.toLowerCase();
  if (!STORAGE_DRIVERS.has(driver)) {
    throw new StorageConfigError(`STORAGE_DRIVER must be "oci", "s3" or "local", got "${raw}".`);
  }
  return driver as StorageDriver;
}

interface ResolvedValues {
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  bucket?: string;
  /** Deprecated variables that supplied a value. */
  deprecatedUsed: string[];
}

function resolveCredentialValues(env: Env, own: CredentialVariables): ResolvedValues {
  const deprecatedUsed: string[] = [];
  const pick = (ownNames: readonly string[], fallbackNames: readonly string[]): string | undefined => {
    const primary = firstVar(env, ownNames);
    if (primary) return primary.value;
    const fallback = firstVar(env, fallbackNames);
    if (fallback) deprecatedUsed.push(fallback.name);
    return fallback?.value;
  };
  return {
    accessKeyId: pick([own.accessKeyId], [AWS_FALLBACK_VARIABLES.accessKeyId]),
    secretAccessKey: pick([own.secretAccessKey], [AWS_FALLBACK_VARIABLES.secretAccessKey]),
    region: pick([own.region], [AWS_FALLBACK_VARIABLES.region]),
    bucket: pick(own.bucket, AWS_FALLBACK_VARIABLES.bucket),
    deprecatedUsed,
  };
}

function warnAwsFallback(names: readonly string[], replacements: readonly string[], warn: (message: string) => void): void {
  if (names.length === 0 || awsFallbackWarned) return;
  awsFallbackWarned = true;
  warn(
    `[storage] ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} deprecated for internal storage; ` +
      `set ${replacements.join(', ')} instead.`
  );
}

function requireHttpUrl(name: string, value: string, env: Env): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new StorageConfigError(`${name} is not a valid URL.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new StorageConfigError(`${name} must use https.`);
  }
  if (parsed.protocol !== 'https:' && isProductionRuntime(env)) {
    throw new StorageConfigError(`${name} must use https in production.`);
  }
  if (parsed.username || parsed.password) {
    throw new StorageConfigError(`${name} must not carry user info.`);
  }
  return `${parsed.protocol}//${parsed.host}`;
}

/** The configured bucket must satisfy the naming rules of its driver; the variable is named in the error. */
function requireValidBucket(variable: string, bucket: string, rules: BucketNameRules): void {
  try {
    assertValidBucketName(bucket, rules);
  } catch (err) {
    if (err instanceof SigV4SigningError) {
      throw new StorageConfigError(`${variable} is not a valid ${rules === 'oci' ? 'OCI' : 'S3'} bucket name.`);
    }
    throw err;
  }
}

function withHiddenSecret(config: Omit<RemoteStorageConfig, 'secretAccessKey'>, secretAccessKey: string): RemoteStorageConfig {
  return Object.defineProperty(config, 'secretAccessKey', {
    value: secretAccessKey,
    enumerable: false,
    writable: false,
    configurable: false,
  }) as RemoteStorageConfig;
}

function missingError(driver: StorageDriver, missing: readonly string[]): StorageConfigError {
  return new StorageConfigError(
    `Storage driver "${driver}" is missing required configuration: ${missing.join(', ')}.`,
    missing
  );
}

function resolveOciConfig(env: Env, warn: (message: string) => void): RemoteStorageConfig {
  const values = resolveCredentialValues(env, OCI_VARIABLES);
  const namespace = readVar(env, 'OCI_NAMESPACE');
  const missing: string[] = [];
  if (namespace === undefined) missing.push('OCI_NAMESPACE');
  if (values.region === undefined) missing.push(OCI_VARIABLES.region);
  if (values.bucket === undefined) missing.push(OCI_VARIABLES.bucket[0]);
  if (values.accessKeyId === undefined) missing.push(OCI_VARIABLES.accessKeyId);
  if (values.secretAccessKey === undefined) missing.push(OCI_VARIABLES.secretAccessKey);
  if (missing.length > 0) throw missingError('oci', missing);

  const region = values.region as string;
  if (!REGION_PATTERN.test(region)) {
    throw new StorageConfigError(`${OCI_VARIABLES.region} must be lowercase letters, digits and hyphens.`);
  }
  requireValidBucket(OCI_VARIABLES.bucket[0], values.bucket as string, 'oci');
  if (!DNS_LABEL_PATTERN.test(namespace as string)) {
    throw new StorageConfigError('OCI_NAMESPACE must be a single DNS label (letters, digits and hyphens).');
  }
  const override = readVar(env, 'OCI_ENDPOINT');
  const endpoint =
    override === undefined
      ? `https://${namespace}.compat.objectstorage.${region}.oraclecloud.com`
      : requireHttpUrl('OCI_ENDPOINT', override, env);

  warnAwsFallback(
    values.deprecatedUsed,
    values.deprecatedUsed.map((name) => replacementFor(name, OCI_VARIABLES)),
    warn
  );
  return withHiddenSecret(
    {
      driver: 'oci',
      endpoint,
      region,
      bucket: values.bucket as string,
      accessKeyId: values.accessKeyId as string,
      forcePathStyle: true,
      namespace: namespace as string,
    },
    values.secretAccessKey as string
  );
}

function resolveS3Config(env: Env, warn: (message: string) => void): RemoteStorageConfig {
  const values = resolveCredentialValues(env, S3_VARIABLES);
  const endpoint = readVar(env, 'S3_ENDPOINT');
  const missing: string[] = [];
  if (endpoint === undefined) missing.push('S3_ENDPOINT');
  if (values.region === undefined) missing.push(S3_VARIABLES.region);
  if (values.bucket === undefined) missing.push(S3_VARIABLES.bucket[0]);
  if (values.accessKeyId === undefined) missing.push(S3_VARIABLES.accessKeyId);
  if (values.secretAccessKey === undefined) missing.push(S3_VARIABLES.secretAccessKey);
  if (missing.length > 0) throw missingError('s3', missing);

  const region = values.region as string;
  if (!REGION_PATTERN.test(region)) {
    throw new StorageConfigError(`${S3_VARIABLES.region} must be lowercase letters, digits and hyphens.`);
  }
  requireValidBucket(S3_VARIABLES.bucket[0], values.bucket as string, 'dns');
  warnAwsFallback(
    values.deprecatedUsed,
    values.deprecatedUsed.map((name) => replacementFor(name, S3_VARIABLES)),
    warn
  );
  return withHiddenSecret(
    {
      driver: 's3',
      endpoint: requireHttpUrl('S3_ENDPOINT', endpoint as string, env),
      region,
      bucket: values.bucket as string,
      accessKeyId: values.accessKeyId as string,
      forcePathStyle: readVar(env, 'S3_FORCE_PATH_STYLE')?.toLowerCase() !== 'false',
    },
    values.secretAccessKey as string
  );
}

function replacementFor(deprecated: string, own: CredentialVariables): string {
  if (deprecated === AWS_FALLBACK_VARIABLES.accessKeyId) return own.accessKeyId;
  if (deprecated === AWS_FALLBACK_VARIABLES.secretAccessKey) return own.secretAccessKey;
  if (deprecated === AWS_FALLBACK_VARIABLES.region) return own.region;
  return own.bucket[0];
}

/**
 * Reads and validates the storage configuration. Throws StorageConfigError for an unknown or
 * (in production) unset driver and for a remote driver with any required value missing.
 */
export function resolveStorageConfig(
  env: Env = process.env,
  options: { warn?: (message: string) => void } = {}
): StorageConfig {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  if (isProductionBuildPhase(env)) {
    return { driver: 'local' };
  }
  const driver = resolveStorageDriver(env);
  if (driver === 'oci') return resolveOciConfig(env, warn);
  if (driver === 's3') return resolveS3Config(env, warn);
  if (isProductionRuntime(env) && !localInProductionWarned) {
    localInProductionWarned = true;
    warn(
      '[storage] STORAGE_DRIVER=local keeps every object on this host\'s disk; it is meant for development, ' +
        'tests and single-node deployments.'
    );
  }
  return { driver: 'local' };
}

export function isRemoteStorageConfig(config: StorageConfig): config is RemoteStorageConfig {
  return config.driver !== 'local';
}
