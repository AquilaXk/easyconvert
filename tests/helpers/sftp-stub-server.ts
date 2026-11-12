import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import { Server, utils, type Connection, type SFTPWrapper } from 'ssh2';

/**
 * A minimal SFTP server for tests, over the `ssh2` server (MIT): public key sign-in, an in-memory tree, and the requests the
 * OpenSSH `sftp` client makes for `get`, `put`, `rm` and `ls -l`. It is what `SftpStorageAdapter` talks to through the real client.
 */

const { OPEN_MODE, STATUS_CODE } = utils.sftp;

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const MODIFIED_AT = new Date('2026-11-01T10:00:00Z');
/** `ls_file` prints the date as `%b %e %H:%M`, which is what the client shows for a listing line. */
const LONGNAME_DATE = 'Nov  1 10:00';

type OpenHandle =
  | { kind: 'read'; path: string }
  | { kind: 'write'; path: string; data: Buffer }
  | { kind: 'dir'; path: string; listed: boolean };

export interface SftpStub {
  host: string;
  port: number;
  /** The private key the client signs in with, OpenSSH format. */
  clientPrivateKey: string;
  /** The server's host key as a `known_hosts` public key line (`ssh-ed25519 <base64>`). */
  hostPublicKey: string;
  /** Files by absolute path. */
  files: Map<string, Buffer>;
  directories: Set<string>;
  /** Sign-ins and requests the server saw, for assertions. */
  log: { connections: number; signedIn: number; refusedKeys: number; reads: string[]; writes: string[]; removes: string[] };
  /** The next this many connections are closed at once, as a server that is going away. */
  dropConnections: number;
  close: () => Promise<void>;
}

function attributes(isDirectory: boolean, size: number) {
  const mtime = Math.floor(MODIFIED_AT.getTime() / 1000);
  return { mode: (isDirectory ? S_IFDIR | 0o755 : S_IFREG | 0o644), uid: 0, gid: 0, size, atime: mtime, mtime };
}

function longname(name: string, isDirectory: boolean, size: number): string {
  const mode = isDirectory ? 'drwxr-xr-x' : '-rw-r--r--';
  return `${mode}   1 test     test     ${String(size).padStart(8)} ${LONGNAME_DATE} ${name}`;
}

function normalize(path: string): string {
  const absolute = path.startsWith('/') ? path : `/${path}`;
  return absolute.length > 1 ? absolute.replace(/\/+$/, '') : absolute;
}

