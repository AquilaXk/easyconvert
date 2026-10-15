/**
 * Flat-plane AHD and AMaZE Bayer demosaicing: validation, calibration, output buffers, the choice of how many threads
 * compute the tiles, and the public entry points. The tile engines live in raw-demosaic-tiles.ts (see the description
 * there); the thread hand-off lives in raw-demosaic-threads.ts.
 */
import os from 'node:os';
import { EngineUnavailableError, InvalidRawSensorError } from '../types';
import { RAW_DECODE_MAX_PIXELS } from './raw-formats';
import {
  applyIec61966SrgbGamma,
  resolveBayerColorMatrix,
  validateBayerSensorCalibration,
  type BayerSensorData,
} from './image';
import {
  type Calibration,
  type CfaLayout,
  type DemosaicEngineKind,
  type FramePlanes,
  type GammaTables,
  type OutputStage,
  type TileJob,
  AMAZE_BITS_10_MAX,
  AMAZE_BITS_12_MAX,
  AMAZE_BITS_14_MAX,
  AMAZE_SCAN_SAMPLES,
  BYTE_RANGE,
  BYTES_PER_16_BIT_SAMPLE,
  CFA_PATTERNS,
  CHANNELS,
  FULL_16_BIT_MAX,
  GAMMA_BISECTION_STEPS,
  GAMMA_COARSE_CELLS,
  GAMMA_LEVELS,
  finishFrame,
  resolveCfa,
  runFrame,
  tileRowCount,
  type SensorInput,
} from './raw-demosaic-tiles';
import { runTilesOnThreads } from './raw-demosaic-threads';

export { cieLabF, linearizeSrgbSample, medianOf25 } from './raw-demosaic-tiles';

export interface DemosaicOptions {
  /** Edge of the square processing tile in pixels (even, DEMOSAIC_MIN_TILE..DEMOSAIC_MAX_TILE). */
  tileSize?: number;
  /** When false the gamma-encoded 8-bit RGB buffer is not produced and `data` is empty. Default true. */
  buildRgb8?: boolean;
  /**
   * Threads that compute the tiles (1..DEMOSAIC_THREADS_MAX; more than the rows of tiles are not used). The result does
   * not depend on it. By default a frame of DEMOSAIC_PARALLEL_MIN_PIXELS or more uses the available cores and a smaller
   * one runs on the calling thread; an explicit count is always honoured, and fails when no thread can be started.
   */
  threads?: number;
}

/** The 8-bit buffer of an output stage as a Buffer over the same memory (empty when none was built). */
function asBuffer(rgb8: Uint8Array | null): Buffer {
  return rgb8 === null ? Buffer.alloc(0) : Buffer.from(rgb8.buffer, rgb8.byteOffset, rgb8.byteLength);
}

export interface DemosaicResult {
  /** Interleaved 8-bit RGB after white balance, colour matrix and (optional) sRGB gamma; empty when buildRgb8 is false. */
  data: Buffer;
  /** Interleaved linear demosaiced RGB, normalised to [0, 1] before white balance and colour transforms. */
  floatData: Float32Array;
  width: number;
  height: number;
  /** Threads that computed the tiles (1: the calling thread). With more than one, the arrays are shared memory. */
  threads: number;
}

export const DEMOSAIC_DEFAULT_TILE = 128;
export const DEMOSAIC_MIN_TILE = 16;
export const DEMOSAIC_MAX_TILE = 1024;
/** Most threads one frame is split across. */
export const DEMOSAIC_THREADS_MAX = 8;
/** Smaller frames run on the calling thread: starting and joining threads costs more than the tiles take. */
export const DEMOSAIC_PARALLEL_MIN_PIXELS = 2_000_000;

function checkTileSize(options?: DemosaicOptions): number {
  const tile = options?.tileSize ?? DEMOSAIC_DEFAULT_TILE;
  if (!Number.isInteger(tile) || tile < DEMOSAIC_MIN_TILE || tile > DEMOSAIC_MAX_TILE || tile % 2 !== 0) {
    throw new InvalidRawSensorError(
      `Invalid demosaic tile size ${tile}: expected an even integer between ${DEMOSAIC_MIN_TILE} and ${DEMOSAIC_MAX_TILE}.`
    );
  }
  return tile;
}

function checkPixelBudget(width: number, height: number): void {
  if (width * height > RAW_DECODE_MAX_PIXELS) {
    throw new InvalidRawSensorError(`Sensor of ${width}x${height} pixels exceeds the ${RAW_DECODE_MAX_PIXELS} pixel demosaic limit.`);
  }
}

