import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { rethrowSandboxUnavailable } from '../security/process-sandbox';
import { EngineUnavailableError, JobTimeoutError } from '../types';
import { DEFAULT_HDR_PEAK_NITS, HLG_REFERENCE_PEAK_NITS, PQ_PEAK_NITS, SDR_PEAK_NITS, createBt2390Parameters } from './hdr-tonemap';
import { type FfprobePath, type ProbeJob, runSandboxedFfprobe } from './media-ffprobe';

/**
 * HDR to SDR video: the filter chain and the colour tags of the 8-bit BT.709 result.
 *
 * ffmpeg's `tonemap` filter has no BT.2390 curve, so the chain converts to PQ-coded RGB with zscale (libzimg),
 * applies the BT.2390 EETF per component as a `lutrgb` expression on 16-bit code values, and converts the result
 * to BT.709 with zscale. Without zscale the build cannot do this and the conversion answers EngineUnavailableError.
 */

/** Transfer names ffprobe reports for HDR video. */
export const PQ_TRANSFER = 'smpte2084';
export const HLG_TRANSFER = 'arib-std-b67';

/** Output colour description of an SDR rendition, written as stream tags (and VUI by the encoders). */
export const SDR_COLOUR_ARGS: readonly string[] = [
  '-color_primaries', 'bt709',
  '-color_trc', 'bt709',
  '-colorspace', 'bt709',
  '-color_range', 'tv',
];

const FULL_SCALE_16 = 65_535;
const PROBE_KILL_SIGNAL = 'SIGKILL';
const FILTER_LIST_TIMEOUT_MS = 10_000;
const FILTER_LIST_MAX_BYTES = 1024 * 1024;
const MAX_LIGHT_LEVEL_OUTPUT_BYTES = 4096;
/** The filter-name column of an `ffmpeg -filters` row: the second whitespace-separated field. */
const FILTER_NAME_FIELD = 1;

function listsZscale(listing: string): boolean {
  return listing.split('\n').some((line) => line.trim().split(/\s+/)[FILTER_NAME_FIELD] === 'zscale');
}

const filterCache = new Map<string, boolean>();

/** Throws EngineUnavailableError (HTTP 503) when this ffmpeg build lacks zscale, the filter the HDR chain needs. */
export function assertZscaleAvailable(ffmpegBin: string | null | undefined): void {
  if (!ffmpegBin || !fs.existsSync(ffmpegBin)) {
    throw new EngineUnavailableError('ffmpeg', 'there is no ffmpeg binary to tone map HDR video');
  }
  let available = filterCache.get(ffmpegBin);
  if (available === undefined) {
    try {
      const listing = execFileSync(ffmpegBin, ['-hide_banner', '-filters'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: FILTER_LIST_TIMEOUT_MS,
        killSignal: PROBE_KILL_SIGNAL,
        maxBuffer: FILTER_LIST_MAX_BYTES,
      });
      available = listsZscale(listing);
    } catch {
      available = false;
    }
    filterCache.set(ffmpegBin, available);
  }
  if (!available) {
    throw new EngineUnavailableError('ffmpeg', "this build has no 'zscale' filter (libzimg), so HDR video cannot be tone mapped to SDR");
  }
}

/** Forgets which ffmpeg builds have zscale (tests that swap binaries). */
export function resetZscaleCache(): void {
  filterCache.clear();
}

/**
 * Maximum content light level in cd/m2 from the first video stream's side data (MP4 `clli`, Matroska
 * MaxCLL), or undefined when the stream states none.
 */
export function probeVideoMaxLightLevel(filePath: string, ffprobe: FfprobePath, job?: ProbeJob): number | undefined {
  let out = '';
  try {
    out = runSandboxedFfprobe(
      ffprobe,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream_side_data=max_content', '-of', 'default=nw=1:nk=1', filePath],
      MAX_LIGHT_LEVEL_OUTPUT_BYTES,
      job,
      true,
    );
  } catch (err) {
    // A missing sandbox and a stopped job (aborted or past its deadline) end the conversion; only a probe that failed to read the file leaves the level unstated.
    rethrowSandboxUnavailable(err);
    if (job?.signal?.aborted || err instanceof JobTimeoutError) throw err;
    return undefined;
  }
  for (const line of out.split('\n')) {
    const value = Number(line.trim());
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

export interface VideoToneMapPlan {
  /** Filter graph fragment to place before the final pixel format. */
  readonly filter: string;
  readonly sourcePeakNits: number;
}

/** `lutrgb` expression of the BT.2390 EETF over 16-bit PQ code values. */
function eetfExpression(sourcePeakNits: number): string {
  const { sourcePq, maxLum, knee } = createBt2390Parameters({ sourcePeakNits, targetPeakNits: SDR_PEAK_NITS });
  // lutrgb's own `maxval` is not the 16-bit full scale for this pixel format, so the code range is spelled out.
  const e1 = `min(val/${FULL_SCALE_16}/${sourcePq},1)`;
  const t = `((${e1}-${knee})/${1 - knee})`;
  const spline = `((2*pow(${t},3)-3*pow(${t},2)+1)*${knee}+(pow(${t},3)-2*pow(${t},2)+${t})*${1 - knee}+(-2*pow(${t},3)+3*pow(${t},2))*${maxLum})`;
  return `clip(${FULL_SCALE_16}*${sourcePq}*if(lt(${e1},${knee}),${e1},${spline}),0,${FULL_SCALE_16})`;
}

/**
 * The filters that turn PQ or HLG video into 8-bit BT.709 SDR. `mode` `clip` only converts (everything above SDR
 * white clips); `bt2390` compresses highlights first. PQ peak is the stream's MaxCLL, or 1000 cd/m2 when it states
 * none; HLG uses its 1000 cd/m2 reference display.
 */
export function planVideoToneMap(transfer: string, mode: 'clip' | 'bt2390', maxLightLevel: number | undefined): VideoToneMapPlan {
  const isHlg = transfer === HLG_TRANSFER;
  const sourcePeakNits = isHlg
    ? HLG_REFERENCE_PEAK_NITS
    : Math.min(PQ_PEAK_NITS, Math.max(SDR_PEAK_NITS, maxLightLevel ?? DEFAULT_HDR_PEAK_NITS));
  const finish = ['zscale=t=bt709:m=bt709:r=tv', 'format=yuv420p'];
  if (mode === 'clip' || sourcePeakNits <= SDR_PEAK_NITS) {
    return {
      sourcePeakNits: mode === 'clip' ? SDR_PEAK_NITS : sourcePeakNits,
      filter: [`zscale=t=linear:npl=${SDR_PEAK_NITS}`, 'format=gbrpf32le', 'zscale=p=bt709', ...finish].join(','),
    };
  }
  const toPq = isHlg
    ? [`zscale=t=linear:npl=${PQ_PEAK_NITS}:p=bt2020:m=gbr:r=pc`, 'format=gbrpf32le', `zscale=t=smpte2084:npl=${PQ_PEAK_NITS}`]
    : ['zscale=t=smpte2084:p=bt2020:m=gbr:r=pc'];
  const expression = eetfExpression(sourcePeakNits);
  return {
    sourcePeakNits,
    filter: [
      ...toPq,
      'format=gbrp16le',
      `lutrgb=r='${expression}':g='${expression}':b='${expression}'`,
      'setparams=colorspace=gbr:range=pc',
      `zscale=t=linear:npl=${SDR_PEAK_NITS}:p=bt709`,
      ...finish,
    ].join(','),
  };
}
