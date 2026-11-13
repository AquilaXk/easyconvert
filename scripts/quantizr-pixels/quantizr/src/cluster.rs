use crate::ord_float::OrdFloat32;

use crate::histogram::{Histogram, HistogramEntry};

pub(crate) struct Cluster<'clust> {
    pub entries: Vec<&'clust HistogramEntry>,
    pub mean: [f32; 4],
    pub weight: f32,
    pub chan_diff: f32,
    widest_chan: u8,
}

impl<'clust> Cluster<'clust> {
    pub(crate) fn new(entries: Vec<&'clust HistogramEntry>) -> Self {
        let mut cluster = Self {
            entries,
            mean: [0.0; 4],
            weight: 0.0,
            chan_diff: 0.0,
            widest_chan: 0,
        };

        cluster.calc_stats();

        cluster
    }

    pub(crate) fn from_histogram(hist: &'clust Histogram) -> Self {
        let mut entries = Vec::with_capacity(hist.map.len());

        for entry in hist.map.values() {
            entries.push(entry)
        }

        Self::new(entries)
    }

    fn calc_stats(&mut self) {
        self.mean = [0.0; 4];
        self.weight = 0.0;

        if self.entries.is_empty() {
            self.chan_diff = 0.0;
            return;
        }

        let mut tmp;

        for e in self.entries.iter() {
            let weight = e.weight as f32;

            tmp = [
                e.color[0] as f32,
                e.color[1] as f32,
                e.color[2] as f32,
                e.color[3] as f32,
            ];
            add_color(&mut self.mean, &tmp, weight);

            self.weight += weight;
        }

        self.mean[0] /= self.weight;
        self.mean[1] /= self.weight;
        self.mean[2] /= self.weight;
        self.mean[3] /= self.weight;

        let mut diff_sum: [f32; 4] = [0f32; 4];

        for &e in self.entries.iter() {
            let weight = e.weight as f32;

            tmp = [
                e.color[0] as f32,
                e.color[1] as f32,
                e.color[2] as f32,
                e.color[3] as f32,
            ];
            add_diff(&mut diff_sum, &tmp, &self.mean, weight);
        }

        let (chan, max_diff_sum) = diff_sum
            .iter()
            .enumerate()
            .max_by_key(|&(_, &d)| OrdFloat32::from(d))
            .unwrap();

        self.chan_diff = max_diff_sum / self.weight;
        self.widest_chan = chan as u8;
    }

    pub(crate) fn split_into(self, max_colors: usize) -> Vec<Self> {
        let max_colors_f32 = max_colors as f32;

        let mut clusters = Vec::<Self>::with_capacity(max_colors);

        clusters.push(self);

        while clusters.len() < max_colors {
            // We want to split bigger clusters in the beginning,
            // and clusters with bigger chan_diff in the end
            let weight_ratio = 0.75 - (clusters.len() as f32 + 1.0) / max_colors_f32 / 2.0;

            // Get the best cluster to split
            let to_split_opt = clusters
                .iter()
                .enumerate()
                .filter(|(_, c)| c.chan_diff > 0.0)
                .map(|(i, c)| {
                    let priority = c.chan_diff * c.weight.powf(weight_ratio);
                    (i, priority)
                })
                .max_by_key(|&(_, p)| OrdFloat32::from(p))
                .map(|(i, _)| clusters.swap_remove(i));

            // If nothing there, this means everything is ready
            let mut to_split = match to_split_opt {
                Some(c) => c,
                None => break,
            };

            let (mut c1, mut c2) = to_split.split();

            if c1.entries.is_empty() {
                c2.chan_diff = 0.0;
                clusters.push(c2);
                continue;
            }

            if c2.entries.is_empty() {
                c1.chan_diff = 0.0;
                clusters.push(c1);
                continue;
            }

            clusters.push(c1);
            clusters.push(c2);
        }

        clusters
    }

