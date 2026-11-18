#!/usr/bin/env node
/**
 * Opt-in client-side encrypted off-host S3/OCI/R2 replication and retention pruning for Redis RDB snapshots.
 *
 * Design & reference implementations:
 * - Envelope AEAD format (`ECRDB01`): NIST SP 800-38D AES-256-GCM with 32-byte random HKDF-SHA256 salt, 12-byte
 *   random nonce, and 16-byte authentication tag (modeled after Google Tink `AesGcmHkdfStreaming` / `FiloSottile/age`),
 *   binding `ECRDB01:<rdbBasename>:<plaintextSha256>:<plaintextBytes>` as Additional Authenticated Data (AAD) so an
 *   untrusted bucket cannot rename an older backup to bypass the 7-day deletion window (policy #186).
 * - S3 REST API & AWS Signature Version 4: RFC 3986 single-pass URI encoding, signed `x-amz-content-sha256` payload
 *   digest, `ListObjectsV2` pagination with `4 MiB` / `10,000`-entry XML bounds, and DNS-pinned SSRF protection.
 *
 * Zero external npm dependencies: runs directly under Node.js 20+ on the host or inside the web image.
 */
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENVELOPE_MAGIC = Buffer.from('ECRDB01\n', 'ascii');
const SALT_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = ENVELOPE_MAGIC.length + SALT_BYTES + IV_BYTES;
const HKDF_INFO = Buffer.from('easyconvert-redis-rdb-offhost-v1', 'utf8');
const RDB_MAGIC = Buffer.from('REDIS', 'ascii');
const MIN_KEY_BYTES = 32;
const MAX_KEY_BYTES = 4096;
const MAX_LIST_XML_BYTES = 4 * 1024 * 1024;
const MAX_LIST_PAGES = 50;
const MAX_LIST_ENTRIES = 10_000;
const REQUEST_TIMEOUT_MS = 60_000;

const BACKUP_RDB_NAME = /^redis-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.rdb$/;
const BACKUP_ENC_NAME = /^(redis-\d{8}T\d{6}Z\.rdb)\.enc$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const REGION_PATTERN = /^[a-z0-9-]{1,64}$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX_PATTERN = /^[A-Za-z0-9/_-]+$/;
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export class OffhostBackupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OffhostBackupError';
  }
}

/** Parses a `.env` file without shell expansion; existing keys in `baseEnv` take precedence. */
export function loadDotEnvFile(filePath, baseEnv = process.env) {
  const merged = { ...baseEnv };
  if (!filePath || !fs.existsSync(filePath)) return merged;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = rawLine.indexOf('=');
    if (eq <= 0) continue;
    const key = rawLine.slice(0, eq).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    if (merged[key] === undefined || merged[key] === '') {
      merged[key] = rawLine.slice(eq + 1);
    }
  }
  return merged;
}

export function isOffhostBackupEnabled(env = process.env) {
  const raw = (env.REDIS_BACKUP_OFFHOST_ENABLED ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

function validateEncryptionKey(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new OffhostBackupError('REDIS_BACKUP_ENCRYPTION_KEY is required when off-host backup is enabled');
  }
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes < MIN_KEY_BYTES || bytes > MAX_KEY_BYTES) {
    throw new OffhostBackupError(`REDIS_BACKUP_ENCRYPTION_KEY must be between ${MIN_KEY_BYTES} and ${MAX_KEY_BYTES} UTF-8 bytes`);
  }
  return raw;
}

