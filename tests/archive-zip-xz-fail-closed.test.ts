import { describe, expect, it } from 'vitest';
import { extractZipArchive, extractXzArchive } from '../src/lib/conversions/archive';
import { ConversionFailedError, ArchiveEntryCollisionError, DecompressionLimitError, EngineUnavailableError } from '../src/lib/types';
import node_child_process from 'node:child_process';
import node_fs from 'node:fs';
import node_os from 'node:os';
import node_path from 'node:path';

function createTempDir(): string {
  const dir = node_path.join(node_os.tmpdir(), `test_zip_xz_${Math.random().toString(36).slice(2)}`);
  node_fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function craftZipWithCentralDir(filename: string, entries: { name: string, data?: string, isSymlink?: boolean }[]): Buffer {
  // We'll just use the system zip for basic files, but to inject evil paths we can't easily use system zip.
  // Actually, wait, node's JSZip or a python script can easily craft these.
  const pythonScript = `
import zipfile
import sys

with zipfile.ZipFile(sys.argv[1], 'w') as zf:
    for arg in sys.argv[2:]:
        parts = arg.split(':', 1)
        name = parts[0]
        data = parts[1] if len(parts) > 1 else 'data'
        info = zipfile.ZipInfo(name)
        if name.startswith("SYMLINK|"):
            info.filename = name.split('|')[1]
            info.create_system = 3 # Unix
            info.external_attr = 0xA0000000
            zf.writestr(info, data)
        else:
            zf.writestr(info, data)
`;
  const dir = createTempDir();
  const scriptPath = node_path.join(dir, 'craft.py');
  node_fs.writeFileSync(scriptPath, pythonScript);
  const outPath = node_path.join(dir, filename);
  const args = entries.map(e => `${e.isSymlink ? 'SYMLINK|' : ''}${e.name}:${e.data || 'data'}`);
  node_child_process.execFileSync('python3', [scriptPath, outPath, ...args]);
  const buf = node_fs.readFileSync(outPath);
  node_fs.rmSync(dir, { recursive: true, force: true });
  return buf;
}

function createXz(data: string, options: string[]): Buffer {
  const dir = createTempDir();
  const inFile = node_path.join(dir, 'in.txt');
  const outFile = node_path.join(dir, 'out.xz');
  node_fs.writeFileSync(inFile, data);
  node_child_process.execFileSync('xz', ['-z', '--stdout', ...options, inFile], { stdio: ['ignore', node_fs.openSync(outFile, 'w'), 'ignore'] });
  const buf = node_fs.readFileSync(outFile);
  node_fs.rmSync(dir, { recursive: true, force: true });
  return buf;
}

describe('ZIP extraction hardening', () => {
  it('fails closed on directory traversal (..)', () => {
    const buf = craftZipWithCentralDir('test.zip', [{ name: 'a/../b' }]);
    expect(() => extractZipArchive(buf)).toThrow(ConversionFailedError);
  });

  it('fails closed on absolute paths', () => {
    const buf = craftZipWithCentralDir('test.zip', [{ name: '/etc/x' }]);
    expect(() => extractZipArchive(buf)).toThrow(ConversionFailedError);
  });

  it('fails closed on drive prefixes', () => {
    const buf = craftZipWithCentralDir('test.zip', [{ name: 'C:\\x' }]);
    expect(() => extractZipArchive(buf)).toThrow(ConversionFailedError);
  });

  it('fails closed on duplicate names', () => {
    const buf = craftZipWithCentralDir('test.zip', [{ name: 'dup.txt' }, { name: 'dup.txt' }]);
    expect(() => extractZipArchive(buf)).toThrow(ArchiveEntryCollisionError);
  });

  it('fails closed on symlinks', () => {
    const buf = craftZipWithCentralDir('test.zip', [{ name: 'link', isSymlink: true }]);
    expect(() => extractZipArchive(buf)).toThrow(ConversionFailedError);
  });
});

describe('XZ extraction hardening', () => {
  const testData = 'xz test data string '.repeat(500);

  it.each([
    ['CRC32', ['-C', 'crc32']],
    ['CRC64', ['-C', 'crc64']],
    ['SHA-256', ['-C', 'sha256']],
    ['Multi-block CRC64', ['-T0', '--block-size=1024', '-C', 'crc64']],
    ['x86 BCJ', ['--x86', '--lzma2']],
    ['Delta', ['--delta', '--lzma2']],
  ])('decodes %s byte-identical to xz -dc', (name, opts) => {
    const buf = createXz(testData, opts);
    const extracted = extractXzArchive(buf);
    expect(extracted).toHaveLength(1);
    expect(extracted[0].buffer.toString()).toBe(testData);
  });

  it('decodes concatenated .xz files', () => {
    const buf1 = createXz('hello', ['-C', 'crc32']);
    const buf2 = createXz(' world', ['-C', 'crc64']);
    const concat = Buffer.concat([buf1, buf2]);
    const extracted = extractXzArchive(concat);
    // Since our extractor outputs an array of files, for XZ it typically returns one file.
    // Concatenated streams should be treated as one single stream of data output, or multiple depending on design.
    // Usually xz -dc concatenates the uncompressed output.
    expect(extracted[0].buffer.toString()).toBe('hello world');
  });
});
