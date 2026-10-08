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
/** Cells per axis of the candidate grid: 20 x 20 x 20 cells of about one palette spacing for a 256-colour palette. */
const GRID_CELLS_PER_AXIS = 20;
/** Share of the extent added around the points' box, so queries slightly outside it still land in a cell. */
const GRID_MARGIN = 0.05;
/** Relative slack on the grid's candidate bound, so rounding never drops a point that ties the limit. */
const GRID_BOUND_SLACK = 1e-9;
/** Rounding slack on the neighbour bound, so that a point exactly on it is still measured. */
const NEIGHBOUR_BOUND_SLACK = 1e-12;
/** A traversal stack of this size covers the deepest tree `KD_TREE_MAX_POINTS` points can make, five times over. */
const STACK_SIZE = 64;
const NO_NODE = -1;

/** Distance from `value` to the interval [lo, hi]: 0 inside it. */
function intervalGap(value: number, lo: number, hi: number): number {
  if (value < lo) return lo - value;
  if (value > hi) return value - hi;
  return 0;
}

export class KdTree3 {
  readonly size: number;
  /** Squared distance of the point the last `nearestIndex` call returned. */
  lastDistance2 = Infinity;
  private readonly coords: Float64Array;
  /** Per node: the point it holds (index into the input), its split axis and its two children. */
  private readonly point: Int32Array;
  private readonly axis: Uint8Array;
  private readonly left: Int32Array;
  private readonly right: Int32Array;
  private readonly root: number;
  private nextNode = 0;
  private readonly stackNode = new Int32Array(STACK_SIZE);
  private readonly stackDistance = new Float64Array(STACK_SIZE);
  private readonly query = new Float64Array(DIMENSIONS);
  /** For each point, the other points in increasing distance from it (built on the first hinted query). */
  private neighbours: Uint16Array | null = null;
  private neighbourDistance: Float64Array | null = null;
  /** The coordinates of the same neighbours, laid out in the same order, so a scan reads memory in sequence. */
  private neighbourCoords: Float64Array | null = null;
  /** Candidate grid (see `enableGrid`): corner of its box, cells per unit length, and each cell's candidate points. */
  private readonly gridLow = new Float64Array(DIMENSIONS);
  private readonly gridScale = new Float64Array(DIMENSIONS);
  private gridStart: Uint32Array | null = null;
  private gridList: Uint16Array | null = null;

  /** `points` is x, y, z interleaved; `count` points are read from it. */
  constructor(points: ArrayLike<number>, count: number) {
    if (!Number.isInteger(count) || count < 1 || count > KD_TREE_MAX_POINTS) {
      throw new RangeError(`A k-d tree holds 1 to ${KD_TREE_MAX_POINTS} points; got ${count}.`);
    }
    this.size = count;
    this.coords = new Float64Array(count * DIMENSIONS);
    for (let i = 0; i < count * DIMENSIONS; i += 1) this.coords[i] = points[i];
    this.point = new Int32Array(count);
    this.axis = new Uint8Array(count);
    this.left = new Int32Array(count).fill(NO_NODE);
    this.right = new Int32Array(count).fill(NO_NODE);
    const order = new Int32Array(count);
    for (let i = 0; i < count; i += 1) order[i] = i;
    this.root = this.build(order, 0, count);
  }

