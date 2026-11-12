import crypto from 'node:crypto';
import dns, { type LookupAddress } from 'node:dns';
import net from 'node:net';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as createJob } from '../src/app/api/v1/jobs/route';
import { GET as readJob } from '../src/app/api/v1/jobs/[id]/route';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { graphScheduler } from '../src/lib/queue/graph';
import { Worker } from '../src/lib/queue/bullmq-engine';
import { allConversionQueues, attachJobLifecycleListeners } from '../src/lib/queue/conversion-queue';
import { processNodeJob } from '../src/lib/queue/node-processor';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { graphNodeCharge, graphReservationUnits } from '../src/lib/jobs/graph-operations';
import { validateJobGraph } from '../src/lib/jobs';
import { NAMED_TASK_OPERATIONS, publicOperationName } from '../src/lib/jobs/named-tasks';
import { resolveNodeResourceClass } from '../src/lib/queue/resource-class';
import { findSealedSecretProblems } from '../src/lib/queue/graph/sealed-nodes';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import { runWithoutFileConfinement } from './helpers/unconfined-files';
import { skipUnless } from './helpers/strict-skip';

/**
 * The website capture as a task of the jobs API: named `capture/website` in a named-task job and `capture.website` in a graph. It takes
 * no input and no upload, counts as one conversion, keeps its URL sealed, refuses an address that cannot be captured before a unit is
 * reserved, and runs through the worker with a Python stand-in for the browser driver.
 */

runWithoutFileConfinement();

const WAIT = { timeout: 20_000, interval: 50 };
const PUBLIC = [{ address: '93.184.216.34', family: 4 }] as LookupAddress[];
const PYTHON = ['/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3'].find((candidate) => existsSync(candidate));
const STAND_IN = `
import json, sys
request = json.load(open(sys.argv[1]))
out = sys.argv[1].rsplit('/', 1)[0] + '/' + request['output']
body = {'pdf': b'%PDF-1.7 captured ', 'png': b'\\x89PNG\\r\\n\\x1a\\n captured ', 'jpg': b'\\xff\\xd8\\xff captured '}[request['format']]
open(out, 'wb').write(body + request['url'].encode())
sys.stdout.write(json.dumps({'ok': True, 'output': request['output'], 'finalUrl': request['url'], 'title': 'T', 'blocked': []}) + '\\n')
`;

let dir = '';
let worker: Worker<ConversionJobData, ConversionJobResult> | undefined;

beforeAll(() => {
  skipUnless('a Python 3 interpreter for the stand-in driver', PYTHON !== undefined);
  dir = mkdtempSync(path.join(os.tmpdir(), 'easyconvert-capture-task-'));
  writeFileSync(path.join(dir, 'capture.py'), STAND_IN);
  chmodSync(path.join(dir, 'capture.py'), 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

afterEach(async () => {
  await worker?.close();
  worker = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function standIn(): void {
  const realLookup = dns.lookup;
  vi.spyOn(dns, 'lookup').mockImplementation(((name: string, options: unknown, callback: (error: NodeJS.ErrnoException | null, list: LookupAddress[]) => void) => {
    if (net.isIP(name) !== 0) return (realLookup as (...args: unknown[]) => void)(name, options, callback);
    process.nextTick(() => callback(null, PUBLIC));
  }) as never);
  vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => PUBLIC) as never);
  vi.stubEnv('CAPTURE_PYTHON_PATH', PYTHON as string);
  vi.stubEnv('CAPTURE_DRIVER_PATH', path.join(dir, 'capture.py'));
}

async function caller() {
  const user = userStore.sanitizeUser(await userStore.createUser({ email: `capture-${Date.now()}-${crypto.randomBytes(4).toString('hex')}@capture.test`, name: 'Capture', tier: 'pro' }));
  const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'capture', { scopes: ['convert:write', 'convert:read'] });
  return { authorization: `Bearer ${secretKey}`, usedToday: async () => (await redisKeyStore.getQuotaUsage(user.id)).usedToday };
}

function post(authorization: string, body: Record<string, unknown>): Promise<Response> {
  return createJob(new NextRequest('http://localhost/api/v1/jobs', { method: 'POST', headers: { 'content-type': 'application/json', authorization }, body: JSON.stringify(body) }));
}

describe('the capture task in the graph engine', () => {
  it('takes no input, counts as one conversion, runs on the memory class, and is spelled capture/website by a named task', () => {
    expect(NAMED_TASK_OPERATIONS).toContain('capture/website');
    expect(publicOperationName('capture.website')).toBe('capture/website');
    expect(graphNodeCharge('capture.website', { outputs: 1, optimizations: [] })).toBe(1);
    expect(graphNodeCharge('capture.website', { outputs: 0, optimizations: [] })).toBe(0);
    expect(graphReservationUnits({ shot: { op: 'capture.website' }, out: { op: 'export.internal', input: 'shot' } })).toBe(1);
    expect(resolveNodeResourceClass({ op: 'capture.website', targetFormat: 'png' })).toBe('memory');
  });

  it('is a source of the graph: no import node is needed, and it takes no input', () => {
    const graph = { nodes: { shot: { op: 'capture.website', url: 'https://site.example/', targetFormat: 'pdf' }, out: { op: 'export.internal', input: 'shot' } } };
    expect(validateJobGraph(graph).valid).toBe(true);
    const withInput = { nodes: { up: { op: 'import.upload', storageKey: 'uploads/u/a.pdf' }, ...graph.nodes, shot: { ...graph.nodes.shot, input: 'up' } } };
    expect(validateJobGraph(withInput).errors.map((error) => error.code)).toContain('IMPORT_NODE_HAS_INPUT');
  });

  it.each([
    ['no format', { op: 'capture.website', url: 'https://site.example/' }, 'targetFormat'],
    ['a format a page is not captured as', { op: 'capture.website', url: 'https://site.example/', targetFormat: 'gif' }, 'targetFormat'],
    ['no url', { op: 'capture.website', targetFormat: 'png' }, 'url'],
    ['a file URL', { op: 'capture.website', url: 'file:///etc/passwd', targetFormat: 'png' }, 'url'],
    ['credentials in the URL', { op: 'capture.website', url: 'https://u:p@site.example/', targetFormat: 'png' }, 'url'],
    ['a port outside the web', { op: 'capture.website', url: 'http://site.example:6379/', targetFormat: 'png' }, 'url'],
  ])('refuses %s at validation, naming the node', (_what, node, field) => {
    const result = validateJobGraph({ nodes: { shot: node, out: { op: 'export.internal', input: 'shot' } } });
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.path.startsWith('nodes.shot') && error.path.includes(field))).toBe(true);
  });

  it('seals the URL like an import of a URL: a token in the address is never stored in the clear', () => {
    expect(findSealedSecretProblems({ op: 'capture.website', url: 'https://site.example/?t=1'.padEnd(9000, 'x') }).map((problem) => problem.path)).toEqual(['url']);
    expect(findSealedSecretProblems({ op: 'capture/website', url: 'https://site.example/' })).toEqual([]);
  });
});

