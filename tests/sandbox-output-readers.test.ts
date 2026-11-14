import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * A sandboxed program may leave a link where its output belongs. Each reader below runs a stand-in that does exactly that, pointing the
 * link at a file of the host, and must refuse it (SandboxOutputKindError) instead of reading the file and handing it on. The stand-in
 * replaces the run itself (executeSandboxedBinary), so the test holds on a host whose sandbox would refuse the link already.
 */

type Run = (binary: string, args: string[], options?: unknown) => Promise<unknown>;
const plantLink = vi.hoisted(() => ({ target: '', outputOf: (_args: string[]): string => '' }));

vi.mock('../src/lib/security/process-sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/security/process-sandbox')>();
  const run: Run = async (_binary, args) => {
    const output = plantLink.outputOf(args);
    fs.symlinkSync(plantLink.target, output);
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1, sandboxed: true, sandboxType: 'host' };
  };
  return { ...actual, executeSandboxedBinary: vi.fn(run) };
});

import { convertDwgToDxf } from '../src/lib/conversions/cad-dwg';
import { convertCadWithOcct } from '../src/lib/conversions/cad-occt';
import { type1FileToOpenType } from '../src/lib/conversions/font-fontforge';
import { renderMidiToWav } from '../src/lib/conversions/midi-render';
import { convertSubtitle } from '../src/worker/subtitle-route';
import { buildPfb, circleGlyph, rectangleGlyph } from './helpers/type1-builder';

/** What a read that met the link says: the kind of the entry, never the content of the file it names. */
const REFUSED_LINK = { name: 'SandboxOutputKindError', kind: 'symbolic link' };
const SECRET_TEXT = 'HOST SECRET THAT IS NOT AN OUTPUT';
let root: string;
const environment = { ...process.env };

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-output-readers-'));
  plantLink.target = path.join(root, 'secret');
  fs.writeFileSync(plantLink.target, SECRET_TEXT);
  // A path each reader accepts as its program, and as the sound font of the MIDI renderer: the stand-in never starts either.
  for (const name of ['DWG2DXF_PATH', 'CAD_CONVERT_PATH', 'FONTFORGE_PATH', 'FLUIDSYNTH_PATH', 'MIDI_SOUNDFONT_PATH']) process.env[name] = plantLink.target;
});

afterEach(() => {
  plantLink.outputOf = () => '';
});

afterAll(() => {
  for (const name of ['DWG2DXF_PATH', 'CAD_CONVERT_PATH', 'FONTFORGE_PATH', 'FLUIDSYNTH_PATH', 'MIDI_SOUNDFONT_PATH']) {
    if (environment[name] === undefined) delete process.env[name];
    else process.env[name] = environment[name];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const after = (flag: string) => (args: string[]) => args[args.indexOf(flag) + 1];
const last = (args: string[]) => args[args.length - 1];

describe('the output of a sandboxed program that is a link to a file of the host', () => {
  it('is refused by the DWG reader', async () => {
    plantLink.outputOf = after('-o');
    const dwg = Buffer.concat([Buffer.from('AC1032'), Buffer.alloc(200)]);

    await expect(convertDwgToDxf(dwg)).rejects.toMatchObject(REFUSED_LINK);
  });

  it('is refused by the CAD kernel wrapper', async () => {
    plantLink.outputOf = last;

    await expect(convertCadWithOcct(Buffer.from('ISO-10303-21;\nEND-ISO-10303-21;\n'), 'step', 'stl')).rejects.toMatchObject(REFUSED_LINK);
  });

  it('is refused by the Type 1 font converter', async () => {
    plantLink.outputOf = last;
    const pfb = buildPfb([rectangleGlyph('.notdef', 500, 50, 400, 700), circleGlyph('O', 700, 300)]);

    await expect(type1FileToOpenType(pfb)).rejects.toMatchObject(REFUSED_LINK);
  });

  it('is refused by the MIDI renderer', async () => {
    plantLink.outputOf = after('-F');
    const midi = Buffer.concat([Buffer.from('MThd'), Buffer.from([0, 0, 0, 6, 0, 0, 0, 1, 0, 96]), Buffer.from('MTrk'), Buffer.from([0, 0, 0, 4, 0, 0xff, 0x2f, 0])]);

    await expect(renderMidiToWav(midi)).rejects.toMatchObject(REFUSED_LINK);
  });

  it('is refused by the subtitle route, which would otherwise rewrite the file the link names', async () => {
    const subtitles = path.join(root, 'subtitles.vtt');
    const cues = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhost text\n';
    fs.writeFileSync(subtitles, cues);
    plantLink.target = subtitles;
    plantLink.outputOf = last;
    const srt = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhello\n');

    try {
      await expect(
        convertSubtitle({ input: srt, src: 'srt', tgt: 'vtt', options: {}, originalFilename: 'a.srt' }, '/usr/bin/ffmpeg', () => undefined)
      ).rejects.toMatchObject(REFUSED_LINK);
    } finally {
      plantLink.target = path.join(root, 'secret');
    }

    expect(fs.readFileSync(subtitles, 'utf8')).toBe(cues);
  });
});
