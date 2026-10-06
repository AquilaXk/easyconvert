import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadConfig,
  resetConfig,
  ConfigurationError,
  configSchema,
  getSecretByteLength,
  isValidCidrOrIp,
} from '../src/lib/config';

describe('Configuration Schema & Loader (Issue #564)', () => {
  beforeEach(() => {
    resetConfig();
  });

  describe('Secret Key Parsers (32-byte enforcement)', () => {
    it('verifies getSecretByteLength handles plain, hex, base64, and 0x-hex formats', () => {
      // 31-byte values
      const plain31 = 'a'.repeat(31);
      const hex31 = Buffer.alloc(31, 0x42).toString('hex');
      const b6431 = Buffer.alloc(31, 0x42).toString('base64');
      const hex0x31 = '0x' + Buffer.alloc(31, 0x42).toString('hex');

      expect(getSecretByteLength(plain31)).toBe(31);
      expect(getSecretByteLength(hex31)).toBe(31);
      expect(getSecretByteLength(b6431)).toBe(31);
      expect(getSecretByteLength(hex0x31)).toBe(31);

      // 32-byte values
      const plain32 = 'a'.repeat(32);
      const hex32 = Buffer.alloc(32, 0x42).toString('hex');
      const b6432 = Buffer.alloc(32, 0x42).toString('base64');
      const hex0x32 = '0x' + Buffer.alloc(32, 0x42).toString('hex');

      expect(getSecretByteLength(plain32)).toBe(32);
      expect(getSecretByteLength(hex32)).toBe(32);
      expect(getSecretByteLength(b6432)).toBe(32);
      expect(getSecretByteLength(hex0x32)).toBe(32);
    });

    it('throws ConfigurationError on 31-byte JOB_SECRET_KEK in production without leaking value', () => {
      const failingSecret = 'sensitive-kek-that-is-31-bytes!';
      expect(failingSecret.length).toBe(31);

      let thrownError: unknown;
      try {
        loadConfig(
          {
            NODE_ENV: 'production',
            JOB_SECRET_KEK: failingSecret,
          },
          { reload: true }
        );
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(ConfigurationError);
      const configErr = thrownError as ConfigurationError;

      // Variable name and rule must appear in error message
      expect(configErr.message).toContain('JOB_SECRET_KEK');
      expect(configErr.message).toContain('at least 32 bytes');

      // The sensitive failing value MUST NEVER leak into the message
      expect(configErr.message).not.toContain(failingSecret);

      // Error list contains details
      expect(configErr.errors.some((e) => e.path === 'JOB_SECRET_KEK')).toBe(true);
    });

    it('rejects 31-byte hex and base64 encoded secrets in production', () => {
      const hex31 = Buffer.alloc(31, 0x5a).toString('hex');
      const b6431 = Buffer.alloc(31, 0x5a).toString('base64');

      expect(() =>
        loadConfig(
          {
            NODE_ENV: 'production',
            STORAGE_SIGNING_SECRET: hex31,
          },
          { reload: true }
        )
      ).toThrow(ConfigurationError);

      expect(() =>
        loadConfig(
          {
            NODE_ENV: 'production',
            WEBHOOK_SECRET_KEK: b6431,
          },
          { reload: true }
        )
      ).toThrow(ConfigurationError);
    });

    it('accepts valid 32-byte secrets across all supported encodings', () => {
      const plain32 = 'valid-production-secret-32-bytes!';
      const hex32 = Buffer.alloc(32, 0x5a).toString('hex');
      const b6432 = Buffer.alloc(32, 0x5a).toString('base64');

      const config = loadConfig(
        {
          NODE_ENV: 'production',
          JOB_SECRET_KEK: plain32,
          STORAGE_SIGNING_SECRET: hex32,
          WEBHOOK_SECRET_KEK: b6432,
        },
        { reload: true }
      );

      expect(config.JOB_SECRET_KEK).toBe(plain32);
      expect(config.STORAGE_SIGNING_SECRET).toBe(hex32);
      expect(config.WEBHOOK_SECRET_KEK).toBe(b6432);
    });
  });

  describe('URL Parsing', () => {
    it('throws ConfigurationError when APP_URL is invalid and does not leak value', () => {
      const invalidUrl = 'not-a-valid-http-url-secret=abc';

      let thrownError: unknown;
      try {
        loadConfig(
          {
            NODE_ENV: 'production',
            APP_URL: invalidUrl,
          },
          { reload: true }
        );
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(ConfigurationError);
      const configErr = thrownError as ConfigurationError;

      expect(configErr.message).toContain('APP_URL');
      expect(configErr.message).not.toContain(invalidUrl);
    });

    it('validates REDIS_URL and storage endpoints as URLs', () => {
      const validConfig = loadConfig(
        {
          NODE_ENV: 'production',
          APP_URL: 'https://easyconvert.app',
          REDIS_URL: 'redis://default:secret@redis-host:6379/0',
          S3_ENDPOINT: 'https://s3.amazonaws.com',
          OCI_ENDPOINT: 'https://objectstorage.ap-seoul-1.oraclecloud.com',
        },
        { reload: true }
      );

      expect(validConfig.APP_URL).toBe('https://easyconvert.app');
      expect(validConfig.REDIS_URL).toBe('redis://default:secret@redis-host:6379/0');
      expect(validConfig.S3_ENDPOINT).toBe('https://s3.amazonaws.com');
      expect(validConfig.OCI_ENDPOINT).toBe('https://objectstorage.ap-seoul-1.oraclecloud.com');
    });

    it('throws ConfigurationError on malformed REDIS_URL', () => {
      expect(() =>
        loadConfig(
          {
            NODE_ENV: 'production',
            REDIS_URL: 'malformed_redis_address',
          },
          { reload: true }
        )
      ).toThrow(ConfigurationError);
    });
  });

  describe('CIDR Subnet & IP Parsing (TRUSTED_PROXIES)', () => {
    it('validates IPv4 and IPv6 CIDR notations', () => {
      expect(isValidCidrOrIp('127.0.0.1/8')).toBe(true);
      expect(isValidCidrOrIp('::1/128')).toBe(true);
      expect(isValidCidrOrIp('10.0.0.0/8')).toBe(true);
      expect(isValidCidrOrIp('172.16.0.0/12')).toBe(true);
      expect(isValidCidrOrIp('192.168.0.0/16')).toBe(true);
      expect(isValidCidrOrIp('fc00::/7')).toBe(true);
      expect(isValidCidrOrIp('192.168.1.50')).toBe(true); // plain IP

      // Invalid CIDRs
      expect(isValidCidrOrIp('10.0.0.0/33')).toBe(false); // prefix > 32 for IPv4
      expect(isValidCidrOrIp('fc00::/129')).toBe(false); // prefix > 128 for IPv6
      expect(isValidCidrOrIp('invalid-ip/24')).toBe(false);
      expect(isValidCidrOrIp('')).toBe(false);
    });

    it('parses comma-separated string of trusted proxies', () => {
      const config = loadConfig(
        {
          NODE_ENV: 'production',
          TRUSTED_PROXIES: '10.0.0.0/8, 172.16.0.0/12, ::1/128',
        },
        { reload: true }
      );

      expect(config.TRUSTED_PROXIES).toBe('10.0.0.0/8, 172.16.0.0/12, ::1/128');
    });

    it('parses array of strings of trusted proxies', () => {
      const parsed = configSchema.parse({
        TRUSTED_PROXIES: ['10.0.0.0/8', '192.168.0.0/16'],
      });

      expect(parsed.TRUSTED_PROXIES).toEqual(['10.0.0.0/8', '192.168.0.0/16']);
    });

    it('throws ConfigurationError on CIDR typo in TRUSTED_PROXIES', () => {
      expect(() =>
        loadConfig(
          {
            NODE_ENV: 'production',
            TRUSTED_PROXIES: '10.0.0.0/99, 127.0.0.1/8',
          },
          { reload: true }
        )
      ).toThrow(ConfigurationError);
    });
  });

  describe('Worker Numeric Settings & Coercion', () => {
    it('coerces string values to integers for worker settings', () => {
      const config = loadConfig(
        {
          NODE_ENV: 'production',
          WORKER_CONCURRENCY: '16',
          WORKER_MAX_RSS_MB: '8192',
          WORKER_MAX_JOBS: '500',
          WORKER_DRAIN_TIMEOUT_MS: '30000',
          WORKER_HEARTBEAT_INTERVAL_MS: '2000',
        },
        { reload: true }
      );

      expect(config.WORKER_CONCURRENCY).toBe(16);
      expect(config.WORKER_MAX_RSS_MB).toBe(8192);
      expect(config.WORKER_MAX_JOBS).toBe(500);
      expect(config.WORKER_DRAIN_TIMEOUT_MS).toBe(30000);
      expect(config.WORKER_HEARTBEAT_INTERVAL_MS).toBe(2000);
    });

    it('throws ConfigurationError when numeric settings fail bounds or parsing', () => {
      expect(() =>
        loadConfig(
          {
            NODE_ENV: 'production',
            WORKER_CONCURRENCY: 'not-a-number',
          },
          { reload: true }
        )
      ).toThrow(ConfigurationError);

      expect(() =>
        loadConfig(
          {
            NODE_ENV: 'production',
            WORKER_MAX_RSS_MB: '50', // below minimum 100
          },
          { reload: true }
        )
      ).toThrow(ConfigurationError);
    });
  });

  describe('Enums & Known Values', () => {
    it('accepts valid NODE_ENV and NEXT_PHASE values', () => {
      const config = loadConfig(
        {
          NODE_ENV: 'production',
          NEXT_PHASE: 'phase-production-build',
        },
        { reload: true }
      );

      expect(config.NODE_ENV).toBe('production');
      expect(config.NEXT_PHASE).toBe('phase-production-build');
    });

    it('throws ConfigurationError on unknown NODE_ENV or NEXT_PHASE', () => {
      expect(() =>
        loadConfig(
          {
            NODE_ENV: 'invalid-environment' as any,
          },
          { reload: true }
        )
      ).toThrow(ConfigurationError);

      expect(() =>
        loadConfig(
          {
            NODE_ENV: 'production',
            NEXT_PHASE: 'invalid-phase' as any,
          },
          { reload: true }
        )
      ).toThrow(ConfigurationError);
    });
  });

  describe('Environment Lifecycle & Defaults', () => {
    it('succeeds in development with an empty environment', () => {
      const config = loadConfig({ NODE_ENV: 'development' }, { reload: true });

      expect(config.NODE_ENV).toBe('development');
      expect(config.APP_URL).toBe('http://localhost:3000');
      expect(config.WORKER_CONCURRENCY).toBe(3);
      expect(config.WORKER_MAX_RSS_MB).toBe(4096);
      expect(config.EASYCONVERT_STORAGE_DIR).toBe('/tmp/easyconvert');
    });

    it('falls back gracefully to defaults in development when invalid config is provided', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const config = loadConfig(
        {
          NODE_ENV: 'development',
          APP_URL: 'invalid-url-in-dev',
        },
        { reload: true }
      );

      expect(config.NODE_ENV).toBe('development');
      expect(config.APP_URL).toBe('http://localhost:3000');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('formats ConfigurationError correctly without leaking secrets', () => {
      const err = new ConfigurationError([{ path: 'TEST_VAR', rule: 'Must be valid' }]);
      expect(err.message).toBe('ConfigurationError: TEST_VAR: Must be valid');
      expect(err.errors[0].path).toBe('TEST_VAR');
      expect(err.errors[0].rule).toBe('Must be valid');
    });
  });
});