function checkThreads(options?: DemosaicOptions): number | undefined {
  const threads = options?.threads;
  if (threads === undefined) return undefined;
  if (!Number.isInteger(threads) || threads < 1 || threads > DEMOSAIC_THREADS_MAX) {
    throw new InvalidRawSensorError(`Invalid demosaic thread count ${threads}: expected an integer between 1 and ${DEMOSAIC_THREADS_MAX}.`);
  }
  return threads;
}

/** How many threads a frame uses: the request, else the cores for a large frame; never more than there are rows of tiles. */
function planThreads(requested: number | undefined, pixels: number, tileRows: number): number {
  if (requested !== undefined) return Math.min(requested, tileRows);
  if (pixels < DEMOSAIC_PARALLEL_MIN_PIXELS) return 1;
  return Math.max(1, Math.min(os.availableParallelism(), DEMOSAIC_THREADS_MAX, tileRows));
}

let gammaTables: GammaTables | null = null;

/** Built on first use: it calls the reference transfer function of image.ts, which is not initialised at module load. */
function getGammaTables(): GammaTables {
  if (gammaTables) return gammaTables;
  const thresholds = new Float64Array(GAMMA_LEVELS + 2);
  const code = (x: number): number => Math.round(applyIec61966SrgbGamma(x) * BYTE_RANGE);
  for (let k = 1; k <= GAMMA_LEVELS; k += 1) {
    let lo = 0;
    let hi = 1;
    for (let step = 0; step < GAMMA_BISECTION_STEPS; step += 1) {
      const mid = (lo + hi) / 2;
      if (code(mid) >= k) hi = mid;
      else lo = mid;
    }
    thresholds[k] = hi;
  }
  thresholds[GAMMA_LEVELS + 1] = Infinity;
  const coarse = new Uint8Array(GAMMA_COARSE_CELLS + 1);
  let level = 0;
  for (let j = 0; j <= GAMMA_COARSE_CELLS; j += 1) {
    while (level < GAMMA_LEVELS && thresholds[level + 1] <= j / GAMMA_COARSE_CELLS) level += 1;
    coarse[j] = level;
  }
  gammaTables = { thresholds, coarse };
  return gammaTables;
}

function allocateFloats(count: number, shared: boolean): Float32Array {
  return shared ? new Float32Array(new SharedArrayBuffer(count * Float32Array.BYTES_PER_ELEMENT)) : new Float32Array(count);
}

function createOutputStage(
  sensor: BayerSensorData,
  options: DemosaicOptions | undefined,
  wb: readonly number[],
  gamma: boolean,
  roundToFloat32: boolean,
  shared: boolean
): OutputStage {
  const { width, height } = sensor;
  const buildRgb8 = options?.buildRgb8 !== false;
  const rgb8Bytes = width * height * CHANNELS;
  let rgb8: Uint8Array | null = null;
  if (buildRgb8) rgb8 = shared ? new Uint8Array(new SharedArrayBuffer(rgb8Bytes)) : Buffer.alloc(rgb8Bytes);
  return {
    width,
    floatOut: allocateFloats(width * height * CHANNELS, shared),
    rgb8,
    tables: buildRgb8 && gamma ? getGammaTables() : null,
    wbR: wb[0],
    wbG: wb[1],
    wbB: wb[2],
    matrix: sensor.colorMatrix || resolveBayerColorMatrix(sensor),
    gamma,
    roundToFloat32,
  };
}

function falseColorPassCount(sensor: BayerSensorData): number {
  if (!sensor.falseColorSuppression) return 0;
  return typeof sensor.falseColorSuppression === 'number' ? sensor.falseColorSuppression : 1;
}

function buildCalibration(
  cal: { defaultBLevel: number; wLevel: number; hasArrayBlackLevel: boolean; blackLevelArr?: number[] },
  engine: DemosaicEngineKind
): Calibration {
  const black = new Float64Array(4);
  const range = new Float64Array(4);
  const arr = cal.blackLevelArr;
  for (let idx = 0; idx < 4; idx += 1) {
    let level = cal.defaultBLevel;
    if (engine === 'amaze' && cal.hasArrayBlackLevel && arr) {
      level = arr[idx % arr.length] ?? cal.defaultBLevel;
    } else if (engine === 'ahd' && cal.hasArrayBlackLevel && arr && arr.length === 4) {
      level = arr[idx];
    }
    black[idx] = level;
    range[idx] = engine === 'amaze' ? Math.max(1, cal.wLevel - level) : cal.wLevel - level;
  }
  return { black, range };
}

