/**
 * Spectral analysis of a square dither mask: a plain discrete Fourier transform (separable, O(n^3)) with the
 * power averaged over rings of equal radial frequency. It shares nothing with the generator under test.
 */

/** Power |F(u, v)|^2 of an n x n real field, DC at (0, 0), computed with a separable DFT. */
export function powerSpectrum(field: ArrayLike<number>, n: number): Float64Array {
  const cos = new Float64Array(n * n);
  const sin = new Float64Array(n * n);
  for (let k = 0; k < n; k += 1) {
    for (let x = 0; x < n; x += 1) {
      cos[k * n + x] = Math.cos((2 * Math.PI * k * x) / n);
      sin[k * n + x] = Math.sin((2 * Math.PI * k * x) / n);
    }
  }
  // Rows first: R[y][u] = sum_x f[y][x] e^{-2 pi i u x / n}.
  const realRows = new Float64Array(n * n);
  const imagRows = new Float64Array(n * n);
  for (let y = 0; y < n; y += 1) {
    for (let u = 0; u < n; u += 1) {
      let re = 0;
      let im = 0;
      for (let x = 0; x < n; x += 1) {
        const value = field[y * n + x];
        re += value * cos[u * n + x];
        im -= value * sin[u * n + x];
      }
      realRows[y * n + u] = re;
      imagRows[y * n + u] = im;
    }
  }
  const power = new Float64Array(n * n);
  for (let u = 0; u < n; u += 1) {
    for (let v = 0; v < n; v += 1) {
      let re = 0;
      let im = 0;
      for (let y = 0; y < n; y += 1) {
        const a = realRows[y * n + u];
        const b = imagRows[y * n + u];
        const c = cos[v * n + y];
        const s = -sin[v * n + y];
        re += a * c - b * s;
        im += a * s + b * c;
      }
      power[v * n + u] = re * re + im * im;
    }
  }
  return power;
}

/**
 * Mean power per integer radial frequency (cycles per field width), DC excluded; index r holds the mean over all
 * (u, v) with round(hypot(u, v)) = r after folding the frequencies into [-n/2, n/2).
 */
export function radialPower(power: Float64Array, n: number): Float64Array {
  const sums = new Float64Array(n);
  const counts = new Float64Array(n);
  for (let v = 0; v < n; v += 1) {
    for (let u = 0; u < n; u += 1) {
      if (u === 0 && v === 0) continue;
      const fu = u < n / 2 ? u : u - n;
      const fv = v < n / 2 ? v : v - n;
      const r = Math.round(Math.hypot(fu, fv));
      if (r >= n) continue;
      sums[r] += power[v * n + u];
      counts[r] += 1;
    }
  }
  return sums.map((s, r) => (counts[r] > 0 ? s / counts[r] : 0));
}

/** Mean of `radial` over the radii lo..hi inclusive. */
export function bandMean(radial: Float64Array, lo: number, hi: number): number {
  let sum = 0;
  for (let r = lo; r <= hi; r += 1) sum += radial[r];
  return sum / (hi - lo + 1);
}
