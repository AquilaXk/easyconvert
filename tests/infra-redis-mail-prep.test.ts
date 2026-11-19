import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAIL_DAILY_HARD_CAP,
  MAIL_DAILY_VERIFY_CAP,
  MAIL_DAILY_WARN,
  mailBudgetLeft,
  reserveMailSend,
  resetMailBudgetMemory,
  resolveMailBudgetLimits,
} from '../src/lib/auth/mail-budget';
import { readCompoundFileRoot } from '../src/lib/compound-file-kind';
import { ConfigurationError, parseConfig } from '../src/lib/config';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { CFBF_MAGIC } from '../src/lib/format-signatures';
import { EngineUnavailableError } from '../src/lib/types';
import { resetNativeBinaryCache } from '../src/worker/engines';
import { withMissingBinary } from './helpers/native-tools';
import {
  ENVELOPE_MAGIC,
  OffhostBackupError,
  openRdbEnvelope,
  parseListObjectsV2Xml,
  parseOffhostConfig,
  pullEncryptedBackup,
  sealRdbEnvelope,
} from '../deploy/oci/redis-backup-offhost.mjs';

const ROOT = path.resolve(__dirname, '..');
const DEPLOY_SCRIPT = path.join(ROOT, 'deploy', 'oci', 'deploy.sh');
const BACKUP_SCRIPT = path.join(ROOT, 'deploy', 'oci', 'redis-backup.sh');
const SAMPLE_RDB = Buffer.concat([Buffer.from('REDIS0012', 'ascii'), crypto.randomBytes(256)]);
const TEST_KEK = 'k'.repeat(40);

const sha256 = (buf: Buffer): string => crypto.createHash('sha256').update(buf).digest('hex');

