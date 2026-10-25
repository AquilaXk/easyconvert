import dns from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SpawnCall = {
  command: string;
  args: string[];
  options: { env: NodeJS.ProcessEnv; timeout?: number; shell?: boolean };
  stdin: string;
  keyDirMode?: number;
  keyFileMode?: number;
  keyContent?: string;
  keyPath?: string;
};

type ChildBehavior = 'ok' | 'exit-1' | 'spawn-error' | 'spawn-throws' | 'killed-by-timeout';

const mocks = vi.hoisted(() => ({
  calls: [] as SpawnCall[],
  behavior: { current: 'ok' as ChildBehavior },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const fs = await import('node:fs');
  const nodePath = await import('node:path');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const spawn = (command: string, args: string[], options: SpawnCall['options']) => {
    const call: SpawnCall = { command, args, options, stdin: '' };
    const identityIndex = args.indexOf('-i');
    if (identityIndex !== -1) {
      const keyPath = args[identityIndex + 1];
      call.keyPath = keyPath;
      call.keyDirMode = fs.statSync(nodePath.dirname(keyPath)).mode & 0o777;
      call.keyFileMode = fs.statSync(keyPath).mode & 0o777;
      call.keyContent = fs.readFileSync(keyPath, 'utf8');
    }
    mocks.calls.push(call);
    if (mocks.behavior.current === 'spawn-throws') throw new Error('spawn EACCES');
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    child.stdin.on('data', (chunk: Buffer) => {
      call.stdin += chunk.toString();
    });
    if (mocks.behavior.current === 'spawn-error') {
      setImmediate(() => {
        child.emit('error', new Error('spawn sftp ENOENT'));
        child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      });
    } else {
      child.stdin.on('end', () => {
        setImmediate(() => {
          if (mocks.behavior.current === 'killed-by-timeout') child.emit('close', null, 'SIGTERM');
          else if (mocks.behavior.current === 'exit-1') {
            child.stderr.write('Connection closed');
            child.emit('close', 1, null);
          } else child.emit('close', 0, null);
        });
      });
    }
    return child;
  };
  return { ...actual, spawn, default: { ...actual, spawn } };
});

import { SftpStorageAdapter } from '../src/lib/storage/adapters/sftp';
import { StorageInputError, StorageInvalidKeyError, StorageSsrfError } from '../src/lib/storage/adapters/adapter-interface';
import { sftpBatch, sftpCommandLine } from '../src/lib/storage/adapters/sftp-protocol';

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA-test-key-material\n-----END OPENSSH PRIVATE KEY-----\n';
const PUBLIC_ADDRESS = [{ address: '93.184.216.34', family: 4 }];

function adapter(overrides: Partial<ConstructorParameters<typeof SftpStorageAdapter>[0]> = {}) {
  return new SftpStorageAdapter({
    type: 'sftp',
    host: 'sftp.customer.example.com',
    username: 'sftpuser',
    privateKey: PRIVATE_KEY,
    basePath: '/srv/data',
    ...overrides,
  });
}

function leftoverWorkDirs(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('easyconvert-sftp-') || name.startsWith('sftp-key-'));
}

