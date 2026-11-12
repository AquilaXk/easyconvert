import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { ENGINE_IDS, ENGINE_NAMES, type EngineId } from '../src/lib/conversions/engine-ids';
import { requiresNativeEngine } from '../src/lib/conversions/native-engine-pairs';
import {
  debianPackageVersion,
  describeEngines,
  engineOfResult,
  enginesForPair,
  installedEngineVersion,
  resetEngineVersionProbes,
  resolveEngineChoice,
} from '../src/worker/engine-registry';
import { EngineNotOfferedError, EngineVersionNotOfferedError } from '../src/lib/conversions/engine-errors';
import { EngineUnavailableError, typedFailureOf } from '../src/lib/types';
import { withBinaryAt, withMissingBinary } from './helpers/native-tools';

/**
 * Which engines a pair lists. The expected lists below are written from what each worker route converts (the engine of the
 * program that draws or writes the pair, and the in-process converter where it converts the pair too), not read from the registry.
 */

const listing = (src: string, tgt: string): string => enginesForPair(src, tgt).map((e) => (e.default ? `${e.id}*` : e.id)).join(' ');

describe('the engines of a pair', () => {
  it.each([
    // An office suite writes the pair and the in-process converter converts it too.
    ['docx', 'pdf', 'libreoffice* easyconvert'],
    ['rtf', 'pdf', 'libreoffice* easyconvert'],
    ['xlsx', 'ods', 'libreoffice* easyconvert'],
    // HTML prefers the office suite; text and Markdown render in-process unless their script needs the suite.
    ['html', 'pdf', 'libreoffice* easyconvert'],
    ['txt', 'pdf', 'easyconvert* libreoffice'],
    ['md', 'pdf', 'easyconvert* libreoffice'],
    // Only the office suite writes these, or draws these sources.
    ['docx', 'doc', 'libreoffice*'],
    ['docx', 'jpg', 'libreoffice*'],
    ['key', 'pdf', 'libreoffice*'],
    ['csv', 'xls', 'libreoffice*'],
    ['pdf', 'doc', 'libreoffice*'],
    // Page images of a text source are drawn by Poppler from the PDF the converter writes.
    ['txt', 'jpg', 'poppler*'],
    ['pdf', 'png', 'poppler*'],
    ['pdf', 'tiff', 'poppler*'],
    ['pdf', 'txt', 'poppler* easyconvert'],
    ['pdf', 'svg', 'poppler*'],
    ['eps', 'pdf', 'ghostscript*'],
    ['ps', 'png', 'ghostscript*'],
    ['xps', 'pdf', 'ghostxps*'],
    ['djvu', 'pdf', 'djvulibre*'],
    ['pdf', 'mobi', 'calibre*'],
    ['docx', 'azw3', 'calibre*'],
    ['srt', 'vtt', 'ffmpeg*'],
    ['mp3', 'wav', 'ffmpeg*'],
    ['mp4', 'webm', 'ffmpeg*'],
    ['wav', 'flac', 'ffmpeg* easyconvert'],
    ['flac', 'wav', 'ffmpeg* easyconvert'],
    ['svg', 'pdf', 'librsvg* easyconvert'],
    ['zip', 'tar', '7zip* easyconvert'],
    ['tar', 'gz', '7zip* easyconvert'],
    ['rar', 'zip', '7zip*'],
    ['iso', 'zip', '7zip*'],
    ['7z', 'tar', '7zip* easyconvert'],
    ['zip', 'zst', 'easyconvert*'],
    ['cr2', 'jpg', 'libraw*'],
    // The Sigma and Raspberry Pi frames are decoded in-process.
    ['x3f', 'jpg', 'easyconvert*'],
    // No program converts these: the converter is the only engine.
    ['png', 'jpg', 'easyconvert*'],
    ['csv', 'json', 'easyconvert*'],
    ['mp3', 'zip', 'easyconvert*'],
    ['woff2', 'ttf', 'easyconvert*'],
  ])('%s to %s lists %s', (src, tgt, expected) => {
    expect(listing(src, tgt)).toBe(expected);
  });

  it('lists nothing for a pair the registry does not offer', () => {
    expect(enginesForPair('png', 'docx')).toEqual([]);
    expect(enginesForPair('nope', 'pdf')).toEqual([]);
  });

  it('lists every pair of the registry with ids of the catalogue, one default, first, and the converter only where no engine is required', () => {
    let pairs = 0;
    for (const [src, def] of Object.entries(FORMAT_REGISTRY)) {
      for (const tgt of def.targetFormats) {
        pairs += 1;
        const engines = enginesForPair(src, tgt);
        const ids = engines.map((e) => e.id);
        expect(engines.length, `${src} -> ${tgt}`).toBeGreaterThan(0);
        expect(new Set(ids).size, `${src} -> ${tgt}`).toBe(ids.length);
        expect(ids.every((id) => ENGINE_IDS.includes(id)), `${src} -> ${tgt}`).toBe(true);
        expect(engines.map((e) => e.default), `${src} -> ${tgt}`).toEqual(engines.map((_, i) => i === 0));
        if (requiresNativeEngine(src, tgt)) expect(ids, `${src} -> ${tgt}`).not.toContain('easyconvert');
      }
    }
    expect(pairs).toBeGreaterThan(2000);
  });

  it('names each engine once with a display name', () => {
    expect(ENGINE_IDS).toHaveLength(Object.keys(ENGINE_NAMES).length);
    expect(ENGINE_IDS).toEqual(expect.arrayContaining(['easyconvert', 'libreoffice', 'ffmpeg', 'poppler', '7zip', 'ghostscript', 'ghostxps', 'djvulibre', 'calibre', 'librsvg', 'libraw']));
  });
});