function childrenOf(stub: SftpStub, directory: string): Array<{ name: string; isDirectory: boolean; size: number }> {
  const prefix = directory === '/' ? '/' : `${directory}/`;
  const entries = new Map<string, { name: string; isDirectory: boolean; size: number }>();
  for (const [file, body] of stub.files) {
    if (file.startsWith(prefix) && !file.slice(prefix.length).includes('/')) entries.set(file, { name: file.slice(prefix.length), isDirectory: false, size: body.length });
  }
  for (const dir of stub.directories) {
    if (dir.startsWith(prefix) && dir !== directory && !dir.slice(prefix.length).includes('/')) entries.set(dir, { name: dir.slice(prefix.length), isDirectory: true, size: 0 });
  }
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function serveSftp(stub: SftpStub, sftp: SFTPWrapper): void {
  const handles = new Map<string, OpenHandle>();
  const newHandle = (open: OpenHandle): Buffer => {
    const id = crypto.randomBytes(4);
    handles.set(id.toString('hex'), open);
    return id;
  };
  const handleOf = (id: Buffer) => handles.get(id.toString('hex'));
  const statOf = (reqId: number, path: string) => {
    const target = normalize(path);
    const file = stub.files.get(target);
    if (file) return sftp.attrs(reqId, attributes(false, file.length));
    if (stub.directories.has(target) || target === '/') return sftp.attrs(reqId, attributes(true, 0));
    return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
  };

  sftp.on('REALPATH', (reqId, path) => {
    const resolved = path === '.' || path === '' ? '/' : normalize(path);
    sftp.name(reqId, [{ filename: resolved, longname: resolved, attrs: attributes(true, 0) }]);
  });
  sftp.on('STAT', statOf);
  sftp.on('LSTAT', statOf);
  sftp.on('FSTAT', (reqId, handle) => {
    const open = handleOf(handle);
    if (open?.kind === 'read') return sftp.attrs(reqId, attributes(false, stub.files.get(open.path)?.length ?? 0));
    return sftp.attrs(reqId, attributes(open?.kind === 'dir', open?.kind === 'write' ? open.data.length : 0));
  });
  sftp.on('OPEN', (reqId, filename, flags) => {
    const target = normalize(filename);
    if (flags & OPEN_MODE.WRITE) {
      return sftp.handle(reqId, newHandle({ kind: 'write', path: target, data: Buffer.alloc(0) }));
    }
    if (!stub.files.has(target)) return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
    stub.log.reads.push(target);
    return sftp.handle(reqId, newHandle({ kind: 'read', path: target }));
  });
  sftp.on('READ', (reqId, handle, offset, length) => {
    const open = handleOf(handle);
    const body = open?.kind === 'read' ? stub.files.get(open.path) : undefined;
    if (!body) return sftp.status(reqId, STATUS_CODE.FAILURE);
    if (offset >= body.length) return sftp.status(reqId, STATUS_CODE.EOF);
    return sftp.data(reqId, body.subarray(offset, Math.min(body.length, offset + length)));
  });
  sftp.on('WRITE', (reqId, handle, offset, data) => {
    const open = handleOf(handle);
    if (open?.kind !== 'write') return sftp.status(reqId, STATUS_CODE.FAILURE);
    const grown = Buffer.alloc(Math.max(open.data.length, offset + data.length));
    open.data.copy(grown);
    data.copy(grown, offset);
    open.data = grown;
    return sftp.status(reqId, STATUS_CODE.OK);
  });
  sftp.on('CLOSE', (reqId, handle) => {
    const open = handleOf(handle);
    if (open?.kind === 'write') {
      stub.files.set(open.path, open.data);
      stub.log.writes.push(open.path);
    }
    handles.delete(handle.toString('hex'));
    sftp.status(reqId, STATUS_CODE.OK);
  });
  sftp.on('REMOVE', (reqId, path) => {
    const target = normalize(path);
    if (!stub.files.delete(target)) return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
    stub.log.removes.push(target);
    return sftp.status(reqId, STATUS_CODE.OK);
  });
  sftp.on('SETSTAT', (reqId) => sftp.status(reqId, STATUS_CODE.OK));
  sftp.on('FSETSTAT', (reqId) => sftp.status(reqId, STATUS_CODE.OK));
  sftp.on('OPENDIR', (reqId, path) => {
    const target = normalize(path);
    if (target !== '/' && !stub.directories.has(target)) return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
    return sftp.handle(reqId, newHandle({ kind: 'dir', path: target, listed: false }));
  });
  sftp.on('READDIR', (reqId, handle) => {
    const open = handleOf(handle);
    if (open?.kind !== 'dir' || open.listed) return sftp.status(reqId, STATUS_CODE.EOF);
    open.listed = true;
    const entries = childrenOf(stub, open.path).map((entry) => ({
      filename: entry.name,
      longname: longname(entry.name, entry.isDirectory, entry.size),
      attrs: attributes(entry.isDirectory, entry.size),
    }));
    return entries.length === 0 ? sftp.status(reqId, STATUS_CODE.EOF) : sftp.name(reqId, entries);
  });
}

function sameKey(offered: Buffer, expected: Buffer): boolean {
  return offered.length === expected.length && crypto.timingSafeEqual(offered, expected);
}

/** Starts the server on 127.0.0.1 with a random port; `close` ends it and every connection. */
export async function startSftpStub(): Promise<SftpStub> {
  const client = utils.generateKeyPairSync('ed25519');
  const host = utils.generateKeyPairSync('ed25519');
  const clientPublic = utils.parseKey(client.public);
  const hostPublic = utils.parseKey(host.public);
  if (clientPublic instanceof Error || hostPublic instanceof Error) throw new Error('the stub could not read its own key pair');
  const expectedClientKey = Buffer.from(clientPublic.getPublicSSH());

  const stub: SftpStub = {
    host: '127.0.0.1',
    port: 0,
    clientPrivateKey: client.private,
    hostPublicKey: `ssh-ed25519 ${Buffer.from(hostPublic.getPublicSSH()).toString('base64')}`,
    files: new Map(),
    directories: new Set(),
    log: { connections: 0, signedIn: 0, refusedKeys: 0, reads: [], writes: [], removes: [] },
    dropConnections: 0,
    close: async () => undefined,
  };

  const connections = new Set<Connection>();
  const server = new Server({ hostKeys: [host.private] }, (connection: Connection) => {
    stub.log.connections++;
    connections.add(connection);
    connection.on('close', () => connections.delete(connection));
    if (stub.dropConnections > 0) {
      stub.dropConnections--;
      connection.end();
      return;
    }
    connection.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey') return ctx.reject(['publickey']);
      if (!sameKey(ctx.key.data, expectedClientKey)) {
        stub.log.refusedKeys++;
        return ctx.reject(['publickey']);
      }
      if (ctx.signature && !clientPublic.verify(ctx.blob as Buffer, ctx.signature, ctx.key.algo)) return ctx.reject(['publickey']);
      if (!ctx.signature) return ctx.accept();
      stub.log.signedIn++;
      return ctx.accept();
    });
    connection.on('ready', () => {
      connection.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          serveSftp(stub, sftp);
          // the client says it is done by closing its side; the server ends the channel, which ends the client
          sftp.on('end', () => connection.end());
        });
      });
    });
    connection.on('error', () => undefined);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stub.port = (server.address() as AddressInfo).port;
  stub.close = () =>
    new Promise<void>((resolve) => {
      for (const connection of connections) connection.end();
      server.close(() => resolve());
    });
  return stub;
}