/** The sensor samples the engines read, in shared memory: the frame itself when it already is, else a copy of what is read. */
function shareSamples(input: SensorInput, width: number, height: number): SensorInput | null {
  const { samples, kind } = input;
  if (!ArrayBuffer.isView(samples)) return null;
  if (samples.buffer instanceof SharedArrayBuffer) return input;
  const needed = kind === 'bytes16' ? width * height * BYTES_PER_16_BIT_SAMPLE : width * height;
  const view = samples as Uint8Array | Uint16Array | Float32Array;
  let copy: Uint8Array | Uint16Array | Float32Array;
  if (view instanceof Uint16Array) {
    copy = new Uint16Array(new SharedArrayBuffer(needed * Uint16Array.BYTES_PER_ELEMENT));
  } else if (view instanceof Float32Array) {
    copy = new Float32Array(new SharedArrayBuffer(needed * Float32Array.BYTES_PER_ELEMENT));
  } else if (view instanceof Uint8Array) {
    copy = new Uint8Array(new SharedArrayBuffer(needed));
  } else {
    return null;
  }
  (copy as Uint8Array).set(view.subarray(0, needed) as Uint8Array);
  return { samples: copy, kind };
}

interface EngineRun {
  kind: DemosaicEngineKind;
  sensor: BayerSensorData;
  options: DemosaicOptions | undefined;
  tile: number;
  input: SensorInput;
  calibration: Calibration;
  layout: CfaLayout;
  wb: readonly number[];
  gamma: boolean;
  roundToFloat32: boolean;
}

function buildJob(run: EngineRun, input: SensorInput, shared: boolean, passes: number): TileJob {
  const { sensor, options, kind, tile, calibration, layout, wb, gamma, roundToFloat32 } = run;
  const { width, height } = sensor;
  let planes: FramePlanes | null = null;
  if (passes > 0) {
    planes = { green: allocateFloats(width * height, shared), red: allocateFloats(width * height, shared), blue: allocateFloats(width * height, shared) };
  }
  return { kind, width, height, tile, input, calibration, layout, out: createOutputStage(sensor, options, wb, gamma, roundToFloat32, shared), planes };
}

/** Runs the tiles of a validated frame on the calling thread or on worker threads, then the finishing step. */
function runEngine(run: EngineRun): DemosaicResult {
  const { sensor, options, tile } = run;
  const { width, height } = sensor;
  const passes = falseColorPassCount(sensor);
  const requested = checkThreads(options);
  const threads = planThreads(requested, width * height, tileRowCount(height, tile));
  if (threads > 1) {
    const shared = shareSamples(run.input, width, height);
    if (shared !== null) {
      const job = buildJob(run, shared, true, passes);
      try {
        runTilesOnThreads(job, threads);
        finishFrame(job, passes);
        return { data: asBuffer(job.out.rgb8), floatData: job.out.floatOut, width, height, threads };
      } catch (error) {
        // A frame left to the default runs on this thread when no worker thread can be started here; a request does not.
        if (requested !== undefined || !(error instanceof EngineUnavailableError)) throw error;
      }
    } else if (requested !== undefined) {
      throw new InvalidRawSensorError('Threaded demosaicing needs the sensor samples as a typed array.');
    }
  }
  const job = buildJob(run, run.input, false, passes);
  runFrame(job, passes);
  return { data: asBuffer(job.out.rgb8), floatData: job.out.floatOut, width, height, threads: 1 };
}

function amazeNormalizationMax(sensor: BayerSensorData): number {
  const { data, bitsPerSample } = sensor;
  if (bitsPerSample) return (1 << bitsPerSample) - 1;
  if (!(data instanceof Uint16Array)) return BYTE_RANGE;
  let maxVal = 0;
  const len = Math.min(data.length, AMAZE_SCAN_SAMPLES);
  for (let i = 0; i < len; i += 1) {
    if (data[i] > maxVal) maxVal = data[i];
  }
  if (maxVal > AMAZE_BITS_14_MAX) return FULL_16_BIT_MAX;
  if (maxVal > AMAZE_BITS_12_MAX) return AMAZE_BITS_14_MAX;
  if (maxVal > AMAZE_BITS_10_MAX) return AMAZE_BITS_12_MAX;
  return BYTE_RANGE;
}

/**
 * AMaZE-style Bayer demosaicing: directional green estimates chosen by 5x5 local homogeneity, colour differences
 * interpolated from neighbouring sites and median-filtered, optional false-colour suppression, then white balance,
 * colour matrix and sRGB encoding. The result does not depend on the tile size or the thread count.
 */