describe('the engine named by a result', () => {
  it.each<[string, string, string | undefined, boolean, EngineId]>([
    ['docx', 'pdf', 'native-soffice', true, 'libreoffice'],
    ['docx', 'pdf', 'native-soffice-pool', true, 'libreoffice'],
    ['docx', 'jpg', 'native-poppler', true, 'libreoffice'],
    ['docx', 'pdf', 'internal-fallback', true, 'easyconvert'],
    ['pdf', 'png', 'native-poppler', true, 'poppler'],
    ['zip', 'tar', 'native-7z', true, '7zip'],
    ['png', 'jpg', 'internal-fallback', true, 'easyconvert'],
    ['x3f', 'jpg', 'in-process-raw', true, 'easyconvert'],
    // The media converter runs FFmpeg itself, so the in-process result of a media pair is FFmpeg's unless FFmpeg was off.
    ['mp4', 'gif', 'internal-fallback', true, 'ffmpeg'],
    ['mp4', 'gif', 'internal-fallback', false, 'easyconvert'],
    ['wav', 'flac', 'internal-fallback', false, 'easyconvert'],
  ])('%s to %s with %s (FFmpeg on: %s) is %s', (src, tgt, used, ffmpegOn, expected) => {
    expect(engineOfResult(src, tgt, used, ffmpegOn)).toBe(expected);
  });
});

describe('the version of an engine', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-registry-'));
  const script = (name: string, body: string): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  afterEach(() => resetEngineVersionProbes());

  // The first line each program prints, as the versions of the worker image and of a developer machine print it.
  it.each<[string, EngineId, string, string]>([
    ['SOFFICE_PATH', 'libreoffice', 'echo "LibreOffice 25.2.3.2 520(Build:2)"', '25.2.3.2'],
    ['FFMPEG_PATH', 'ffmpeg', 'echo "ffmpeg version 7.1.1-1 Copyright (c) 2000-2025 the FFmpeg developers"', '7.1.1'],
    ['FFMPEG_PATH', 'ffmpeg', 'echo "ffmpeg version n8.0 Copyright (c) 2000-2025 the FFmpeg developers"', '8.0'],
    ['PDFTOPPM_PATH', 'poppler', 'echo "pdftoppm version 25.03.0" >&2; echo "Copyright 2005-2025 The Poppler Developers" >&2', '25.03.0'],
    ['P7ZIP_PATH', '7zip', 'echo; echo "7-Zip (z) 26.01 (x64) : Copyright (c) 1999-2026 Igor Pavlov : 2026-01-26"', '26.01'],
    ['P7ZIP_PATH', '7zip', 'echo "7-Zip [64] 16.02 : Copyright (c) 1999-2016 Igor Pavlov : 2016-05-21"', '16.02'],
    ['GXPS_PATH', 'ghostxps', 'echo "Usage: gxps [option* file]+..."; echo "Version: 10.05.1"; exit 1', '10.05.1'],
    ['DDJVU_PATH', 'djvulibre', 'echo "DDJVU --- DjVuLibre-3.5.28" >&2; echo "DjVu decompression utility" >&2', '3.5.28'],
    ['EBOOK_CONVERT_PATH', 'calibre', 'echo "ebook-convert (calibre 7.26.0)"', '7.26.0'],
    ['RSVG_CONVERT_PATH', 'librsvg', 'echo "rsvg-convert version 2.60.0"', '2.60.0'],
  ])('reads %s of %s from the program (%s)', async (envVar, engine, body, expected) => {
    const binary = script(`probe-${engine}`, body);
    expect(await withBinaryAt(envVar, binary, () => installedEngineVersion(engine))).toBe(expected);
  });

  it('reads Ghostscript from the gs that sits next to ps2pdf', async () => {
    const gsDir = fs.mkdtempSync(path.join(dir, 'gs-'));
    fs.writeFileSync(path.join(gsDir, 'gs'), '#!/bin/sh\necho 10.05.1\n', { mode: 0o755 });
    const ps2pdf = path.join(gsDir, 'ps2pdf');
    fs.writeFileSync(ps2pdf, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(await withBinaryAt('PS2PDF_PATH', ps2pdf, () => installedEngineVersion('ghostscript'))).toBe('10.05.1');
  });

  it('is the release version for the in-process converter and absent for a program that is not installed', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')) as { version: string };
    expect(await installedEngineVersion('easyconvert')).toBe(pkg.version);
    expect(await withMissingBinary('SOFFICE_PATH', () => installedEngineVersion('libreoffice'))).toBeUndefined();
  });

  it('is absent for a program that prints no version, and is asked again later', async () => {
    const binary = script('probe-silent', 'echo "nothing to see"');
    expect(await withBinaryAt('RSVG_CONVERT_PATH', binary, () => installedEngineVersion('librsvg'))).toBeUndefined();
  });

  it('reads LibRaw from the debian package, as its program prints none', () => {
    const status = path.join(dir, 'dpkg-status');
    fs.writeFileSync(status, 'Package: libraw23t64\nVersion: 0.21.1-9\n\nPackage: libraw-bin\nStatus: install ok installed\nVersion: 1:0.21.4-2+b1\nArchitecture: arm64\n\nPackage: zlib\nVersion: 1:1.3\n');
    expect(debianPackageVersion('libraw-bin', status)).toBe('0.21.4');
    expect(debianPackageVersion('absent-package', status)).toBeUndefined();
    expect(debianPackageVersion('libraw-bin', path.join(dir, 'no-such-file'))).toBeUndefined();
  });

  it('lists every engine with its installed state', async () => {
    const engines = await describeEngines();
    expect(engines.map((e) => e.id)).toEqual([...ENGINE_IDS]);
    expect(engines.find((e) => e.id === 'easyconvert')).toMatchObject({ installed: true, name: ENGINE_NAMES.easyconvert });
    const missing = await withMissingBinary('SOFFICE_PATH', async () => (await describeEngines()).find((e) => e.id === 'libreoffice'));
    expect(missing?.installed).toBe(false);
    expect(missing).not.toHaveProperty('version');
  });
});

