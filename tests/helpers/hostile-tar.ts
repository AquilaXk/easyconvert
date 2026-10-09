import { execFileSync } from 'node:child_process';

/**
 * Byte-level tar builder for hostile fixtures that a tar tool would refuse to write: a header whose magic or prefix
 * the system tar would not emit, a mode with the setuid bit, bytes hidden behind the end-of-archive blocks. The
 * results are read back with Python's tarfile, an independent reader.
 */
const BLOCK = 512;
const CHECKSUM_OFFSET = 148;
const CHECKSUM_LENGTH = 8;
const READ_BUFFER_BYTES = 256 * 1024 * 1024;

export interface HostileTarHeader {
  name: string;
  /** Size field value; `hostileTarMember` fills in the body length when this is absent. */
  size?: number;
  /** One-character type flag; `0` is a regular file, `5` a directory. */
  typeflag?: string;
  mode?: number;
  /** The six bytes at offset 257; an empty string leaves a v7 header with no magic. */
  magic?: string;
  /** The two bytes at offset 263. */
  version?: string;
  /** The ustar prefix field at offset 345. */
  prefix?: string;
  mtime?: number;
}

function octalField(value: number, digits: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(digits, '0')}\0`, 'ascii');
}

/** One 512-byte header with a correct checksum. */
export function hostileTarHeader(spec: HostileTarHeader): Buffer {
  const header = Buffer.alloc(BLOCK);
  header.write(spec.name, 0, 100, 'utf8');
  octalField(spec.mode ?? 0o644, 7).copy(header, 100);
  octalField(0, 7).copy(header, 108);
  octalField(0, 7).copy(header, 116);
  octalField(spec.size ?? 0, 11).copy(header, 124);
  octalField(spec.mtime ?? 1_614_834_360, 11).copy(header, 136);
  header.fill(0x20, CHECKSUM_OFFSET, CHECKSUM_OFFSET + CHECKSUM_LENGTH);
  header.write(spec.typeflag ?? '0', 156, 1, 'ascii');
  header.write(spec.magic ?? 'ustar\0', 257, 6, 'latin1');
  header.write(spec.version ?? '00', 263, 2, 'latin1');
  if (spec.prefix !== undefined) header.write(spec.prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `, 'ascii').copy(header, CHECKSUM_OFFSET);
  return header;
}

function padded(body: Buffer): Buffer {
  return Buffer.concat([body, Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK)]);
}

/** A member: header and padded body. */
export function hostileTarMember(spec: HostileTarHeader, body: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([hostileTarHeader({ size: body.length, ...spec }), padded(body)]);
}

export function hostileTarEnd(): Buffer {
  return Buffer.alloc(2 * BLOCK);
}

export interface PythonTarEntry {
  name: string;
  type: string;
  size: number;
  mode: number;
}

const PY_LIST = [
  'import sys, json, tarfile, io',
  'with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()), ignore_zeros=sys.argv[1] == "1") as t:',
  '    print(json.dumps([{"name": m.name, "type": m.type.decode(), "size": m.size, "mode": m.mode} for m in t]))',
].join('\n');

const PY_MEMBER = [
  'import sys, tarfile, io',
  'with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read())) as t:',
  '    sys.stdout.buffer.write(t.extractfile(sys.argv[1]).read())',
].join('\n');

/**
 * The members Python's tarfile finds. With `ignoreZeros` it reads past end-of-archive blocks, as a consumer that
 * joins archives does, so data hidden behind the terminator shows up.
 */
export function pythonTarEntries(tar: Buffer, options: { ignoreZeros?: boolean } = {}): PythonTarEntry[] {
  const out = execFileSync('python3', ['-c', PY_LIST, options.ignoreZeros ? '1' : '0'], { input: tar, encoding: 'utf8', maxBuffer: READ_BUFFER_BYTES });
  return JSON.parse(out) as PythonTarEntry[];
}

export function pythonTarMember(tar: Buffer, name: string): Buffer {
  return execFileSync('python3', ['-c', PY_MEMBER, name], { input: tar, maxBuffer: READ_BUFFER_BYTES });
}
