/**
 * Static k-d tree over three-dimensional points (a colour palette in Oklab), for exact nearest-neighbour search
 * (Bentley 1975). Built once by median splits on the axis of widest spread; queries walk an explicit stack, so
 * there is no recursion and no allocation per query. A palette has at most 256 entries, so the tree is at most
 * nine levels deep.
 */

const DIMENSIONS = 3;
/** Most points a tree holds; the palettes this serves have at most 256 colours. */
export const KD_TREE_MAX_POINTS = 4096;
/**
 * Largest tree for which each point keeps a sorted list of its neighbours (size squared entries) to answer
 * queries that come with a hint.
 */
const NEIGHBOUR_TABLE_MAX_POINTS = 512;
/**
 * Bits and cells per axis of the lazy Heckbert `minmaxdist` inverse-colormap grid (`32 x 32 x 32 = 32,768` subboxes),
 * adapted from Paul Heckbert (SIGGRAPH '82) and `find_nearby_colors` in `mozilla/mozjpeg` `jquant2.c` lines 628-754
 * (commit `08265790774cd0714832c9e675522acbe5581437`, IJG / BSD-3-Clause; based in part on the work of the Independent
 * JPEG Group, Copyright (C) 1991-1996 Thomas G. Lane, Copyright (C) 2009-2023 D. R. Commander).
 */
const GRID_BITS = 5;
const GRID_CELLS_PER_AXIS = 1 << GRID_BITS;
const GRID_TOTAL_CELLS = 1 << (GRID_BITS * DIMENSIONS);
/** Share of the extent added around the points' box, so queries slightly outside it still land in a cell. */
const GRID_MARGIN = 0.05;
/** Relative slack on the grid's candidate bound, so rounding never drops a point that ties the limit. */
const GRID_BOUND_SLACK = 1e-9;
const GRID_BOUND_ABS_SLACK = 1e-24;
/** Rounding slack on the neighbour bound, so that a point exactly on it is still measured. */
const NEIGHBOUR_BOUND_SLACK = 1e-12;
/** Query count at which the lazy 32x32x32 candidate grid is enabled automatically when not already active. */
const AUTO_GRID_QUERY_THRESHOLD = 512;
const AUTO_GRID_MIN_POINTS = 16;
/** A traversal stack of this size covers the deepest tree `KD_TREE_MAX_POINTS` points can make, five times over. */
const STACK_SIZE = 64;
const NO_NODE = -1;

/** Distance from `value` to the interval [lo, hi]: 0 inside it. */
function intervalGap(value: number, lo: number, hi: number): number {
  if (value < lo) return lo - value;
  if (value > hi) return value - hi;
  return 0;
}

/** In-place quickselect (`nth_element`) partitioning `order[start..end)` around `target` by `(coords[p*3+axis], p)`. */
function selectAxisMedian(coords: Float64Array, order: Int32Array, start: number, end: number, target: number, axis: number): void {
  let lo = start;
  let hi = end - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const pivotIdx = order[mid];
    const pivotVal = coords[pivotIdx * DIMENSIONS + axis];
    order[mid] = order[hi];
    order[hi] = pivotIdx;
    let store = lo;
    for (let i = lo; i < hi; i += 1) {
      const idx = order[i];
      const val = coords[idx * DIMENSIONS + axis];
      if (val < pivotVal || (val === pivotVal && idx < pivotIdx)) {
        order[i] = order[store];
        order[store] = idx;
        store += 1;
      }
    }
    order[hi] = order[store];
    order[store] = pivotIdx;
    if (store === target) return;
    if (store < target) lo = store + 1;
    else hi = store - 1;
  }
}

