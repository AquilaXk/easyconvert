/**
 * The order of the palette of an indexed PNG, chosen so that colours which sit next to each other in the picture sit next to each other in the
 * palette. A picture written that way has small differences between the indices of neighbouring pixels, which the row filters and the deflater
 * both use, and the most popular colour at index 0 matches the filter byte in front of every row.
 *
 * Ported from oxipng 10.2.1 (`src/reduction/palette.rs`: `CoOccurrenceMatrix`, `ezeng_reindex`, `pairwise_swap_search`,
 * `apply_most_popular_color`; oxipng/oxipng, MIT, Copyright (c) 2016 Joshua Holmer), which has them from Zeng's technique ("Index assignment
 * for palette-based images", Pinho et al., "A note on Zeng's technique for color reindexing of palette-based images", IEEE SPL 2004) and
 * the C of libwebp (BSD-3-Clause). Everything is its algorithm, in the same order of tie-breaks, so the order equals the one oxipng writes
 * at its `-o2`; what is ours is the typed arrays and the single pass over the pixels.
 */

const MAX_COLOURS = 256;
/** Least number of colours worth ordering: with two the order is a coin toss and the luma sort of oxipng covers them. */
const MIN_COLOURS = 3;
/** The most popular colour goes to index 0 only if it covers this share of the picture (oxipng: 15 percent). */
const POPULAR_SHARE_NUMERATOR = 3;
const POPULAR_SHARE_DENOMINATOR = 20;
/** The cells next to a cell are counted left and above, so every colour is counted about this many times in its row of the matrix. */
const COUNTS_PER_PIXEL = 4;

/** For every pair of colours, how often they are next to each other (left or above, both directions): `n * n` symmetric cells. */
function coOccurrences(indices: Uint8Array, width: number, height: number, colours: number): Uint32Array {
  const cells = new Uint32Array(colours * colours);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const value = indices[row + x];
      if (x > 0) cells[indices[row + x - 1] * colours + value] += 1;
      if (y > 0) cells[indices[row - width + x] * colours + value] += 1;
    }
  }
  for (let i = 0; i < colours; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      const sum = cells[i * colours + j] + cells[j * colours + i];
      cells[i * colours + j] = sum;
      cells[j * colours + i] = sum;
    }
  }
  return cells;
}

/** The pair with the most co-occurrences (the first of equal ones, by row then column), or null when no two colours meet. */
function heaviestEdge(cells: Uint32Array, colours: number): [number, number] | null {
  let best: [number, number] | null = null;
  let weight = 0;
  for (let i = 0; i < colours; i += 1) {
    for (let j = 0; j < i; j += 1) {
      const value = cells[i * colours + j];
      if (value > weight) {
        weight = value;
        best = [j, i];
      }
    }
  }
  return best;
}

/** Zeng's greedy order with the insertion at the cheapest position (oxipng's `ezeng_reindex`): the colour most tied to the placed ones goes next. */
function insertionOrder(cells: Uint32Array, colours: number, edge: [number, number]): number[] {
  const order = [edge[0], edge[1]];
  const sumColour: number[] = [];
  const sumWeight: number[] = [];
  let bestAt = 0;
  let bestWeight = 0;
  for (let colour = 0; colour < colours; colour += 1) {
    if (colour === order[0] || colour === order[1]) continue;
    const weight = cells[colour * colours + order[0]] + cells[colour * colours + order[1]];
    if (weight > bestWeight) {
      bestAt = sumColour.length;
      bestWeight = weight;
    }
    sumColour.push(colour);
    sumWeight.push(weight);
  }
  while (sumColour.length > 0) {
    const next = sumColour[bestAt];
    const nextRow = next * colours;
    const placed = order.length;
    let bestPosition = 0;
    let bestCost = Number.POSITIVE_INFINITY;
    let crossCost = 0;
    for (let position = 0; position <= placed; position += 1) {
      let newCost = 0;
      for (let k = 0; k < placed; k += 1) newCost += cells[nextRow + order[k]] * (k < position ? position - k : k + 1 - position);
      if (newCost + crossCost < bestCost) {
        bestCost = newCost + crossCost;
        bestPosition = position;
      }
      if (position < placed) {
        const rowAt = order[position] * colours;
        for (let k = position + 1; k < placed; k += 1) crossCost += cells[rowAt + order[k]];
        for (let k = 0; k < position; k += 1) crossCost -= cells[rowAt + order[k]];
      }
    }
    order.splice(bestPosition, 0, next);
    const last = sumColour.length - 1;
    sumColour[bestAt] = sumColour[last];
    sumWeight[bestAt] = sumWeight[last];
    sumColour.length = last;
    sumWeight.length = last;
    bestAt = 0;
    bestWeight = 0;
    for (let i = 0; i < sumColour.length; i += 1) {
      sumWeight[i] += cells[nextRow + sumColour[i]];
      if (sumWeight[i] > bestWeight) {
        bestAt = i;
        bestWeight = sumWeight[i];
      }
    }
  }
  return order;
}