describe('SFTP adapter: the boundary between caller data and the sftp client', () => {
  let before: string[];

  beforeEach(() => {
    mocks.calls.length = 0;
    mocks.behavior.current = 'ok';
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue(PUBLIC_ADDRESS as never);
    before = leftoverWorkDirs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('remote paths', () => {
    const hostile = [
      'a\n!touch /tmp/pwned',
      'a"\n!id',
      'a\r\n!id',
      'a\u0000b',
      'a\u0085!id',
      'a\u2028!id',
      'a\tb',
      'a\ud800b',
    ];

    it.each(hostile)('refuses %j in every operation before any sftp process starts', async (remotePath) => {
      const target = adapter();
      await expect(target.downloadStream(remotePath)).rejects.toThrow(StorageInvalidKeyError);
      await expect(target.uploadStream(remotePath, new PassThrough())).rejects.toThrow(StorageInvalidKeyError);
      await expect(target.head(remotePath)).rejects.toThrow(StorageInvalidKeyError);
      await expect(target.delete(remotePath)).rejects.toThrow(StorageInvalidKeyError);
      expect(mocks.calls).toHaveLength(0);
    });

    it('refuses a path too long for one sftp line in every operation', async () => {
      const target = adapter();
      const tooLong = 'x'.repeat(2100);
      await expect(target.downloadStream(tooLong)).rejects.toThrow(StorageInvalidKeyError);
      await expect(target.uploadStream(tooLong, new PassThrough())).rejects.toThrow(StorageInvalidKeyError);
      await expect(target.head(tooLong)).rejects.toThrow(StorageInvalidKeyError);
      await expect(target.delete(tooLong)).rejects.toThrow(StorageInvalidKeyError);
      expect(mocks.calls).toHaveLength(0);
    });

    it.each(['../../etc/passwd', '../x', 'a/../../x', '/../etc/passwd', '//..//etc', '..', '', '/', 'a/..'])(
      'refuses %j, which leaves the base path or names the base path itself',
      async (remotePath) => {
        const target = adapter();
        await expect(target.delete(remotePath)).rejects.toThrow(StorageInvalidKeyError);
        await expect(target.head(remotePath)).rejects.toThrow(StorageInvalidKeyError);
        expect(mocks.calls).toHaveLength(0);
      },
    );

    it('keeps a path whose dot segments stay below the base path, resolved with POSIX rules', async () => {
      await adapter().delete('/a/../b//c.txt');
      expect(mocks.calls[0].stdin).toBe('rm "/srv/data/b/c.txt"\nquit\n');
    });

    it('quotes a double quote, a backslash and a space so they stay inside the one argument', async () => {
      await adapter().delete('say "hi" \\ there');
      expect(mocks.calls[0].stdin).toBe('rm "/srv/data/say \\"hi\\" \\\\ there"\nquit\n');
    });

    it('turns a relative base path into a path that cannot be read as an option', async () => {
      await adapter({ basePath: 'uploads' }).delete('-rf');
      await adapter({ basePath: '-weird' }).delete('x');
      expect(mocks.calls[0].stdin).toBe('rm "./uploads/-rf"\nquit\n');
      expect(mocks.calls[1].stdin).toBe('rm "./-weird/x"\nquit\n');
    });

    it('refuses a key that climbs above the server root instead of clamping it, and keeps a key below it', async () => {
      await expect(adapter({ basePath: undefined }).delete('../../etc/passwd')).rejects.toThrow(StorageInvalidKeyError);
      await adapter({ basePath: undefined }).delete('a/b');
      expect(mocks.calls.map((call) => call.stdin)).toEqual(['rm "/a/b"\nquit\n']);
    });

    it.each(['/srv/da\nta', '../escape', 'a/../../escape', '/srv/da\u0000ta'])('refuses the base path %j when the adapter is built', (basePath) => {
      expect(() => adapter({ basePath })).toThrow(StorageInputError);
    });
  });

  describe('destination', () => {
    it.each([
      '-oProxyCommand=touch /tmp/x',
      '-oProxyCommand=touch${IFS}/tmp/x',
      '-o',
      'user name',
      'user\nname',
      'a:b',
      'a/b',
      'a;b',
      '',
    ])('refuses the user name %j', (username) => {
      expect(() => adapter({ username })).toThrow(StorageInputError);
    });

    it.each([
      '-oProxyCommand=touch /tmp/x',
      '-host.example.com',
      'host name.example.com',
      'host\n.example.com',
      'host.example.com:22',
      'host.example.com/path',
      'user@host.example.com',
      'a..example.com',
      '[::1]',
      'fe80::1%eth0',
      '',
    ])('refuses the host %j', (host) => {
      expect(() => adapter({ host })).toThrow(StorageInputError);
    });

    it('refuses a user name over 100 characters and a host label over 63', () => {
      expect(() => adapter({ username: 'x'.repeat(101) })).toThrow(StorageInputError);
      expect(() => adapter({ host: `${'a'.repeat(64)}.example.com` })).toThrow(StorageInputError);
    });

    it.each([0, -1, 22.5, 65536, Number.NaN])('refuses the port %j', (port) => {
      expect(() => adapter({ port })).toThrow(StorageInputError);
    });

    it.each([
      ['sftp.customer.example.com', 'sftpuser', 'sftpuser@sftp.customer.example.com'],
      ['93.184.216.34', 'bob_API-1.x', 'bob_API-1.x@93.184.216.34'],
      ['2606:2800:220:1::1', 'sftpuser', 'sftpuser@[2606:2800:220:1::1]'],
      ['sftp.customer.example.com', 'ops@corp.example', 'ops@corp.example@sftp.customer.example.com'],
    ])('passes %s for %s as the one operand after "--"', async (host, username, destination) => {
      await adapter({ host, username }).delete('f');
      const { args } = mocks.calls[0];
      expect(args.slice(-2)).toEqual(['--', destination]);
      expect(args.filter((arg) => arg === '--')).toHaveLength(1);
      expect(args.indexOf('--')).toBe(args.length - 2);
    });

    it('keeps the host key policy and the batch options of the existing contract', async () => {
      await adapter({ port: 2222 }).delete('f');
      const { args } = mocks.calls[0];
      expect(args).toEqual(expect.arrayContaining(['StrictHostKeyChecking=accept-new', 'BatchMode=yes', 'ConnectTimeout=10']));
      expect(args[args.indexOf('-P') + 1]).toBe('2222');
    });
  });

  describe('the private key file', () => {
    it('lives in a 0700 directory of its own as a 0600 file while sftp runs, and is gone when it succeeds', async () => {
      await adapter().delete('f');
      const [call] = mocks.calls;
      expect(call.keyContent).toBe(PRIVATE_KEY);
      expect(call.keyFileMode).toBe(0o600);
      expect(call.keyDirMode).toBe(0o700);
      expect(path.dirname(call.keyPath as string)).not.toBe(os.tmpdir());
      expect(fs.existsSync(path.dirname(call.keyPath as string))).toBe(false);
      expect(leftoverWorkDirs()).toEqual(before);
    });

    it.each<ChildBehavior>(['exit-1', 'spawn-error', 'spawn-throws', 'killed-by-timeout'])('is gone when sftp ends as %s', async (behavior) => {
      mocks.behavior.current = behavior;
      const target = adapter();
      await target.delete('f');
      await expect(target.uploadStream('f', new PassThrough().end('data'))).rejects.toThrow();
      for (const call of mocks.calls) {
        expect(call.keyPath).toBeDefined();
        expect(fs.existsSync(path.dirname(call.keyPath as string))).toBe(false);
      }
      expect(leftoverWorkDirs()).toEqual(before);
    });

    it('is never written when the adapter refuses the destination or the host is private', async () => {
      expect(() => adapter({ username: '-oProxyCommand=x' })).toThrow(StorageInputError);
      await expect(adapter({ host: '127.0.0.1' }).delete('f')).rejects.toThrow(StorageSsrfError);
      expect(mocks.calls).toHaveLength(0);
      expect(leftoverWorkDirs()).toEqual(before);
    });

    it('is not written when no private key is configured', async () => {
      await adapter({ privateKey: undefined }).delete('f');
      expect(mocks.calls[0].args).toEqual([
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ConnectTimeout=10',
        '-P', '22',
        '--', 'sftpuser@sftp.customer.example.com',
      ]);
    });
  });

  describe('the child process', () => {
    it('runs without a shell, with a bounded lifetime, and without the secrets of the server process', async () => {
      vi.stubEnv('ENCRYPTION_KEY', 'server-secret-aes-key');
      vi.stubEnv('DATABASE_URL', 'postgres://user:pw@db/prod');
      vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'aws-secret');
      vi.stubEnv('SSH_AUTH_SOCK', '/run/agent.sock');
      await adapter().delete('f');
      const { options, args } = mocks.calls[0];
      expect(options.shell).toBe(false);
      expect(options.timeout).toBeGreaterThan(0);
      expect(Object.keys(options.env).sort()).toEqual(['HOME', 'LANG', 'PATH']);
      expect(JSON.stringify(options.env)).not.toMatch(/server-secret|postgres:|aws-secret|agent\.sock/);
      expect(options.env.HOME).toBe(path.dirname(args[args.indexOf('-i') + 1]));
      expect(options.env.HOME).not.toBe(process.env.HOME);
      expect(options.env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
    });
  });
});

describe('sftp batch quoting against the real sftp client', () => {
  const sftpServer = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server', '/usr/lib/ssh/sftp-server'].find((candidate) => fs.existsSync(candidate));
  const sftpClient = fs.existsSync('/usr/bin/sftp') ? '/usr/bin/sftp' : undefined;
  // skip-ok: the real-client rows need an OpenSSH sftp client and sftp-server, which a developer machine or a runner may not install; the argv and script rows above assert the same quoting without them.
  const runnable = sftpServer !== undefined && sftpClient !== undefined;
  let sandbox: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sftp-quote-'));
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  function runBatch(script: string): { status: number | null; stderr: string } {
    const result = spawnSync(sftpClient as string, ['-D', sftpServer as string], {
      input: script,
      env: { PATH: '/usr/bin:/bin', HOME: sandbox, LANG: 'C.UTF-8' } as unknown as NodeJS.ProcessEnv,
      cwd: sandbox,
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { status: result.status, stderr: result.stderr };
  }

  const awkwardNames = [
    'plain.txt',
    'with space.txt',
    'say "hi".txt',
    'back\\slash.txt',
    'trailing\\',
    'star*.txt',
    'what?.txt',
    '[brackets].txt',
    "it's.txt",
    '#hash.txt',
    '$HOME ~ `id`.txt',
    '!touch injected',
    '-rf',
    'ünï-文字.txt',
    '\\"\\\\"',
  ];

  it.skipIf(!runnable).each(awkwardNames)('puts, lists, gets and removes the file named %j by exactly that name', (name) => {
    const local = path.join(sandbox, 'local.bin');
    const remoteDir = path.join(sandbox, 'remote');
    const fetched = path.join(sandbox, 'fetched.bin');
    fs.mkdirSync(remoteDir);
    fs.writeFileSync(local, 'payload');
    const remote = `./remote/${name}`;

    expect(runBatch(sftpBatch(sftpCommandLine('put', local, remote))).status).toBe(0);
    expect(fs.readdirSync(remoteDir)).toEqual([name]);
    expect(fs.readFileSync(path.join(remoteDir, name), 'utf8')).toBe('payload');

    expect(runBatch(sftpBatch(sftpCommandLine('ls -l', remote))).status).toBe(0);
    expect(runBatch(sftpBatch(sftpCommandLine('get', remote, fetched))).status).toBe(0);
    expect(fs.readFileSync(fetched, 'utf8')).toBe('payload');

    expect(runBatch(sftpBatch(sftpCommandLine('rm', remote))).status).toBe(0);
    expect(fs.readdirSync(remoteDir)).toEqual([]);
    expect(fs.existsSync(path.join(sandbox, 'injected'))).toBe(false);
  });

  it.skipIf(!runnable)('control: the old unquoted line break does run a local command in this sftp client', () => {
    const marker = path.join(sandbox, 'pwned');
    runBatch(`rm "x"\n!touch ${marker}\nquit\n`);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('refuses to build a line that sftp would cut in two', () => {
    expect(() => sftpCommandLine('rm', `/srv/${'a'.repeat(2050)}`)).toThrow(StorageInvalidKeyError);
    expect(sftpCommandLine('rm', `/srv/${'a'.repeat(1900)}`)).toMatch(/^rm "/);
  });
});