export function parseOffhostConfig(env = process.env) {
  const encryptionKey = validateEncryptionKey(env.REDIS_BACKUP_ENCRYPTION_KEY);
  const endpointRaw = (env.REDIS_BACKUP_S3_ENDPOINT ?? '').trim();
  if (!endpointRaw) throw new OffhostBackupError('REDIS_BACKUP_S3_ENDPOINT is required when off-host backup is enabled');
  let endpointUrl;
  try {
    endpointUrl = new URL(endpointRaw);
  } catch {
    throw new OffhostBackupError('REDIS_BACKUP_S3_ENDPOINT must be a valid URL');
  }
  if (endpointUrl.username || endpointUrl.password) {
    throw new OffhostBackupError('REDIS_BACKUP_S3_ENDPOINT must not contain credentials');
  }
  const allowInsecureLoopback = env.REDIS_BACKUP_ALLOW_INSECURE_HTTP === '1';
  const isLoopbackLiteral = endpointUrl.hostname === '127.0.0.1' || endpointUrl.hostname === '[::1]' || endpointUrl.hostname === '::1';
  if (endpointUrl.protocol !== 'https:' && !(allowInsecureLoopback && endpointUrl.protocol === 'http:' && isLoopbackLiteral)) {
    throw new OffhostBackupError('REDIS_BACKUP_S3_ENDPOINT must use https://');
  }

  const region = (env.REDIS_BACKUP_S3_REGION ?? '').trim();
  if (!REGION_PATTERN.test(region)) {
    throw new OffhostBackupError('REDIS_BACKUP_S3_REGION must match [a-z0-9-]{1,64}');
  }
  const bucket = (env.REDIS_BACKUP_S3_BUCKET ?? '').trim();
  if (!BUCKET_PATTERN.test(bucket)) {
    throw new OffhostBackupError('REDIS_BACKUP_S3_BUCKET must be a valid S3 bucket name');
  }
  const accessKeyId = (env.REDIS_BACKUP_S3_ACCESS_KEY_ID ?? '').trim();
  const secretAccessKey = env.REDIS_BACKUP_S3_SECRET_ACCESS_KEY ?? '';
  if (!accessKeyId || !secretAccessKey) {
    throw new OffhostBackupError('REDIS_BACKUP_S3_ACCESS_KEY_ID and REDIS_BACKUP_S3_SECRET_ACCESS_KEY are required');
  }

  const rawPrefix = (env.REDIS_BACKUP_S3_PREFIX ?? 'redis-backups').trim().replace(/^\/+|\/+$/g, '');
  const prefix = rawPrefix === '' ? 'redis-backups' : rawPrefix;
  if (!PREFIX_PATTERN.test(prefix) || prefix.includes('..')) {
    throw new OffhostBackupError('REDIS_BACKUP_S3_PREFIX must contain only [A-Za-z0-9/_-]');
  }

  return {
    encryptionKey,
    endpointUrl,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    prefix,
    allowLoopback: env.REDIS_BACKUP_ALLOW_LOOPBACK === '1' || (allowInsecureLoopback && isLoopbackLiteral),
  };
}

function buildAad(rdbBasename, plaintextLength) {
  if (!BACKUP_RDB_NAME.test(rdbBasename)) {
    throw new OffhostBackupError(`Invalid Redis backup basename: ${rdbBasename}`);
  }
  return Buffer.from(`ECRDB01:${rdbBasename}:${plaintextLength}`, 'utf8');
}

function deriveAesKey(encryptionKey, salt) {
  const ikm = Buffer.from(encryptionKey, 'utf8');
  try {
    return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, HKDF_INFO, 32));
  } finally {
    ikm.fill(0);
  }
}

export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Encrypts a verified Redis RDB buffer into an `ECRDB01` AES-256-GCM envelope:
 * `[8B magic][32B HKDF salt][12B IV][AES-GCM(32B plaintext SHA-256 || plaintext)][16B GCM auth tag]`,
 * with `ECRDB01:<rdbBasename>:<plaintextBytes>` bound as AAD so neither the plaintext digest leaks in headers nor can an
 * older object be renamed to bypass the 7-day deletion window.
 */
export function sealRdbEnvelope(plaintext, rdbBasename, encryptionKey, expectedSha256) {
  validateEncryptionKey(encryptionKey);
  if (!Buffer.isBuffer(plaintext) || plaintext.length < RDB_MAGIC.length) {
    throw new OffhostBackupError('Plaintext RDB buffer is empty or truncated');
  }
  if (!plaintext.subarray(0, RDB_MAGIC.length).equals(RDB_MAGIC)) {
    throw new OffhostBackupError('Plaintext RDB buffer does not begin with REDIS magic');
  }
  const actualSha256 = sha256Hex(plaintext);
  if (expectedSha256 !== undefined) {
    const normalizedExpected = expectedSha256.toLowerCase();
    if (!SHA256_HEX.test(normalizedExpected) || actualSha256 !== normalizedExpected) {
      throw new OffhostBackupError('Plaintext RDB SHA-256 does not match expected digest');
    }
  }
  const digestBytes = Buffer.from(actualSha256, 'hex');
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = deriveAesKey(encryptionKey, salt);
  try {
    const aad = buildAad(rdbBasename, plaintext.length);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(digestBytes), cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      envelope: Buffer.concat([ENVELOPE_MAGIC, salt, iv, encrypted, tag]),
      plaintextSha256: actualSha256,
    };
  } finally {
    key.fill(0);
  }
}

