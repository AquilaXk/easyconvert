import fs from 'node:fs';
import { bdRate, type RdPoint } from '../bd-rate';
import { BITS_PER_BYTE, BITS_PER_KILOBIT } from '../config';
import { convertWithProject } from '../convert';
import type { FamilyRunner } from '../context';
import { OutputIntegrityError } from '../errors';
import { decodedPcmHash, fileSize, measureAudioSnr, measureLoudness, probeFile } from '../measure';
import type { BenchRow } from '../report';
import { numberRecord } from '../ref-cache';
import { measuredRow, type MetricSpec, skippedGroup, SPEC, throughputRow } from '../rows';
import { runTool } from '../tools';

/**
 * Audio family: wav to Opus and AAC at four bit rates (SNR against the source, loudness and true-peak drift,
 * BD-rate against ffmpeg's libopus and aac encoders at the same rates) and to FLAC (bit-exact decode, size against
 * ffmpeg's flac encoder).
 */

interface Source {
  file: string;
  /** Four bit rates in kbit/s, low to high; the second one is the headline point. */
  bitratesK: readonly [number, number, number, number];
}

const SOURCES: readonly Source[] = [
  { file: 'music.wav', bitratesK: [48, 64, 96, 128] },
  { file: 'speech.wav', bitratesK: [16, 24, 32, 48] },
];

interface LossyTarget {
  target: 'opus' | 'aac';
  codec: 'opus' | 'aac';
  tool: string;
  encoderArgs: readonly string[];
}

const LOSSY: readonly LossyTarget[] = [
  { target: 'opus', codec: 'opus', tool: 'ffmpeg libopus', encoderArgs: ['-c:a', 'libopus'] },
  { target: 'aac', codec: 'aac', tool: 'ffmpeg aac', encoderArgs: ['-c:a', 'aac', '-f', 'adts'] },
];

/** ffmpeg's flac encoder default, which is the level the project's FLAC path uses. */
const FLAC_COMPRESSION_LEVEL = '5';
const HEADLINE_INDEX = 1;
const LOSSY_SPECS: readonly MetricSpec[] = [SPEC.snr, SPEC.loudnessShift, SPEC.truePeakShift, SPEC.bitrate, SPEC.bdRateSnr, SPEC.throughput];
const FLAC_SPECS: readonly MetricSpec[] = [SPEC.losslessExact, SPEC.bytes, SPEC.throughput];

interface Encoded {
  kbps: number;
  snr: number;
  loudnessShift: number;
  truePeakShift: number;
}

const parseEncoded = numberRecord(['kbps', 'snr', 'loudnessShift', 'truePeakShift']);
const parseFlac = numberRecord(['bytes', 'exact']);

