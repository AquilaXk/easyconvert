/**
 * Counts the Redis commands and round trips of the request paths that read per-user data, and times them against a local
 * Redis. The same file runs on any revision (it only calls the public store functions), so a base and a head can be compared:
 *
 *   REDIS_URL=redis://:<password>@127.0.0.1:<port> npx tsx bench/redis-queries.ts [--runs 21] [--only dlq,jobs] [--json]
 *
 * It empties the database it is pointed at, so it refuses anything but a loopback host on a port other than 6379.
 */
import crypto from 'node:crypto';
import Redis from 'ioredis';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};
const RUNS = Number(flag('runs') ?? 21);
const ONLY = flag('only')?.split(',');
const AS_JSON = argv.includes('--json');

const REDIS_URL = process.env.REDIS_URL ?? '';
const target = REDIS_URL ? new URL(REDIS_URL) : undefined;
if (!target || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.port === '' || target.port === '6379') {
  console.error('REDIS_URL must name a loopback Redis on a port other than 6379: this script empties the database.');
  process.exit(2);
}

const DLQ_USERS = 50;
const DLQ_PER_USER = 20;
const GRAPHS = 1000;
const JOBS = 500;
const FILES = 500;
const CREDENTIALS_PER_USER = 4;
const CREDENTIAL_USERS = 50;
const ALL_STATES = ['waiting', 'active', 'completed', 'failed', 'delayed', 'cancelled'] as const;

interface Tally {
  commands: number;
  trips: number;
  byName: Record<string, number>;
}

const tally: Tally = { commands: 0, trips: 0, byName: {} };
const seenStreams = new WeakSet<object>();

/**
 * Counts every command the process sends: one trip per command sent alone and one per pipeline (its commands share a stream).
 * Commands issued together (a Promise.all of reads) each count as a trip, so for a fan-out that column is an upper bound.
 */
function installCounter(): void {
  const proto = Redis.prototype as unknown as { sendCommand: (command: { name: string }, stream?: object, node?: unknown) => unknown };
  const original = proto.sendCommand;
  proto.sendCommand = function counted(this: unknown, command, stream, node) {
    tally.commands += 1;
    tally.byName[command.name] = (tally.byName[command.name] ?? 0) + 1;
    if (stream === undefined) tally.trips += 1;
    else if (!seenStreams.has(stream)) {
      seenStreams.add(stream);
      tally.trips += 1;
    }
    return original.call(this, command, stream, node);
  };
}

function resetTally(): void {
  tally.commands = 0;
  tally.trips = 0;
  tally.byName = {};
}

interface Scenario {
  name: string;
  /** Seeds the data (not measured) and returns the call that is measured. */
  prepare: () => Promise<() => Promise<unknown>>;
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const percentile95 = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * 0.95))];

async function seedDlq(): Promise<string> {
  const { webhookDispatcher } = await import('../src/lib/api-keys/webhook-dispatcher');
  const users = Array.from({ length: DLQ_USERS }, (_, n) => `dlq_user_${n}`);
  const payload = { jobId: 'j', note: 'x'.repeat(1200) };
  for (const user of users) {
    for (let n = 0; n < DLQ_PER_USER; n += 1) {
      const id = `dlq_${user}_${n}`;
      await webhookDispatcher.saveToDlq({
        id,
        originalDeliveryId: `wh_${id}`,
        targetUrl: 'https://93.184.215.14/hooks/easyconvert',
        event: 'job.failed',
        payload,
        secret: 'whsec_bench',
        failedAt: Date.now() - n * 1000,
        finalStatusCode: 500,
        errorMessage: 'Internal Server Error',
        retryCount: 3,
        status: 'failed',
        ownerUserId: user,
      });
    }
  }
  return users[0];
}

async function seedGraphs(user: string): Promise<void> {
  const { graphScheduler } = await import('../src/lib/queue/graph');
  const { sealGraph } = await import('../src/lib/queue/graph/node-jobs');
  const now = Date.now();
  for (let n = 0; n < GRAPHS; n += 1) {
    const graphId = `job_${now - n}_${crypto.randomBytes(4).toString('hex')}`;
    const graph = sealGraph(graphId, {
      nodes: {
        upload: { op: 'import.upload', storageKey: `conversions/${user}/in${n}.csv` },
        convert: { op: 'convert', inputs: ['upload'], targetFormat: 'json' },
      },
    } as never);
    await graphScheduler.initGraph(graphId, graph, { ownerUserId: user, originalFilename: `in${n}.csv`, createdAt: now - n });
  }
}

