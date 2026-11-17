//! Zero-copy color-clustering frontend with single-pass O(1) bitset key lookup.
//!
//! Derived from `crates/vtracer/src/frontend/color_cluster.rs` and
//! `crates/vtracer/src/frontend/keying.rs` of `visioncortex/vtracer`
//! at tag `1.0.0-alpha.4` (commit `2500df76b5aea0ac22d15296b22722442f825c5b`,
//! dual-licensed MIT OR Apache-2.0; see `../LICENSE` and `../SOURCE`).
//!
//! Two low-level and lookup optimizations over upstream, preserving byte-for-byte
//! identical output for every input image:
//! 1. **Zero-copy `ColorImage` handoff**: upstream `ColorClusterFrontend::prepare`
//!    (`color_cluster.rs:58`) unconditionally clones the entire `W * H * 4` RGBA
//!    buffer (up to 64 MiB at 16 MP) because `Frontend::segment` borrows `&ColorImage`
//!    while `visioncortex::color_clusters::Runner::new` takes `ColorImage` by value.
//!    `OwnedColorClusterFrontend` moves the caller's owned `ColorImage` directly
//!    into `Runner::new` with zero pixel copies.
//! 2. **Single-pass 64-byte L1 bitset key-color lookup**: upstream `find_unused_color`
//!    (`keying.rs:44-94`) runs a full `W * H` scan (`color_exists`) for each of up to
//!    `6 + 7 * 7 * 7 = 349` candidate colors (`5.58 billion` pixel reads at 16 MP).
//!    Every candidate uses only channel values `{0, 37, 74, 111, 148, 185, 222, 255}`.
//!    A compile-time 256-byte LUT maps those 8 byte values to `0..=7` and packs all
//!    `8 * 8 * 8 = 512` candidate presence flags into `[u64; 8]` (64 bytes, one CPU
//!    cache line) in a single sequential pass over `pixels`.

use std::cell::RefCell;

use visioncortex::color_clusters::{
    Clusters, KeyingAction, Runner, RunnerConfig, HIERARCHICAL_MAX,
};
use visioncortex::{Color, ColorImage, PointI32};
use vtracer::error::Error;
use vtracer::frontend::Frontend;
use vtracer::ir::{Layer, Paint, RegionMask, Segmentation};

const KEYING_THRESHOLD: f32 = 0.2;
const INVALID_AXIS: u8 = 8;

/// Maps `{0, 37, 74, 111, 148, 185, 222, 255}` to `0..=7` and all other bytes to `8`.
const CANDIDATE_AXIS: [u8; 256] = {
    let mut lut = [INVALID_AXIS; 256];
    lut[0] = 0;
    lut[37] = 1;
    lut[74] = 2;
    lut[111] = 3;
    lut[148] = 4;
    lut[185] = 5;
    lut[222] = 6;
    lut[255] = 7;
    lut
};

const AXIS_VALUES: [u8; 8] = [0, 37, 74, 111, 148, 185, 222, 255];

#[inline]
const fn bit_index(ir: usize, ig: usize, ib: usize) -> usize {
    (ir << 6) | (ig << 3) | ib
}

#[inline]
fn is_seen(seen: &[u64; 8], ir: usize, ig: usize, ib: usize) -> bool {
    let idx = bit_index(ir, ig, ib);
    ((seen[idx >> 6] >> (idx & 63)) & 1) != 0
}

/// Exact equivalent of `vtracer::frontend::keying::should_key_image` (`keying.rs:17-42`),
/// scanning the same five rows as contiguous 4-byte slices without per-pixel index multiplies.
pub fn should_key_image(img: &ColorImage) -> bool {
    if img.width == 0 || img.height == 0 {
        return false;
    }
    let threshold = ((img.width * 2) as f32 * KEYING_THRESHOLD) as usize;
    let mut transparent = 0usize;
    let row_stride = img.width * 4;
    let rows = [
        0,
        img.height / 4,
        img.height / 2,
        3 * img.height / 4,
        img.height - 1,
    ];
    for y in rows {
        let start = y * row_stride;
        for px in img.pixels[start..start + row_stride].chunks_exact(4) {
            if px[3] == 0 {
                transparent += 1;
            }
            if transparent >= threshold {
                return true;
            }
        }
    }
    false
}

