import { SandboxedProcessError, type SandboxedExecutionOptions, type SandboxedExecutionResult } from '../security/process-sandbox';
import { explainFfmpegFailure, partialDecodeIn } from './media-decode-failures';
import { runFfmpeg } from './media-process';

/**
 * A failure of the encoder FFmpeg reports at the start of a run, with the change to the arguments that lets the same run
 * start. The log is the only report of these conditions, so a rule costs nothing for a conversion that does not meet one.
 * A rule answers undefined when the log gives it nothing to change. Each pattern below stays within one line and is
 * bounded, as the log echoes the input's tags.
 */
type RetryRule = (args: readonly string[], log: string) => string[] | undefined;

/** Most times one transcode is started again: one per audio stream that needs a change, and the stream limit of a conversion bounds those. */
const MAX_RESTARTS = 8;

/** Block size a FLAC encoder works with by default: a stream shorter than it is one frame whatever the block size. */
const FLAC_NOMINAL_BLOCK_SAMPLES = 4096;
/**
 * `[flac @ 0x...] invalid block size: 1`: FFmpeg 9.0 opens the FLAC encoder with the length of the first frame it gets, so a
 * stream of fewer than FLAC's 16 samples makes the encoder refuse to start. Builds 6.1 and 7.1 take the same stream.
 */
const FLAC_SHORT_STREAM = /\[flac @ [^\]\n]{0,64}\] invalid block size: \d{1,6}/;

/**
 * Opus channel mapping family 1 (RFC 7845 section 5.1.1.2) lists the layouts of the Vorbis I specification, whose surround
 * channels are the rear pair; AC-3, E-AC-3 and DTS put theirs at the sides. The pair at the sides is the pair of the same count at
 * the rear, so these layouts are relabelled, which moves no sample and mixes nothing.
 */
const OPUS_REAR_LAYOUT_OF: Readonly<Record<string, string>> = { '5.1(side)': '5.1', '5.0(side)': '5.0', 'quad(side)': 'quad' };
/** `[libopus @ 0x...] Invalid channel layout 5.1(side) for specified mapping family -1.` */
const OPUS_UNLISTED_LAYOUT = /\[libopus @ [^\]\n]{0,64}\] Invalid channel layout (\S{1,32}) for specified mapping family/;
/** `[aost#0:1/libopus @ 0x...] ...`: the output stream whose encoder did not start. */
const OPUS_FAILED_OUTPUT = /\[aost#0:(\d{1,3})\/libopus @/;
/** `Stream #0:1 -> #0:1 (ac3 (native) -> opus (libopus))`: the output stream index of every stream FFmpeg encodes with libopus. */
const OPUS_OUTPUT_MAPPINGS = /-> #0:(\d{1,3}) \([^\n]{0,160}\(libopus\)\)/g;

/** A rule whose change is already in `args` does not apply again: a second identical failure is passed on, not retried. */
function withFlacBlockSize(args: readonly string[], log: string): string[] | undefined {
  if (!FLAC_SHORT_STREAM.test(log) || args.includes('-frame_size:a')) return undefined;
  return [...args.slice(0, -1), '-frame_size:a', String(FLAC_NOMINAL_BLOCK_SAMPLES), args[args.length - 1]];
}

/**
 * `args` with the audio stream that failed relabelled to the rear layout. The change is made to that stream alone, at its
 * position among the audio outputs, because a file may carry other tracks (a stereo commentary beside a 5.1 mix) that the
 * relabelling would break. The output path is the last argument.
 */
function withOpusRearLayout(args: readonly string[], log: string): string[] | undefined {
  const layout = OPUS_UNLISTED_LAYOUT.exec(log)?.[1];
  const failed = OPUS_FAILED_OUTPUT.exec(log)?.[1];
  if (layout === undefined || failed === undefined || !Object.hasOwn(OPUS_REAR_LAYOUT_OF, layout)) return undefined;
  const ordinal = [...log.matchAll(OPUS_OUTPUT_MAPPINGS)].map((mapping) => mapping[1]).indexOf(failed);
  if (ordinal === -1 || args.includes(`-filter:a:${ordinal}`)) return undefined;
  const filter = `channelmap=channel_layout=${OPUS_REAR_LAYOUT_OF[layout]}`;
  const common = args.indexOf('-filter:a');
  const chain = common === -1 ? filter : `${args[common + 1]},${filter}`;
  return [...args.slice(0, -1), `-filter:a:${ordinal}`, chain, args[args.length - 1]];
}

const RETRY_RULES: readonly RetryRule[] = [withFlacBlockSize, withOpusRearLayout];

/**
 * Runs ffmpeg for a transcode in the sandbox. A run that fails because a stream cannot be decoded is reported as the typed
 * error that names the stream or the codec, and a run that exits with status 0 after its decoder skipped packets for a coding
 * tool FFmpeg lacks is refused: its output holds only a part of the stream. An encoder that refuses to start for a reason one
 * of the rules above knows is started again with that rule's change. Every other failure is passed on unchanged.
 */
export async function runFfmpegTranscode(
  ffmpegBin: string,
  args: string[],
  options: SandboxedExecutionOptions
): Promise<SandboxedExecutionResult> {
  let attempt = args;
  let result: SandboxedExecutionResult | undefined;
  for (let restarts = 0; result === undefined; restarts += 1) {
    try {
      result = await runFfmpeg(ffmpegBin, attempt, options);
    } catch (error) {
      if (!(error instanceof SandboxedProcessError)) throw error;
      const adjusted = restarts < MAX_RESTARTS ? firstAdjustment(attempt, error.stderr) : undefined;
      if (adjusted === undefined) throw explainFfmpegFailure(error.stderr) ?? error;
      attempt = adjusted;
    }
  }
  const refusal = partialDecodeIn(result.stderr.toString('utf8'));
  if (refusal !== undefined) throw refusal;
  return result;
}

/** The arguments of the next attempt for a failed run, or undefined when no rule applies (exported for its test). */
export function firstAdjustment(args: readonly string[], log: string): string[] | undefined {
  for (const rule of RETRY_RULES) {
    const adjusted = rule(args, log);
    if (adjusted !== undefined) return adjusted;
  }
  return undefined;
}
