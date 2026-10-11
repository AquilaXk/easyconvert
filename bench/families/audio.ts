import fs from 'node:fs';
import { type RdPoint, tryBdRate } from '../bd-rate';
import { ClassRows } from '../class-rows';
import { BITS_PER_BYTE, BITS_PER_KILOBIT, PUBLIC_SPEED_SAMPLES } from '../config';
import { convertWithProject } from '../convert';
import type { FamilyContext, FamilyRunner } from '../context';
import { EDGE_CASE_PREFIX, type RemoteSample, remoteSample, remoteSamples } from '../corpora';
import { OutputIntegrityError } from '../errors';
import { decodedPcmHash, fileSize, measureAudioSnr, measureLoudness, probeFile } from '../measure';
import type { BenchRow } from '../report';
import { numberRecord } from '../ref-cache';
import { measuredRow, type MetricSpec, skippedGroup, skippedRow, SPEC, throughputRow, speedRowId, undeterminedBdRows } from '../rows';
import { runTool } from '../tools';

/**
 * Audio family: wav to Opus and AAC at four bit rates (SNR against the source, loudness and true-peak drift,
 * BD-rate against ffmpeg's libopus and aac encoders at the same rates) and to FLAC (bit-exact decode, size against
 * ffmpeg's flac encoder). The public sample sets (bench/corpus/remote-manifest.json) add the tracks of the EBU sound quality
 * assessment material (speech, solo instruments, voice, castanets and drums, orchestra, pop) and a 24-bit studio production,
 * each cut to its first seconds as 16-bit or 24-bit PCM, and edge cases made from them: a quiet passage with one short burst,
 * telephone-band speech, a 5.1 mix, a clipped signal and a 96 kHz 24-bit signal. Every sample has its own rows, and each class has
 * rows that average the BD-rates of its samples (bench/class-rows.ts).
 */

/** Seconds of each public track the benchmark uses: long enough for a stable rate, short enough for a pull request. */
const PUBLIC_SECONDS = 12;

/** The bit rates of a content class (kbit/s, low to high; the second is the headline): speech needs less than a stereo mix, transients and surround more. */
const CLASS_BITRATES: Readonly<Record<string, readonly [number, number, number, number]>> = {
  speech: [32, 48, 64, 96],
  transient: [64, 96, 128, 192],
  surround: [128, 192, 256, 320],
};
const DEFAULT_BITRATES: readonly [number, number, number, number] = [48, 64, 96, 128];

/** A signal made from public samples with ffmpeg filters; the id carries EDGE_CASE_PREFIX, so a pull request does not run it. */
interface EdgeCase {
  file: string;
  /** The public samples it is made from. */
  inputs: readonly string[];
  /** Bit rates of the lossy targets. */
  bitratesK: readonly [number, number, number, number];
  /** ffmpeg arguments after the inputs, up to the output file. */
  args: readonly string[];
  bitDepth: 16 | 24;
}

const EDGE_CASES: readonly EdgeCase[] = [
  {
    file: `${EDGE_CASE_PREFIX}quiet-with-burst.wav`,
    inputs: [],
    bitratesK: DEFAULT_BITRATES,
    args: ['-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=44100:duration=0.5,volume=-6dB,adelay=4000|4000,apad=whole_dur=9,aformat=channel_layouts=stereo', '-c:a', 'pcm_s16le'],
    bitDepth: 16,
  },
  {
    file: `${EDGE_CASE_PREFIX}telephone-speech-8k.wav`,
    inputs: ['sqam-49-speech-en-f.flac'],
    bitratesK: [8, 12, 16, 24],
    args: ['-t', String(PUBLIC_SECONDS), '-af', 'pan=mono|c0=0.5*c0+0.5*c1,aresample=8000', '-c:a', 'pcm_s16le'],
    bitDepth: 16,
  },
  {
    file: `${EDGE_CASE_PREFIX}surround-5.1.wav`,
    inputs: ['sqam-65-orchestra-strauss.flac'],
    bitratesK: CLASS_BITRATES.surround,
    args: ['-t', String(PUBLIC_SECONDS), '-af', 'pan=5.1|FL=c0|FR=c1|FC=0.5*c0+0.5*c1|LFE=0.25*c0+0.25*c1|BL=0.7*c0|BR=0.7*c1', '-c:a', 'pcm_s16le'],
    bitDepth: 16,
  },
  {
    file: `${EDGE_CASE_PREFIX}clipped-castanets.wav`,
    inputs: ['sqam-27-castanets.flac'],
    bitratesK: CLASS_BITRATES.transient,
    args: ['-t', String(PUBLIC_SECONDS), '-af', 'volume=18dB', '-c:a', 'pcm_s16le'],
    bitDepth: 16,
  },
  {
    file: `${EDGE_CASE_PREFIX}studio-96k-24bit.wav`,
    inputs: ['pteraxys-part1.flac'],
    bitratesK: DEFAULT_BITRATES,
    args: ['-t', '6', '-af', 'aresample=96000', '-c:a', 'pcm_s24le'],
    bitDepth: 24,
  },
];