export const runAudio: FamilyRunner = async (ctx) => {
  const rows: BenchRow[] = [];
  for (const source of SOURCES) {
    const sourceFile = ctx.corpusPath(source.file);
    const input = ctx.corpusBuffer(source.file);

    for (const lossy of LOSSY) {
      const caseName = `${source.file}->${lossy.target}`;
      if (!ctx.inScope('audio', caseName)) continue;
      const plan = ctx.plan(['ffmpeg', 'ffprobe'], caseName);
      if (!plan.ok) {
        rows.push(...skippedGroup('audio', caseName, LOSSY_SPECS, lossy.tool, plan));
        continue;
      }
      ctx.log(`audio ${caseName}`);
      const ffmpeg = plan.paths.ffmpeg;

      const referenceEncode = (kbps: number, output: string): void => {
        runTool(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', sourceFile, '-vn', '-map_metadata', '-1', ...lossy.encoderArgs, '-b:a', `${kbps}k`, output]);
      };
      const oursEncode = async (kbps: number): Promise<Buffer> => {
        const out = await convertWithProject(input, 'wav', lossy.target, { audio: { codec: lossy.codec, bitrateK: kbps } }, source.file);
        return out.buffer;
      };

      if (ctx.quality) {
        const sourceProbe = probeFile(plan.paths.ffprobe, sourceFile).streams[0];
        const sampleRate = Number(sourceProbe.sample_rate);
        const channels = sourceProbe.channels ?? 1;
        const sourceLoudness = measureLoudness(ffmpeg, sourceFile);
        const measure = (file: string): Encoded => {
          const seconds = Number(probeFile(plan.paths.ffprobe, file).format.duration);
          const loudness = measureLoudness(ffmpeg, file);
          return {
            kbps: (fileSize(file) * BITS_PER_BYTE) / seconds / BITS_PER_KILOBIT,
            snr: measureAudioSnr(ffmpeg, file, sourceFile, sampleRate, channels),
            loudnessShift: Math.abs(loudness.integrated - sourceLoudness.integrated),
            truePeakShift: loudness.truePeak - sourceLoudness.truePeak,
          };
        };

        const ours: Encoded[] = [];
        const reference: Encoded[] = [];
        for (const kbps of source.bitratesK) {
          const oursFile = ctx.scratch(`ours-${kbps}k.${lossy.target}`);
          fs.writeFileSync(oursFile, await oursEncode(kbps));
          ours.push(measure(oursFile));
          // The reference encode and its measurements are functions of ffmpeg, the source and the rate alone.
          reference.push(
            await ctx.refCache.value(
              'audio',
              { kind: 'encode-measure', tools: ['ffmpeg', 'ffprobe'], files: [source.file], settings: { case: caseName, kbps, encoder: lossy.encoderArgs.join(' ') } },
              parseEncoded,
              () => {
                const refFile = ctx.scratch(`ref-${kbps}k.${lossy.target}`);
                referenceEncode(kbps, refFile);
                return measure(refFile);
              }
            )
          );
        }

        const o = ours[HEADLINE_INDEX];
        const r = reference[HEADLINE_INDEX];
        rows.push(measuredRow('audio', caseName, SPEC.snr, o.snr, r.snr, lossy.tool));
        rows.push(measuredRow('audio', caseName, SPEC.loudnessShift, o.loudnessShift, r.loudnessShift, lossy.tool));
        rows.push(measuredRow('audio', caseName, SPEC.truePeakShift, o.truePeakShift, r.truePeakShift, lossy.tool));
        rows.push(measuredRow('audio', caseName, SPEC.bitrate, o.kbps, r.kbps, lossy.tool));
        const curve = (points: Encoded[]): RdPoint[] => points.map((e) => ({ rate: e.kbps, quality: e.snr }));
        rows.push(measuredRow('audio', caseName, SPEC.bdRateSnr, bdRate(curve(reference), curve(ours)), 0, lossy.tool));
      }

      if (ctx.speed) {
        const timingOut = ctx.scratch(`timing.${lossy.target}`);
        const headlineKbps = source.bitratesK[HEADLINE_INDEX];
        const timing = await ctx.time(
          async () => {
            await oursEncode(headlineKbps);
          },
          () => referenceEncode(headlineKbps, timingOut),
          'light'
        );
        rows.push(throughputRow('audio', caseName, input.length, timing, lossy.tool));
      }
    }

    const flacCase = `${source.file}->flac`;
    if (!ctx.inScope('audio', flacCase)) continue;
    const flacPlan = ctx.plan(['ffmpeg'], flacCase);
    if (!flacPlan.ok) {
      rows.push(...skippedGroup('audio', flacCase, FLAC_SPECS, 'ffmpeg flac', flacPlan));
      continue;
    }
    ctx.log(`audio ${flacCase}`);
    const ffmpeg = flacPlan.paths.ffmpeg;
    const referenceEncode = (output: string): void => {
      runTool(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', sourceFile, '-vn', '-map_metadata', '-1', '-c:a', 'flac', '-compression_level', FLAC_COMPRESSION_LEVEL, output]);
    };
    const oursEncode = async (): Promise<Buffer> => (await convertWithProject(input, 'wav', 'flac', {}, source.file)).buffer;
    if (ctx.quality) {
      const oursFile = ctx.scratch('ours.flac');
      fs.writeFileSync(oursFile, await oursEncode());
      const sourceHash = decodedPcmHash(ffmpeg, sourceFile);
      const oursExact = decodedPcmHash(ffmpeg, oursFile) === sourceHash;
      const reference = await ctx.refCache.value(
        'audio',
        { kind: 'flac-size-exact', tools: ['ffmpeg'], files: [source.file], settings: { case: flacCase, compressionLevel: FLAC_COMPRESSION_LEVEL } },
        parseFlac,
        () => {
          const refFile = ctx.scratch('ref.flac');
          referenceEncode(refFile);
          return { bytes: fileSize(refFile), exact: decodedPcmHash(ffmpeg, refFile) === sourceHash ? 1 : 0 };
        }
      );
      if (reference.exact !== 1) throw new OutputIntegrityError(`the reference flac encode of ${source.file} is not bit-exact; the benchmark setup is broken`);
      rows.push(measuredRow('audio', flacCase, SPEC.losslessExact, oursExact ? 1 : 0, 1, 'ffmpeg flac'));
      rows.push(measuredRow('audio', flacCase, SPEC.bytes, fileSize(oursFile), reference.bytes, 'ffmpeg flac'));
    }
    if (ctx.speed) {
      const timingOut = ctx.scratch('timing.flac');
      const timing = await ctx.time(
        async () => {
          await oursEncode();
        },
        () => referenceEncode(timingOut),
        'light'
      );
      rows.push(throughputRow('audio', flacCase, input.length, timing, 'ffmpeg flac'));
    }
  }
  return rows;
};
