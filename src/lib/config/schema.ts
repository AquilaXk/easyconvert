import { z } from 'zod';
import net from 'node:net';

/**
 * Calculates effective byte length of a secret.
 * Handles explicit hex (0x prefix or even-length hex >= 62 chars),
 * padded base64, and plain UTF-8 strings.
 */
export function getSecretByteLength(value: string): number {
  if (typeof value !== 'string') return 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;

  // 1. Explicit 0x-prefixed hex string
  if (/^0x[0-9a-fA-F]+$/i.test(trimmed)) {
    return Math.floor((trimmed.length - 2) / 2);
  }

  // 2. Base64 with padding (= or ==)
  if (/^[A-Za-z0-9+/_-]+=+/i.test(trimmed)) {
    try {
      return Buffer.from(trimmed, 'base64').length;
    } catch {
      // fallback to plain UTF-8
    }
  }

  // 3. Hex string:
  // If 64 or more hex characters, it represents at least 32 bytes in hex.
  // If exactly 62 hex characters, it represents 31 bytes in hex.
  if (/^[0-9a-fA-F]+$/i.test(trimmed) && trimmed.length % 2 === 0) {
    if (trimmed.length === 62) {
      return 31;
    }
    if (trimmed.length >= 64) {
      return trimmed.length / 2;
    }
  }

  // 4. Plain string (UTF-8 byte length)
  return Buffer.byteLength(trimmed, 'utf-8');
}

/**
 * Reusable schema for cryptographic secrets and encryption keys.
 * Enforces at least 32 bytes of key material.
 */
export const secretSchema = z.string().refine(
  (val) => getSecretByteLength(val) >= 32,
  { message: 'Must be at least 32 bytes' }
);

/**
 * Validates whether a single string is a valid CIDR subnet or IP address.
 */
export function isValidCidrOrIp(item: string): boolean {
  if (typeof item !== 'string') return false;
  const trimmed = item.trim();
  if (!trimmed) return false;

  const parts = trimmed.split('/');
  if (parts.length === 1) {
    return net.isIP(parts[0]) !== 0;
  }
  if (parts.length === 2) {
    const ip = parts[0];
    const prefixStr = parts[1];
    if (!/^\d+$/.test(prefixStr)) return false;
    const prefix = Number.parseInt(prefixStr, 10);
    const ipType = net.isIP(ip);
    if (ipType === 4) {
      if (prefix >= 0 && prefix <= 32) {
        try {
          const b = new net.BlockList();
          b.addSubnet(ip, prefix, 'ipv4');
          return true;
        } catch {
          return false;
        }
      }
    } else if (ipType === 6) {
      if (prefix >= 0 && prefix <= 128) {
        try {
          const b = new net.BlockList();
          b.addSubnet(ip, prefix, 'ipv6');
          return true;
        } catch {
          return false;
        }
      }
    }
  }
  return false;
}

/**
 * CIDR list parser accepting either a comma-separated string or an array of strings.
 */
export const cidrListSchema = z
  .union([z.string(), z.array(z.string())])
  .refine(
    (val) => {
      const list = Array.isArray(val)
        ? val
        : val
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
      if (list.length === 0) return false;
      return list.every(isValidCidrOrIp);
    },
    { message: 'Must be a valid CIDR subnet or IP address list' }
  );

export const DEFAULT_TRUSTED_PROXIES = [
  '127.0.0.1/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
] as const;

/**
 * Complete environment configuration schema covering every process.env variable.
 */
