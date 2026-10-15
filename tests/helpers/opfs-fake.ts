/**
 * An in-memory implementation of the Origin Private File System surface the OPFS worker uses
 * (navigator.storage.getDirectory, directory and file handles, FileSystemSyncAccessHandle).
 *
 * It follows the platform contract (WHATWG File System, "createSyncAccessHandle"): one open sync access
 * handle per file (a second open fails with NoModificationAllowedError), reads and writes address bytes with
 * `{ at }`, a write past the end grows the file, and `getFile()` returns the current bytes. It records every
 * write so a test can assert how large a single write was. It imports nothing from src.
 */

export interface FakeOpfsConfig {
  /** Total bytes all files may hold; a write that would pass it throws QuotaExceededError, as a full origin quota does. */
  quotaBytes?: number;
  /** False leaves createSyncAccessHandle off the file handles, as on a window (it exists in workers only). */
  syncAccess?: boolean;
  /** Makes navigator.storage.getDirectory reject with this error name (a blocked or private browsing context). */
  getDirectoryFails?: string;
}

export interface FakeOpfsWriteLog {
  /** Size in bytes of every write, in call order. */
  sizes: number[];
  /** Largest single write. */
  maxWrite: number;
}

class FakeQuota {
  used = 0;
  constructor(readonly limit: number) {}
}

class FakeSyncAccessHandle {
  constructor(
    private readonly file: FakeFileHandle,
    private readonly log: FakeOpfsWriteLog,
    private readonly quota: FakeQuota
  ) {}

  private closed = false;

  private assertOpen(): void {
    if (this.closed) throw new DOMException('The access handle is closed.', 'InvalidStateError');
  }

  getSize(): number {
    this.assertOpen();
    return this.file.bytes.byteLength;
  }

  read(target: ArrayBufferView, options: { at: number } = { at: 0 }): number {
    this.assertOpen();
    const view = new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
    const available = Math.max(0, this.file.bytes.byteLength - options.at);
    const count = Math.min(view.byteLength, available);
    view.set(this.file.bytes.subarray(options.at, options.at + count));
    return count;
  }

  write(source: ArrayBufferView, options: { at: number } = { at: 0 }): number {
    this.assertOpen();
    const view = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    this.log.sizes.push(view.byteLength);
    this.log.maxWrite = Math.max(this.log.maxWrite, view.byteLength);
    const end = options.at + view.byteLength;
    const growth = Math.max(0, end - this.file.bytes.byteLength);
    if (this.quota.used + growth > this.quota.limit) {
      throw new DOMException('The origin quota is used up.', 'QuotaExceededError');
    }
    this.quota.used += growth;
    if (end > this.file.bytes.byteLength) {
      const grown = new Uint8Array(end);
      grown.set(this.file.bytes);
      this.file.bytes = grown;
    }
    this.file.bytes.set(view, options.at);
    return view.byteLength;
  }

  truncate(size: number): void {
    this.assertOpen();
    const next = new Uint8Array(size);
    next.set(this.file.bytes.subarray(0, Math.min(size, this.file.bytes.byteLength)));
    this.quota.used += next.byteLength - this.file.bytes.byteLength;
    this.file.bytes = next;
  }

  flush(): void {
    this.assertOpen();
  }

  close(): void {
    this.closed = true;
    this.file.locked = false;
  }
}

class FakeFileHandle {
  readonly kind = 'file';
  bytes: Uint8Array = new Uint8Array(0);
  locked = false;

  constructor(
    readonly name: string,
    private readonly log: FakeOpfsWriteLog,
    private readonly quota: FakeQuota,
    syncAccess: boolean
  ) {
    if (!syncAccess) (this as { createSyncAccessHandle?: unknown }).createSyncAccessHandle = undefined;
  }

  async createSyncAccessHandle(): Promise<FakeSyncAccessHandle> {
    if (this.locked) throw new DOMException('Another access handle is open.', 'NoModificationAllowedError');
    this.locked = true;
    return new FakeSyncAccessHandle(this, this.log, this.quota);
  }

  async getFile(): Promise<File> {
    return new File([this.bytes.slice().buffer as ArrayBuffer], this.name);
  }
}

class FakeDirectoryHandle {
  readonly kind = 'directory';
  private readonly entries = new Map<string, FakeFileHandle | FakeDirectoryHandle>();

  constructor(
    readonly name: string,
    private readonly log: FakeOpfsWriteLog,
    private readonly quota: FakeQuota,
    private readonly syncAccess: boolean
  ) {}

  /** Names of the entries in this directory. */
  entryNames(): string[] {
    return [...this.entries.keys()];
  }

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<FakeDirectoryHandle> {
    const existing = this.entries.get(name);
    if (existing instanceof FakeDirectoryHandle) return existing;
    if (existing || !options.create) throw new DOMException(`No directory ${name}.`, 'NotFoundError');
    const created = new FakeDirectoryHandle(name, this.log, this.quota, this.syncAccess);
    this.entries.set(name, created);
    return created;
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<FakeFileHandle> {
    const existing = this.entries.get(name);
    if (existing instanceof FakeFileHandle) return existing;
    if (existing || !options.create) throw new DOMException(`No file ${name}.`, 'NotFoundError');
    const created = new FakeFileHandle(name, this.log, this.quota, this.syncAccess);
    this.entries.set(name, created);
    return created;
  }

  async removeEntry(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) throw new DOMException(`No entry ${name}.`, 'NotFoundError');
    if (entry instanceof FakeFileHandle) {
      // A file with an open sync access handle cannot be removed.
      if (entry.locked) throw new DOMException(`${name} is open.`, 'NoModificationAllowedError');
      this.quota.used -= entry.bytes.byteLength;
    }
    this.entries.delete(name);
  }
}

export interface FakeOpfs {
  /** Value for `navigator`: only `storage.getDirectory` is provided. */
  navigator: { storage: { getDirectory: () => Promise<FakeDirectoryHandle> } };
  writes: FakeOpfsWriteLog;
  /** Files left in the session directory of a job (empty when the directory or its files are gone). */
  sessionFiles(jobId: string): Promise<string[]>;
  /** Bytes all files hold now. */
  usedBytes(): number;
}

export function createFakeOpfs(config: FakeOpfsConfig = {}): FakeOpfs {
  const writes: FakeOpfsWriteLog = { sizes: [], maxWrite: 0 };
  const quota = new FakeQuota(config.quotaBytes ?? Number.POSITIVE_INFINITY);
  const root = new FakeDirectoryHandle('', writes, quota, config.syncAccess ?? true);
  const getDirectory = async (): Promise<FakeDirectoryHandle> => {
    if (config.getDirectoryFails) throw new DOMException('Storage is not available.', config.getDirectoryFails);
    return root;
  };
  return {
    navigator: { storage: { getDirectory } },
    writes,
    usedBytes: () => quota.used,
    async sessionFiles(jobId: string): Promise<string[]> {
      try {
        const sessions = await (await root.getDirectoryHandle('easyconvert')).getDirectoryHandle('sessions');
        return (await sessions.getDirectoryHandle(jobId)).entryNames();
      } catch {
        return [];
      }
    },
  };
}
