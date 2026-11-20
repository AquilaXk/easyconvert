import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractZipArchive } from '../src/lib/conversions/archive';
import { convertWithNative7z } from '../src/worker/engines';

/**
 * The job store keeps an upload under a name of its own (`<digest>.bin`), so 7-Zip lists a raw compressed stream
 * (xz, bzip2, lzma, compress) and a package whose payload is one stream without a `Path`, and the name it unpacks the
 * stream to comes from that file name, not from the extension of the upload. Every such source converts to a zip of
 * the files it holds, the same as when the file carries its own extension.
 */

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'archive-sources');
const ENGINE_TIMEOUT_MS = 120_000;
const BODY = 'stream payload\n';

let work: string;

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-store-wrapper-'));
  fs.mkdirSync(path.join(work, 'tree', 'dir'), { recursive: true });
  fs.writeFileSync(path.join(work, 'tree', 'hello.txt'), BODY);
  fs.writeFileSync(path.join(work, 'tree', 'dir', 'nested.txt'), 'nested\n');
  execFileSync('tar', ['-C', path.join(work, 'tree'), '-cf', path.join(work, 'tree.tar'), '.']);
  fs.writeFileSync(path.join(work, 'body.txt'), BODY);
});

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

async function convertStored(bytes: Buffer, src: string, storedName: string, uploadName: string) {
  const inputPath = path.join(work, storedName);
  fs.writeFileSync(inputPath, bytes);
  const result = await convertWithNative7z({ inputPath }, src, 'zip', {}, uploadName);
  if (!result) throw new Error('the native engine did not take the conversion');
  const entries = await extractZipArchive(Buffer.isBuffer(result.buffer) ? result.buffer : fs.readFileSync(result.outputPath!));
  return new Map(entries.map((entry) => [entry.filename, entry.buffer.toString('utf-8')]));
}

describe.each(['abc123.bin', 'f00d.staged', 'noextension'])('input stored as %s', (storedName) => {
  it.each([
    ['xz', 'body.txt.xz', ['xz', '-kc', 'body.txt']],
    ['bz2', 'body.txt.bz2', ['bzip2', '-kc', 'body.txt']],
  ])('%s unpacks to the one file it holds', async (src, upload, command) => {
    const stream = execFileSync(command[0], command.slice(1), { cwd: work });
    const files = await convertStored(stream, src, storedName, upload);
    expect([...files.values()]).toEqual([BODY]);
  }, ENGINE_TIMEOUT_MS);

  it.each([
    ['tar.xz', ['xz', '-kc', 'tree.tar']],
    ['txz', ['xz', '-kc', 'tree.tar']],
    ['tar.bz2', ['bzip2', '-kc', 'tree.tar']],
    ['tbz2', ['bzip2', '-kc', 'tree.tar']],
  ])('%s unpacks to the members of its tar', async (src, command) => {
    const stream = execFileSync(command[0], command.slice(1), { cwd: work });
    const files = await convertStored(stream, src, storedName, `tree.${src}`);
    expect(files.get('hello.txt')).toBe(BODY);
    expect(files.get('dir/nested.txt')).toBe('nested\n');
  }, ENGINE_TIMEOUT_MS);

  it.each([
    ['lzma', 'long.txt.lzma'],
    ['z', 'long.txt.Z'],
  ])('%s unpacks to the one file it holds', async (src, fixture) => {
    const files = await convertStored(fs.readFileSync(path.join(FIXTURE_DIR, fixture)), src, storedName, fixture);
    expect(files.size).toBe(1);
  }, ENGINE_TIMEOUT_MS);

  it.each([
    ['deb', 'probe.deb'],
    ['rpm', 'probe.rpm'],
    ['deb', 'links.xz.deb'],
    ['rpm', 'links.xz.rpm'],
  ])('the %s package %s unpacks to the files it installs', async (src, fixture) => {
    const files = await convertStored(fs.readFileSync(path.join(FIXTURE_DIR, fixture)), src, storedName, fixture);
    expect(files.get('opt/probe/hello.txt') ?? files.get('opt/pkg/hello.txt')).toBe('hello archive\n');
  }, ENGINE_TIMEOUT_MS);
});