describe('the choice of an engine for a pair', () => {
  beforeAll(() => resetEngineVersionProbes());
  const rejection = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (err: unknown) => err);

  it('is nothing when the request names no engine and no version', async () => {
    expect(await resolveEngineChoice('docx', 'pdf', {})).toBeUndefined();
  });

  it('accepts an engine the pair lists', async () => {
    expect(await resolveEngineChoice('png', 'jpg', { engine: 'easyconvert' })).toEqual({ engine: 'easyconvert' });
  });

  it('accepts the installed version of the engine, and refuses any other with the installed one named', async () => {
    const installed = await installedEngineVersion('easyconvert');
    expect(await resolveEngineChoice('png', 'jpg', { engine: 'easyconvert', engineVersion: installed })).toMatchObject({ engine: 'easyconvert' });
    const err = await rejection(resolveEngineChoice('png', 'jpg', { engine: 'easyconvert', engineVersion: '99.0.0' }));
    expect(err).toBeInstanceOf(EngineVersionNotOfferedError);
    expect(typedFailureOf(err)).toEqual({ status: 422, code: 'engine_version_unavailable' });
    expect((err as EngineVersionNotOfferedError).installedVersion).toBe(installed);
    expect((err as Error).message).toContain(installed);
  });

  it('refuses an engine the pair does not list with the engines it does, the default first', async () => {
    const err = await rejection(resolveEngineChoice('png', 'jpg', { engine: 'libreoffice' }));
    expect(err).toBeInstanceOf(EngineNotOfferedError);
    expect(typedFailureOf(err)).toEqual({ status: 422, code: 'engine_not_offered' });
    expect((err as EngineNotOfferedError).engines).toEqual(['easyconvert']);
    expect((err as Error).message).toContain('easyconvert');
    const office = await rejection(resolveEngineChoice('docx', 'pdf', { engine: 'ffmpeg' }));
    expect((office as EngineNotOfferedError).engines).toEqual(['libreoffice', 'easyconvert']);
  });

  it('refuses an engine id nobody knows, and a version without an engine', async () => {
    const unknown = await rejection(resolveEngineChoice('docx', 'pdf', { engine: 'word' }));
    expect(unknown).toBeInstanceOf(EngineNotOfferedError);
    expect((unknown as EngineNotOfferedError).engines).toEqual(['libreoffice', 'easyconvert']);
    expect((unknown as Error).message).toContain("'word'");
    const bare = await rejection(resolveEngineChoice('docx', 'pdf', { engineVersion: '1.0' }));
    expect(typedFailureOf(bare)).toEqual({ status: 422, code: 'engine_not_offered' });
    expect((bare as EngineNotOfferedError).engines).toEqual(['libreoffice', 'easyconvert']);
  });

  it('answers the missing-tool refusal for a listed engine whose program is not installed', async () => {
    const err = await withMissingBinary('SOFFICE_PATH', () => rejection(resolveEngineChoice('docx', 'pdf', { engine: 'libreoffice' })));
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect(typedFailureOf(err)).toEqual({ status: 503, code: 'engine_unavailable' });
  });

  it('puts the engines of a refusal in the problem fields of the error class', async () => {
    const err = await rejection(resolveEngineChoice('png', 'jpg', { engine: 'ffmpeg' }));
    expect((err as EngineNotOfferedError).problemExtensions).toEqual({ engines: ['easyconvert'] });
  });
});
