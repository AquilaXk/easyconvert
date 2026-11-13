use crate::ord_float::OrdFloat32;

use crate::vpsearch;

use crate::cluster::Cluster;
use crate::histogram::Histogram;
use crate::palette::Palette;

/// Passes of Lloyd's algorithm after the two of upstream, for a histogram of more than `SMALL_HISTOGRAM` entries and at most `LLOYD_MAX_ENTRIES`
/// (ten 0.4 to 2.8 megapixel photographs, mean PSNR against the source: two passes +0.11 dB, four +0.16, ten +0.23, twenty +0.32, at the same bytes). The cap
/// bounds the 20 bytes an entry that the passes hold (20 MB), which the memory limit of the worker's call leaves room for. (Not in upstream.)
const LLOYD_PASSES: usize = 2;
const LLOYD_MAX_ENTRIES: usize = 1 << 20;
/// A histogram of at most this many entries is iterated until it stops improving (each pass is a few microseconds), up to `SMALL_PASSES`.
const SMALL_HISTOGRAM: usize = 1024;
const SMALL_PASSES: usize = 24;
const SMALL_STOP_RATIO: f32 = 0.999;
/// The entries of a large histogram are cut into this many ranges, each assigned on its own thread; the partial sums are added in range order,
/// so the result does not depend on how many threads run (or on whether one starts).
const LLOYD_CHUNKS: usize = 4;
const LLOYD_THREADED_ENTRIES: usize = 8192;

pub(crate) struct Colormap {
    palette: Palette,
    tree: vpsearch::SearchTree,
    pub(crate) error: f32,
}

impl Colormap {
    pub(crate) fn from_clusters(clusters: &Vec<Cluster>) -> Self {
        assert!(clusters.len() <= 256);

        let size = clusters.len();
        let mut entries = [[0f32; 4]; 256];
        let mut weights = [0f32; 256];
        let mut total_weight = 0f32;

        clusters.iter().enumerate().for_each(|(i, c)| {
            entries[i] = [c.mean[0], c.mean[1], c.mean[2], c.mean[3]];

            let weight = c.weight;
            weights[i] = weight;
            total_weight += weight;
        });

        let entries_sl = &mut entries[..size];
        let mut error;

        let mut tree = vpsearch::SearchTree::new(entries_sl, &weights);
        (error, weights) = kmeans(clusters, entries_sl, &tree, total_weight);

        if error > 0.001 {
            tree = vpsearch::SearchTree::new(entries_sl, &weights);
            (error, weights) = kmeans(clusters, entries_sl, &tree, total_weight);
        }

        let entry_count: usize = clusters.iter().map(|c| c.entries.len()).sum();
        if size > 1 && entry_count <= LLOYD_MAX_ENTRIES {
            let (points, point_weights) = flatten(clusters, entry_count);
            let passes = if entry_count <= SMALL_HISTOGRAM { SMALL_PASSES } else { LLOYD_PASSES };
            for _ in 0..passes {
                tree = vpsearch::SearchTree::new(entries_sl, &weights);
                let previous = error;
                (error, weights) = lloyd(&points, &point_weights, entries_sl, &tree, total_weight);
                if entry_count <= SMALL_HISTOGRAM && error >= previous * SMALL_STOP_RATIO {
                    break;
                }
            }
        }

        round_and_clamp_colors(entries_sl);
        sort_colors(entries_sl, &mut weights);

        tree = vpsearch::SearchTree::new(entries_sl, &weights);

        Self {
            palette: entries[..size].into(),
            tree,
            error,
        }
    }

    pub(crate) fn from_histogram(hist: &Histogram) -> Self {
        assert!(hist.map.len() <= 256);

        let size = hist.map.len();
        let mut entries = [[0f32; 4]; 256];
        let mut weights = [0f32; 256];

        hist.map.values().enumerate().for_each(|(i, e)| {
            entries[i] = [
                e.color[0] as f32,
                e.color[1] as f32,
                e.color[2] as f32,
                e.color[3] as f32,
            ];
            weights[i] = e.weight as f32;
        });

        let entries_sl = &mut entries[..size];

        sort_colors(entries_sl, &mut weights);

        let tree = vpsearch::SearchTree::new(entries_sl, &weights);

        Self {
            palette: entries[..size].into(),
            tree,
            error: 0f32,
        }
    }

