/**
 * Blue-noise dither mask by the void-and-cluster algorithm (R. Ulichney, "The void-and-cluster method for dither
 * array generation", Proc. SPIE 1913, 1993). The generator below is the committed source of the mask: it is
 * deterministic (a fixed-seed shuffle, ties broken by position) and builds the 64 x 64 array in a few tens of
 * milliseconds the first time it is asked for.
 *
 * A mask value is the rank of a pixel in the order in which the algorithm fills an empty array with the most
 * evenly spaced points, so thresholding the mask at any level gives a point pattern with no low-frequency
 * energy (blue noise), unlike the white noise of a random mask or the lattice of a golden-ratio ramp.
 */

export const BLUE_NOISE_SIDE = 64;
export const BLUE_NOISE_CELLS = BLUE_NOISE_SIDE * BLUE_NOISE_SIDE;
/** Gaussian standard deviation, in pixels, of the energy each point spreads (the paper uses 1.5). */
const SIGMA = 1.5;
/** Kernel half-width: weights beyond 4 sigma are below 0.0004 of the peak. */
const KERNEL_RADIUS = Math.ceil(4 * SIGMA);
/** Share of cells set in the initial binary pattern (the paper's "about 10%"). */
const INITIAL_DENSITY = 0.1;
/** Fixed seed of the initial shuffle: xorshift32 must not start at 0. */
const SEED = 0x9e3779b1;
/** The relaxation of the initial pattern converges in a few hundred moves; this bounds a pathological case. */
const MAX_RELAXATION_MOVES = BLUE_NOISE_CELLS * 8;
const XORSHIFT_LEFT_1 = 13;
const XORSHIFT_RIGHT = 17;
const XORSHIFT_LEFT_2 = 5;

class EnergyField {
  readonly energy = new Float64Array(BLUE_NOISE_CELLS);
  readonly bin = new Uint8Array(BLUE_NOISE_CELLS);
  private readonly offsets: Int32Array;
  private readonly weights: Float64Array;

  constructor() {
    const size = 2 * KERNEL_RADIUS + 1;
    this.offsets = new Int32Array(size * size * 2);
    this.weights = new Float64Array(size * size);
    let k = 0;
    for (let dy = -KERNEL_RADIUS; dy <= KERNEL_RADIUS; dy += 1) {
      for (let dx = -KERNEL_RADIUS; dx <= KERNEL_RADIUS; dx += 1) {
        this.offsets[k * 2] = dx;
        this.offsets[k * 2 + 1] = dy;
        this.weights[k] = Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA));
        k += 1;
      }
    }
  }

  private spread(cell: number, sign: 1 | -1): void {
    const cx = cell % BLUE_NOISE_SIDE;
    const cy = (cell - cx) / BLUE_NOISE_SIDE;
    for (let k = 0; k < this.weights.length; k += 1) {
      const x = (cx + this.offsets[k * 2] + BLUE_NOISE_SIDE) % BLUE_NOISE_SIDE;
      const y = (cy + this.offsets[k * 2 + 1] + BLUE_NOISE_SIDE) % BLUE_NOISE_SIDE;
      this.energy[y * BLUE_NOISE_SIDE + x] += sign * this.weights[k];
    }
  }

  add(cell: number): void {
    this.bin[cell] = 1;
    this.spread(cell, 1);
  }

  remove(cell: number): void {
    this.bin[cell] = 0;
    this.spread(cell, -1);
  }

  /** The set cell with the most energy around it: the tightest cluster. Ties go to the lowest index. */
  tightestCluster(): number {
    let best = -1;
    let bestEnergy = -Infinity;
    for (let i = 0; i < BLUE_NOISE_CELLS; i += 1) {
      if (this.bin[i] === 1 && this.energy[i] > bestEnergy) {
        bestEnergy = this.energy[i];
        best = i;
      }
    }
    return best;
  }

  /** The empty cell with the least energy around it: the largest void. Ties go to the lowest index. */
  largestVoid(): number {
    let best = -1;
    let bestEnergy = Infinity;
    for (let i = 0; i < BLUE_NOISE_CELLS; i += 1) {
      if (this.bin[i] === 0 && this.energy[i] < bestEnergy) {
        bestEnergy = this.energy[i];
        best = i;
      }
    }
    return best;
  }
}

/** Ranks 0 .. 4095, each used once: the order in which void-and-cluster fills the array. */
export function generateVoidAndClusterRanks(): Uint16Array {
  const ranks = new Uint16Array(BLUE_NOISE_CELLS);

  // Step 1: a pseudo-random initial pattern of about 10% ones.
  const order = new Uint16Array(BLUE_NOISE_CELLS);
  for (let i = 0; i < BLUE_NOISE_CELLS; i += 1) order[i] = i;
  let state = SEED;
  const next = (): number => {
    state ^= state << XORSHIFT_LEFT_1;
    state ^= state >>> XORSHIFT_RIGHT;
    state ^= state << XORSHIFT_LEFT_2;
    return state >>> 0;
  };
  for (let i = BLUE_NOISE_CELLS - 1; i > 0; i -= 1) {
    const j = next() % (i + 1);
    const swap = order[i];
    order[i] = order[j];
    order[j] = swap;
  }
  const initialOnes = Math.round(BLUE_NOISE_CELLS * INITIAL_DENSITY);
  const field = new EnergyField();
  for (let i = 0; i < initialOnes; i += 1) field.add(order[i]);

  // Step 2: move the tightest cluster into the largest void until the pattern is stable.
  for (let move = 0; move < MAX_RELAXATION_MOVES; move += 1) {
    const cluster = field.tightestCluster();
    field.remove(cluster);
    const hole = field.largestVoid();
    field.add(hole);
    if (hole === cluster) break;
  }

  // Phase 1: take ones out of the prototype, tightest cluster first; the last one out has rank 0.
  const prototype = Uint8Array.from(field.bin);
  for (let rank = initialOnes - 1; rank >= 0; rank -= 1) {
    const cluster = field.tightestCluster();
    field.remove(cluster);
    ranks[cluster] = rank;
  }

  // Phases 2 and 3: put the prototype back and fill the largest void with the next rank until nothing is left.
  // After half the cells are set, the largest void of the ones is the tightest cluster of the zeros.
  for (let i = 0; i < BLUE_NOISE_CELLS; i += 1) if (prototype[i] === 1) field.add(i);
  for (let rank = initialOnes; rank < BLUE_NOISE_CELLS; rank += 1) {
    const hole = field.largestVoid();
    field.add(hole);
    ranks[hole] = rank;
  }
  return ranks;
}

let cachedRanks: Uint16Array | undefined;
let cachedCentred: Float32Array | undefined;

/** The mask as ranks, generated on first use. */
export function blueNoiseRanks(): Uint16Array {
  cachedRanks ??= generateVoidAndClusterRanks();
  return cachedRanks;
}

/** The mask as thresholds centred on zero, (rank + 0.5) / 4096 - 0.5, in [-0.5, 0.5). */
export function blueNoiseCentred(): Float32Array {
  if (cachedCentred === undefined) {
    const ranks = blueNoiseRanks();
    cachedCentred = new Float32Array(BLUE_NOISE_CELLS);
    for (let i = 0; i < BLUE_NOISE_CELLS; i += 1) cachedCentred[i] = (ranks[i] + 0.5) / BLUE_NOISE_CELLS - 0.5;
  }
  return cachedCentred;
}
