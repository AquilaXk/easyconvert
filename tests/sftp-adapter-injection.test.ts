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
  knownHosts?: string;
  killed?: boolean;
  floodedBytes?: number;
};

type ChildBehavior =
  | 'ok'
  | 'exit-1'
  | 'spawn-error'
  | 'spawn-throws'
  | 'killed-by-timeout'
  | 'command-fails'
  | 'command-fails-not-found'
  | 'auth-fails'
  | 'listing'
  | 'listing-missing'
  | 'download'
  | 'long-error'
  | 'flood-stdout'
  | 'flood-stderr'
  | 'spool-grows';

const FLOOD_CHUNK_BYTES = 16 * 1024;
const FLOOD_MAX_CHUNKS = 4000;

const mocks = vi.hoisted(() => ({
  calls: [] as SpawnCall[],
  behavior: { current: 'ok' as ChildBehavior },
  spoolCap: 0,
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
    const knownHostsOption = args.find((arg) => arg.startsWith('UserKnownHostsFile='));
    if (knownHostsOption) call.knownHosts = fs.readFileSync(knownHostsOption.slice('UserKnownHostsFile='.length), 'utf8');
    mocks.calls.push(call);
    if (mocks.behavior.current === 'spawn-throws') throw new Error('spawn EACCES');
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: (signal: string) => {
        call.killed = true;
        setImmediate(() => child.emit('close', null, signal));
        return true;
      },
    });
    child.stdin.on('data', (chunk: Buffer) => {
      call.stdin += chunk.toString();
    });
    const batchMode = args.includes('-b');
    const quotedArgs = () => [...call.stdin.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    const flood = (stream: PassThrough) => {
      call.floodedBytes = 0;
      let chunks = 0;
      const pump = () => {
        if (call.killed || chunks++ >= FLOOD_MAX_CHUNKS) return;
        call.floodedBytes = (call.floodedBytes as number) + FLOOD_CHUNK_BYTES;
        stream.write(Buffer.alloc(FLOOD_CHUNK_BYTES, 0x78));
        setImmediate(pump);
      };
      pump();
    };
    const finish = (code: number, stderr = '', stdout = '') => {
      if (stdout) child.stdout.write(stdout);
      if (stderr) child.stderr.write(stderr);
      setImmediate(() => child.emit('close', code, null));
    };
    const echoed = () => `sftp> ${call.stdin.split('\n')[0]}\n`;
    if (mocks.behavior.current === 'spawn-error') {
      setImmediate(() => {
        child.emit('error', new Error('spawn sftp ENOENT'));
        child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      });
    } else {
      child.stdin.on('end', () => {
        setImmediate(() => {
          const behavior = mocks.behavior.current;
          if (behavior === 'killed-by-timeout') child.emit('close', null, 'SIGTERM');
          else if (behavior === 'exit-1') finish(1, 'Connection closed');
          else if (behavior === 'long-error') finish(255, 'x'.repeat(5000));
          else if (behavior === 'command-fails') finish(batchMode ? 1 : 0, 'dest open "/srv/data/nodir/x": No such file or directory\n');
          else if (behavior === 'command-fails-not-found') finish(batchMode ? 1 : 0, `File "${quotedArgs()[0]}" not found.\n`);
          else if (behavior === 'auth-fails') finish(255, 'sftpuser@93.184.216.34: Permission denied (publickey).\n');
          else if (behavior === 'listing') {
            finish(0, '', `${echoed()}-rw-r--r--    ?  1000  1000      1234 Oct 25 13:57 f\nsftp> quit\n`);
          } else if (behavior === 'listing-missing') finish(0, '', `${echoed()}sftp> quit\n`);
          else if (behavior === 'download') {
            fs.writeFileSync(nodePath.resolve(quotedArgs()[1].replace(/\\(.)/g, '$1')), 'payload');
            finish(0);
          } else if (behavior === 'flood-stdout') flood(child.stdout);
          else if (behavior === 'flood-stderr') flood(child.stderr);
          else if (behavior === 'spool-grows') {
            const fd = fs.openSync(quotedArgs()[1].replace(/\\(.)/g, '$1'), 'w');
            fs.ftruncateSync(fd, mocks.spoolCap + 1);
            fs.closeSync(fd);
          } else finish(0);
        });
      });
    }
    return child;
  };
  return { ...actual, spawn, default: { ...actual, spawn } };
});