    pub(crate) fn get_palette(&self) -> &Palette {
        &self.palette
    }

    /// The palette entry `ind` as the four channels the search compares. (Not in upstream.)
    #[inline(always)]
    pub(crate) fn entry(&self, ind: u8) -> [f32; 4] {
        let c = &self.palette.entries[usize::from(ind)];
        [c.r as f32, c.g as f32, c.b as f32, c.a as f32]
    }

    #[inline(always)]
    pub(crate) fn nearest_ind(&self, color: &[f32; 4]) -> (u8, [f32; 4], f32) {
        self.tree.find_nearest(color)
    }
}

fn kmeans(
    clusters: &Vec<Cluster>,
    entries: &mut [[f32; 4]],
    tree: &vpsearch::SearchTree,
    total_weight: f32,
) -> (f32, [f32; 256]) {
    let mut colors = [[0f32; 4]; 256];
    let mut weights = [0f32; 256];

    let mut total_err = 0f32;

    for cluster in clusters.iter() {
        for entry in cluster.entries.iter() {
            let hist_color = [
                entry.color[0] as f32,
                entry.color[1] as f32,
                entry.color[2] as f32,
                entry.color[3] as f32,
            ];
            let weight = entry.weight as f32;

            let (ind, _, err) = tree.find_nearest(&hist_color);

            let color = &mut colors[usize::from(ind)];
            add_color(color, &hist_color, weight);

            weights[ind as usize] += weight;
            total_err += err * err;
        }
    }

    for ((ec, c), weight) in entries.iter_mut().zip(colors).zip(weights) {
        if weight > 0.0 {
            ec[0] = c[0] / weight;
            ec[1] = c[1] / weight;
            ec[2] = c[2] / weight;
            ec[3] = c[3] / weight;
        }
    }

    (total_err / total_weight, weights)
}

/// The entries of all clusters in one run, as the colours and the weights the passes of `lloyd` read. (Not in upstream.)
fn flatten(clusters: &[Cluster], count: usize) -> (Vec<[f32; 4]>, Vec<f32>) {
    let mut points = Vec::with_capacity(count);
    let mut weights = Vec::with_capacity(count);
    for entry in clusters.iter().flat_map(|c| c.entries.iter()) {
        points.push([entry.color[0] as f32, entry.color[1] as f32, entry.color[2] as f32, entry.color[3] as f32]);
        weights.push(entry.weight as f32);
    }
    (points, weights)
}

struct PartialSums {
    colors: [[f32; 4]; 256],
    weights: [f32; 256],
    err: f32,
}

fn assign(points: &[[f32; 4]], point_weights: &[f32], tree: &vpsearch::SearchTree) -> PartialSums {
    let mut sums = PartialSums {
        colors: [[0f32; 4]; 256],
        weights: [0f32; 256],
        err: 0f32,
    };
    for (point, &weight) in points.iter().zip(point_weights) {
        let (ind, _, err) = tree.find_nearest(point);
        add_color(&mut sums.colors[usize::from(ind)], point, weight);
        sums.weights[usize::from(ind)] += weight;
        sums.err += err * err;
    }
    sums
}