export class KdTree3 {
  readonly size: number;
  /** Squared distance of the point the last `nearestIndex` call returned. */
  lastDistance2 = Infinity;
  private readonly coords: Float64Array;
  private readonly ptX: Float64Array;
  private readonly ptY: Float64Array;
  private readonly ptZ: Float64Array;
  /** Per node (SoA in preorder DFS layout): point index, node coordinates, split axis, and child indices. */
  private readonly point: Int32Array;
  private readonly nodeX: Float64Array;
  private readonly nodeY: Float64Array;
  private readonly nodeZ: Float64Array;
  private readonly axis: Uint8Array;
  private readonly left: Int32Array;
  private readonly right: Int32Array;
  private readonly root: number;
  private nextNode = 0;
  private ungriddedQueries = 0;
  private readonly stackNode = new Int32Array(STACK_SIZE);
  private readonly stackDistance = new Float64Array(STACK_SIZE);
  /** For each point, the other points in increasing distance from it (built on the first hinted query). */
  private neighbours: Uint16Array | null = null;
  private neighbourDistance: Float64Array | null = null;
  /** The coordinates of the same neighbours, laid out in the same order, so a scan reads memory in sequence. */
  private neighbourCoords: Float64Array | null = null;
  /** Lazy 32x32x32 Heckbert `minmaxdist` grid: `-1` unvisited, `>= 0` single winner, `<= -2` `-(poolOffset + 2)`. */
  private readonly gridLow = new Float64Array(DIMENSIONS);
  private readonly gridScale = new Float64Array(DIMENSIONS);
  private gridCells: Int32Array | null = null;
  private gridNearX2: Float64Array | null = null;
  private gridFarX2: Float64Array | null = null;
  private gridNearY2: Float64Array | null = null;
  private gridFarY2: Float64Array | null = null;
  private gridNearZ2: Float64Array | null = null;
  private gridFarZ2: Float64Array | null = null;
  private gridScratchNear: Float64Array | null = null;
  private gridPool: Uint16Array | null = null;
  private gridPoolLen = 0;

  /** `points` is x, y, z interleaved; `count` points are read from it. */
  constructor(points: ArrayLike<number>, count: number) {
    if (!Number.isInteger(count) || count < 1 || count > KD_TREE_MAX_POINTS) {
      throw new RangeError(`A k-d tree holds 1 to ${KD_TREE_MAX_POINTS} points; got ${count}.`);
    }
    this.size = count;
    this.coords = new Float64Array(count * DIMENSIONS);
    this.ptX = new Float64Array(count);
    this.ptY = new Float64Array(count);
    this.ptZ = new Float64Array(count);
    for (let i = 0; i < count; i += 1) {
      const x = points[i * DIMENSIONS];
      const y = points[i * DIMENSIONS + 1];
      const z = points[i * DIMENSIONS + 2];
      this.coords[i * DIMENSIONS] = x;
      this.coords[i * DIMENSIONS + 1] = y;
      this.coords[i * DIMENSIONS + 2] = z;
      this.ptX[i] = x;
      this.ptY[i] = y;
      this.ptZ[i] = z;
    }
    this.point = new Int32Array(count);
    this.nodeX = new Float64Array(count);
    this.nodeY = new Float64Array(count);
    this.nodeZ = new Float64Array(count);
    this.axis = new Uint8Array(count);
    this.left = new Int32Array(count).fill(NO_NODE);
    this.right = new Int32Array(count).fill(NO_NODE);
    const order = new Int32Array(count);
    for (let i = 0; i < count; i += 1) order[i] = i;
    this.root = this.build(order, 0, count);
  }

