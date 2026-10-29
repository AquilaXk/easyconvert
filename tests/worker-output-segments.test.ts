import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeOutputSegments } from '../src/worker/worker-output';

/**
 * The file route writes the byte ranges of a converted archive to the output file. The file must hold the ranges joined,
 * in order, whatever the number of ranges, empty ones among them, and whatever the kernel accepts of a call.
 */
const SEGMENT_COUNT = 2500;
const MEMBER_BYTES = 700;

let workDir = '';
let outputPath = '';

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-output-segments-'));
  outputPath = path.join(workDir, 'out.tar');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Ranges of different lengths, some empty, each filled with a byte that tells it from its neighbours. */
function manySegments(): Uint8Array[] {
  return Array.from({ length: SEGMENT_COUNT }, (_, index) => {
    const length = index % 7 === 0 ? 0 : (index * 37) % MEMBER_BYTES;
    return Buffer.alloc(length, index % 251);
  });
}

function write(segments: readonly Uint8Array[]): Buffer {
  const written = writeOutputSegments(segments, 'tar', undefined, { outputPath });
  expect(written).toBe(outputPath);
  return fs.readFileSync(outputPath);
}

describe('writeOutputSegments', () => {
  it('writes the ranges joined, in order, empty ones included, with one call for the whole list', () => {
    const segments = manySegments();
    const writev = vi.spyOn(fs, 'writevSync');

    expect(write(segments).equals(Buffer.concat(segments))).toBe(true);
    expect(writev).toHaveBeenCalledTimes(1);
    expect(writev.mock.calls[0][1]).toHaveLength(SEGMENT_COUNT);
  });

  it('writes an empty output as an empty file', () => {
    expect(write([])).toHaveLength(0);
  });

  it.each([
    ['inside a range', (segments: Uint8Array[]) => segments[0].byteLength + segments[1].byteLength + 5],
    ['at the end of a range', (segments: Uint8Array[]) => segments[0].byteLength + segments[1].byteLength],
    ['after a single byte', () => 1],
  ])('continues where a short write stopped, %s', (_name, acceptedBytes) => {
    const segments = manySegments();
    const writev = fs.writevSync;
    let shortened = 0;
    vi.spyOn(fs, 'writevSync').mockImplementation((fd, buffers, position) => {
      if (shortened > 0) return writev(fd, buffers, position ?? undefined);
      shortened++;
      let remaining = acceptedBytes(buffers as Uint8Array[]);
      const accepted: Uint8Array[] = [];
      for (const buffer of buffers) {
        const view = new Uint8Array(buffer.buffer, buffer.byteOffset, Math.min(buffer.byteLength, remaining));
        accepted.push(view);
        remaining -= view.byteLength;
      }
      return writev(fd, accepted, position ?? undefined);
    });

    expect(write(segments).equals(Buffer.concat(segments))).toBe(true);
    expect(shortened).toBe(1);
  });

  it('continues after short writes on every call', () => {
    const segments = manySegments().slice(0, 60);
    const writev = fs.writevSync;
    vi.spyOn(fs, 'writevSync').mockImplementation((fd, buffers, position) => {
      const first = buffers.find((buffer) => buffer.byteLength > 0) as Uint8Array;
      const one = new Uint8Array(first.buffer, first.byteOffset, Math.min(first.byteLength, 3));
      return writev(fd, [one], position ?? undefined);
    });

    expect(write(segments).equals(Buffer.concat(segments))).toBe(true);
  });

  it('writes ranges that are all empty as an empty file', () => {
    expect(write([Buffer.alloc(0), Buffer.alloc(0)])).toHaveLength(0);
  });

  it('throws what the write threw and closes the file', () => {
    const failure = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    vi.spyOn(fs, 'writevSync').mockImplementation(() => {
      throw failure;
    });
    const close = vi.spyOn(fs, 'closeSync');

    expect(() => writeOutputSegments([Buffer.from('data')], 'tar', undefined, { outputPath })).toThrow(failure);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('throws the failure of the call that follows a short write, keeps what the first call wrote, and closes the file once', () => {
    const failure = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    const segments = [Buffer.from('first range'), Buffer.from('second range')];
    const writev = fs.writevSync;
    let calls = 0;
    vi.spyOn(fs, 'writevSync').mockImplementation((fd, buffers, position) => {
      calls++;
      if (calls > 1) throw failure;
      return writev(fd, [new Uint8Array(buffers[0].buffer, buffers[0].byteOffset, 5)], position ?? undefined);
    });
    const close = vi.spyOn(fs, 'closeSync');

    expect(() => writeOutputSegments(segments, 'tar', undefined, { outputPath })).toThrow(failure);

    expect(calls).toBe(2);
    expect(close).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(outputPath).toString()).toBe('first');
  });

  it('throws when a write reports more bytes than were pending, and closes the file', () => {
    const writev = vi.spyOn(fs, 'writevSync').mockReturnValue(100);
    const close = vi.spyOn(fs, 'closeSync');

    expect(() => writeOutputSegments([Buffer.from('data'), Buffer.from('more')], 'tar', undefined, { outputPath })).toThrow(/more bytes written than were pending/);
    expect(writev).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('throws when a write accepts no bytes while some are pending, and closes the file', () => {
    const SPIN_LIMIT = 100;
    const writev = vi.spyOn(fs, 'writevSync').mockImplementation(() => {
      if (writev.mock.calls.length > SPIN_LIMIT) throw new Error('the write was repeated without progress');
      return 0;
    });
    const close = vi.spyOn(fs, 'closeSync');

    expect(() => writeOutputSegments([Buffer.alloc(0), Buffer.from('data')], 'tar', undefined, { outputPath })).toThrow(/accepted no bytes/);
    expect(writev).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