async function seedJobs(user: string): Promise<void> {
  const { conversionQueue } = await import('../src/lib/queue/conversion-queue');
  const admin = new Redis(REDIS_URL);
  for (let n = 0; n < JOBS; n += 1) {
    const job = await conversionQueue.add('convert', {
      userId: user,
      sourceFormat: 'csv',
      targetFormat: 'json',
      originalFilename: `in${n}.csv`,
      fileSize: 1000 + n,
      options: { note: 'y'.repeat(900) },
    } as never);
    // Most of a user's jobs have ended: only every tenth is still queued.
    if (n % 10 !== 0) {
      const key = (conversionQueue as unknown as { getJobKey: (id: string) => string }).getJobKey(job.id);
      await admin.hset(key, 'state', 'completed', 'finishedOn', String(Date.now()), 'returnvalue', JSON.stringify({ outputKey: `results/${job.id}/out.json`, note: 'z'.repeat(600) }));
    }
  }
  await admin.quit();
}

async function seedCredentials(): Promise<{ user: string; list: (userId: string) => Promise<unknown> }> {
  const { CredentialsVault } = await import('../src/lib/storage/credentials-vault');
  const vault = new CredentialsVault(new Redis(REDIS_URL));
  const users = Array.from({ length: CREDENTIAL_USERS }, (_, n) => `vault_user_${n}`);
  for (const user of users) {
    for (let n = 0; n < CREDENTIALS_PER_USER; n += 1) {
      await vault.store(user, { type: 's3', bucket: `b${n}`, accessKeyId: 'AKIA', secretAccessKey: 'secret'.repeat(8) }, { name: `c${n}` });
    }
  }
  return { user: users[0], list: (userId) => vault.list(userId) };
}

async function seedAccount() {
  const { userStore } = await import('../src/lib/auth/user-store');
  const { redisKeyStore } = await import('../src/lib/api-keys/redis-key-store');
  const { getRetentionLedger } = await import('../src/lib/storage/retention-ledger');
  const { newRecord, resolveRetentionPolicy } = await import('../src/lib/storage/result-retention');
  const user = userStore.sanitizeUser(await userStore.createUser({ email: `bench_${Date.now()}@bench.test`, name: 'bench', tier: 'pro' }));
  const keys: { secretKey: string }[] = [];
  for (let n = 0; n < 3; n += 1) keys.push(await redisKeyStore.generateApiKey(user.id, `key${n}`, { scopes: ['*'] }));
  const ledger = getRetentionLedger();
  const policy = resolveRetentionPolicy();
  for (let n = 0; n < FILES; n += 1) {
    const storageKey = `conversions/${user.id}/out${n}.json`;
    await redisKeyStore.recordUserFile({ userId: user.id, fileName: `out${n}.json`, fromFormat: 'csv', toFormat: 'json', size: 1000, downloadUrl: `/api/storage/file/${encodeURIComponent(storageKey)}`, storageKey });
    await ledger.update(storageKey, () => newRecord(storageKey, Date.now(), policy));
  }
  return { user, secretKey: keys[0].secretKey };
}