export function openRdbEnvelope(envelope, rdbBasename, encryptionKey, expectedSha256) {
  validateEncryptionKey(encryptionKey);
  const minBytes = HEADER_BYTES + 32 + RDB_MAGIC.length + TAG_BYTES;
  if (!Buffer.isBuffer(envelope) || envelope.length < minBytes) {
    throw new OffhostBackupError('Encrypted RDB envelope is truncated');
  }
  if (!envelope.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)) {
    throw new OffhostBackupError('Encrypted RDB envelope has an invalid magic header');
  }
  const salt = envelope.subarray(ENVELOPE_MAGIC.length, ENVELOPE_MAGIC.length + SALT_BYTES);
  const iv = envelope.subarray(ENVELOPE_MAGIC.length + SALT_BYTES, HEADER_BYTES);
  const ciphertext = envelope.subarray(HEADER_BYTES, envelope.length - TAG_BYTES);
  const plaintextLength = ciphertext.length - 32;
  const tag = envelope.subarray(envelope.length - TAG_BYTES);
  const key = deriveAesKey(encryptionKey, salt);
  let inner;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(buildAad(rdbBasename, plaintextLength));
    decipher.setAuthTag(tag);
    inner = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new OffhostBackupError('Encrypted RDB authentication failed (wrong key, tampered bytes, or renamed object)');
  } finally {
    key.fill(0);
  }
  const embeddedSha256 = inner.subarray(0, 32).toString('hex');
  const plaintext = inner.subarray(32);
  if (expectedSha256 !== undefined && embeddedSha256 !== expectedSha256.toLowerCase()) {
    throw new OffhostBackupError('Encrypted RDB envelope SHA-256 does not match expected digest');
  }
  if (!plaintext.subarray(0, RDB_MAGIC.length).equals(RDB_MAGIC)) {
    throw new OffhostBackupError('Decrypted RDB payload does not start with REDIS magic');
  }
  const computedSha256 = sha256Hex(plaintext);
  if (computedSha256 !== embeddedSha256) {
    throw new OffhostBackupError('Decrypted RDB payload failed SHA-256 integrity check');
  }
  return { plaintext, plaintextSha256: computedSha256 };
}

function isDisallowedIp(address, allowLoopback) {
  const normalized = address.replace(/^\[|\]$/g, '');
  if (net.isIPv4(normalized)) {
    const parts = normalized.split('.').map(Number);
    const [a, b] = parts;
    if (a === 127) return !allowLoopback;
    if (a === 0 || a === 10 || a === 169 && b === 254 || a >= 224) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (net.isIPv6(normalized)) {
    const lower = normalized.toLowerCase();
    if (lower === '::1') return !allowLoopback;
    if (lower === '::' || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('ff')) return true;
    if (lower.startsWith('::ffff:')) {
      const tail = lower.slice(7);
      if (net.isIPv4(tail)) return isDisallowedIp(tail, allowLoopback);
      return true;
    }
    return false;
  }
  return true;
}

async function resolveSafeEndpointIp(hostname, allowLoopback) {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(bare) !== 0) {
    if (isDisallowedIp(bare, allowLoopback)) {
      throw new OffhostBackupError(`Refusing private, link-local, or loopback S3 endpoint address: ${bare}`);
    }
    return { address: bare, family: net.isIPv6(bare) ? 6 : 4 };
  }
  const records = await dns.promises.lookup(bare, { all: true, verbatim: true });
  if (records.length === 0) {
    throw new OffhostBackupError(`Could not resolve S3 endpoint host: ${bare}`);
  }
  for (const rec of records) {
    if (isDisallowedIp(rec.address, allowLoopback)) {
      throw new OffhostBackupError(`Refusing S3 endpoint resolving to non-public IP (${bare})`);
    }
  }
  return { address: records[0].address, family: records[0].family };
}

