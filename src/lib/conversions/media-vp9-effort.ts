import { type PictureSize } from './media-encoder-threads';
import { type StreamLayout, firstVideoStream } from './media-ffprobe';
import { computeMediaTimeoutMs } from './media-job-limit';

/**
 * How hard libvpx-vp9 works on a job. The "good" deadline at cpu-used 2 is the encoder setting the project documents
 * and compares against its reference (docs/policy-decisions.md, entry 54). Its cost does not fall with a higher
 * cpu-used (measured: 62 s at 2 and 64 s at 5 for the same 1080p60 clip on four cores), so a job too big for the media
 * time limit at that setting changes the deadline to "realtime" instead.
 *
 * The estimate is the work (pixels to encode) over a measured rate and an assumed share of a host. The share is two
 * cores: a worker runs several jobs at once, and the nightly real-file run puts three on a four-core runner.
 */

export type Vp9Deadline = 'good' | 'realtime';

export interface Vp9Workload {
  width: number;
  height: number;
  /** Frames the encoder receives. */
  frames: number;
  /** Length of the input in seconds, which sets the media time limit. */
  durationSec: number;
}

/**
 * Pixels the good deadline encodes per CPU second, tone mapping and decoding of a 10-bit source included: 1,797 frames
 * of 1080p (3.73 gigapixels) took 241 CPU seconds, which is 15.4. Taken as 15.
 */
const GOOD_MEGAPIXELS_PER_CPU_SECOND = 15;
/** Cores one job may count on. */
const ASSUMED_CORES_PER_JOB = 2;
/** Part of the time limit the encode may use; the rest is for reading the file, audio, muxing and a slow host. */
const ENCODE_SHARE_OF_LIMIT = 0.5;
const PIXELS_PER_MEGAPIXEL = 1_000_000;
const MS_PER_SECOND = 1000;

/** The deadline for a job: "good" unless its estimated encode time at that setting is past its share of the time limit. */
export function vp9DeadlineFor(workload: Vp9Workload): Vp9Deadline {
  const megapixels = (workload.width * workload.height * workload.frames) / PIXELS_PER_MEGAPIXEL;
  const estimatedSeconds = megapixels / GOOD_MEGAPIXELS_PER_CPU_SECOND / ASSUMED_CORES_PER_JOB;
  const allowedSeconds = (computeMediaTimeoutMs(workload.durationSec) / MS_PER_SECOND) * ENCODE_SHARE_OF_LIMIT;
  return estimatedSeconds > allowedSeconds ? 'realtime' : 'good';
}

/** libvpx-vp9 speed settings: row multithreading, the "good" deadline, cpu-used 2 and four tile columns (log2 = 2). */
export const VP9_SPEED_ARGS: readonly string[] = ['-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-tile-columns', '2'];
/**
 * The same threading with the realtime deadline at cpu-used 5. At the same CRF it encodes in a quarter of the CPU time,
 * for a file about a quarter larger and an SSIM 0.001 lower (docs/policy-decisions.md, entry 54).
 */
export const VP9_REALTIME_SPEED_ARGS: readonly string[] = ['-row-mt', '1', '-deadline', 'realtime', '-cpu-used', '5', '-tile-columns', '2'];

export function vp9SpeedArgs(deadline: Vp9Deadline): readonly string[] {
  return deadline === 'realtime' ? VP9_REALTIME_SPEED_ARGS : VP9_SPEED_ARGS;
}

export interface Vp9DeadlineRequest {
  codec: string;
  /** The picture the encoder receives when no filter changes its size; undefined when one may. */
  picture: PictureSize | undefined;
  layout: StreamLayout | undefined;
  twoPass: boolean;
  /** The request names a frame rate, so the encoder does not receive the source's own. */
  rateRequested: boolean;
}

/**
 * The libvpx deadline for a conversion whose picture reaches the encoder as it is, at the source's own frame rate: the
 * good deadline unless its frames do not fit the media time limit. A request that changes the size or the rate, a
 * two-pass encode (it needs the good deadline) and a source whose frame count or length is not known keep the good one.
 */
export function vp9DeadlineOfInput(request: Vp9DeadlineRequest): Vp9Deadline {
  const { picture, layout } = request;
  if (request.codec !== 'vp9' || request.twoPass || request.rateRequested || picture === undefined || layout === undefined) return 'good';
  const source = firstVideoStream(layout.streams);
  const durationSec = layout.durationSec;
  if (source === undefined || durationSec === undefined) return 'good';
  const rate = source.averageFrameRate ?? source.frameRate;
  const frames = source.frameCount ?? (rate === undefined ? undefined : (rate.num / rate.den) * durationSec);
  return frames === undefined ? 'good' : vp9DeadlineFor({ ...picture, frames, durationSec });
}