/// Single-pass O(W*H) bitset equivalent of `vtracer::frontend::keying::find_unused_color`
/// (`keying.rs:59-94`), probing candidates in the exact same order.
pub fn find_unused_color_fast(pixels: &[u8]) -> Result<Color, Error> {
    let mut seen = [0u64; 8];
    for px in pixels.chunks_exact(4) {
        let ir = CANDIDATE_AXIS[px[0] as usize];
        let ig = CANDIDATE_AXIS[px[1] as usize];
        let ib = CANDIDATE_AXIS[px[2] as usize];
        if (ir | ig | ib) < INVALID_AXIS {
            let idx = bit_index(ir as usize, ig as usize, ib as usize);
            seen[idx >> 6] |= 1u64 << (idx & 63);
        }
    }

    const SPECIALS: [(usize, usize, usize); 6] = [
        (7, 0, 0), // (255, 0, 0)
        (0, 7, 0), // (0, 255, 0)
        (0, 0, 7), // (0, 0, 255)
        (7, 7, 0), // (255, 255, 0)
        (0, 7, 7), // (0, 255, 255)
        (7, 0, 7), // (255, 0, 255)
    ];
    for &(ir, ig, ib) in &SPECIALS {
        if !is_seen(&seen, ir, ig, ib) {
            return Ok(Color::new(AXIS_VALUES[ir], AXIS_VALUES[ig], AXIS_VALUES[ib]));
        }
    }

    for ir in 0..7 {
        for ig in 0..7 {
            for ib in 0..7 {
                if !is_seen(&seen, ir, ig, ib) {
                    return Ok(Color::new(AXIS_VALUES[ir], AXIS_VALUES[ig], AXIS_VALUES[ib]));
                }
            }
        }
    }

    Err(Error::NoKeyColor)
}

/// Sequential slice pass equivalent of `vtracer::frontend::keying::apply_key` (`keying.rs:97-105`).
pub fn apply_key_in_place(pixels: &mut [u8], key: Color) {
    let kr = key.r;
    let kg = key.g;
    let kb = key.b;
    for px in pixels.chunks_exact_mut(4) {
        if px[3] == 0 {
            px[0] = kr;
            px[1] = kg;
            px[2] = kb;
            px[3] = 255;
        }
    }
}

/// One-shot color-clustering frontend that consumes its owned `ColorImage` without cloning.
pub struct OwnedColorClusterFrontend {
    pub image: RefCell<Option<ColorImage>>,
    pub color_precision_loss: i32,
    pub layer_difference: i32,
    pub good_min_area: usize,
}

impl OwnedColorClusterFrontend {
    fn segmentation_from_clusters(clusters: &Clusters, width: usize, height: usize) -> Segmentation {
        let view = clusters.view();
        let mut seg = Segmentation::new(width as u32, height as u32);
        seg.layers.reserve(view.clusters_output.len());
        for &cluster_index in view.clusters_output.iter().rev() {
            let cluster = view.get_cluster(cluster_index);
            let image = cluster.to_image_with_hole(view.width, false);
            let mask = RegionMask::new(
                image,
                PointI32 {
                    x: cluster.rect.left,
                    y: cluster.rect.top,
                },
            );
            seg.layers.push(Layer {
                paint: Paint::Solid(cluster.residue_color()),
                mask,
            });
        }
        seg
    }
}

impl Frontend for OwnedColorClusterFrontend {
    fn segment(&self, fallback: &ColorImage) -> Result<Segmentation, Error> {
        let mut img = self
            .image
            .borrow_mut()
            .take()
            .unwrap_or_else(|| fallback.clone());
        if img.width == 0 || img.height == 0 {
            return Err(Error::EmptyImage);
        }
        let width = img.width;
        let height = img.height;

        let key_color = if should_key_image(&img) {
            let key = find_unused_color_fast(&img.pixels)?;
            apply_key_in_place(&mut img.pixels, key);
            key
        } else {
            Color::default()
        };

        let config = RunnerConfig {
            diagonal: self.layer_difference == 0,
            hierarchical: HIERARCHICAL_MAX,
            batch_size: 25600,
            good_min_area: self.good_min_area,
            good_max_area: width * height,
            is_same_color_a: self.color_precision_loss,
            is_same_color_b: 1,
            deepen_diff: self.layer_difference,
            hollow_neighbours: 1,
            key_color,
            keying_action: KeyingAction::Discard,
        };

        let clusters = Runner::new(config, img).run();
        Ok(Self::segmentation_from_clusters(&clusters, width, height))
    }
}