function scenarios(): Scenario[] {
  let account: Awaited<ReturnType<typeof seedAccount>> | undefined;
  let jobUser = '';
  const accountOnce = async () => (account ??= await seedAccount());
  return [
    {
      name: 'dlq.list (20 of 1000 entries)',
      prepare: async () => {
        const { webhookDispatcher } = await import('../src/lib/api-keys/webhook-dispatcher');
        const user = await seedDlq();
        return () => webhookDispatcher.getDlqEntries(user);
      },
    },
    {
      name: 'dashboard.snapshot',
      prepare: async () => {
        const { loadDashboardSnapshot } = await import('../src/lib/dashboard/snapshot');
        const { webhookDispatcher } = await import('../src/lib/api-keys/webhook-dispatcher');
        const { user } = await accountOnce();
        for (let n = 0; n < DLQ_PER_USER; n += 1) {
          await webhookDispatcher.saveToDlq({
            id: `dlq_acct_${n}`, originalDeliveryId: `wh_acct_${n}`, targetUrl: 'https://93.184.215.14/h', event: 'job.failed',
            payload: { jobId: 'j', note: 'x'.repeat(1200) }, secret: 's', failedAt: Date.now() - n, retryCount: 3, status: 'failed', ownerUserId: user.id,
          });
        }
        return () => loadDashboardSnapshot(user);
      },
    },
    {
      name: 'account.files (500 files)',
      prepare: async () => {
        const { listAccountFiles } = await import('../src/lib/dashboard/account-files');
        const { user } = await accountOnce();
        return () => listAccountFiles(user.id);
      },
    },
    {
      name: 'jobs.list (1000 graphs, 500 jobs)',
      prepare: async () => {
        const { listVisibleWork } = await import('../src/lib/queue/user-jobs');
        jobUser = `jobs_user_${crypto.randomBytes(3).toString('hex')}`;
        await seedGraphs(jobUser);
        await seedJobs(jobUser);
        return () => listVisibleWork(jobUser, [...ALL_STATES], 50);
      },
    },
    {
      name: 'jobs.list status=active,waiting',
      prepare: async () => {
        const { listVisibleWork } = await import('../src/lib/queue/user-jobs');
        return () => listVisibleWork(jobUser, ['waiting', 'active'], 50);
      },
    },
    {
      name: 'concurrency.check (free submit)',
      prepare: async () => {
        const { conversionQueue } = await import('../src/lib/queue/conversion-queue');
        return () => conversionQueue.getJobsByUser(jobUser, ['waiting', 'active', 'delayed'], 5, 0);
      },
    },
    {
      name: 'credentials.list (200 of 50 users)',
      prepare: async () => {
        const { user, list } = await seedCredentials();
        return () => list(user);
      },
    },
    {
      name: 'apikey.verify',
      prepare: async () => {
        const { redisKeyStore } = await import('../src/lib/api-keys/redis-key-store');
        const { secretKey } = await accountOnce();
        return () => redisKeyStore.verifyApiKey(secretKey);
      },
    },
    {
      name: 'quota.usage',
      prepare: async () => {
        const { redisKeyStore } = await import('../src/lib/api-keys/redis-key-store');
        const { user } = await accountOnce();
        return () => redisKeyStore.getQuotaUsage(user.id);
      },
    },
    {
      name: 'session.check (jti + user)',
      prepare: async () => {
        const { createSessionToken, getSessionFromToken } = await import('../src/lib/auth/session');
        const { user } = await accountOnce();
        const token = createSessionToken(user);
        return () => getSessionFromToken(token);
      },
    },
  ];
}

async function main(): Promise<void> {
  const admin = new Redis(REDIS_URL);
  await admin.flushdb();
  await admin.quit();
  installCounter();
  const rows: { name: string; commands: number; trips: number; medianMs: number; p95Ms: number; byName: Record<string, number> }[] = [];
  for (const scenario of scenarios()) {
    const run = await scenario.prepare();
    if (ONLY && !ONLY.some((part) => scenario.name.startsWith(part))) continue;
    for (let warm = 0; warm < 3; warm += 1) await run();
    resetTally();
    await run();
    const { commands, trips, byName } = { ...tally, byName: { ...tally.byName } };
    const times: number[] = [];
    for (let n = 0; n < RUNS; n += 1) {
      const started = process.hrtime.bigint();
      await run();
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    rows.push({ name: scenario.name, commands, trips, medianMs: median(times), p95Ms: percentile95(times), byName });
  }
  if (AS_JSON) console.log(JSON.stringify(rows));
  else {
    console.log('scenario'.padEnd(38), 'cmds'.padStart(6), 'trips'.padStart(6), 'median ms'.padStart(10), 'p95 ms'.padStart(8));
    for (const row of rows) {
      console.log(row.name.padEnd(38), String(row.commands).padStart(6), String(row.trips).padStart(6), row.medianMs.toFixed(2).padStart(10), row.p95Ms.toFixed(2).padStart(8));
    }
  }
  process.exit(0);
}

void main();
