import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDockerfile } from './helpers/dockerfile';
import { skipUnless } from './helpers/strict-skip';

/**
 * The worker image carries the ONNX Korean OCR engine: the models (PaddleOCR weights, Apache-2.0, converted by RapidOCR, Apache-2.0), the
 * onnxruntime native library (MIT, built statically from libraries that have notices of their own) and the notices that go with them. The
 * npm package of onnxruntime ships no licence file, so the install script fetches them by digest and the image copies them to /licenses.
 * The expectations come from the licence terms (the text and the notices ship with what they cover) and from the pins of the script.
 */

const ROOT = path.resolve(__dirname, '..');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8');
const INSTALL_FILE = path.join(ROOT, 'scripts', 'install-onnx-ocr-models.sh');
const INSTALL = fs.readFileSync(INSTALL_FILE, 'utf-8');
const LICENSING = fs.readFileSync(path.join(ROOT, 'docs', 'licensing.md'), 'utf-8');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as { dependencies: Record<string, string> };
const stages = parseDockerfile(DOCKERFILE);
const stage = stages.find((candidate) => candidate.name === 'ocronnx');
const runner = stages[stages.length - 1];
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

const pin = (name: string): string => {
  const match = new RegExp(`^${name}="([^"]+)"$`, 'm').exec(INSTALL);
  expect(match, name).not.toBeNull();
  return match?.[1] ?? '';
};

describe('the ocronnx stage of the worker image', () => {
  it('runs the pinned install script into /opt/ocr-onnx on the base of the other stages', () => {
    expect(stage?.baseImage).toBe(stages[0].baseImage);
    const run = stage?.instructions.filter((instruction) => instruction.keyword === 'RUN').map((instruction) => instruction.argument) ?? [];
    expect(run).toContain('/tmp/install-onnx-ocr-models.sh /opt/ocr-onnx');
  });

  it('copies the models, with their licence directory and NOTICE, into the runner and then into /licenses', () => {
    const copies = runner.instructions.filter((instruction) => instruction.keyword === 'COPY').map((instruction) => instruction.argument);
    expect(copies).toContain('--from=ocronnx /opt/ocr-onnx /opt/ocr-onnx');
    const copyToLicenses = runner.instructions.find((instruction) => instruction.keyword === 'RUN' && instruction.argument.includes('/licenses/onnx-ocr.'));
    expect(copyToLicenses?.argument).toContain('cd /opt/ocr-onnx/licenses');
    expect(copyToLicenses?.argument).toContain('cp "$f" "/licenses/onnx-ocr.$f"');
    expect(copyToLicenses?.argument).toContain('cp /opt/ocr-onnx/NOTICE /licenses/onnx-ocr.NOTICE');
    // the licence copy comes after /licenses was made, by the same step that collects the other tools' notices
    const order = runner.instructions.map((instruction) => instruction.argument);
    expect(order.indexOf(copyToLicenses?.argument ?? '')).toBeGreaterThan(order.findIndex((argument) => argument.startsWith('cp /usr/share/doc/oxipng/SOURCE /licenses/')));
  });

  it('removes the native libraries of the other platforms and checks the one that is left', () => {
    const build = stages[0].instructions.filter((instruction) => instruction.keyword === 'RUN').map((instruction) => instruction.argument).join('\n');
    expect(build).toContain('rm -rf darwin win32');
    expect(build).toContain('libonnxruntime.so.1');
  });
});

describe('the install script of the ONNX OCR models', () => {
  it('pins every model file and every licence file by SHA-256, and the licence texts by the commit of a tag', () => {
    for (const name of ['DET_SHA256', 'REC_SHA256', 'DICT_SHA256', 'ORT_LICENSE_SHA256', 'ORT_NOTICES_SHA256', 'PADDLEOCR_LICENSE_SHA256', 'RAPIDOCR_LICENSE_SHA256']) {
      expect(pin(name), name).toMatch(SHA256);
    }
    for (const name of ['ORT_COMMIT', 'PADDLEOCR_COMMIT', 'RAPIDOCR_COMMIT']) expect(pin(name), name).toMatch(COMMIT);
    expect(INSTALL).toContain('raw.githubusercontent.com/microsoft/onnxruntime/${ORT_COMMIT}/LICENSE');
    expect(INSTALL).toContain('raw.githubusercontent.com/microsoft/onnxruntime/${ORT_COMMIT}/ThirdPartyNotices.txt');
    expect(INSTALL).toContain('raw.githubusercontent.com/PaddlePaddle/PaddleOCR/${PADDLEOCR_COMMIT}/LICENSE');
    expect(INSTALL).toContain('raw.githubusercontent.com/RapidAI/RapidOCR/${RAPIDOCR_COMMIT}/LICENSE');
  });

  it('keeps the onnxruntime notices in step with the version of the package it ships', () => {
    expect(PACKAGE.dependencies['onnxruntime-node']).toBe(pin('ORT_VERSION'));
  });

  it('installs the licence files named in the image copy and the licensing guide', () => {
    for (const file of ['onnxruntime.LICENSE', 'onnxruntime.ThirdPartyNotices.txt', 'paddleocr.LICENSE', 'rapidocr.LICENSE']) {
      expect(INSTALL, file).toContain(`licenses/${file}`);
      expect(LICENSING, file).toContain(`/licenses/onnx-ocr.${file}`);
    }
    expect(LICENSING).toContain('/licenses/onnx-ocr.NOTICE');
  });

  it('does not say that the licence of onnxruntime is in the npm package or in THIRD_PARTY_NOTICES', () => {
    const section = /### 2\.18 ONNX Korean OCR[\s\S]*?(?=\n### |\n---)/.exec(LICENSING)?.[0] ?? '';
    expect(section).not.toBe('');
    expect(section).not.toMatch(/node_modules\/onnxruntime-node\/LICENSE/);
    expect(section).toContain('ships neither a `LICENSE` nor the third-party notices');
  });

  const sha256Missing = skipUnless('sha256sum', spawnSync('sha256sum', ['--version'], { stdio: 'ignore' }).status === 0);
  it.skipIf(sha256Missing)('installs nothing when a download does not match its digest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onnx-ocr-install-'));
    try {
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nprintf "not the file" \nexit 0\n', { mode: 0o755 });
      const target = path.join(dir, 'out');
      const run = spawnSync('bash', [INSTALL_FILE, target], { encoding: 'utf-8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      expect(run.status).not.toBe(0);
      expect(run.stderr + run.stdout).toMatch(/FAILED|did NOT match|WARNING/i);
      expect(fs.existsSync(path.join(target, 'det.onnx'))).toBe(false);
      expect(fs.existsSync(path.join(target, 'licenses'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