/// One pass of Lloyd's algorithm over the histogram: every entry goes to its nearest palette entry and every palette entry moves to the
/// weighted mean of its entries, as `kmeans` does over the clusters. A large histogram is assigned on up to `LLOYD_CHUNKS` threads. (Not in upstream.)
fn lloyd(points: &[[f32; 4]], point_weights: &[f32], entries: &mut [[f32; 4]], tree: &vpsearch::SearchTree, total_weight: f32) -> (f32, [f32; 256]) {
    let ranges = if points.len() >= LLOYD_THREADED_ENTRIES { LLOYD_CHUNKS } else { 1 };
    let chunk = points.len().div_ceil(ranges);
    let partials: Vec<PartialSums> = if ranges == 1 {
        vec![assign(points, point_weights, tree)]
    } else {
        std::thread::scope(|scope| {
            let spans: Vec<(&[[f32; 4]], &[f32])> = points.chunks(chunk).zip(point_weights.chunks(chunk)).collect();
            // A thread that cannot start is replaced by the calling thread; the sums are the same either way.
            let handles: Vec<_> = spans[1..]
                .iter()
                .map(|&(p, w)| std::thread::Builder::new().spawn_scoped(scope, move || assign(p, w, tree)).map_err(|_| (p, w)))
                .collect();
            let mut partials = vec![assign(spans[0].0, spans[0].1, tree)];
            for handle in handles {
                partials.push(match handle {
                    Ok(running) => running.join().expect("a Lloyd pass does not panic"),
                    Err((p, w)) => assign(p, w, tree),
                });
            }
            partials
        })
    };

    let mut colors = [[0f32; 4]; 256];
    let mut weights = [0f32; 256];
    let mut total_err = 0f32;
    for partial in &partials {
        for i in 0..entries.len() {
            for k in 0..4 {
                colors[i][k] += partial.colors[i][k];
            }
            weights[i] += partial.weights[i];
        }
        total_err += partial.err;
    }

    for ((ec, c), weight) in entries.iter_mut().zip(colors).zip(weights) {
        if weight > 0.0 {
            ec[0] = c[0] / weight;
            ec[1] = c[1] / weight;
            ec[2] = c[2] / weight;
            ec[3] = c[3] / weight;
        }
    }

    (total_err / total_weight, weights)
}

fn round_and_clamp_colors(entries: &mut [[f32; 4]]) {
    for entry in entries.iter_mut() {
        entry[0] = entry[0].round().clamp(0.0, 255.0);
        entry[1] = entry[1].round().clamp(0.0, 255.0);
        entry[2] = entry[2].round().clamp(0.0, 255.0);
        entry[3] = entry[3].round().clamp(0.0, 255.0);
    }
}

/// Sort colors by alpha channel for better PNG compression.
/// Weights are sorted along with the colors.
fn sort_colors(entries: &mut [[f32; 4]], weights: &mut [f32]) {
    assert!(weights.len() >= entries.len());

    let mut indexes: Vec<usize> = (0..entries.len()).collect();
    indexes.sort_by_cached_key(|&i| OrdFloat32::from(entries[i][3]));

    for i in 0..indexes.len() {
        if indexes[i] != i {
            let mut current = i;

            loop {
                let target = indexes[current];

                indexes[current] = current;

                if indexes[target] == target {
                    break;
                }

                entries.swap(current, target);
                weights.swap(current, target);

                current = target;
            }
        }
    }

    // entries.sort_unstable_by_key(|e| OrdFloat32::from(e[3]));
}

#[cfg(target_arch = "x86_64")]
#[inline(always)]
fn add_color(dst: &mut [f32; 4], src: &[f32; 4], weight: f32) {
    unsafe {
        use std::arch::x86_64::*;

        let mut psrc = _mm_loadu_ps(src.as_ptr());
        let mut pdst = _mm_loadu_ps(dst.as_ptr());
        let pweights = _mm_set1_ps(weight);

        psrc = _mm_mul_ps(psrc, pweights);
        pdst = _mm_add_ps(pdst, psrc);

        _mm_storeu_ps(dst.as_mut_ptr(), pdst);
    }
}

#[cfg(all(target_arch = "aarch64", target_feature = "neon"))]
#[inline(always)]
fn add_color(dst: &mut [f32; 4], src: &[f32; 4], weight: f32) {
    unsafe {
        use std::arch::aarch64::*;

        let mut psrc = vld1q_f32(src.as_ptr());
        let mut pdst = vld1q_f32(dst.as_ptr());
        let pweights = vmovq_n_f32(weight);

        psrc = vmulq_f32(psrc, pweights);
        pdst = vaddq_f32(pdst, psrc);

        vst1q_f32(dst.as_mut_ptr(), pdst);
    }
}

#[cfg(not(any(
    target_arch = "x86_64",
    all(target_arch = "aarch64", target_feature = "neon")
)))]
#[inline(always)]
fn add_color(dst: &mut [f32; 4], src: &[f32; 4], weight: f32) {
    dst[0] += src[0] * weight;
    dst[1] += src[1] * weight;
    dst[2] += src[2] * weight;
    dst[3] += src[3] * weight;
}