  private build(order: Int32Array, start: number, end: number): number {
    if (start >= end) return NO_NODE;
    const c = this.coords;
    // Split on the axis along which the points of this range are spread widest.
    let bestAxis = 0;
    let bestSpread = -1;
    for (let d = 0; d < DIMENSIONS; d += 1) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = start; i < end; i += 1) {
        const v = c[order[i] * DIMENSIONS + d];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo > bestSpread) {
        bestSpread = hi - lo;
        bestAxis = d;
      }
    }
    const mid = (start + end) >> 1;
    selectAxisMedian(c, order, start, end, mid, bestAxis);
    const p = order[mid];
    const node = this.nextNode;
    this.nextNode += 1;
    this.point[node] = p;
    this.nodeX[node] = c[p * DIMENSIONS];
    this.nodeY[node] = c[p * DIMENSIONS + 1];
    this.nodeZ[node] = c[p * DIMENSIONS + 2];
    this.axis[node] = bestAxis;
    this.left[node] = this.build(order, start, mid);
    this.right[node] = this.build(order, mid + 1, end);
    return node;
  }

  private buildNeighbourTable(): void {
    const n = this.size;
    const stride = n - 1;
    const index = new Uint16Array(n * stride);
    const distance = new Float64Array(n * stride);
    const coords = new Float64Array(n * stride * DIMENSIONS);
    const c = this.coords;
    const others = new Int32Array(stride);
    const scratch = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      let k = 0;
      for (let j = 0; j < n; j += 1) {
        const dx = c[i * DIMENSIONS] - c[j * DIMENSIONS];
        const dy = c[i * DIMENSIONS + 1] - c[j * DIMENSIONS + 1];
        const dz = c[i * DIMENSIONS + 2] - c[j * DIMENSIONS + 2];
        scratch[j] = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (j !== i) {
          others[k] = j;
          k += 1;
        }
      }
      others.sort((a, b) => scratch[a] - scratch[b] || a - b);
      for (let m = 0; m < stride; m += 1) {
        index[i * stride + m] = others[m];
        distance[i * stride + m] = scratch[others[m]];
        coords[(i * stride + m) * DIMENSIONS] = c[others[m] * DIMENSIONS];
        coords[(i * stride + m) * DIMENSIONS + 1] = c[others[m] * DIMENSIONS + 1];
        coords[(i * stride + m) * DIMENSIONS + 2] = c[others[m] * DIMENSIONS + 2];
      }
    }
    this.neighbours = index;
    this.neighbourDistance = distance;
    this.neighbourCoords = coords;
  }

  /**
   * Enables a lazy 32x32x32 Heckbert `minmaxdist` candidate grid over the bounding box of the points.
   * Only the 1D axis distance tables (`32 * n`) are precomputed upfront (< 0.05 ms); each 3D subbox is populated
   * on first hit, storing a single-winner index directly (`>= 0`) for O(1) lookup or a compact slice in `gridPool`.
   */
  enableGrid(): void {
    if (this.gridCells !== null || this.size > NEIGHBOUR_TABLE_MAX_POINTS) return;
    const n = this.size;
    const c = this.coords;
    const cells = GRID_CELLS_PER_AXIS;
    const low = this.gridLow;
    const edge = new Float64Array(DIMENSIONS);
    for (let d = 0; d < DIMENSIONS; d += 1) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < n; i += 1) {
        const v = c[i * DIMENSIONS + d];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const margin = Math.max((hi - lo) * GRID_MARGIN, 1e-6);
      low[d] = lo - margin;
      edge[d] = (hi - lo + 2 * margin) / cells;
      this.gridScale[d] = 1 / edge[d];
    }
    const nearX2 = new Float64Array(cells * n);
    const farX2 = new Float64Array(cells * n);
    const nearY2 = new Float64Array(cells * n);
    const farY2 = new Float64Array(cells * n);
    const nearZ2 = new Float64Array(cells * n);
    const farZ2 = new Float64Array(cells * n);
    const { ptX, ptY, ptZ } = this;
    for (let cell = 0; cell < cells; cell += 1) {
      const x0 = low[0] + cell * edge[0];
      const y0 = low[1] + cell * edge[1];
      const z0 = low[2] + cell * edge[2];
      const x1 = x0 + edge[0];
      const y1 = y0 + edge[1];
      const z1 = z0 + edge[2];
      const base = cell * n;
      for (let i = 0; i < n; i += 1) {
        const px = ptX[i];
        const py = ptY[i];
        const pz = ptZ[i];
        const nx = intervalGap(px, x0, x1);
        const ny = intervalGap(py, y0, y1);
        const nz = intervalGap(pz, z0, z1);
        nearX2[base + i] = nx * nx;
        nearY2[base + i] = ny * ny;
        nearZ2[base + i] = nz * nz;
        const fx = Math.max(Math.abs(px - x0), Math.abs(px - x1));
        const fy = Math.max(Math.abs(py - y0), Math.abs(py - y1));
        const fz = Math.max(Math.abs(pz - z0), Math.abs(pz - z1));
        farX2[base + i] = fx * fx;
        farY2[base + i] = fy * fy;
        farZ2[base + i] = fz * fz;
      }
    }
    this.gridNearX2 = nearX2;
    this.gridFarX2 = farX2;
    this.gridNearY2 = nearY2;
    this.gridFarY2 = farY2;
    this.gridNearZ2 = nearZ2;
    this.gridFarZ2 = farZ2;
    this.gridScratchNear = new Float64Array(n);
    this.gridPool = new Uint16Array(Math.max(2048, n * 8));
    this.gridPoolLen = 0;
    this.gridCells = new Int32Array(GRID_TOTAL_CELLS).fill(-1);
  }

  private fillGridCell(cell: number, cx: number, cy: number, cz: number): number {
    const n = this.size;
    const nearX2 = this.gridNearX2 as Float64Array;
    const farX2 = this.gridFarX2 as Float64Array;
    const nearY2 = this.gridNearY2 as Float64Array;
    const farY2 = this.gridFarY2 as Float64Array;
    const nearZ2 = this.gridNearZ2 as Float64Array;
    const farZ2 = this.gridFarZ2 as Float64Array;
    const nearest2 = this.gridScratchNear as Float64Array;
    const xBase = cx * n;
    const yBase = cy * n;
    const zBase = cz * n;
    let limit = Infinity;
    for (let i = 0; i < n; i += 1) {
      const near = nearX2[xBase + i] + nearY2[yBase + i] + nearZ2[zBase + i];
      nearest2[i] = near;
      const far = farX2[xBase + i] + farY2[yBase + i] + farZ2[zBase + i];
      if (far < limit) limit = far;
    }
    const bound = limit * (1 + GRID_BOUND_SLACK) + GRID_BOUND_ABS_SLACK;
    let count = 0;
    let singleWinner = 0;
    for (let i = 0; i < n; i += 1) {
      if (nearest2[i] <= bound) {
        singleWinner = i;
        count += 1;
      }
    }
    const gridCells = this.gridCells as Int32Array;
    if (count === 1) {
      gridCells[cell] = singleWinner;
      return singleWinner;
    }
    let pool = this.gridPool as Uint16Array;
    if (this.gridPoolLen + count + 1 > pool.length) {
      const grown = new Uint16Array(Math.max(pool.length * 2, this.gridPoolLen + count + 1024));
      grown.set(pool.subarray(0, this.gridPoolLen));
      pool = grown;
      this.gridPool = pool;
    }
    const offset = this.gridPoolLen;
    pool[offset] = count;
    let k = 1;
    for (let i = 0; i < n; i += 1) {
      if (nearest2[i] <= bound) {
        pool[offset + k] = i;
        k += 1;
      }
    }
    this.gridPoolLen = offset + count + 1;
    const encoded = -(offset + 2);
    gridCells[cell] = encoded;
    return encoded;
  }

  /**
   * Exact nearest point by the triangle inequality, starting from `hint`: a point farther from the hint than
   * (distance of the query to the hint) + (distance of the query to the best point so far) cannot be nearer,
   * so only the hint's closest neighbours are measured. With a good hint that is one to three points.
   */
  private nearestFromHint(x: number, y: number, z: number, hint: number): number {
    if (this.neighbours === null) this.buildNeighbourTable();
    const neighbours = this.neighbours as Uint16Array;
    const distances = this.neighbourDistance as Float64Array;
    const around = this.neighbourCoords as Float64Array;
    const c = this.coords;
    const stride = this.size - 1;
    const dx0 = x - c[hint * DIMENSIONS];
    const dy0 = y - c[hint * DIMENSIONS + 1];
    const dz0 = z - c[hint * DIMENSIONS + 2];
    let bestDistance2 = dx0 * dx0 + dy0 * dy0 + dz0 * dz0;
    const hintDistance = Math.sqrt(bestDistance2);
    let reach = 2 * hintDistance + NEIGHBOUR_BOUND_SLACK;
    let bestIndex = hint;
    const base = hint * stride;
    for (let m = 0; m < stride; m += 1) {
      if (distances[base + m] > reach) break;
      const o = (base + m) * DIMENSIONS;
      const dx = x - around[o];
      const dy = y - around[o + 1];
      const dz = z - around[o + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestDistance2 || (d2 === bestDistance2 && neighbours[base + m] < bestIndex)) {
        bestDistance2 = d2;
        bestIndex = neighbours[base + m];
        reach = hintDistance + Math.sqrt(d2) + NEIGHBOUR_BOUND_SLACK;
      }
    }
    this.lastDistance2 = bestDistance2;
    return bestIndex;
  }

  /**
   * Index of the point nearest to (x, y, z); ties go to the lower index. `hint` is a point to start from (any index,
   * for speed only), `otherHint` a second one. The squared distance is left in `lastDistance2`.
   */
  nearestIndex(x: number, y: number, z: number, hint: number = -1, otherHint: number = -1): number {
    if (
      this.gridCells === null &&
      this.size >= AUTO_GRID_MIN_POINTS &&
      this.size <= NEIGHBOUR_TABLE_MAX_POINTS &&
      ++this.ungriddedQueries >= AUTO_GRID_QUERY_THRESHOLD
    ) {
      this.enableGrid();
    }
    if (this.gridCells !== null) {
      const gx = (x - this.gridLow[0]) * this.gridScale[0];
      const gy = (y - this.gridLow[1]) * this.gridScale[1];
      const gz = (z - this.gridLow[2]) * this.gridScale[2];
      if (gx >= 0 && gx < GRID_CELLS_PER_AXIS && gy >= 0 && gy < GRID_CELLS_PER_AXIS && gz >= 0 && gz < GRID_CELLS_PER_AXIS) {
        const cx = gx | 0;
        const cy = gy | 0;
        const cz = gz | 0;
        const cell = (cx << 10) | (cy << 5) | cz;
        let entry = this.gridCells[cell];
        if (entry === -1) entry = this.fillGridCell(cell, cx, cy, cz);
        const { ptX, ptY, ptZ } = this;
        if (entry >= 0) {
          const dx = x - ptX[entry];
          const dy = y - ptY[entry];
          const dz = z - ptZ[entry];
          this.lastDistance2 = dx * dx + dy * dy + dz * dz;
          return entry;
        }
        const pool = this.gridPool as Uint16Array;
        const offset = -entry - 2;
        const end = offset + 1 + pool[offset];
        let found = pool[offset + 1];
        const dx0 = x - ptX[found];
        const dy0 = y - ptY[found];
        const dz0 = z - ptZ[found];
        let foundDistance = dx0 * dx0 + dy0 * dy0 + dz0 * dz0;
        for (let m = offset + 2; m < end; m += 1) {
          const p = pool[m];
          const dx = x - ptX[p];
          const dy = y - ptY[p];
          const dz = z - ptZ[p];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < foundDistance) {
            foundDistance = d2;
            found = p;
          }
        }
        this.lastDistance2 = foundDistance;
        return found;
      }
    }
    const c = this.coords;
    if (hint >= 0 && hint < this.size && this.size <= NEIGHBOUR_TABLE_MAX_POINTS && this.size > 1) {
      if (this.neighbours !== null || otherHint >= 0) {
        let start = hint;
        if (otherHint >= 0 && otherHint < this.size && otherHint !== hint) {
          // Of two guesses, start from the one nearer the query: the smaller its distance, the fewer neighbours to measure.
          const ax = x - c[hint * DIMENSIONS];
          const ay = y - c[hint * DIMENSIONS + 1];
          const az = z - c[hint * DIMENSIONS + 2];
          const bx = x - c[otherHint * DIMENSIONS];
          const by = y - c[otherHint * DIMENSIONS + 1];
          const bz = z - c[otherHint * DIMENSIONS + 2];
          if (bx * bx + by * by + bz * bz < ax * ax + ay * ay + az * az) start = otherHint;
        }
        return this.nearestFromHint(x, y, z, start);
      }
    }
    return this.nearestByTree(x, y, z, hint);
  }

  private nearestByTree(x: number, y: number, z: number, hint: number): number {
    const c = this.coords;
    const nodeX = this.nodeX;
    const nodeY = this.nodeY;
    const nodeZ = this.nodeZ;
    const point = this.point;
    const axisArr = this.axis;
    const leftArr = this.left;
    const rightArr = this.right;
    const stackNode = this.stackNode;
    const stackDistance = this.stackDistance;
    let bestIndex = -1;
    let bestDistance = Infinity;
    if (hint >= 0 && hint < this.size) {
      const dx = x - c[hint * DIMENSIONS];
      const dy = y - c[hint * DIMENSIONS + 1];
      const dz = z - c[hint * DIMENSIONS + 2];
      bestIndex = hint;
      bestDistance = dx * dx + dy * dy + dz * dz;
    }
    stackNode[0] = this.root;
    stackDistance[0] = 0;
    let top = 1;
    while (top > 0) {
      top -= 1;
      let node = stackNode[top];
      if (stackDistance[top] > bestDistance) continue;
      while (node !== NO_NODE) {
        const nx = nodeX[node];
        const ny = nodeY[node];
        const nz = nodeZ[node];
        const dx = x - nx;
        const dy = y - ny;
        const dz = z - nz;
        const d2 = dx * dx + dy * dy + dz * dz;
        const p = point[node];
        if (d2 < bestDistance || (d2 === bestDistance && p < bestIndex)) {
          bestDistance = d2;
          bestIndex = p;
        }
        const ax = axisArr[node];
        let delta = dz;
        if (ax === 0) delta = dx;
        else if (ax === 1) delta = dy;
        const goesLeft = delta < 0;
        const far = goesLeft ? rightArr[node] : leftArr[node];
        const delta2 = delta * delta;
        if (far !== NO_NODE && delta2 <= bestDistance && top < STACK_SIZE) {
          stackNode[top] = far;
          stackDistance[top] = delta2;
          top += 1;
        }
        node = goesLeft ? leftArr[node] : rightArr[node];
      }
    }
    this.lastDistance2 = bestDistance;
    return bestIndex;
  }
}