interface AudioSample {
  file: string;
  /** Four bit rates in kbit/s, low to high; the second one is the headline point. */
  bitratesK: readonly [number, number, number, number];
  contentClass: string | null;
  remote: RemoteSample | null;
  edge: EdgeCase | null;
  bitDepth: 16 | 24;
}

const CORE_SOURCES: readonly AudioSample[] = [
  { file: 'music.wav', bitratesK: [48, 64, 96, 128], contentClass: null, remote: null, edge: null, bitDepth: 16 },
  { file: 'speech.wav', bitratesK: [16, 24, 32, 48], contentClass: null, remote: null, edge: null, bitDepth: 16 },
];

function publicSamples(): AudioSample[] {
  const tracks = remoteSamples('audio').map(
    (sample): AudioSample => ({
      file: sample.id,
      bitratesK: CLASS_BITRATES[sample.class] ?? DEFAULT_BITRATES,
      contentClass: sample.class,
      remote: sample,
      edge: null,
      bitDepth: sample.meta.bitDepth === 24 ? 24 : 16,
    })
  );
  const edges = EDGE_CASES.map((edge): AudioSample => ({ file: edge.file, bitratesK: edge.bitratesK, contentClass: null, remote: null, edge, bitDepth: edge.bitDepth }));
  return [...tracks, ...edges];
}

/** The samples a case of this family can name, as the tests and the provenance record list them. */
export const AUDIO_EDGE_CASE_IDS: readonly string[] = EDGE_CASES.map((edge) => edge.file);

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

/** Our side failed to convert a public sample; the sample's rows say so instead of ending the run. */
class OursConversionError extends Error {}

/** The PCM WAV file of a sample: the generated file itself, a track cut to its first seconds, or an edge case built from tracks. */
async function sourceWav(ctx: FamilyContext, sample: AudioSample, ffmpeg: string, made: Map<string, string | null>): Promise<string | null> {
  if (sample.remote === null && sample.edge === null) return ctx.corpusPath(sample.file);
  if (made.has(sample.file)) return made.get(sample.file) ?? null;
  const output = ctx.scratch(`${sample.file}.wav`);
  const base = ['-hide_banner', '-nostdin', '-v', 'error', '-y'];
  let wav: string | null = output;
  if (sample.remote !== null) {
    const track = await ctx.remote(sample.remote);
    if (track === null) wav = null;
    else runTool(ffmpeg, [...base, '-i', track, '-t', String(PUBLIC_SECONDS), '-c:a', sample.bitDepth === 24 ? 'pcm_s24le' : 'pcm_s16le', output]);
  } else if (sample.edge !== null) {
    const inputs: string[] = [];
    for (const id of sample.edge.inputs) {
      const source = remoteSample(id);
      const path = source === undefined ? null : await ctx.remote(source);
      if (path === null) wav = null;
      else inputs.push('-i', path);
    }
    if (wav !== null) runTool(ffmpeg, [...base, ...(sample.edge.inputs.length > 0 ? inputs : []), ...sample.edge.args, output]);
  }
  made.set(sample.file, wav);
  return wav;
}