function uriEncode(str, encodeSlash = true) {
  let out = '';
  for (const byte of Buffer.from(str, 'utf8')) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9_.~-]/.test(ch) || (!encodeSlash && ch === '/')) {
      out += ch;
    } else {
      out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function formatAmzDate(date) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function signS3Request(config, method, rawPath, queryPairs, payloadHash, extraHeaders = {}, now = new Date()) {
  const { amzDate, dateStamp } = formatAmzDate(now);
  const hostHeader = config.endpointUrl.host;
  const canonicalUri = uriEncode(rawPath, false);
  const sortedQuery = [...queryPairs]
    .map(([k, v]) => [uriEncode(k, true), uriEncode(v, true)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const canonicalQuery = sortedQuery.map(([k, v]) => `${k}=${v}`).join('&');

  const headersToSign = {
    host: hostHeader,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
  };
  const signedHeaderNames = Object.keys(headersToSign).sort();
  const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${headersToSign[k]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(Buffer.from(canonicalRequest, 'utf8'))].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return {
    pathWithQuery: canonicalQuery ? `${canonicalUri}?${canonicalQuery}` : canonicalUri,
    headers: {
      ...headersToSign,
      authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

async function sendS3Request(config, method, objectKey, { query = [], body = Buffer.alloc(0), headers = {}, maxResponseBytes = MAX_LIST_XML_BYTES } = {}) {
  const basePath = config.endpointUrl.pathname.replace(/\/+$/, '');
  const rawPath = objectKey
    ? `${basePath}/${config.bucket}/${objectKey}`
    : `${basePath}/${config.bucket}`;
  const payloadHash = body.length === 0 ? EMPTY_SHA256 : sha256Hex(body);
  const extraHeaders = body.length > 0 ? { 'content-length': String(body.length), ...headers } : headers;
  const signed = signS3Request(config, method, rawPath, query, payloadHash, extraHeaders);
  const pinned = await resolveSafeEndpointIp(config.endpointUrl.hostname, config.allowLoopback);
  const transport = config.endpointUrl.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: config.endpointUrl.protocol,
        hostname: config.endpointUrl.hostname.replace(/^\[|\]$/g, ''),
        port: config.endpointUrl.port || (config.endpointUrl.protocol === 'https:' ? 443 : 80),
        method,
        path: signed.pathWithQuery,
        headers: signed.headers,
        servername: net.isIP(config.endpointUrl.hostname.replace(/^\[|\]$/g, '')) === 0 ? config.endpointUrl.hostname : undefined,
        timeout: REQUEST_TIMEOUT_MS,
        lookup: (_host, opts, cb) => {
          const all = typeof opts === 'object' && opts !== null && opts.all === true;
          const callback = typeof opts === 'function' ? opts : cb;
          if (all) callback(null, [{ address: pinned.address, family: pinned.family }]);
          else callback(null, pinned.address, pinned.family);
        },
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxResponseBytes) {
            req.destroy(new OffhostBackupError(`S3 response exceeded ${maxResponseBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const responseBody = Buffer.concat(chunks);
          if (status < 200 || status >= 300) {
            reject(new OffhostBackupError(`S3 ${method} failed with HTTP ${status}`));
            return;
          }
          resolve({ status, body: responseBody });
        });
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new OffhostBackupError(`S3 ${method} timed out after ${REQUEST_TIMEOUT_MS}ms`)));
    req.on('error', reject);
    if (body.length > 0) req.write(body);
    req.end();
  });
}

function decodeXmlEntities(str) {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function parseListObjectsV2Xml(xmlText) {
  if (xmlText.length > MAX_LIST_XML_BYTES) {
    throw new OffhostBackupError('ListObjectsV2 XML exceeded maximum allowed size');
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xmlText)) {
    throw new OffhostBackupError('ListObjectsV2 XML contains forbidden DTD/ENTITY declarations');
  }
  const items = [];
  const contentsRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match;
  while ((match = contentsRegex.exec(xmlText)) !== null) {
    if (items.length >= MAX_LIST_ENTRIES) {
      throw new OffhostBackupError('ListObjectsV2 XML exceeded maximum entry count');
    }
    const block = match[1];
    const keyMatch = /<Key>([\s\S]*?)<\/Key>/.exec(block);
    const modMatch = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block);
    if (!keyMatch) continue;
    items.push({
      key: decodeXmlEntities(keyMatch[1].trim()),
      lastModifiedMs: modMatch ? Date.parse(decodeXmlEntities(modMatch[1].trim())) : Number.NaN,
    });
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xmlText);
  const tokenMatch = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xmlText);
  return {
    items,
    isTruncated: truncated,
    nextContinuationToken: tokenMatch ? decodeXmlEntities(tokenMatch[1].trim()) : undefined,
  };
}

export function parseBackupTimestampMs(rdbBasename) {
  const m = BACKUP_RDB_NAME.exec(rdbBasename);
  if (!m) return Number.NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

export async function listRemoteBackups(config) {
  const prefix = `${config.prefix}/redis-`;
  const results = [];
  let token;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const query = [
      ['list-type', '2'],
      ['prefix', prefix],
    ];
    if (token !== undefined) query.push(['continuation-token', token]);
    const res = await sendS3Request(config, 'GET', '', { query });
    const parsed = parseListObjectsV2Xml(res.body.toString('utf8'));
    for (const item of parsed.items) {
      if (!item.key.startsWith(`${config.prefix}/`)) continue;
      const basename = item.key.slice(config.prefix.length + 1);
      const encMatch = BACKUP_ENC_NAME.exec(basename);
      if (!encMatch) continue;
      const rdbName = encMatch[1];
      const stampMs = parseBackupTimestampMs(rdbName);
      if (!Number.isFinite(stampMs)) continue;
      results.push({
        key: item.key,
        rdbName,
        stampMs,
        lastModifiedMs: item.lastModifiedMs,
      });
    }
    if (!parsed.isTruncated || !parsed.nextContinuationToken) {
      results.sort((a, b) => a.rdbName.localeCompare(b.rdbName));
      return results;
    }
    token = parsed.nextContinuationToken;
  }
  throw new OffhostBackupError(`ListObjectsV2 pagination exceeded ${MAX_LIST_PAGES} pages; refusing incomplete retention listing`);
}

export async function pushEncryptedBackup(config, localRdbPath, expectedSha256) {
  const rdbBasename = path.basename(localRdbPath);
  if (!BACKUP_RDB_NAME.test(rdbBasename)) {
    throw new OffhostBackupError(`Local RDB file name must match redis-YYYYMMDDTHHMMSSZ.rdb: ${rdbBasename}`);
  }
  const plaintext = fs.readFileSync(localRdbPath);
  const { envelope, plaintextSha256 } = sealRdbEnvelope(plaintext, rdbBasename, config.encryptionKey, expectedSha256);
  const objectKey = `${config.prefix}/${rdbBasename}.enc`;
  await sendS3Request(config, 'PUT', objectKey, {
    body: envelope,
    headers: { 'content-type': 'application/octet-stream' },
  });
  return { objectKey, bytes: envelope.length, plaintextSha256 };
}

export async function pruneRemoteByAge(config, maxAgeDays, nowMs = Date.now()) {
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1) {
    throw new OffhostBackupError('BACKUP_MAX_AGE_DAYS must be an integer >= 1');
  }
  const cutoffMs = nowMs - maxAgeDays * 86_400_000;
  const backups = await listRemoteBackups(config);
  const removed = [];
  for (const item of backups) {
    const oldestKnownMs = Number.isFinite(item.lastModifiedMs) ? Math.min(item.stampMs, item.lastModifiedMs) : item.stampMs;
    if (oldestKnownMs < cutoffMs) {
      await sendS3Request(config, 'DELETE', item.key);
      removed.push(item.key);
    }
  }
  return removed;
}

export async function pruneRemoteByCount(config, keepCount) {
  if (!Number.isInteger(keepCount) || keepCount < 1) {
    throw new OffhostBackupError('BACKUP_KEEP must be an integer >= 1');
  }
  const backups = await listRemoteBackups(config);
  if (backups.length <= keepCount) return [];
  const excess = backups.slice(0, backups.length - keepCount);
  const removed = [];
  for (const item of excess) {
    await sendS3Request(config, 'DELETE', item.key);
    removed.push(item.key);
  }
  return removed;
}

export async function pullEncryptedBackup(config, rdbBasename, destRdbPath, expectedSha256) {
  if (!BACKUP_RDB_NAME.test(rdbBasename)) {
    throw new OffhostBackupError(`Backup name must match redis-YYYYMMDDTHHMMSSZ.rdb: ${rdbBasename}`);
  }
  const objectKey = `${config.prefix}/${rdbBasename}.enc`;
  const maxBytes = 4 * 1024 * 1024 * 1024;
  const res = await sendS3Request(config, 'GET', objectKey, { maxResponseBytes: maxBytes });
  const { plaintext, plaintextSha256 } = openRdbEnvelope(res.body, rdbBasename, config.encryptionKey, expectedSha256);
  const dir = path.dirname(destRdbPath);
  const partPath = path.join(dir, `.pull-${process.pid}-${Date.now()}.part`);
  fs.writeFileSync(partPath, plaintext, { mode: 0o600 });
  fs.writeFileSync(`${destRdbPath}.sha256`, `${plaintextSha256}  ${rdbBasename}\n`, { mode: 0o600 });
  fs.renameSync(partPath, destRdbPath);
  return { destRdbPath, bytes: plaintext.length, plaintextSha256 };
}

async function runCli(argv) {
  const args = [...argv];
  let envFile;
  if (args[0] === '--env-file') {
    envFile = args[1];
    args.splice(0, 2);
  }
  const env = loadDotEnvFile(envFile, process.env);
  const command = args[0];
  if (command === 'is-enabled') {
    process.stdout.write(isOffhostBackupEnabled(env) ? 'true\n' : 'false\n');
    return;
  }
  if (!isOffhostBackupEnabled(env) && command !== 'pull') {
    return;
  }
  const config = parseOffhostConfig(env);
  if (command === 'push') {
    const [, localPath, expectedSha256] = args;
    if (!localPath) throw new OffhostBackupError('usage: redis-backup-offhost.mjs push <local-rdb-path> [expected-sha256]');
    const out = await pushEncryptedBackup(config, localPath, expectedSha256);
    process.stderr.write(`[redis-backup] offhost ok: ${out.objectKey}, ${out.bytes} encrypted bytes\n`);
    return;
  }
  if (command === 'prune-age') {
    const days = Number(args[1]);
    const removed = await pruneRemoteByAge(config, days);
    for (const key of removed) process.stderr.write(`[redis-backup] offhost removed ${key} (older than ${days} days)\n`);
    return;
  }
  if (command === 'prune-count') {
    const keep = Number(args[1]);
    const removed = await pruneRemoteByCount(config, keep);
    for (const key of removed) process.stderr.write(`[redis-backup] offhost removed ${key} (more than ${keep} kept)\n`);
    return;
  }
  if (command === 'pull') {
    const [, rdbBasename, destPath, expectedSha256] = args;
    if (!rdbBasename || !destPath) throw new OffhostBackupError('usage: redis-backup-offhost.mjs pull <redis-YYYYMMDDTHHMMSSZ.rdb> <dest-path> [expected-sha256]');
    const out = await pullEncryptedBackup(config, rdbBasename, destPath, expectedSha256);
    process.stderr.write(`[redis-backup] offhost pull ok: ${out.destRdbPath}, ${out.bytes} bytes, sha256 ${out.plaintextSha256}\n`);
    return;
  }
  if (command === 'list') {
    const items = await listRemoteBackups(config);
    for (const item of items) process.stdout.write(`${item.key}\n`);
    return;
  }
  throw new OffhostBackupError('usage: redis-backup-offhost.mjs [--env-file <path>] <push|prune-age|prune-count|pull|list>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runCli(process.argv.slice(2)).catch((err) => {
    const msg = err instanceof OffhostBackupError ? err.message : (err instanceof Error ? err.message : 'unexpected off-host backup failure');
    process.stderr.write(`[redis-backup] ERROR: ${msg}\n`);
    process.exit(1);
  });
}