import { SftpStorageAdapter } from '../src/lib/storage/adapters/sftp';
import {
  StorageAdapterError,
  StorageAuthenticationError,
  StorageInputError,
  StorageInvalidKeyError,
  StorageNotFoundError,
  StorageSsrfError,
} from '../src/lib/storage/adapters/adapter-interface';
import {
  SFTP_BATCH_ARGS,
  SFTP_MAX_OUTPUT_BYTES,
  parseSftpListingSize,
  sftpBatch,
  sftpCommandLine,
} from '../src/lib/storage/adapters/sftp-protocol';
import { REMOTE_STAGED_OBJECT_MAX_BYTES } from '../src/lib/storage/remote-storage-backend';

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
      ['sftp.customer.example.com', 'sftpuser', '93.184.216.34', 'sftpuser@93.184.216.34'],
      ['93.184.216.34', 'bob_API-1.x', '93.184.216.34', 'bob_API-1.x@93.184.216.34'],
      ['2606:2800:220:1::1', 'sftpuser', '2606:2800:220:1::1', 'sftpuser@[2606:2800:220:1::1]'],
      ['sftp.customer.example.com', 'ops@corp.example', '2606:2800:220:1::1', 'ops@corp.example@[2606:2800:220:1::1]'],
    ])('passes %s for %s as the one operand after "--", with the address that passed the check', async (host, username, address, destination) => {
      vi.mocked(dns.promises.lookup).mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }] as never);
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
      await target.delete('f').catch(() => undefined);
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
        '-o', 'ConnectTimeout=10',
        '-o', 'HostKeyAlias=sftp.customer.example.com',
        '-P', '22',
        '-b', '-',
        '-o', 'StrictHostKeyChecking=accept-new',
        '--', 'sftpuser@93.184.216.34',
      ]);
    });
  });

  describe('the exit status of the client', () => {
    it('puts "-b -" before "--", the form that makes a failed command exit 1', async () => {
      await adapter().delete('f');
      const { args } = mocks.calls[0];
      const batch = args.indexOf('-b');
      expect(args.slice(batch, batch + 2)).toEqual(['-b', '-']);
      expect(batch).toBeLessThan(args.indexOf('--'));
    });

    it('rejects an upload whose put failed instead of reporting its size', async () => {
      mocks.behavior.current = 'command-fails';
      await expect(adapter().uploadStream('nodir/x', new PassThrough().end('data'))).rejects.toThrow(/No such file or directory/);
      expect(leftoverWorkDirs()).toEqual(before);
    });

    it('answers false for a delete whose rm failed, and true when it did not', async () => {
      mocks.behavior.current = 'command-fails';
      await expect(adapter().delete('missing')).resolves.toBe(false);
      mocks.behavior.current = 'ok';
      await expect(adapter().delete('there')).resolves.toBe(true);
    });

    it('answers null for a head whose ls failed', async () => {
      mocks.behavior.current = 'command-fails';
      await expect(adapter().head('missing')).resolves.toBeNull();
    });

    it('does not turn a refused login, a lost connection or a killed client into "not found" or "false"', async () => {
      mocks.behavior.current = 'auth-fails';
      await expect(adapter().delete('f')).rejects.toThrow(StorageAuthenticationError);
      await expect(adapter().head('f')).rejects.toThrow(StorageAuthenticationError);
      mocks.behavior.current = 'exit-1';
      await expect(adapter().uploadStream('f', new PassThrough().end('x'))).rejects.toThrow(StorageAdapterError);
      mocks.behavior.current = 'killed-by-timeout';
      await expect(adapter().delete('f')).rejects.toThrow(/SIGTERM/);
    });

    it('answers a download of a missing file with not found that names the key and none of the batch', async () => {
      mocks.behavior.current = 'command-fails-not-found';
      const error = await adapter().downloadStream('docs/secret name.txt').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(StorageNotFoundError);
      expect((error as Error).message).toBe('Remote object not found: "docs/secret name.txt"');
      expect(leftoverWorkDirs()).toEqual(before);
    });

    it('streams a downloaded file and removes its spool when the stream closes', async () => {
      mocks.behavior.current = 'download';
      const stream = await adapter().downloadStream('f');
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks).toString()).toBe('payload');
      await new Promise((resolve) => setImmediate(resolve));
      expect(leftoverWorkDirs()).toEqual(before);
    });
  });

  describe('the address the client connects to', () => {
    it('is the address that passed the check, so a second answer of the name is never asked for', async () => {
      vi.mocked(dns.promises.lookup)
        .mockReset()
        .mockResolvedValueOnce(PUBLIC_ADDRESS as never)
        .mockResolvedValue([{ address: '169.254.169.254', family: 4 }] as never);
      await adapter().delete('f');
      const { args } = mocks.calls[0];
      expect(dns.promises.lookup).toHaveBeenCalledTimes(1);
      expect(args.at(-1)).toBe('sftpuser@93.184.216.34');
      expect(args.filter((arg) => arg.includes('customer.example.com'))).toEqual(['HostKeyAlias=sftp.customer.example.com']);
      expect(args.join(' ')).not.toContain('169.254.169.254');
    });

    it('is the first address when the name has several that are all allowed, and a bracketed IPv6 address', async () => {
      vi.mocked(dns.promises.lookup).mockResolvedValue([
        { address: '2606:2800:220:1::1', family: 6 },
        { address: '93.184.216.34', family: 4 },
      ] as never);
      await adapter().delete('f');
      expect(mocks.calls[0].args.at(-1)).toBe('sftpuser@[2606:2800:220:1::1]');
    });

    it('is refused with no sftp process when any address of the name is restricted', async () => {
      vi.mocked(dns.promises.lookup).mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.7', family: 4 },
      ] as never);
      await expect(adapter().delete('f')).rejects.toThrow(StorageSsrfError);
      expect(mocks.calls).toHaveLength(0);
    });

    it('names the host as the alias of its key also when the host is an IP literal', async () => {
      await adapter({ host: '93.184.216.34' }).delete('f');
      expect(mocks.calls[0].args.filter((arg) => arg.startsWith('HostKeyAlias='))).toEqual(['HostKeyAlias=93.184.216.34']);
    });
  });

  describe('the host key', () => {
    const ed25519Blob = (seed: number) => {
      const type = Buffer.from('ssh-ed25519');
      const length = (n: number) => Buffer.from([0, 0, 0, n]);
      return Buffer.concat([length(type.length), type, length(32), Buffer.alloc(32, seed)]).toString('base64');
    };
    const KEY = ed25519Blob(7);

    it('is accepted on first use when the credential carries none, and no known hosts file is named', async () => {
      await adapter().delete('f');
      const { args, knownHosts } = mocks.calls[0];
      expect(args).toContain('StrictHostKeyChecking=accept-new');
      expect(args.some((arg) => arg.startsWith('UserKnownHostsFile='))).toBe(false);
      expect(knownHosts).toBeUndefined();
    });

    it.each([
      ['a bare public key', `ssh-ed25519 ${KEY}`],
      ['a public key with a comment', `ssh-ed25519 ${KEY} root@server`],
      ['a known_hosts line', `sftp.customer.example.com ssh-ed25519 ${KEY}`],
      ['a known_hosts line with a port', `[sftp.customer.example.com]:2222 ssh-ed25519 ${KEY} comment`],
      ['a known_hosts line with an address list', `sftp.customer.example.com,93.184.216.34\tssh-ed25519 ${KEY}\n`],
    ])('is the only key trusted when the credential pins %s', async (_label, hostKey) => {
      await adapter({ hostKey }).delete('f');
      const { args, knownHosts, keyPath } = mocks.calls[0];
      const workDir = path.dirname(keyPath as string);
      expect(args).toEqual(expect.arrayContaining(['StrictHostKeyChecking=yes', `UserKnownHostsFile=${workDir}/known_hosts`, 'GlobalKnownHostsFile=/dev/null']));
      expect(args).not.toContain('StrictHostKeyChecking=accept-new');
      expect(knownHosts).toBe(`* ssh-ed25519 ${KEY}\n`);
      expect(fs.existsSync(workDir)).toBe(false);
    });

    it('keeps the pinned key out of the batch, the environment and the error text', async () => {
      mocks.behavior.current = 'exit-1';
      const error = await adapter({ hostKey: `ssh-ed25519 ${KEY}` }).uploadStream('f', new PassThrough().end('x')).catch((err: unknown) => err);
      expect((error as Error).message).not.toContain(KEY);
      expect(mocks.calls[0].stdin).not.toContain(KEY);
      expect(JSON.stringify(mocks.calls[0].options.env)).not.toContain(KEY);
    });

    const rsaBlob = Buffer.concat([Buffer.from([0, 0, 0, 7]), Buffer.from('ssh-rsa'), Buffer.from([0, 0, 0, 1, 3])]).toString('base64');
    it.each([
      ['an empty value', ''],
      ['a fingerprint, which ssh cannot pin by itself', 'SHA256:k8wGEmVEp2+o/OnhH59/WerdxuKucXAmHLLkp66zVqM'],
      ['two lines', `ssh-ed25519 ${KEY}\nssh-ed25519 ${ed25519Blob(8)}`],
      ['a line break inside', `ssh-ed25519\n${KEY}`],
      ['a certificate authority marker', `@cert-authority * ssh-ed25519 ${KEY}`],
      ['a revoked marker', `@revoked * ssh-ed25519 ${KEY}`],
      ['a key type that is not pinned', `ssh-dss ${KEY}`],
      ['a key type that differs from the key data', `ssh-rsa ${KEY}`],
      ['key data of another type under the stated type', `ssh-ed25519 ${rsaBlob}`],
      ['base64 with a character outside the alphabet', 'ssh-ed25519 AAAA!AAA'],
      ['no key data', 'ssh-ed25519'],
      ['a host and a type with no key data', 'host ssh-ed25519'],
      ['a non-ASCII character', `ssh-ed25519 ${KEY} 키`],
      ['key data over the size limit', `ssh-ed25519 ${'A'.repeat(9000)}`],
    ])('refuses %s when the adapter is built', (_label, hostKey) => {
      expect(() => adapter({ hostKey })).toThrow(StorageInputError);
    });
  });

  describe('the output of the client', () => {
    it('reads the size from the listing line after the echoed command', async () => {
      mocks.behavior.current = 'listing';
      await expect(adapter().head('f')).resolves.toMatchObject({ size: 1234 });
    });

    it('ignores a listing line a key spells out inside the echoed command', async () => {
      mocks.behavior.current = 'listing';
      const crafted = 'x" -rw-r--r-- 1 u g 999 Jan  1 00:00 y';
      await expect(adapter().head(crafted)).resolves.toMatchObject({ size: 1234 });
    });

    it('does not read a size out of the echo when the server printed no listing', async () => {
      mocks.behavior.current = 'listing-missing';
      const crafted = 'x" -rw-r--r-- 1 u g 999 Jan  1 00:00 y';
      await expect(adapter().head(crafted)).rejects.toThrow(StorageAdapterError);
    });

    it.each([
      ['a remote file, link count "?"', 'sftp> ls -l "f"\n-rw-r--r--    ? aquila   wheel           5 Oct 25 13:57 ./f\nsftp> quit\n', 5],
      ['a file with an old date and a numeric owner', 'sftp> ls -l "f"\n-rwxr-xr-x    ? 1000     1000     90210 Jan  3  2021 /srv/f\nsftp> quit\n', 90210],
      ['a numeric link count', 'sftp> ls -l "f"\n-rw-r--r--    2 u g 7 Jan  3 10:00 f\n', 7],
      ['no listing at all', 'sftp> ls -l "f"\nsftp> quit\n', undefined],
      ['no echo', '-rw-r--r--    ? u g 7 Jan  3 10:00 f\n', undefined],
      ['a line that holds a listing but starts with something else', 'sftp> ls -l "f"\nxx -rw-r--r-- ? u g 7 Jan  3 10:00 f\n', undefined],
    ])('parses %s', (_label, stdout, size) => {
      expect(parseSftpListingSize(stdout)).toBe(size);
    });

    it.each(['flood-stdout', 'flood-stderr'] as const)('stops a client that streams %s without end and rejects', async (behavior) => {
      mocks.behavior.current = behavior;
      await expect(adapter().head('f')).rejects.toThrow(new RegExp(`passed ${SFTP_MAX_OUTPUT_BYTES} bytes`));
      const [call] = mocks.calls;
      expect(call.killed).toBe(true);
      expect(call.floodedBytes).toBeLessThanOrEqual(SFTP_MAX_OUTPUT_BYTES + 2 * FLOOD_CHUNK_BYTES);
      expect(leftoverWorkDirs()).toEqual(before);
    });

    it('cuts the standard error that goes into an error message', async () => {
      mocks.behavior.current = 'long-error';
      const error = await adapter().uploadStream('f', new PassThrough().end('x')).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(StorageAdapterError);
      expect((error as Error).message.length).toBeLessThan(700);
    });

    it('stops a download whose spool grows past the largest object the store stages, and removes the spool', async () => {
      mocks.behavior.current = 'spool-grows';
      mocks.spoolCap = REMOTE_STAGED_OBJECT_MAX_BYTES;
      await expect(adapter().downloadStream('f')).rejects.toThrow(/download passed \d+ bytes/);
      expect(mocks.calls[0].killed).toBe(true);
      expect(leftoverWorkDirs()).toEqual(before);
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

  function runBatch(script: string, batchArgs: readonly string[] = SFTP_BATCH_ARGS): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(sftpClient as string, [...batchArgs, '-D', sftpServer as string], {
      input: script,
      env: { PATH: '/usr/bin:/bin', HOME: sandbox, LANG: 'C.UTF-8' } as unknown as NodeJS.ProcessEnv,
      cwd: sandbox,
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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
    '*',
    '?',
    '[a]',
    "it's.txt",
    '#hash.txt',
    '$HOME ~ `id`.txt',
    '!touch injected',
    '-rf',
    'ünï-文字.txt',
    '\\"\\\\"',
  ];

  const DECOYS = ['a.txt', '*', '?', '[a]'];
  const DECOY_CONTENT = 'decoy-content-that-is-longer';

  it.skipIf(!runnable).each(awkwardNames)('puts, lists, gets and removes the file named %j by exactly that name and no sibling', (name) => {
    const local = path.join(sandbox, 'local.bin');
    const remoteDir = path.join(sandbox, 'remote');
    const fetched = path.join(sandbox, 'fetched.bin');
    fs.mkdirSync(remoteDir);
    fs.writeFileSync(local, 'payload');
    const decoys = DECOYS.filter((decoy) => decoy !== name);
    for (const decoy of decoys) fs.writeFileSync(path.join(remoteDir, decoy), DECOY_CONTENT);
    const remote = `./remote/${name}`;
    const decoysIntact = () => decoys.every((decoy) => fs.readFileSync(path.join(remoteDir, decoy), 'utf8') === DECOY_CONTENT);

    expect(runBatch(sftpBatch(sftpCommandLine('put', local, remote))).status).toBe(0);
    expect(fs.readdirSync(remoteDir).sort()).toEqual([name, ...decoys].sort());
    expect(fs.readFileSync(path.join(remoteDir, name), 'utf8')).toBe('payload');
    expect(decoysIntact()).toBe(true);

    const listing = runBatch(sftpBatch(sftpCommandLine('ls -l', remote)));
    expect(listing.status).toBe(0);
    expect(parseSftpListingSize(listing.stdout)).toBe('payload'.length);
    expect(runBatch(sftpBatch(sftpCommandLine('get', remote, fetched))).status).toBe(0);
    expect(fs.readFileSync(fetched, 'utf8')).toBe('payload');

    expect(runBatch(sftpBatch(sftpCommandLine('rm', remote))).status).toBe(0);
    expect(fs.readdirSync(remoteDir).sort()).toEqual([...decoys].sort());
    expect(decoysIntact()).toBe(true);
    expect(fs.existsSync(path.join(sandbox, 'injected'))).toBe(false);
  });

  describe('a failed command', () => {
    const failing = [
      ['put into a missing directory', () => sftpCommandLine('put', path.join(sandbox, 'local.bin'), './nodir/x')],
      ['rm of a missing file', () => sftpCommandLine('rm', './missing')],
      ['get of a missing file', () => sftpCommandLine('get', './missing', path.join(sandbox, 'fetched.bin'))],
      ['ls -l of a missing file', () => sftpCommandLine('ls -l', './missing')],
    ] as const;

    it.skipIf(!runnable).each(failing)('%s exits 1 with -b - and stops the batch there', (_label, line) => {
      fs.writeFileSync(path.join(sandbox, 'local.bin'), 'payload');
      const result = runBatch(sftpBatch(line(), sftpCommandLine('put', path.join(sandbox, 'local.bin'), './after.txt')));
      expect(result.status).toBe(1);
      expect(fs.existsSync(path.join(sandbox, 'after.txt'))).toBe(false);
      expect(result.stdout).not.toContain('sftp> quit');
    });

    it.skipIf(!runnable).each(failing)('control: %s exits 0 without -b, which is what the adapter reported as success', (_label, line) => {
      fs.writeFileSync(path.join(sandbox, 'local.bin'), 'payload');
      expect(runBatch(sftpBatch(line()), []).status).toBe(0);
    });

    it.skipIf(!runnable)('prints a missing file as not found, the classification of a failed get', () => {
      expect(runBatch(sftpBatch(sftpCommandLine('get', './missing', path.join(sandbox, 'fetched.bin')))).stderr).toMatch(/not found/);
    });
  });

  it.skipIf(!runnable)('control: the old unquoted line break does run a local command in this sftp client', () => {
    const marker = path.join(sandbox, 'pwned');
    runBatch(`ls -l "."\n!touch ${marker}\nquit\n`);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('refuses to build a line that sftp would cut in two', () => {
    expect(() => sftpCommandLine('rm', `/srv/${'a'.repeat(2050)}`)).toThrow(StorageInvalidKeyError);
    expect(sftpCommandLine('rm', `/srv/${'a'.repeat(1900)}`)).toMatch(/^rm "/);
  });
});
