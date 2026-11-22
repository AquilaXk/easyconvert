import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { findDecoderTool, loggableDiagnostic, readDecodedFile } from '../src/lib/conversions/image-decoder-tools';

/**
 * How the command-line decoders are found: an environment variable is authoritative and must name an absolute path of an
 * executable file; without it the standard directories are searched for each name in turn.
 */

const ENV_NAME = 'DECODER_TEST_PATH';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'decoder-tools-'));
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

const executable = path.join(directory, 'tool');
fs.writeFileSync(executable, '#!/bin/sh\n', { mode: 0o755 });
const plainFile = path.join(directory, 'plain');
fs.writeFileSync(plainFile, 'text', { mode: 0o644 });

describe('findDecoderTool', () => {
  it('takes the absolute path of an executable file from the variable', () => {
    expect(findDecoderTool(ENV_NAME, ['nonesuch'], { [ENV_NAME]: executable })).toBe(executable);
  });

  it.each([
    ['a relative path of an executable file', path.relative(process.cwd(), executable)],
    ['an absolute path of a file that is not executable', plainFile],
    ['an absolute path of a directory', directory],
    ['a path that does not exist', path.join(directory, 'missing')],
  ])('answers null for %s, without looking anywhere else', (_label, value) => {
    expect(findDecoderTool(ENV_NAME, ['env'], { [ENV_NAME]: value })).toBeNull();
  });

  it('searches the standard directories when the variable is unset or empty', () => {
    const found = findDecoderTool(ENV_NAME, ['nonesuch-tool', 'env'], {});
    expect(path.basename(found ?? '')).toBe('env');
    expect(findDecoderTool(ENV_NAME, ['env'], { [ENV_NAME]: '' })).toBe(found);
  });

  it('answers null when no name is installed', () => {
    expect(findDecoderTool(ENV_NAME, ['nonesuch-tool'], {})).toBeNull();
  });
});

describe('loggableDiagnostic', () => {
  it('drops control characters, including escape sequences and line breaks, and collapses white space', () => {
    expect(loggableDiagnostic('convert: bad \u001b[31mred\u001b[0m\r\n\u0000header\u0007 `in\'\n')).toBe("convert: bad [31mred [0m header `in'");
  });

  it('keeps at most the logged number of characters', () => {
    expect(loggableDiagnostic('x'.repeat(2000))).toHaveLength(500);
  });

  it('keeps letters of every script', () => {
    expect(loggableDiagnostic('이미지 画像 изображение')).toBe('이미지 画像 изображение');
  });
});

describe('readDecodedFile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decoded-file-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads a regular file within the limit', async () => {
    const file = path.join(dir, 'regular.png');
    fs.writeFileSync(file, 'PNG');

    expect((await readDecodedFile(file, 10, 'JXL')).toString()).toBe('PNG');
  });

  // A pipe is judged by the open descriptor: the name may have been a file when it was looked at and a pipe when it was opened.
  it('refuses a named pipe instead of reading it as an empty buffer', async () => {
    const pipe = path.join(dir, 'pipe.png');
    expect(spawnSync('mkfifo', [pipe]).status).toBe(0);

    await expect(readDecodedFile(pipe, 10, 'JXL')).rejects.toThrow('Invalid image: the JXL picture could not be decoded');
  });

  it('refuses a named pipe that took the place of the file after its name was looked at', async () => {
    const pipe = path.join(dir, 'swapped.png');
    expect(spawnSync('mkfifo', [pipe]).status).toBe(0);
    const spy = vi.spyOn(fs.promises, 'lstat').mockResolvedValue(fs.statSync(path.join(dir, 'regular.png')));
    try {
      await expect(readDecodedFile(pipe, 10, 'JXL')).rejects.toThrow('Invalid image: the JXL picture could not be decoded');
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a link', async () => {
    const link = path.join(dir, 'link.png');
    fs.symlinkSync(path.join(dir, 'regular.png'), link);

    await expect(readDecodedFile(link, 10, 'JXL')).rejects.toThrow('could not be decoded');
  });
});