    fn split(&mut self) -> (Self, Self) {
        let widest_chan = self.widest_chan as usize;
        let widest_chan_mean = self.mean[widest_chan];

        let mut i: usize = 0;
        let mut lt: usize = 0;
        let mut gt: usize = self.entries.len() - 1;

        let mut lt_weight: usize = 0;
        let mut gt_weight: usize = 0;

        while i <= gt {
            let entry = self.entries[i];
            let val = entry.color[widest_chan] as f32;

            if val < widest_chan_mean {
                lt_weight += entry.weight as usize;
                if lt != i {
                    self.entries.swap(lt, i);
                }
                lt += 1;
                i += 1;
            } else if val > widest_chan_mean {
                gt_weight += entry.weight as usize;
                self.entries.swap(gt, i);
                gt -= 1;
            } else {
                i += 1;
            }
        }

        let mut split_pos = i;
        if lt_weight > gt_weight {
            split_pos = lt;
        }

        let (sp1, sp2) = self.entries.split_at(split_pos);

        (Self::new(sp1.to_vec()), Self::new(sp2.to_vec()))
    }
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

#[cfg(target_arch = "x86_64")]
#[inline(always)]
fn add_diff(dst: &mut [f32; 4], a: &[f32; 4], b: &[f32; 4], weight: f32) {
    unsafe {
        use std::arch::x86_64::*;

        let pa = _mm_loadu_ps(a.as_ptr());
        let pb = _mm_loadu_ps(b.as_ptr());
        let mut pdst = _mm_loadu_ps(dst.as_ptr());
        let pweights = _mm_set1_ps(weight);

        let mut diff = _mm_sub_ps(pa, pb);

        // Abs
        let mask = _mm_castsi128_ps(_mm_srli_epi32(_mm_set1_epi32(-1), 1));
        diff = _mm_and_ps(mask, diff);

        diff = _mm_mul_ps(diff, pweights);
        pdst = _mm_add_ps(pdst, diff);

        _mm_storeu_ps(dst.as_mut_ptr(), pdst);
    }
}

#[cfg(all(target_arch = "aarch64", target_feature = "neon"))]
#[inline(always)]
fn add_diff(dst: &mut [f32; 4], a: &[f32; 4], b: &[f32; 4], weight: f32) {
    unsafe {
        use std::arch::aarch64::*;

        let pa = vld1q_f32(a.as_ptr());
        let pb = vld1q_f32(b.as_ptr());
        let mut pdst = vld1q_f32(dst.as_ptr());
        let pweights = vmovq_n_f32(weight);

        let mut diff = vsubq_f32(pa, pb);
        diff = vabsq_f32(diff);

        diff = vmulq_f32(diff, pweights);
        pdst = vaddq_f32(pdst, diff);

        vst1q_f32(dst.as_mut_ptr(), pdst);
    }
}

#[cfg(not(any(
    target_arch = "x86_64",
    all(target_arch = "aarch64", target_feature = "neon")
)))]
#[inline(always)]
fn add_diff(dst: &mut [f32; 4], a: &[f32; 4], b: &[f32; 4], weight: f32) {
    dst[0] += (a[0] - b[0]).abs() * weight;
    dst[1] += (a[1] - b[1]).abs() * weight;
    dst[2] += (a[2] - b[2]).abs() * weight;
    dst[3] += (a[3] - b[3]).abs() * weight;
}

/// Ward's agglomeration: start with each of `start` as a cluster and merge the pair whose merge adds the least squared error, until `max_colors`
/// clusters are left. Merging clusters of weights wa and wb whose means are d apart adds wa * wb / (wa + wb) * d^2 to the sum of squared errors,
/// so the cheapest merge is found from each cluster's cheapest partner, which is kept up to date. O(n^2) in the number of clusters, so `start`
/// is a histogram of a thousand entries or fewer. (Not in upstream.)
pub(crate) fn merge_cheapest<'clust>(start: Vec<Cluster<'clust>>, max_colors: usize) -> Vec<Cluster<'clust>> {
    struct Merging<'clust> {
        entries: Vec<&'clust HistogramEntry>,
        mean: [f64; 4],
        weight: f64,
        alive: bool,
        /// The cluster that is cheapest to merge this one with, and what that costs.
        partner: usize,
        cost: f64,
    }

    fn merge_cost(a: &Merging, b: &Merging) -> f64 {
        let mut squared = 0.0;
        for k in 0..4 {
            let d = a.mean[k] - b.mean[k];
            squared += d * d;
        }
        a.weight * b.weight / (a.weight + b.weight) * squared
    }

    fn cheapest_partner(of: usize, all: &[Merging]) -> (usize, f64) {
        let mut best = (usize::MAX, f64::MAX);
        for (j, other) in all.iter().enumerate() {
            if j != of && other.alive {
                let cost = merge_cost(&all[of], other);
                if cost < best.1 {
                    best = (j, cost);
                }
            }
        }
        best
    }

    let mut clusters: Vec<Merging> = start
        .into_iter()
        .map(|c| Merging {
            mean: [c.mean[0] as f64, c.mean[1] as f64, c.mean[2] as f64, c.mean[3] as f64],
            weight: c.weight as f64,
            entries: c.entries,
            alive: true,
            partner: usize::MAX,
            cost: f64::MAX,
        })
        .collect();
    let n = clusters.len();
    for i in 0..n {
        let (partner, cost) = cheapest_partner(i, &clusters);
        clusters[i].partner = partner;
        clusters[i].cost = cost;
    }

    let mut alive = n;
    while alive > max_colors {
        let a = (0..n).filter(|&i| clusters[i].alive).min_by(|&x, &y| clusters[x].cost.total_cmp(&clusters[y].cost)).expect("two clusters are alive");
        let b = clusters[a].partner;
        let (wa, wb) = (clusters[a].weight, clusters[b].weight);
        for k in 0..4 {
            clusters[a].mean[k] = (clusters[a].mean[k] * wa + clusters[b].mean[k] * wb) / (wa + wb);
        }
        clusters[a].weight = wa + wb;
        let mut moved = std::mem::take(&mut clusters[b].entries);
        clusters[a].entries.append(&mut moved);
        clusters[b].alive = false;
        alive -= 1;

        for i in 0..n {
            if !clusters[i].alive {
                continue;
            }
            if i == a || clusters[i].partner == a || clusters[i].partner == b {
                let (partner, cost) = cheapest_partner(i, &clusters);
                clusters[i].partner = partner;
                clusters[i].cost = cost;
            } else {
                let cost = merge_cost(&clusters[i], &clusters[a]);
                if cost < clusters[i].cost {
                    clusters[i].partner = a;
                    clusters[i].cost = cost;
                }
            }
        }
    }
    clusters.into_iter().filter(|c| c.alive).map(|c| Cluster::new(c.entries)).collect()
}