export const configSchema = z.object({
  // Runtime environments & phases
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  NEXT_PHASE: z
    .enum([
      'phase-development-server',
      'phase-production-build',
      'phase-production-server',
      'phase-export',
      'phase-info',
      'phase-test',
    ])
    .optional(),

  // URLs & Network
  APP_URL: z.string().url().default('http://localhost:3000'),
  APP_ORIGIN: z.string().url().optional(),
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),
  TRUSTED_PROXIES: cidrListSchema.default([...DEFAULT_TRUSTED_PROXIES]),
  TRUSTED_CDN: cidrListSchema.optional(),

  // Secrets & Key Encryption Keys (enforcing at least 32 bytes)
  STORAGE_SIGNING_SECRET: secretSchema.optional(),
  STORAGE_VAULT_KEY: secretSchema.optional(),
  KEY_ENCRYPTION_KEY: secretSchema.optional(),
  KEY_HASH_PEPPER: secretSchema.optional(),
  WEBHOOK_SECRET_KEK: secretSchema.optional(),
  JOB_SECRET_KEK: secretSchema.optional(),
  JWT_SECRET: secretSchema.optional(),
  OCI_SIGNING_SECRET: secretSchema.optional(),
  S3_SIGNING_SECRET: secretSchema.optional(),

  // Cloud & Object Storage
  STORAGE_DRIVER: z.enum(['s3', 'oci', 'local']).optional(),
  STORAGE_EMULATION: z.string().optional(),
  EASYCONVERT_STORAGE_DIR: z.string().default('/tmp/easyconvert'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_BUCKET_NAME: z.string().optional(),
  AWS_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_BUCKET_NAME: z.string().default('easyconvert-transcode-bucket'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  BYOS_S3_DEV_ENDPOINT_ALLOWLIST: z.string().optional(),
  OCI_ACCESS_KEY_ID: z.string().optional(),
  OCI_BUCKET_NAME: z.string().default('easyconvert-transcode-bucket'),
  OCI_ENDPOINT: z.string().url().optional(),
  OCI_NAMESPACE: z.string().optional(),
  OCI_REGION: z.string().default('ap-seoul-1'),

  // Queue & Redis
  REDIS_URL: z.string().url().optional(),
  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),

  // Worker Settings
  EASYCONVERT_WORKER_ENABLED: z.string().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(3),
  WORKER_MAX_RSS_MB: z.coerce.number().int().min(100).default(4096),
  WORKER_MAX_JOBS: z.coerce.number().int().min(1).default(1000),
  WORKER_DRAIN_TIMEOUT_MS: z.coerce.number().int().min(0).default(60000),
  WORKER_HEARTBEAT_FILE: z.string().optional(),
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(100).default(5000),
  WORKER_QUEUES: z.string().optional(),

  // Rate Limiting & Resource Ceilings
  ANONYMOUS_BURST_CAPACITY: z.coerce.number().int().min(1).default(10),
  ANONYMOUS_BURST_REFILL_RATE: z.coerce.number().int().min(1).default(1),
  ANONYMOUS_DAILY_LIMIT: z.coerce.number().int().min(1).default(100),
  GRAPH_URL_IMPORT_MAX_BYTES: z.coerce.number().int().min(1).default(100 * 1024 * 1024),
  MAX_IN_MEMORY_BYTES: z.coerce.number().int().min(1).default(512 * 1024 * 1024),
  EASYCONVERT_MAX_INPUT_PIXELS: z.coerce.number().int().min(1).optional(),
  LIBREOFFICE_POOL_READINESS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(40000).default(15000),
  EASYCONVERT_PDF_TEXT_DEADLINE_MS: z.coerce.number().int().min(100).optional(),

  // Security & Sandbox
  CONTAINER_SANDBOX: z.string().optional(),
  STRICT_SANDBOX: z.string().optional(),
  KUBERNETES_SERVICE_HOST: z.string().optional(),

  // OAuth & Public UI
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  NEXT_PUBLIC_ADSENSE_CLIENT: z.string().optional(),
  NEXT_PUBLIC_ADSENSE_SLOT: z.string().optional(),

  // System Paths & Tool Binaries
  PATH: z.string().optional(),
  FFMPEG_PATH: z.string().optional(),
  FFPROBE_PATH: z.string().optional(),
  SOFFICE_PATH: z.string().optional(),
  P7ZIP_PATH: z.string().optional(),
  P7Z_PATH: z.string().optional(),
  ZIP_PATH: z.string().optional(),
  UNRAR_PATH: z.string().optional(),
  PDFINFO_PATH: z.string().optional(),
  PDFTOPPM_PATH: z.string().optional(),
  PDFTOCAIRO_PATH: z.string().optional(),
  PDFTOTEXT_PATH: z.string().optional(),
  DCRAW_EMU_PATH: z.string().optional(),
  TESSERACT_PATH: z.string().optional(),
  TESSDATA_PREFIX: z.string().optional(),
  VERAPDF_PATH: z.string().optional(),
  QPDF_PATH: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;