/** Swaps neighbours of the order while that lowers the total of weight times distance (oxipng's `pairwise_swap_search` with a distance of 1). */
function swapNeighbours(order: number[], cells: Uint32Array, colours: number): void {
  let swaps = 2;
  while (swaps >= 2) {
    swaps = 0;
    for (let a = 0; a < colours - 1; a += 1) {
      const b = a + 1;
      const rowA = order[a] * colours;
      const rowB = order[b] * colours;
      let delta = 0;
      for (let i = 0; i < a; i += 1) delta += cells[rowA + order[i]] - cells[rowB + order[i]];
      for (let i = b + 1; i < colours; i += 1) delta -= cells[rowA + order[i]] - cells[rowB + order[i]];
      if (delta < 0) {
        const held = order[a];
        order[a] = order[b];
        order[b] = held;
        swaps += 1;
      }
    }
  }
}

/** Puts the colour that covers the most of the picture first, when it covers at least 15 percent (oxipng's `apply_most_popular_color`). */
function popularFirst(order: number[], cells: Uint32Array, colours: number, pixels: number): void {
  let popular = 0;
  let share = 0;
  for (let i = 0; i < colours; i += 1) {
    let sum = 0;
    for (let j = 0; j < colours; j += 1) sum += cells[i * colours + j];
    if (sum > share) {
      popular = i;
      share = sum;
    }
  }
  if (Math.floor(share / COUNTS_PER_PIXEL) < Math.floor((pixels * POPULAR_SHARE_NUMERATOR) / POPULAR_SHARE_DENOMINATOR)) return;
  const at = order.indexOf(popular);
  if (at >= Math.floor(colours / 2)) {
    order.reverse();
    order.unshift(...order.splice(order.length - (at + 1)));
  } else {
    order.push(...order.splice(0, at));
  }
}

/**
 * The palette order for a picture of 3 to 256 colours, as the old index of each new index, or null when the picture has too few colours or
 * the order is the one it already has. `indices` are one byte a pixel, row after row; every palette entry is used.
 */
export function coOccurrenceOrder(indices: Uint8Array, width: number, height: number, colours: number): Uint8Array | null {
  if (colours < MIN_COLOURS || colours > MAX_COLOURS || indices.length !== width * height) return null;
  const cells = coOccurrences(indices, width, height, colours);
  const edge = heaviestEdge(cells, colours);
  if (edge === null) return null;
  const order = insertionOrder(cells, colours, edge);
  swapNeighbours(order, cells, colours);
  popularFirst(order, cells, colours, indices.length);
  if (order.every((old, index) => old === index)) return null;
  return Uint8Array.from(order);
}

/** The picture's indices renumbered so that the colour `order[i]` becomes `i`. */
export function renumberIndices(indices: Uint8Array, order: Uint8Array): Buffer {
  const newIndexOf = new Uint8Array(MAX_COLOURS);
  order.forEach((old, index) => {
    newIndexOf[old] = index;
  });
  const out = Buffer.allocUnsafe(indices.length);
  for (let i = 0; i < indices.length; i += 1) out[i] = newIndexOf[indices[i]];
  return out;
}

/**
 * The order that swaps index 0 with the colour that most often starts or ends a row, or null when that colour is index 0 or two colours tie. A
 * flat background at index 0 makes the filter byte of 0 in front of each row part of a run, which the deflater matches across the rows; it
 * is what oxipng's `sorted_palette` does first (`most_popular_edge_color`), without its luma sort, which moves nothing else that matters to a
 * graphic (measured with this file's callers).
 */
export function edgeColourFirst(indices: Uint8Array, width: number, height: number, colours: number): Uint8Array | null {
  if (colours < 2 || colours > MAX_COLOURS || indices.length !== width * height || width === 0) return null;
  const counts = new Uint32Array(MAX_COLOURS);
  for (let y = 0; y < height; y += 1) {
    counts[indices[y * width]] += 1;
    counts[indices[(y + 1) * width - 1]] += 1;
  }
  let edge = 0;
  let ties = 1;
  for (let colour = 1; colour < colours; colour += 1) {
    if (counts[colour] > counts[edge]) {
      edge = colour;
      ties = 1;
    } else if (counts[colour] === counts[edge]) ties += 1;
  }
  if (edge === 0 || ties > 1) return null;
  const order = Uint8Array.from({ length: colours }, (_, index) => index);
  order[0] = edge;
  order[edge] = 0;
  return order;
}
