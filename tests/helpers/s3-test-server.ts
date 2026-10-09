/**
 * Locates the independent S3-compatible server that the real-server storage tests run against. It
 * is a server this repository did not write, and it verifies SigV4 itself: CI starts a pinned
 * MinIO image (.github/actions/ci-setup/install-tools.sh) and exports the variables read here.
 *
 *   STORAGE_TEST_S3_ENDPOINT, STORAGE_TEST_S3_ACCESS_KEY_ID, STORAGE_TEST_S3_SECRET_ACCESS_KEY
 *                                      required
 *   STORAGE_TEST_S3_BUCKET             optional, default "easyconvert-client-test"
 *   STORAGE_TEST_S3_REGION             optional, default "us-east-1"
 *
 * Without them the real-server tests skip explicitly; under ORACLE_STRICT_MODE=1 their absence is a
 * failure, because a green strict run must mean the clients were checked against a server they
 * did not write.
 */

export interface RealS3Server {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
}

export const REAL_S3_REQUIRED_VARIABLES = [
  'STORAGE_TEST_S3_ENDPOINT',
  'STORAGE_TEST_S3_ACCESS_KEY_ID',
  'STORAGE_TEST_S3_SECRET_ACCESS_KEY',
] as const;

const DEFAULT_BUCKET = 'easyconvert-client-test';
const DEFAULT_REGION = 'us-east-1';

type Env = Readonly<Record<string, string | undefined>>;

export function isStrictOracleMode(env: Env = process.env): boolean {
  return env.ORACLE_STRICT_MODE === '1';
}

/** The configured test server, or undefined unless all three required variables are set. */
export function readRealS3Server(env: Env = process.env): RealS3Server | undefined {
  const endpoint = env.STORAGE_TEST_S3_ENDPOINT;
  const accessKeyId = env.STORAGE_TEST_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.STORAGE_TEST_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    return undefined;
  }
  return {
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket: env.STORAGE_TEST_S3_BUCKET || DEFAULT_BUCKET,
    region: env.STORAGE_TEST_S3_REGION || DEFAULT_REGION,
  };
}

/** The failure a strict run reports when no test server is configured. */
export function missingRealS3ServerMessage(): string {
  return (
    `ORACLE_STRICT_MODE=1 requires an S3-compatible test server: set ${REAL_S3_REQUIRED_VARIABLES.join(', ')} ` +
    '(CI starts one in the "Install the tools and start the S3 test server" step of .github/actions/ci-setup/action.yml).'
  );
}
