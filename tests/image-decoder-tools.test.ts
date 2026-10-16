import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findDecoderTool } from '../src/lib/conversions/image-decoder-tools';

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
