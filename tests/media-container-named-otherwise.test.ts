import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { probeInput, resolveFfprobeBinary } from '../src/lib/conversions/media-ffprobe';
import { openMediaInput } from '../src/lib/conversions/media-process';
import { requireOracleTool } from './helpers/differential-oracle';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Real files whose container is not the one their name says, taken from the FFmpeg test suite and samples: Argonaut ASF
 * under `.asf`, an AIFF file under `.caf`, an Electronic Arts file under `.mpc`, an LMLM4 stream under `.divx` and a
 * transport stream under `.mpg`. FFmpeg's own probe reads each of them (the oracle: `ffprobe` with no demuxer given names
 * the container), so a conversion that forces the demuxers of the declared format must list the container the bytes are.
 */

const skip = skipWithoutTools('ffmpeg', 'ffprobe');
const CONVERSION_TIMEOUT_MS = 120_000;
const MIN_OUTPUT_SECONDS = 0.1;

interface MislabeledCase {
  id: string;
  format: string;
  container: string;
  target: string;
}

const CASES: readonly MislabeledCase[] = [
  { id: 'fate-cbk2_cut.asf', format: 'asf', container: 'argo_asf', target: 'mp4' },
  { id: 'ffs-sms-received5.caf', format: 'caf', container: 'aiff', target: 'flac' },
  { id: 'fate-thx_logo.mpc', format: 'mpc', container: 'ea', target: 'flac' },
  { id: 'fate-lmlm4_cifat30fps.divx', format: 'divx', container: 'lmlm4', target: 'mp4' },
  { id: 'fate-t.mpg', format: 'mpg', container: 'mpegts', target: 'flac' },
];

function ffprobeValue(file: string, entry: string, ...extra: string[]): string {
  return execFileSync(requireOracleTool('ffprobe'), ['-v', 'error', ...extra, '-show_entries', entry, '-of', 'csv=p=0', file], { encoding: 'utf-8' }).trim();
}

describe.skipIf(skip)('a media file of another container than its name says', () => {
  for (const { id, format, container, target } of CASES) {
    it(`reads ${id} (.${format}) as the ${container} container FFmpeg's own probe finds`, async (ctx) => {
      const sample = await requireRealworldSample(ctx, id);
      expect(ffprobeValue(sample.path, 'format=format_name')).toBe(container);
      const input = openMediaInput(sample.path, format);
      expect(input.demuxers).toContain(container);
      expect(probeInput(input, resolveFfprobeBinary()).streams.length).toBeGreaterThan(0);
    });

    it(`converts ${id} (.${format}) to ${target}`, async (ctx) => {
      const sample = await requireRealworldSample(ctx, id);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-mislabeled-'));
      try {
        const output = path.join(dir, `out.${target}`);
        const result = await dispatchConversion(sample.bytes, format, target, {}, id);
        fs.writeFileSync(output, result.buffer);
        expect(Number(ffprobeValue(output, 'format=duration'))).toBeGreaterThan(MIN_OUTPUT_SECONDS);
        expect(ffprobeValue(output, 'stream=codec_type', '-select_streams', 'a')).toContain('audio');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, CONVERSION_TIMEOUT_MS);
  }
});