describe('Infrastructure advance preparation & CI conformance guards', () => {
  const tempDirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ['AUTH_MAIL_DAILY_WARN', 'AUTH_MAIL_DAILY_VERIFY_CAP', 'AUTH_MAIL_DAILY_HARD_CAP', 'SOFFICE_PATH'] as const;

  beforeEach(() => {
    resetMailBudgetMemory();
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetNativeBinaryCache();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  const makeTempDir = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  describe('1. Configurable transactional SMTP mail budget', () => {
    it('defaults to 350 / 400 / 480 when env vars are unset or blank and scales dynamically when set', async () => {
      expect(resolveMailBudgetLimits({})).toEqual({
        warn: MAIL_DAILY_WARN,
        verifyCap: MAIL_DAILY_VERIFY_CAP,
        hardCap: MAIL_DAILY_HARD_CAP,
      });
      expect(resolveMailBudgetLimits({ AUTH_MAIL_DAILY_WARN: '  ', AUTH_MAIL_DAILY_VERIFY_CAP: '' })).toEqual({
        warn: 350,
        verifyCap: 400,
        hardCap: 480,
      });
      expect(
        resolveMailBudgetLimits({
          AUTH_MAIL_DAILY_WARN: '4000',
          AUTH_MAIL_DAILY_VERIFY_CAP: '5000',
          AUTH_MAIL_DAILY_HARD_CAP: '6000',
        })
      ).toEqual({ warn: 4000, verifyCap: 5000, hardCap: 6000 });

      process.env.AUTH_MAIL_DAILY_WARN = '2';
      process.env.AUTH_MAIL_DAILY_VERIFY_CAP = '3';
      process.env.AUTH_MAIL_DAILY_HARD_CAP = '4';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      expect(await reserveMailSend('verify')).toBe(true);
      expect(await reserveMailSend('verify')).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith('auth_mail_budget level=warn sent=2 cap=3');
      expect(await reserveMailSend('verify')).toBe(true);
      expect(errSpy).toHaveBeenCalledWith('auth_mail_budget level=cap kind=verify sent=3 cap=3');
      expect(await mailBudgetLeft('verify')).toBe(false);
      expect(await reserveMailSend('verify')).toBe(false);
      // Password reset keeps its reserved headroom up to AUTH_MAIL_DAILY_HARD_CAP (4)
      expect(await mailBudgetLeft('reset')).toBe(true);
      expect(await reserveMailSend('reset')).toBe(true);
      expect(await mailBudgetLeft('reset')).toBe(false);
      expect(await reserveMailSend('reset')).toBe(false);
    });

    it('fails closed in both resolveMailBudgetLimits and parseConfig on invalid or inverted caps', () => {
      expect(() => resolveMailBudgetLimits({ AUTH_MAIL_DAILY_WARN: '0' })).toThrow(RangeError);
      expect(() => resolveMailBudgetLimits({ AUTH_MAIL_DAILY_VERIFY_CAP: 'abc' })).toThrow(RangeError);
      expect(() =>
        resolveMailBudgetLimits({ AUTH_MAIL_DAILY_WARN: '500', AUTH_MAIL_DAILY_VERIFY_CAP: '400', AUTH_MAIL_DAILY_HARD_CAP: '600' })
      ).toThrow(/AUTH_MAIL_DAILY_WARN must not exceed AUTH_MAIL_DAILY_VERIFY_CAP/);
      expect(() =>
        resolveMailBudgetLimits({ AUTH_MAIL_DAILY_WARN: '300', AUTH_MAIL_DAILY_VERIFY_CAP: '700', AUTH_MAIL_DAILY_HARD_CAP: '600' })
      ).toThrow(/AUTH_MAIL_DAILY_VERIFY_CAP must not exceed AUTH_MAIL_DAILY_HARD_CAP/);

      expect(() =>
        parseConfig({
          NODE_ENV: 'development',
          AUTH_MAIL_DAILY_WARN: '600',
          AUTH_MAIL_DAILY_VERIFY_CAP: '500',
          AUTH_MAIL_DAILY_HARD_CAP: '450',
        })
      ).toThrow(ConfigurationError);
    });
  });

  describe('2. Configurable Redis memory scaling in deploy.sh budget', () => {
    it('keeps 512m / 256mb up to 20 GiB and scales container + 50% fork-safe maxmemory on larger hosts up to 4096m / 2048mb', () => {
      const runBudget = (cpus: string, memGb: string): Record<string, string> => {
        const res = spawnSync('bash', [DEPLOY_SCRIPT, 'budget'], {
          encoding: 'utf-8',
          env: {
            NODE_ENV: process.env.NODE_ENV ?? 'test',
            PATH: process.env.PATH ?? '',
            EASYCONVERT_BUDGET_CPUS: cpus,
            EASYCONVERT_BUDGET_MEMORY_GB: memGb,
          },
        });
        expect(res.status).toBe(0);
        return Object.fromEntries(res.stdout.trim().split('\n').map((line) => line.split('=') as [string, string]));
      };

      const launch = runBudget('3.5', '20');
      expect(launch.EASYCONVERT_REDIS_MEMORY).toBe('512m');
      expect(launch.EASYCONVERT_REDIS_MAXMEMORY).toBe('256mb');

      const mid = runBudget('8', '48');
      expect(mid.EASYCONVERT_REDIS_MEMORY).toBe('1152m');
      expect(mid.EASYCONVERT_REDIS_MAXMEMORY).toBe('576mb');

      const large = runBudget('16', '96');
      expect(large.EASYCONVERT_REDIS_MEMORY).toBe('2432m');
      expect(large.EASYCONVERT_REDIS_MAXMEMORY).toBe('1216mb');

      const capped = runBudget('32', '256');
      expect(capped.EASYCONVERT_REDIS_MEMORY).toBe('4096m');
      expect(capped.EASYCONVERT_REDIS_MAXMEMORY).toBe('2048mb');
    });
  });

  describe('3. Opt-in encrypted, 7-day-pruned off-host Redis backup replication', () => {
    it('seals and opens ECRDB01 AES-256-GCM envelopes and rejects tampering, wrong keys, and object-rename rollback attacks', () => {
      const rdbName = 'redis-20261210T061700Z.rdb';
      const digest = sha256(SAMPLE_RDB);
      const { envelope, plaintextSha256 } = sealRdbEnvelope(SAMPLE_RDB, rdbName, TEST_KEK, digest);
      expect(plaintextSha256).toBe(digest);
      expect(envelope.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)).toBe(true);
      expect(envelope.includes(Buffer.from('REDIS0012', 'ascii'))).toBe(false);
      // Plaintext SHA-256 is encrypted inside GCM, never exposed in the envelope header
      expect(envelope.includes(Buffer.from(digest, 'hex'))).toBe(false);

      const opened = openRdbEnvelope(envelope, rdbName, TEST_KEK, digest);
      expect(opened.plaintext.equals(SAMPLE_RDB)).toBe(true);
      expect(opened.plaintextSha256).toBe(digest);

      // Rename/rollback attack: valid ciphertext from an older backup renamed to a newer timestamp fails GCM AAD verification
      expect(() => openRdbEnvelope(envelope, 'redis-20261217T061700Z.rdb', TEST_KEK)).toThrow(OffhostBackupError);
      // Wrong key
      expect(() => openRdbEnvelope(envelope, rdbName, 'x'.repeat(40))).toThrow(OffhostBackupError);
      // Bit flip in ciphertext
      const flipped = Buffer.from(envelope);
      flipped[flipped.length - 20] ^= 0xff;
      expect(() => openRdbEnvelope(flipped, rdbName, TEST_KEK)).toThrow(OffhostBackupError);
      // Non-REDIS plaintext rejected before sealing
      expect(() => sealRdbEnvelope(Buffer.from('NOT_A_REDIS_DUMP'), rdbName, TEST_KEK)).toThrow(OffhostBackupError);
    });

    it('enforces HTTPS, >=32-byte keys, SSRF private-IP blocks, and DTD-free ListObjectsV2 XML bounds', () => {
      const validBase: NodeJS.ProcessEnv = {
        NODE_ENV: 'test',
        REDIS_BACKUP_OFFHOST_ENABLED: 'true',
        REDIS_BACKUP_ENCRYPTION_KEY: TEST_KEK,
        REDIS_BACKUP_S3_ENDPOINT: 'https://s3.us-east-1.amazonaws.com',
        REDIS_BACKUP_S3_REGION: 'us-east-1',
        REDIS_BACKUP_S3_BUCKET: 'easyconvert-backups',
        REDIS_BACKUP_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
        REDIS_BACKUP_S3_SECRET_ACCESS_KEY: 'secret-key-example',
      };
      expect(parseOffhostConfig(validBase).prefix).toBe('redis-backups');
      expect(() => parseOffhostConfig({ ...validBase, REDIS_BACKUP_ENCRYPTION_KEY: 'short-key' })).toThrow(/between 32 and 4096/);
      expect(() => parseOffhostConfig({ ...validBase, REDIS_BACKUP_S3_ENDPOINT: 'http://s3.us-east-1.amazonaws.com' })).toThrow(/https:\/\//);
      expect(() => parseOffhostConfig({ ...validBase, REDIS_BACKUP_S3_ENDPOINT: 'https://user:pass@s3.us-east-1.amazonaws.com' })).toThrow(
        /credentials/
      );
      expect(() => parseOffhostConfig({ ...validBase, REDIS_BACKUP_S3_PREFIX: '../escape' })).toThrow(/REDIS_BACKUP_S3_PREFIX/);
      expect(() => parseListObjectsV2Xml('<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe "bad">]><ListBucketResult/>')).toThrow(/DTD\/ENTITY/);
    });

    it('replicates encrypted backups, prunes >7-day objects even when BGSAVE fails, caps at BACKUP_KEEP, and restores via pull', async () => {
      const objects = new Map<string, { body: Buffer; lastModified: string }>();
      const requests: Array<{ method: string; url: string; auth: string; contentSha: string }> = [];

      const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          const urlObj = new URL(req.url ?? '/', 'http://127.0.0.1');
          requests.push({
            method: req.method ?? '',
            url: req.url ?? '',
            auth: String(req.headers.authorization ?? ''),
            contentSha: String(req.headers['x-amz-content-sha256'] ?? ''),
          });
          if (!String(req.headers.authorization ?? '').startsWith('AWS4-HMAC-SHA256 Credential=AKIA_TEST/')) {
            res.writeHead(403).end('Forbidden');
            return;
          }
          const prefix = '/test-bucket/';
          if (req.method === 'GET' && urlObj.pathname === '/test-bucket' && urlObj.searchParams.get('list-type') === '2') {
            const wantPrefix = urlObj.searchParams.get('prefix') ?? '';
            const itemsXml = [...objects.entries()]
              .filter(([key]) => key.startsWith(wantPrefix))
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, val]) => `<Contents><Key>${key}</Key><LastModified>${val.lastModified}</LastModified><Size>${val.body.length}</Size></Contents>`)
              .join('');
            res.writeHead(200, { 'content-type': 'application/xml' });
            res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>${itemsXml}</ListBucketResult>`);
            return;
          }
          if (urlObj.pathname.startsWith(prefix)) {
            const key = decodeURIComponent(urlObj.pathname.slice(prefix.length));
            if (req.method === 'PUT') {
              expect(req.headers['x-amz-content-sha256']).toBe(sha256(body));
              objects.set(key, { body, lastModified: new Date().toISOString() });
              res.writeHead(200).end();
              return;
            }
            if (req.method === 'GET') {
              const found = objects.get(key);
              if (!found) {
                res.writeHead(404).end();
                return;
              }
              res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(found.body);
              return;
            }
            if (req.method === 'DELETE') {
              objects.delete(key);
              res.writeHead(204).end();
              return;
            }
          }
          res.writeHead(404).end();
        });
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      try {
        const port = (server.address() as AddressInfo).port;
        const sandbox = makeTempDir('offhost-e2e-');
        const home = path.join(sandbox, 'home');
        const bin = path.join(sandbox, 'bin');
        const backups = path.join(sandbox, 'backups');
        const rdbPath = path.join(sandbox, 'dump.rdb');
        fs.mkdirSync(path.join(home, 'current', 'deploy', 'oci'), { recursive: true });
        fs.mkdirSync(bin, { recursive: true });
        fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
        fs.copyFileSync(path.join(ROOT, 'deploy', 'oci', 'redis-backup-offhost.mjs'), path.join(home, 'current', 'deploy', 'oci', 'redis-backup-offhost.mjs'));
        fs.writeFileSync(rdbPath, SAMPLE_RDB);

        const writeStub = (name: string, scriptBody: string): void => {
          const p = path.join(bin, name);
          fs.writeFileSync(p, `#!/usr/bin/env bash\n${scriptBody}\n`, { mode: 0o755 });
        };
        writeStub('flock', 'exit 0');
        writeStub(
          'docker',
          `args=("$@")
for i in "\${!args[@]}"; do [ "\${args[$i]}" = "exec" ] && exec_at=$i; [ "\${args[$i]}" = "ps" ] && ps_at=$i; done
if [ -n "\${ps_at:-}" ]; then [ -n "\${FAIL_REDIS:-}" ] && exit 0; echo "c0ffee"; exit 0; fi
rest=("\${args[@]:$((exec_at + 3))}")
case "\${rest[0]}" in
  sh)
    case "\${rest[4]}" in
      INFO) printf '# Persistence\\r\\nrdb_bgsave_in_progress:0\\r\\nrdb_saves:%s\\r\\nrdb_last_bgsave_status:ok\\r\\n' "$(cat "${sandbox}/saves")" ;;
      BGSAVE) echo $(($(cat "${sandbox}/saves") + 1)) > "${sandbox}/saves"; printf 'Background saving started\\r\\n' ;;
    esac ;;
  redis-check-rdb) exit 0 ;;
  sha256sum) printf '%s  /data/dump.rdb\\n' "${sha256(SAMPLE_RDB)}" ;;
  cat) cat "${rdbPath}" ;;
esac`
        );
        fs.writeFileSync(path.join(sandbox, 'saves'), '10');

        const runBackupAsync = (env: Record<string, string>) =>
          new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
            const child = spawn('bash', [BACKUP_SCRIPT], { env: env as NodeJS.ProcessEnv });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (d: Buffer) => {
              stdout += d.toString('utf8');
            });
            child.stderr.on('data', (d: Buffer) => {
              stderr += d.toString('utf8');
            });
            child.on('error', reject);
            child.on('close', (code) => resolve({ status: code, stdout, stderr }));
          });

        // 1) Default OFF: zero HTTP requests to S3
        fs.writeFileSync(path.join(home, 'current', '.env'), 'REDIS_PASSWORD=secretpass\n');
        const offRes = await runBackupAsync({
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          EASYCONVERT_HOME: home,
          BACKUP_DIR: backups,
          BACKUP_MIN_FREE_MB: '0',
          BACKUP_POLL_SECONDS: '1',
        });
        expect(offRes.status, offRes.stderr).toBe(0);
        expect(requests).toHaveLength(0);

        // Seed remote bucket with 1 expired object (9 days old) and 2 recent objects
        const stampOf = (msAgo: number): string =>
          new Date(Date.now() - msAgo).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
        const expiredRdb = `redis-${stampOf(9 * 86_400_000)}.rdb`;
        const keptOld1 = `redis-${stampOf(3 * 86_400_000)}.rdb`;
        const keptOld2 = `redis-${stampOf(2 * 86_400_000)}.rdb`;
        for (const [name, ageMs] of [
          [expiredRdb, 9 * 86_400_000],
          [keptOld1, 3 * 86_400_000],
          [keptOld2, 2 * 86_400_000],
        ] as const) {
          objects.set(`ec-backups/${name}.enc`, {
            body: sealRdbEnvelope(SAMPLE_RDB, name, TEST_KEK).envelope,
            lastModified: new Date(Date.now() - ageMs).toISOString(),
          });
        }

        const envContent = [
          'REDIS_PASSWORD=secretpass',
          'REDIS_BACKUP_OFFHOST_ENABLED=true',
          `REDIS_BACKUP_ENCRYPTION_KEY=${TEST_KEK}`,
          `REDIS_BACKUP_S3_ENDPOINT=http://127.0.0.1:${port}`,
          'REDIS_BACKUP_S3_REGION=us-east-1',
          'REDIS_BACKUP_S3_BUCKET=test-bucket',
          'REDIS_BACKUP_S3_PREFIX=ec-backups',
          'REDIS_BACKUP_S3_ACCESS_KEY_ID=AKIA_TEST',
          'REDIS_BACKUP_S3_SECRET_ACCESS_KEY=SECRET_TEST_KEY',
          'REDIS_BACKUP_ALLOW_INSECURE_HTTP=1',
        ].join('\n');
        fs.writeFileSync(path.join(home, 'current', '.env'), `${envContent}\n`);

        // 2) Even when Redis container is down (`FAIL_REDIS=1`), remote >7-day backup is pruned first!
        const failedRun = await runBackupAsync({
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          EASYCONVERT_HOME: home,
          BACKUP_DIR: backups,
          BACKUP_MIN_FREE_MB: '0',
          BACKUP_POLL_SECONDS: '1',
          FAIL_REDIS: '1',
        });
        expect(failedRun.status).toBe(1);
        expect(objects.has(`ec-backups/${expiredRdb}.enc`)).toBe(false);
        expect(objects.has(`ec-backups/${keptOld1}.enc`)).toBe(true);

        // 3) Healthy backup uploads encrypted `.rdb.enc` and prunes to BACKUP_KEEP=2
        for (const f of fs.readdirSync(backups)) fs.rmSync(path.join(backups, f), { force: true });
        const okRun = await runBackupAsync({
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          EASYCONVERT_HOME: home,
          BACKUP_DIR: backups,
          BACKUP_MIN_FREE_MB: '0',
          BACKUP_POLL_SECONDS: '1',
          BACKUP_KEEP: '2',
        });
        expect(okRun.status, okRun.stderr).toBe(0);
        const createdLocal = path.basename(okRun.stdout.trim());
        expect(objects.has(`ec-backups/${createdLocal}.enc`)).toBe(true);
        // BACKUP_KEEP=2 removed `keptOld1` and kept `keptOld2` + `createdLocal`
        expect([...objects.keys()].sort()).toEqual([`ec-backups/${keptOld2}.enc`, `ec-backups/${createdLocal}.enc`].sort());

        // 4) Restore pull decrypts and verifies SHA-256 + mode 0600
        const restoredPath = path.join(sandbox, 'restored', createdLocal);
        fs.mkdirSync(path.dirname(restoredPath), { recursive: true });
        const cfg = parseOffhostConfig({
          NODE_ENV: 'test',
          REDIS_BACKUP_OFFHOST_ENABLED: 'true',
          REDIS_BACKUP_ENCRYPTION_KEY: TEST_KEK,
          REDIS_BACKUP_S3_ENDPOINT: `http://127.0.0.1:${port}`,
          REDIS_BACKUP_S3_REGION: 'us-east-1',
          REDIS_BACKUP_S3_BUCKET: 'test-bucket',
          REDIS_BACKUP_S3_PREFIX: 'ec-backups',
          REDIS_BACKUP_S3_ACCESS_KEY_ID: 'AKIA_TEST',
          REDIS_BACKUP_S3_SECRET_ACCESS_KEY: 'SECRET_TEST_KEY',
          REDIS_BACKUP_ALLOW_INSECURE_HTTP: '1',
        });
        const pulled = await pullEncryptedBackup(cfg, createdLocal, restoredPath, sha256(SAMPLE_RDB));
        expect(pulled.plaintextSha256).toBe(sha256(SAMPLE_RDB));
        expect(fs.readFileSync(restoredPath).equals(SAMPLE_RDB)).toBe(true);
        expect(fs.statSync(restoredPath).mode & 0o777).toBe(0o600);

        // 5) Host without `node` on PATH falls back to `docker run` + `images.env`, runs prune-age & prune-count, and leaks no JWT_SECRET or argv secret
        const noNodeBin = path.join(sandbox, 'no-node-bin');
        fs.mkdirSync(noNodeBin, { recursive: true });
        for (const cmd of ['awk', 'basename', 'bash', 'cat', 'chmod', 'cut', 'date', 'df', 'dirname', 'find', 'grep', 'head', 'id', 'mkdir', 'mv', 'pwd', 'rm', 'sed', 'sh', 'shasum', 'sha256sum', 'sleep', 'tail', 'tr', 'wc']) {
          const found = spawnSync('which', [cmd], { encoding: 'utf-8' }).stdout.trim();
          if (found) fs.symlinkSync(found, path.join(noNodeBin, cmd));
        }
        fs.symlinkSync(path.join(bin, 'flock'), path.join(noNodeBin, 'flock'));
        const dockerArgsLog = path.join(sandbox, 'docker-fallback-args.txt');
        const dockerEnvLog = path.join(sandbox, 'docker-fallback-env.txt');
        fs.writeFileSync(path.join(home, 'current', 'images.env'), 'EASYCONVERT_WEB_IMAGE=ghcr.io/example/easyconvert-web@sha256:deadbeef\n');
        fs.appendFileSync(path.join(home, 'current', '.env'), 'JWT_SECRET=do-not-pass-to-backup-container\n');
        const expiredFallback = `redis-${stampOf(10 * 86_400_000)}.rdb`;
        objects.set(`ec-backups/${expiredFallback}.enc`, {
          body: sealRdbEnvelope(SAMPLE_RDB, expiredFallback, TEST_KEK).envelope,
          lastModified: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        });
        fs.writeFileSync(
          path.join(noNodeBin, 'docker'),
          `#!/usr/bin/env bash
if [ "$1" = "inspect" ]; then exit 1; fi
if [ "$1" = "run" ]; then
  printf '%s\\n' "$*" >> "${dockerArgsLog}"
  printf 'JWT=%s\\n' "\${JWT_SECRET:-}" >> "${dockerEnvLog}"
  mounted=""
  args=("$@")
  for i in "\${!args[@]}"; do
    case "\${args[$i]}" in
      *:/opt/redis-backup-offhost.mjs:ro) mounted="\${args[$i]%%:/opt/redis-backup-offhost.mjs:ro}" ;;
      /opt/redis-backup-offhost.mjs) sub_at=$i ;;
    esac
  done
  exec "${process.execPath}" "$mounted" "\${args[@]:$((sub_at + 1))}"
fi
exit 1
`,
          { mode: 0o755 }
        );
        const fallbackPrune = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
          const child = spawn('bash', [BACKUP_SCRIPT, 'prune'], {
            env: {
              PATH: noNodeBin,
              EASYCONVERT_HOME: home,
              BACKUP_DIR: backups,
              BACKUP_MIN_FREE_MB: '0',
              BACKUP_POLL_SECONDS: '1',
              BACKUP_KEEP: '2',
            } as unknown as NodeJS.ProcessEnv,
          });
          let stderr = '';
          child.stderr.on('data', (d: Buffer) => {
            stderr += d.toString('utf8');
          });
          child.on('error', reject);
          child.on('close', (code) => resolve({ status: code, stderr }));
        });
        expect(fallbackPrune.status, fallbackPrune.stderr).toBe(0);
        expect(objects.has(`ec-backups/${expiredFallback}.enc`)).toBe(false);
        const loggedArgs = fs.readFileSync(dockerArgsLog, 'utf-8');
        expect(loggedArgs).toContain('ghcr.io/example/easyconvert-web@sha256:deadbeef');
        expect(loggedArgs).not.toContain(TEST_KEK);
        expect(loggedArgs).not.toContain('SECRET_TEST_KEY');
        expect(fs.readFileSync(dockerEnvLog, 'utf-8').trim()).toBe('JWT=\nJWT=');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('4. CFBF unallocated directory slot & missing-engine ordering regression guards', () => {
    it('ignores zero-filled unallocated directory slots (Object Type 0) in sibling links while rejecting real sibling cycles', () => {
      const buf = Buffer.alloc(512 * 3, 0);
      Buffer.from(CFBF_MAGIC).copy(buf, 0);
      buf.writeUInt16LE(0x003e, 24);
      buf.writeUInt16LE(3, 26);
      buf.writeUInt16LE(0xfffe, 28);
      buf.writeUInt16LE(9, 30);
      buf.writeUInt16LE(6, 32);
      buf.writeUInt32LE(1, 44);
      buf.writeUInt32LE(1, 48);
      buf.writeUInt32LE(4096, 56);
      buf.writeUInt32LE(0xfffffffe, 60);
      buf.writeUInt32LE(0xfffffffe, 68);
      for (let i = 0; i < 109; i++) buf.writeUInt32LE(0xffffffff, 76 + i * 4);
      buf.writeUInt32LE(0, 76);
      for (let i = 0; i < 128; i++) buf.writeUInt32LE(0xffffffff, 512 + i * 4);
      buf.writeUInt32LE(0xfffffffd, 512);
      buf.writeUInt32LE(0xfffffffe, 516);

      const dir = 1024;
      Buffer.from('Root Entry', 'utf16le').copy(buf, dir);
      buf.writeUInt16LE(22, dir + 64);
      buf[dir + 66] = 5;
      buf.writeUInt32LE(0xffffffff, dir + 68);
      buf.writeUInt32LE(0xffffffff, dir + 72);
      buf.writeUInt32LE(1, dir + 76);

      // Entry 1: WORKBOOK whose right sibling points to unallocated slot 2 (type 0, left=0, right=0)
      const e1 = dir + 128;
      Buffer.from('Workbook', 'utf16le').copy(buf, e1);
      buf.writeUInt16LE(18, e1 + 64);
      buf[e1 + 66] = 2;
      buf.writeUInt32LE(0xffffffff, e1 + 68);
      buf.writeUInt32LE(2, e1 + 72);
      buf.writeUInt32LE(0xffffffff, e1 + 76);

      const parsed = readCompoundFileRoot(buf);
      expect(parsed.status).toBe('read');
      if (parsed.status === 'read') {
        expect(parsed.names.has('WORKBOOK')).toBe(true);
      }
    });

    it('throws EngineUnavailableError before CFBF parsing when soffice binary is unavailable on native-suite pairs', async () => {
      const stubOle = Buffer.concat([Buffer.from(CFBF_MAGIC), Buffer.alloc(504, 0)]);
      for (const [src, tgt] of [
        ['doc', 'rtf'],
        ['doc', 'png'],
        ['pps', 'ppt'],
        ['ppt', 'odp'],
        ['ppt', 'png'],
        ['xls', 'jpg'],
      ] as const) {
        const err = await withMissingBinary('SOFFICE_PATH', () => dispatchConversion(stubOle, src, tgt, {}, `probe.${src}`)).catch((e: unknown) => e);
        expect(err, `${src}->${tgt}`).toBeInstanceOf(EngineUnavailableError);
        expect((err as EngineUnavailableError).engineName, `${src}->${tgt}`).toBe('soffice');
      }
    });
  });
});