export const runAudio: FamilyRunner = async (ctx) => {
  const rows: BenchRow[] = [];
  const classes = new ClassRows();
  const sources = [...CORE_SOURCES, ...publicSamples()];
  const madeWavs = new Map<string, string | null>();
  for (const source of sources) {
    if (source.contentClass === null) continue;
    for (const lossy of LOSSY) classes.expect(source.contentClass, `->${lossy.target}`, [SPEC.bdRateSnr.metric]);
    classes.expect(source.contentClass, '->flac', [SPEC.bytes.metric]);
  }
  for (const source of sources) {
    const publicSample = source.remote !== null || source.edge !== null;
    const cacheFiles = source.edge !== null ? source.edge.inputs : [source.file];
    const speedWanted = !publicSample || PUBLIC_SPEED_SAMPLES.audio.includes(source.file);
    // A speed-only run times a few public samples; the others have only quality rows, which it does not measure.
    if (!ctx.quality && !speedWanted) continue;

    for (const lossy of LOSSY) {
      const caseName = `${source.file}->${lossy.target}`;
      if (!ctx.inScope('audio', caseName)) continue;
      const plan = ctx.plan(['ffmpeg', 'ffprobe'], caseName);
      if (!plan.ok) {
        rows.push(...skippedGroup('audio', caseName, LOSSY_SPECS, lossy.tool, plan));
        continue;
      }
      const sourceFile = await sourceWav(ctx, source, plan.paths.ffmpeg, madeWavs);
      if (sourceFile === null) {
        rows.push(...LOSSY_SPECS.map((spec) => skippedRow('audio', caseName, spec, lossy.tool, 'optional-tool', `public sample ${source.file} could not be fetched`)));
        continue;
      }
      const input = fs.readFileSync(sourceFile);
      ctx.log(`audio ${caseName}`);
      const ffmpeg = plan.paths.ffmpeg;

      const referenceEncode = (kbps: number, output: string): void => {
        runTool(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', sourceFile, '-vn', '-map_metadata', '-1', ...lossy.encoderArgs, '-b:a', `${kbps}k`, output]);
      };
      const oursEncode = async (kbps: number): Promise<Buffer> => {
        try {
          const out = await convertWithProject(input, 'wav', lossy.target, { audio: { codec: lossy.codec, bitrateK: kbps } }, source.file);
          return out.buffer;
        } catch (error) {
          if (!publicSample) throw error;
          throw new OursConversionError(error instanceof Error ? error.message : String(error));
        }
      };

      if (ctx.quality) {
        try {
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
                { kind: 'encode-measure', tools: ['ffmpeg', 'ffprobe'], files: cacheFiles, settings: { case: caseName, kbps, encoder: lossy.encoderArgs.join(' '), seconds: PUBLIC_SECONDS } },
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
          const bd = tryBdRate(curve(reference), curve(ours));
          if ('value' in bd) {
            rows.push(measuredRow('audio', caseName, SPEC.bdRateSnr, bd.value, 0, lossy.tool));
            if (source.contentClass !== null) classes.add(source.contentClass, `->${lossy.target}`, SPEC.bdRateSnr, bd.value, 0);
          } else {
            rows.push(...undeterminedBdRows('audio', caseName, [SPEC.bdRateSnr], lossy.tool, bd.reason));
            if (source.contentClass !== null) classes.exclude(source.contentClass, `->${lossy.target}`, SPEC.bdRateSnr.metric);
          }
        } catch (error) {
          if (!(error instanceof OursConversionError)) throw error;
          ctx.log(`audio ${caseName}: the product could not convert the sample: ${error.message.slice(0, 300)}`);
          rows.push(measuredRow('audio', caseName, SPEC.converts, 0, 1, lossy.tool));
          continue;
        }
      }

      if (ctx.speed && speedWanted) {
        const timingOut = ctx.scratch(`timing.${lossy.target}`);
        const headlineKbps = source.bitratesK[HEADLINE_INDEX];
        const timing = await ctx.time(
          speedRowId('audio', caseName),
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
    const sourceFile = await sourceWav(ctx, source, flacPlan.paths.ffmpeg, madeWavs);
    if (sourceFile === null) {
      rows.push(...FLAC_SPECS.map((spec) => skippedRow('audio', flacCase, spec, 'ffmpeg flac', 'optional-tool', `public sample ${source.file} could not be fetched`)));
      continue;
    }
    const input = fs.readFileSync(sourceFile);
    ctx.log(`audio ${flacCase}`);
    const ffmpeg = flacPlan.paths.ffmpeg;
    const pcmCodec = source.bitDepth === 24 ? 'pcm_s24le' : 'pcm_s16le';
    const referenceEncode = (output: string): void => {
      runTool(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', sourceFile, '-vn', '-map_metadata', '-1', '-c:a', 'flac', '-compression_level', FLAC_COMPRESSION_LEVEL, output]);
    };
    const oursEncode = async (): Promise<Buffer> => {
      try {
        return (await convertWithProject(input, 'wav', 'flac', {}, source.file)).buffer;
      } catch (error) {
        if (!publicSample) throw error;
        throw new OursConversionError(error instanceof Error ? error.message : String(error));
      }
    };
    if (ctx.quality) {
      try {
        const oursFile = ctx.scratch('ours.flac');
        fs.writeFileSync(oursFile, await oursEncode());
        const sourceHash = decodedPcmHash(ffmpeg, sourceFile, pcmCodec);
        const oursExact = decodedPcmHash(ffmpeg, oursFile, pcmCodec) === sourceHash;
        const reference = await ctx.refCache.value(
          'audio',
          { kind: 'flac-size-exact', tools: ['ffmpeg'], files: cacheFiles, settings: { case: flacCase, compressionLevel: FLAC_COMPRESSION_LEVEL, seconds: PUBLIC_SECONDS } },
          parseFlac,
          () => {
            const refFile = ctx.scratch('ref.flac');
            referenceEncode(refFile);
            return { bytes: fileSize(refFile), exact: decodedPcmHash(ffmpeg, refFile, pcmCodec) === sourceHash ? 1 : 0 };
          }
        );
        if (reference.exact !== 1) throw new OutputIntegrityError(`the reference flac encode of ${source.file} is not bit-exact; the benchmark setup is broken`);
        rows.push(measuredRow('audio', flacCase, SPEC.losslessExact, oursExact ? 1 : 0, 1, 'ffmpeg flac'));
        rows.push(measuredRow('audio', flacCase, SPEC.bytes, fileSize(oursFile), reference.bytes, 'ffmpeg flac'));
        if (source.contentClass !== null) classes.add(source.contentClass, '->flac', SPEC.bytes, fileSize(oursFile), reference.bytes);
      } catch (error) {
        if (!(error instanceof OursConversionError)) throw error;
        ctx.log(`audio ${flacCase}: the product could not convert the sample: ${error.message.slice(0, 300)}`);
        rows.push(measuredRow('audio', flacCase, SPEC.converts, 0, 1, 'ffmpeg flac'));
        continue;
      }
    }
    if (ctx.speed && speedWanted) {
      const timingOut = ctx.scratch('timing.flac');
      const timing = await ctx.time(
        speedRowId('audio', flacCase),
        async () => {
          await oursEncode();
        },
        () => referenceEncode(timingOut),
        'light'
      );
      rows.push(throughputRow('audio', flacCase, input.length, timing, 'ffmpeg flac'));
    }
  }
  const toolOf = (suffix: string): string => (suffix === '->flac' ? 'ffmpeg flac' : (LOSSY.find((lossy) => suffix === `->${lossy.target}`)?.tool ?? 'ffmpeg'));
  rows.push(...classes.rows('audio', toolOf).filter((row) => ctx.inScope('audio', row.case)));
  return rows;
};