export function demosaicAmazeBayerCfa(sensor: BayerSensorData, options?: DemosaicOptions): DemosaicResult {
  const { width, height, pattern, data, whiteBalance, applySrgbGamma } = sensor;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || (width & 1) !== 0 || (height & 1) !== 0) {
    throw new InvalidRawSensorError(`Invalid sensor dimensions: ${width}x${height}. Minimum 2x2 with even dimensions required.`);
  }
  if (!CFA_PATTERNS.has(pattern)) {
    throw new InvalidRawSensorError(`Unsupported Bayer CFA pattern: '${pattern}'. Expected RGGB, BGGR, GRBG, or GBRG.`);
  }
  checkPixelBudget(width, height);
  if (!data || data.length < width * height) {
    throw new InvalidRawSensorError(`Bayer sensor buffer underflow: expected at least ${width * height} samples, got ${data ? data.length : 0}.`);
  }
  const tile = checkTileSize(options);
  return runEngine({
    kind: 'amaze',
    sensor,
    options,
    tile,
    input: { samples: data, kind: 'direct' },
    calibration: buildCalibration(validateBayerSensorCalibration(sensor, amazeNormalizationMax(sensor)), 'amaze'),
    layout: resolveCfa(pattern),
    wb: whiteBalance ?? [1, 1, 1],
    gamma: Boolean(applySrgbGamma),
    roundToFloat32: false,
  });
}

interface AhdInput {
  sensorData: SensorInput;
  maxVal: number;
}

/** Legacy field aliases of the reference AHD: `rawData` for `data` and `bitDepth` for `bitsPerSample`. */
interface LegacyAhdFields {
  rawData?: BayerSensorData['data'];
  bitDepth?: number;
}

function resolveAhdInput(sensor: BayerSensorData, width: number, height: number): AhdInput {
  const legacy = sensor as BayerSensorData & LegacyAhdFields;
  const raw = sensor.data ?? legacy.rawData;
  if (!raw || raw.length === 0) {
    throw new InvalidRawSensorError('Bayer sensor buffer empty or undefined.');
  }
  const bitDepth = sensor.bitsPerSample ?? legacy.bitDepth ?? (raw instanceof Uint16Array ? 16 : 8);
  const packedBytes = !(raw instanceof Uint16Array) && !(raw instanceof Float32Array) && bitDepth > 8;
  const needed = packedBytes ? width * height * BYTES_PER_16_BIT_SAMPLE : width * height;
  if (raw.length < needed) {
    throw new InvalidRawSensorError(`Bayer sensor buffer underflow: expected at least ${needed} samples, got ${raw.length}.`);
  }
  return { sensorData: { samples: raw, kind: packedBytes ? 'bytes16' : 'direct' }, maxVal: (1 << bitDepth) - 1 };
}

/**
 * Adaptive Homogeneity-Directed demosaicing (Hirakawa and Parks, 2005): two complete candidate fields (green
 * interpolated horizontally or vertically, red and blue from colour differences), compared in CIELab by the
 * homogeneity of their 5x5 neighbourhoods, then a 3x3 median of the colour differences (see the tile module for the
 * arithmetic). The result does not depend on the tile size or the thread count.
 */
export function demosaicAhdBayerCfa(sensor: BayerSensorData, options?: DemosaicOptions): DemosaicResult {
  const { width, height } = sensor;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
    throw new InvalidRawSensorError(`Invalid sensor dimensions: ${width}x${height}. Minimum 2x2 required.`);
  }
  const pattern = String(sensor.pattern).toUpperCase();
  if (!CFA_PATTERNS.has(pattern)) {
    throw new InvalidRawSensorError(`Unsupported Bayer CFA pattern: '${sensor.pattern}'. Expected RGGB, BGGR, GRBG, or GBRG.`);
  }
  checkPixelBudget(width, height);
  const { sensorData, maxVal } = resolveAhdInput(sensor, width, height);
  const tile = checkTileSize(options);
  return runEngine({
    kind: 'ahd',
    sensor,
    options,
    tile,
    input: sensorData,
    calibration: buildCalibration(validateBayerSensorCalibration(sensor, maxVal), 'ahd'),
    layout: resolveCfa(pattern),
    wb: sensor.whiteBalance ?? [1, 1, 1],
    gamma: sensor.applySrgbGamma ?? true,
    roundToFloat32: true,
  });
}