  private build(order: Int32Array, start: number, end: number): number {
    if (start >= end) return NO_NODE;
    // Split on the axis along which the points of this range are spread widest.
    let bestAxis = 0;
    let bestSpread = -1;
    for (let d = 0; d < DIMENSIONS; d += 1) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = start; i < end; i += 1) {
        const v = this.coords[order[i] * DIMENSIONS + d];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo > bestSpread) {
        bestSpread = hi - lo;
        bestAxis = d;
      }
    }
    const axis = bestAxis;
    order.subarray(start, end).sort((a, b) => this.coords[a * DIMENSIONS + axis] - this.coords[b * DIMENSIONS + axis] || a - b);
    const mid = (start + end) >> 1;
    const node = this.nextNode;
    this.nextNode += 1;
    this.point[node] = order[mid];
    this.axis[node] = axis;
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
   * Builds a grid over the bounding box of the points that lists, for each cell, every point that can be the
   * nearest one for some location in that cell. A point p qualifies unless it is farther from the cell than the
   * nearest point is from the cell's farthest corner: such a p loses to that point for every location in the
   * cell. The lists are therefore complete, and a query inside the box measures only its cell's few candidates
   * and still returns the exact nearest point. Building costs a few tens of milliseconds, so it pays off for
   * rasters of hundreds of thousands of queries.
   */
  enableGrid(): void {
    if (this.gridStart !== null || this.size > NEIGHBOUR_TABLE_MAX_POINTS) return;
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
    const start = new Uint32Array(cells * cells * cells + 1);
    const lists: number[] = [];
    const nearest2 = new Float64Array(n);
    for (let cx = 0; cx < cells; cx += 1) {
      for (let cy = 0; cy < cells; cy += 1) {
        for (let cz = 0; cz < cells; cz += 1) {
          const x0 = low[0] + cx * edge[0];
          const y0 = low[1] + cy * edge[1];
          const z0 = low[2] + cz * edge[2];
          let limit = Infinity;
          for (let i = 0; i < n; i += 1) {
            const px = c[i * DIMENSIONS];
            const py = c[i * DIMENSIONS + 1];
            const pz = c[i * DIMENSIONS + 2];
            const nx = intervalGap(px, x0, x0 + edge[0]);
            const ny = intervalGap(py, y0, y0 + edge[1]);
            const nz = intervalGap(pz, z0, z0 + edge[2]);
            nearest2[i] = nx * nx + ny * ny + nz * nz;
            const fx = Math.max(Math.abs(px - x0), Math.abs(px - x0 - edge[0]));
            const fy = Math.max(Math.abs(py - y0), Math.abs(py - y0 - edge[1]));
            const fz = Math.max(Math.abs(pz - z0), Math.abs(pz - z0 - edge[2]));
            const farthest = fx * fx + fy * fy + fz * fz;
            if (farthest < limit) limit = farthest;
          }
          for (let i = 0; i < n; i += 1) if (nearest2[i] <= limit * (1 + GRID_BOUND_SLACK)) lists.push(i);
          start[(cx * cells + cy) * cells + cz + 1] = lists.length;
        }
      }
    }
    this.gridStart = start;
    this.gridList = Uint16Array.from(lists);
  }

  /** The candidates of the grid cell holding (x, y, z), or -1 when the point lies outside the grid. */
  private cellOf(x: number, y: number, z: number): number {
    const cells = GRID_CELLS_PER_AXIS;
    const gx = (x - this.gridLow[0]) * this.gridScale[0];
    const gy = (y - this.gridLow[1]) * this.gridScale[1];
    const gz = (z - this.gridLow[2]) * this.gridScale[2];
    if (!(gx >= 0 && gx < cells && gy >= 0 && gy < cells && gz >= 0 && gz < cells)) return -1;
    return (Math.trunc(gx) * cells + Math.trunc(gy)) * cells + Math.trunc(gz);
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
    const c = this.coords;
    if (this.gridStart !== null) {
      const cell = this.cellOf(x, y, z);
      if (cell >= 0) {
        const list = this.gridList as Uint16Array;
        const end = this.gridStart[cell + 1];
        let found = -1;
        let foundDistance = Infinity;
        for (let m = this.gridStart[cell]; m < end; m += 1) {
          const p = list[m];
          const dx = x - c[p * DIMENSIONS];
          const dy = y - c[p * DIMENSIONS + 1];
          const dz = z - c[p * DIMENSIONS + 2];
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
    if (hint >= 0 && hint < this.size && this.size <= NEIGHBOUR_TABLE_MAX_POINTS && this.size > 1) {
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
    const query = this.query;
    query[0] = x;
    query[1] = y;
    query[2] = z;
    let bestIndex = -1;
    let bestDistance = Infinity;
    // A caller that looks up neighbouring pixels passes the last answer: it is usually the next one, and
    // starting from its distance lets the search discard almost every branch.
    if (hint >= 0 && hint < this.size) {
      const dx = x - c[hint * DIMENSIONS];
      const dy = y - c[hint * DIMENSIONS + 1];
      const dz = z - c[hint * DIMENSIONS + 2];
      bestIndex = hint;
      bestDistance = dx * dx + dy * dy + dz * dz;
    }
    this.stackNode[0] = this.root;
    this.stackDistance[0] = 0;
    let top = 1;
    while (top > 0) {
      top -= 1;
      let node = this.stackNode[top];
      // The far side of a split is only worth visiting while its splitting plane is not farther than the best point
      // (a plane at exactly that distance can hold a point of equal distance and lower index).
      if (this.stackDistance[top] > bestDistance) continue;
      while (node !== NO_NODE) {
        const p = this.point[node];
        const dx = x - c[p * DIMENSIONS];
        const dy = y - c[p * DIMENSIONS + 1];
        const dz = z - c[p * DIMENSIONS + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestDistance || (d2 === bestDistance && p < bestIndex)) {
          bestDistance = d2;
          bestIndex = p;
        }
        const axis = this.axis[node];
        const delta = query[axis] - c[p * DIMENSIONS + axis];
        const goesLeft = delta < 0;
        const far = goesLeft ? this.right[node] : this.left[node];
        if (far !== NO_NODE && top < STACK_SIZE) {
          this.stackNode[top] = far;
          this.stackDistance[top] = delta * delta;
          top += 1;
        }
        node = goesLeft ? this.left[node] : this.right[node];
      }
    }
    this.lastDistance2 = bestDistance;
    return bestIndex;
  }
}
