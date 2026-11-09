import zlib from 'node:zlib';
import type Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as extractRoute } from '../src/app/api/tools/archive-extract/route';
import { create7zArchiveAsync, createTarArchive } from '../src/lib/conversions';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { anonymousUserId } from '../src/lib/auth/anonymous-identity';
import { ANONYMOUS_DAILY_CONVERSIONS } from '../src/lib/plan-limits';
import { MAX_EXTRACTED_BYTES } from '../src/lib/tools/tool-names';

/**
 * The web extraction counts the bytes it inflates against its own cap, not the sizes an archive claims, and stops there:
 * the 500 MiB of the job graph is not what an anonymous request may hold in memory.
 */

const MIB = 1024 * 1024;
/** A rough check of the peak, far above what the cap needs and far below the 500 MiB of the graph path: not a measurement. */
const MEMORY_GROWTH_CEILING_BYTES = 250 * MIB;
let nextClient = 1;

/** A deflate stream of `megabytes` MiB of zeros and its CRC-32, written in chunks so that the test itself holds little. */
async function deflatedZerosAsync(megabytes: number): Promise<{ data: Buffer; crc: number }> {
  const chunk = Buffer.alloc(MIB);
  const deflate = zlib.createDeflateRaw();
  const parts: Buffer[] = [];
  deflate.on('data', (part: Buffer) => parts.push(part));
  const ended = new Promise<void>((resolve) => deflate.on('end', resolve));
  let crc = 0;
  for (let i = 0; i < megabytes; i++) {
    crc = zlib.crc32(chunk, crc);
    if (!deflate.write(chunk)) await new Promise((resolve) => deflate.once('drain', resolve));
  }
  deflate.end();
  await ended;
  return { data: Buffer.concat(parts), crc };
}

/** A ZIP of one deflated entry whose headers claim `claimedBytes` of data, whatever the stream holds. */
function zipClaiming(entry: { data: Buffer; crc: number }, claimedBytes: number): Buffer {
  const name = Buffer.from('zeros.bin');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(entry.crc, 14);
  local.writeUInt32LE(entry.data.length, 18);
  local.writeUInt32LE(claimedBytes, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(entry.crc, 16);
  central.writeUInt32LE(entry.data.length, 20);
  central.writeUInt32LE(claimedBytes, 24);
  central.writeUInt16LE(name.length, 28);
  const localPart = Buffer.concat([local, name, entry.data]);
  const centralPart = Buffer.concat([central, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, end]);
}

function extract(ip: string, name: string, content: Buffer) {
  const form = new FormData();
  form.append('files', new File([new Uint8Array(content)], name));
  return extractRoute(new NextRequest('http://localhost/api/tools/archive-extract', { method: 'POST', headers: { 'x-forwarded-for': ip }, body: form }));
}

let redisClients: { keys: Redis | null; users: Redis | null };

beforeEach(() => {
  redisClients = { keys: redisKeyStore.getRedisClient(), users: redisUserStore.getRedisClient() };
  redisKeyStore.setRedisClient(null);
  redisUserStore.setRedisClient(null);
  vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
  vi.stubEnv('ANONYMOUS_DAILY_LIMIT', String(ANONYMOUS_DAILY_CONVERSIONS));
  redisKeyStore.resetStore();
});

afterEach(() => {
  vi.unstubAllEnvs();
  redisKeyStore.setRedisClient(redisClients.keys);
  redisUserStore.setRedisClient(redisClients.users);
});

describe('what the web extraction inflates', () => {
  it('refuses a ZIP whose headers understate its data, without inflating past what they claim', async () => {
    const ip = `203.0.113.${nextClient++}`;
    const before = (await redisKeyStore.getQuotaUsage(anonymousUserId(ip))).remaining;
    const zip = zipClaiming(await deflatedZerosAsync(200), 1024);
    expect(zip.length).toBeLessThan(2 * MIB);
    const rss = process.memoryUsage().rss;

    const res = await extract(ip, 'lying.zip', zip);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(process.memoryUsage().rss - rss).toBeLessThan(MEMORY_GROWTH_CEILING_BYTES);
    expect((await redisKeyStore.getQuotaUsage(anonymousUserId(ip))).remaining).toBe(before);
  }, 60_000);

  it('stops a gzipped TAR as it inflates past the cap, answering 413 and giving the conversion back', async () => {
    const ip = `203.0.113.${nextClient++}`;
    const before = (await redisKeyStore.getQuotaUsage(anonymousUserId(ip))).remaining;
    const zeros = await new Promise<Buffer>((resolve, reject) => {
      const gzip = zlib.createGzip();
      const parts: Buffer[] = [];
      gzip.on('data', (part: Buffer) => parts.push(part));
      gzip.on('end', () => resolve(Buffer.concat(parts)));
      gzip.on('error', reject);
      for (let i = 0; i < 200; i++) gzip.write(Buffer.alloc(MIB));
      gzip.end();
    });
    const rss = process.memoryUsage().rss;

    const res = await extract(ip, 'bomb.tar.gz', zeros);

    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('input_over_limit');
    expect(process.memoryUsage().rss - rss).toBeLessThan(MEMORY_GROWTH_CEILING_BYTES);
    expect((await redisKeyStore.getQuotaUsage(anonymousUserId(ip))).remaining).toBe(before);
  }, 60_000);

  it('stops a TAR whose entries together pass the cap', async () => {
    const ip = `203.0.113.${nextClient++}`;
    const tar = createTarArchive([{ filename: 'a.bin', buffer: Buffer.alloc(MAX_EXTRACTED_BYTES / 2 + MIB) }, { filename: 'b.bin', buffer: Buffer.alloc(MAX_EXTRACTED_BYTES / 2 + MIB) }]).buffer;
    const res = await extract(ip, 'two.tar', tar);
    expect(res.status).toBe(413);
  });

  it('stops a 7Z that unpacks past the cap', async () => {
    const ip = `203.0.113.${nextClient++}`;
    const sevenZip = (await create7zArchiveAsync([{ filename: 'zeros.bin', buffer: Buffer.alloc(MAX_EXTRACTED_BYTES + 2 * MIB) }])).buffer;
    const res = await extract(ip, 'big.7z', sevenZip);
    expect(res.status).toBe(413);
  }, 60_000);

  it('lists an archive within the cap', async () => {
    const ip = `203.0.113.${nextClient++}`;
    const small = await deflatedZerosAsync(1);
    const res = await extract(ip, 'small.zip', zipClaiming(small, MIB));
    expect(res.status).toBe(200);
    expect((await res.json()).entries).toMatchObject([{ name: 'zeros.bin', size: MIB }]);
  });
});