describe.skipIf(skipUnless('a Python 3 interpreter for the stand-in driver', PYTHON !== undefined))('the capture task through the jobs API', () => {
  it('runs a named capture/website task with no upload, stores its URL sealed, charges one unit, and keeps the page for download', async () => {
    standIn();
    worker = new Worker<ConversionJobData, ConversionJobResult>([...allConversionQueues] as never, (job) => processNodeJob(job), { concurrency: 2 });
    attachJobLifecycleListeners(worker);
    const who = await caller();
    const tasks = {
      shot: { operation: 'capture/website', url: 'https://news.example/today?token=s3cret', output_format: 'pdf', options: { capture: { pdf: { paper: 'A4', landscape: true }, timeoutMs: 20000 } } },
      out: { operation: 'export/url', input: 'shot' },
    };
    const accepted = await post(who.authorization, { tasks });
    expect(accepted.status, await accepted.clone().text()).toBe(202);
    const created = await accepted.json();
    expect(created.tasks.shot).toMatchObject({ operation: 'capture/website' });

    const node = (await graphScheduler.getGraphState(created.jobId))?.graph.nodes.shot as unknown as Record<string, unknown>;
    expect(node).toMatchObject({ op: 'capture.website', targetFormat: 'pdf' });
    expect(node.url).toBeUndefined();
    expect(JSON.stringify(node)).not.toContain('s3cret');
    expect(typeof node.sealed).toBe('string');

    await vi.waitFor(async () => expect(['completed', 'failed']).toContain((await graphScheduler.getGraphState(created.jobId))?.status), WAIT);
    const read = await readJob(new NextRequest(`http://localhost/api/v1/jobs/${created.jobId}`, { headers: { authorization: who.authorization } }), { params: Promise.resolve({ id: created.jobId }) });
    const body = await read.json();
    expect(body.status, JSON.stringify(body)).toBe('completed');
    const [file] = body.tasks.out.result.files as Array<{ filename: string; downloadUrl: string }>;
    expect(file.filename).toBe('news.example-today.pdf');
    const stored = s3Storage.getObject(decodeURIComponent(file.downloadUrl.slice('/api/storage/file/'.length)));
    expect(stored?.buffer.toString('latin1')).toBe('%PDF-1.7 captured https://news.example/today?token=s3cret');
    await vi.waitFor(async () => expect(await who.usedToday()).toBe(1), WAIT);
  }, 40_000);

  it('accepts the capture node of a graph the same way, and refuses an address that cannot be captured before a unit is reserved', async () => {
    standIn();
    const who = await caller();
    const initGraph = vi.spyOn(graphScheduler, 'initGraph');
    const refused = await post(who.authorization, { graph: { nodes: { shot: { op: 'capture.website', url: 'ftp://files.example/', targetFormat: 'png' }, out: { op: 'export.internal', input: 'shot' } } } });
    expect(refused.status).toBe(422);
    expect((await refused.json()).invalidParams[0].name).toBe('nodes.shot.url');
    const namedRefused = await post(who.authorization, { tasks: { shot: { operation: 'capture/website', output_format: 'png' }, out: { operation: 'export/url', input: 'shot' } } });
    expect(namedRefused.status).toBe(422);
    expect(initGraph).not.toHaveBeenCalled();
    expect(await who.usedToday()).toBe(0);
    const accepted = await post(who.authorization, { graph: { nodes: { shot: { op: 'capture.website', url: 'https://site.example/', targetFormat: 'jpg' }, out: { op: 'export.internal', input: 'shot' } } } });
    expect(accepted.status, await accepted.clone().text()).toBeLessThan(300);
    expect(initGraph).toHaveBeenCalledTimes(1);
  });
});
