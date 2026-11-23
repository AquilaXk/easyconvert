use crate::cluster::Cluster;
use crate::colormap::Colormap;
use crate::error::Error;
use crate::histogram::Histogram;
use crate::image::Image;
use crate::options::Options;
use crate::palette::Palette;

const EMPTY_PIX: [u8; 4] = [0; 4];

/// A histogram of more colours than `max_colors` and at most this many is reduced by Ward's agglomeration of its entries (`cluster::merge_cheapest`,
/// quadratic in the entries: 1 to 3 ms for 800); a larger one by upstream's median cut. (Not in upstream.)
const WARD_MAX_ENTRIES: usize = 1024;

/// A picture of this many pixels or more is dithered in `DITHER_BANDS` bands on as many threads (0.4 megapixel photographs: 12 of 90 ms of the
/// compress path on the Linux VM become 4). The palette indices change by what the dropped error at the three seams would have added. (Not in upstream.)
const DITHER_BAND_MIN_PIXELS: usize = 100_000;
const DITHER_BANDS: usize = 4;

/// Slots of the cache of nearest palette entries by exact pixel colour (a power of two).
const CACHE_BITS: u32 = 12;
const CACHE_SLOTS: usize = 1 << CACHE_BITS;
const CACHE_VALID: u64 = 1 << 40;
const CACHE_KEY_MASK: u64 = CACHE_VALID | 0xFFFF_FFFF;

/// A direct-mapped cache from the exact colour of a pixel to the palette index nearest to it. The answer for one colour never changes, so a
/// hit is the index that the search would have found, and a flat area of the picture is looked up instead of searched. (Not in upstream.)
struct NearestCache {
    slots: Vec<u64>,
}

impl NearestCache {
    fn new() -> Self {
        Self {
            slots: vec![0; CACHE_SLOTS],
        }
    }

    #[inline(always)]
    fn index_of(&mut self, key: u32, colormap: &Colormap, pix: &[f32; 4]) -> u8 {
        let slot = (key.wrapping_mul(0x9E37_79B1) >> (32 - CACHE_BITS)) as usize;
        let tagged = u64::from(key) | CACHE_VALID;
        let cached = self.slots[slot];
        if cached & CACHE_KEY_MASK == tagged {
            return (cached >> 32) as u8;
        }
        let (ind, _, _) = colormap.nearest_ind(pix);
        self.slots[slot] = tagged | (u64::from(ind) << 32);
        ind
    }
}

#[inline(always)]
fn colour_key(pix: &[u8]) -> u32 {
    u32::from_le_bytes([pix[0], pix[1], pix[2], pix[3]])
}

/// Passes of remap work on four threads, using exact stripe-start repair when `run_tolerance` is set so multi-threaded
/// undithered output stays bit-for-bit identical to a single-thread pass. (Not in upstream.)
#[inline(always)]
fn dist_sq(a: &[f32; 4], b: &[f32; 4]) -> f32 {
    let d0 = a[0] - b[0];
    let d1 = a[1] - b[1];
    let d2 = a[2] - b[2];
    let d3 = a[3] - b[3];
    d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3
}

/// Deterministic undithered mapper matching NearestMapper: caches lookups per distinct colour, keeps runs of identical pixels,
/// and optionally snaps opaque transition pixels to the previous opaque pixel's index when within `run_tolerance`. (Not in upstream.)
struct PlainRemapper<'a> {
    colormap: &'a Colormap,
    keeps_runs: bool,
    distance_factor: f32,
    cache: NearestCache,
    last_key: u64,
    last_index: u8,
    previous_index: i32,
}

impl<'a> PlainRemapper<'a> {
    fn new(colormap: &'a Colormap, run_tolerance: f32) -> Self {
        let factor = 1.0 + run_tolerance;
        Self {
            colormap,
            keeps_runs: run_tolerance > 0.0,
            distance_factor: factor * factor,
            cache: NearestCache::new(),
            last_key: u64::MAX,
            last_index: 0,
            previous_index: -1,
        }
    }

    fn resume_at(&mut self, data: &[u8], out: &[u8], at: usize) {
        self.last_key = u64::MAX;
        self.last_index = 0;
        self.previous_index = -1;
        if at == 0 {
            return;
        }
        let prev_pix = &data[(at - 1) * 4..at * 4];
        self.previous_index = if prev_pix[3] == 0 { -1 } else { i32::from(out[at - 1]) };
        let mut last = at;
        while last > 0 {
            last -= 1;
            let p = &data[last * 4..last * 4 + 4];
            if p[3] != 0 {
                self.last_key = u64::from(colour_key(p));
                self.last_index = out[last];
                return;
            }
        }
    }

    fn run_range(&mut self, data: &[u8], out: &mut [u8], base: usize, from: usize, to: usize, until_same: bool) -> usize {
        for p in from..to {
            let data_point = p * 4;
            let raw = &data[data_point..data_point + 4];
            if raw[3] == 0 {
                let ind = self.cache.index_of(0, self.colormap, &[0.0; 4]);
                out[p - base] = ind;
                self.previous_index = -1;
                continue;
            }
            let key_u32 = colour_key(raw);
            let key = u64::from(key_u32);
            if key != self.last_key {
                let colour = [raw[0] as f32, raw[1] as f32, raw[2] as f32, raw[3] as f32];
                let nearest = self.cache.index_of(key_u32, self.colormap, &colour);
                let mut chosen = nearest;
                if self.keeps_runs && self.previous_index >= 0 {
                    let prev = self.previous_index as u8;
                    if prev != nearest {
                        let prev_entry = self.colormap.entry(prev);
                        if prev_entry[3] != 0.0
                            && dist_sq(&colour, &prev_entry)
                                <= dist_sq(&colour, &self.colormap.entry(nearest)) * self.distance_factor
                        {
                            chosen = prev;
                        }
                    }
                }
                self.last_key = key;
                self.last_index = chosen;
            }
            let same = until_same && out[p - base] == self.last_index;
            out[p - base] = self.last_index;
            self.previous_index = i32::from(self.last_index);
            if same {
                return p + 1;
            }
        }
        to
    }
}

// Result of quantization
pub struct QuantizeResult {
    error: f32,
    dithering_level: f32,
    run_tolerance: f32,
    colormap: Colormap,
}

impl QuantizeResult {
    /// Quantizes the provided [`Image`]
    pub fn quantize(image: &Image, attr: &Options) -> Self {
        let mut hist = Histogram::new();
        hist.add_image(image);

        Self::quantize_histogram(&hist, attr)
    }

    /// Quantizes the provided [`Histogram`]
    pub fn quantize_histogram(hist: &Histogram, attr: &Options) -> Self {
        let max_colors = attr.get_max_colors() as usize;

        let colormap = if hist.map.len() <= max_colors {
            Colormap::from_histogram(hist)
        } else {
            // The squared error that the target allows, summed over the pixels and the three colour channels. No target: nothing is allowed.
            let target_sse = if attr.get_target_mse() > 0.0 {
                let total_weight: f64 = hist.map.values().map(|entry| entry.weight as f64).sum();
                attr.get_target_mse() as f64 * 3.0 * total_weight
            } else {
                f64::MIN
            };
            let clusters = if hist.map.len() <= WARD_MAX_ENTRIES {
                // A histogram this small is merged from its own entries, where the median cut would split it into boxes.
                crate::cluster::merge_cheapest(hist.map.values().map(|entry| Cluster::new(vec![entry])).collect(), max_colors, target_sse)
            } else {
                Cluster::from_histogram(hist).split_into(max_colors, target_sse)
            };

            Colormap::from_clusters(&clusters)
        };

        Self {
            error: colormap.error,
            colormap,
            dithering_level: 1.0,
            run_tolerance: 0.0,
        }
    }

    /// Sets the dithering level.
    ///
    /// Returns [`Error::ValueOutOfRange`] if the provided value is greater
    /// than 1.0 or lesser than 0.0
    pub fn set_dithering_level(&mut self, level: f32) -> Result<(), Error> {
        if !(0.0..=1.0).contains(&level) {
            return Err(Error::ValueOutOfRange);
        }

        self.dithering_level = level;

        Ok(())
    }

    /// Sets the relative distance tolerance for extending runs of identical palette indices when undithered. (Not in upstream.)
    ///
    /// Returns [`Error::ValueOutOfRange`] if the provided value is outside `0.0..=2.0`.
    pub fn set_run_tolerance(&mut self, tolerance: f32) -> Result<(), Error> {
        if !(0.0..=2.0).contains(&tolerance) {
            return Err(Error::ValueOutOfRange);
        }

        self.run_tolerance = tolerance;

        Ok(())
    }

    /// Returns quantization error. The lesser the error the better the image
    /// was quantized
    pub fn get_error(&self) -> f32 {
        self.error
    }

    /// Returns the [`Palette`] generated after quantization
    pub fn get_palette(&self) -> &Palette {
        self.colormap.get_palette()
    }

    /// Remaps the proxided [`Image`] to a slize of bytes.
    ///
    /// Returns [`Error::BufferTooSmall`] if the provided buffer is smaller
    /// than `image.width * image.height`
    pub fn remap_image(&self, image: &Image, buf: &mut [u8]) -> Result<(), Error> {
        if buf.len() < image.width * image.height {
            return Err(Error::BufferTooSmall);
        }

        if self.dithering_level > 0.0 {
            self.remap_image_dither(image, buf);
        } else {
            self.remap_image_no_dither(image, buf);
        }

        Ok(())
    }

    fn remap_image_no_dither(&self, image: &Image, buf: &mut [u8]) {
        let total_pixels = image.width * image.height;
        let bands = if total_pixels >= DITHER_BAND_MIN_PIXELS && image.height >= DITHER_BANDS * 8 {
            DITHER_BANDS
        } else {
            1
        };
        if bands == 1 {
            PlainRemapper::new(&self.colormap, self.run_tolerance).run_range(&image.data, buf, 0, 0, total_pixels, false);
            return;
        }
        let rows_per_band = image.height.div_ceil(bands);
        let chunk_pixels = rows_per_band * image.width;
        let slots: Vec<std::sync::Mutex<&mut [u8]>> = buf[..total_pixels]
            .chunks_mut(chunk_pixels)
            .map(std::sync::Mutex::new)
            .collect();
        let run = |band: usize| {
            let from = band * chunk_pixels;
            let mut rows = slots[band].lock().expect("a band does not panic");
            let to = from + rows.len();
            PlainRemapper::new(&self.colormap, self.run_tolerance).run_range(&image.data, &mut rows, from, from, to, false);
        };
        std::thread::scope(|scope| {
            // A thread that cannot start leaves its band to the calling thread, which gives the same indices.
            let started: Vec<_> = (1..slots.len())
                .map(|band| (band, std::thread::Builder::new().spawn_scoped(scope, move || run(band)).is_ok()))
                .collect();
            run(0);
            for (band, running) in started {
                if !running {
                    run(band);
                }
            }
        });
        if self.run_tolerance > 0.0 && slots.len() > 1 {
            let starts: Vec<usize> = (1..slots.len()).map(|band| band * chunk_pixels).collect();
            let mut repair = PlainRemapper::new(&self.colormap, self.run_tolerance);
            for (k, &from) in starts.iter().enumerate() {
                let to = if k + 1 < starts.len() { starts[k + 1] } else { total_pixels };
                repair.resume_at(&image.data, &buf[..total_pixels], from);
                repair.run_range(&image.data, &mut buf[..total_pixels], 0, from, to, true);
            }
        }
    }

    /// Dithers the picture in horizontal bands, each on its own thread, when it has `DITHER_BAND_MIN_PIXELS` pixels or more. The error that a
    /// band's last row would pass on to the next band's first row is dropped, and the first row of a band starts with no error, as the first row
    /// of the picture does: a band's answer does not depend on the others, so the indices do not depend on the number of threads that run.
    /// (Not in upstream.)
    fn remap_image_dither(&self, image: &Image, buf: &mut [u8]) {
        let bands = if image.width * image.height >= DITHER_BAND_MIN_PIXELS && image.height >= DITHER_BANDS * 8 {
            DITHER_BANDS
        } else {
            1
        };
        let rows_per_band = image.height.div_ceil(bands);
        let slots: Vec<std::sync::Mutex<&mut [u8]>> = buf[..image.width * image.height]
            .chunks_mut(rows_per_band * image.width)
            .map(std::sync::Mutex::new)
            .collect();
        let run = |band: usize| {
            let mut rows = slots[band].lock().expect("a band does not panic");
            self.remap_rows(image, band * rows_per_band, &mut rows);
        };
        std::thread::scope(|scope| {
            // A thread that cannot start leaves its band to the calling thread, which gives the same indices.
            let started: Vec<_> = (1..slots.len())
                .map(|band| (band, std::thread::Builder::new().spawn_scoped(scope, move || run(band)).is_ok()))
                .collect();
            run(0);
            for (band, running) in started {
                if !running {
                    run(band);
                }
            }
        });
    }

    /// The dithering of the rows `first_row ..` that `buf` holds (`buf.len() / image.width` of them).
    fn remap_rows(&self, image: &Image, first_row: usize, buf: &mut [u8]) {
        let error_size = image.width + 2;
        let mut error_curr = vec![[0f32; 4]; error_size];
        let mut error_next = vec![[0f32; 4]; error_size];

        let dithering_coeff = self.dithering_level * 15.0 / 16.0 / 16.0;
        let err_threshold = self.error;
        // println!("Err threshold {}", self.error);

        let mut cache = NearestCache::new();

        for row in 0..buf.len() / image.width {
            let y = first_row + row;
            // The direction of a row follows the row of the picture, as when the picture is dithered in one run: the first row runs to the right.
            let x_reverse = y % 2 == 1;

            for xx in 0..image.width {
                let x = if x_reverse { image.width - 1 - xx } else { xx };

                let point = image.width * y + x;
                let data_point = point * 4;

                let err_ind = x + 1;
                let err_inds = if x_reverse {
                    (err_ind + 1, err_ind, err_ind - 1)
                } else {
                    (err_ind - 1, err_ind, err_ind + 1)
                };

                let err_pix = &mut error_curr[err_ind];
                let pix = pix_or_empty(&image.data[data_point..data_point + 4]);

                // No error has reached this pixel (a flat area, or a picture that the palette holds exactly): its colour is searched for as it
                // is, which the cache answers, and a pixel that the palette holds exactly passes on no error at all. (Not in upstream.)
                let (ind, pal_pix, dith_pix) = if err_pix.iter().all(|&e| e == 0.0) {
                    let colour = [pix[0] as f32, pix[1] as f32, pix[2] as f32, pix[3] as f32];
                    let ind = cache.index_of(colour_key(pix), &self.colormap, &colour);
                    let pal_pix = self.colormap.entry(ind);
                    if pal_pix == colour {
                        buf[image.width * row + x] = ind;
                        continue;
                    }
                    (ind, pal_pix, colour)
                } else {
                    let err_total = err_pix[0] * err_pix[0]
                        + err_pix[1] * err_pix[1]
                        + err_pix[2] * err_pix[2]
                        + err_pix[3] * err_pix[3];

                    if err_total > err_threshold {
                        err_pix[0] *= 0.8;
                        err_pix[1] *= 0.8;
                        err_pix[2] *= 0.8;
                        err_pix[3] *= 0.8;
                    }

                    let dith_pix = [
                        pix[0] as f32 + err_pix[0],
                        pix[1] as f32 + err_pix[1],
                        pix[2] as f32 + err_pix[2],
                        pix[3] as f32 + err_pix[3],
                    ];

                    let (ind, pal_pix, _) = self.colormap.nearest_ind(&dith_pix);
                    (ind, pal_pix, dith_pix)
                };

                buf[image.width * row + x] = ind;

                let mut err_r = dith_pix[0] - pal_pix[0];
                let mut err_g = dith_pix[1] - pal_pix[1];
                let mut err_b = dith_pix[2] - pal_pix[2];
                let mut err_a = dith_pix[3] - pal_pix[3];

                let err_total = err_r * err_r + err_g * err_g + err_b * err_b + err_a * err_a;
                if err_total > err_threshold {
                    err_r *= 0.75;
                    err_g *= 0.75;
                    err_b *= 0.75;
                    err_a *= 0.75;
                }

                err_r *= dithering_coeff;
                err_g *= dithering_coeff;
                err_b *= dithering_coeff;
                err_a *= dithering_coeff;

                let err = &mut error_next[err_inds.0];
                err[0] += err_r * 3.0;
                err[1] += err_g * 3.0;
                err[2] += err_b * 3.0;
                err[3] += err_a * 3.0;

                let err = &mut error_next[err_inds.1];
                err[0] += err_r * 5.0;
                err[1] += err_g * 5.0;
                err[2] += err_b * 5.0;
                err[3] += err_a * 5.0;

                let err = &mut error_next[err_inds.2];
                err[0] += err_r * 1.0;
                err[1] += err_g * 1.0;
                err[2] += err_b * 1.0;
                err[3] += err_a * 1.0;

                let err = &mut error_curr[err_inds.2];
                err[0] += err_r * 7.0;
                err[1] += err_g * 7.0;
                err[2] += err_b * 7.0;
                err[3] += err_a * 7.0;
            }

            std::mem::swap(&mut error_curr, &mut error_next);
            error_next.fill_with(|| [0f32; 4]);
        }
    }
}

#[inline(always)]
fn pix_or_empty(pix: &[u8]) -> &[u8] {
    if pix[3] == 0 {
        return &EMPTY_PIX;
    }
    pix
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_pixels_with_holes(width: usize, height: usize) -> Vec<u8> {
        let mut pixels = vec![0u8; width * height * 4];
        let mut state: u32 = 0x1234_5678;
        for y in 0..height {
            for x in 0..width {
                let idx = (y * width + x) * 4;
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                // Put transparent holes specifically across band seam rows as well as scattered spots.
                let on_seam = y == height.div_ceil(DITHER_BANDS) - 1 && x + 4 >= width;
                if on_seam || (state & 0x3F) == 0 {
                    pixels[idx] = 200;
                    pixels[idx + 1] = 100;
                    pixels[idx + 2] = 50;
                    pixels[idx + 3] = 0;
                } else {
                    pixels[idx] = ((x * 255 / width) as u8).saturating_add(((state >> 24) as u8) & 15);
                    pixels[idx + 1] = ((y * 255 / height) as u8).saturating_add(((state >> 16) as u8) & 15);
                    pixels[idx + 2] = (((x + y) & 255) as u8) ^ (((state >> 8) as u8) & 7);
                    pixels[idx + 3] = 255;
                }
            }
        }
        pixels
    }

    #[test]
    fn run_tolerance_rejects_out_of_range_values() {
        let pixels = vec![10u8, 20, 30, 255, 40, 50, 60, 255];
        let img = Image::new(&pixels, 2, 1).unwrap();
        let mut res = QuantizeResult::quantize(&img, &Options::default());
        assert!(matches!(res.set_run_tolerance(-0.01), Err(Error::ValueOutOfRange)));
        assert!(matches!(res.set_run_tolerance(f32::NAN), Err(Error::ValueOutOfRange)));
        assert!(matches!(res.set_run_tolerance(2.01), Err(Error::ValueOutOfRange)));
        assert!(res.set_run_tolerance(0.0).is_ok());
        assert!(res.set_run_tolerance(0.25).is_ok());
        assert!(res.set_run_tolerance(2.0).is_ok());
    }

    #[test]
    fn threaded_undithered_remap_matches_single_pass_with_and_without_run_tolerance() {
        let width = 512;
        let height = 256;
        let pixels = test_pixels_with_holes(width, height);
        let image = Image::new(&pixels, width, height).expect("valid synthetic image");
        let total = width * height;
        assert!(total >= DITHER_BAND_MIN_PIXELS);

        let mut opts = Options::default();
        opts.set_max_colors(64).unwrap();
        let mut res = QuantizeResult::quantize(&image, &opts);
        res.set_dithering_level(0.0).unwrap();

        for &tol in &[0.0_f32, 0.25_f32] {
            res.set_run_tolerance(tol).unwrap();
            let mut single = vec![0u8; total];
            PlainRemapper::new(&res.colormap, tol).run_range(&image.data, &mut single, 0, 0, total, false);
            let mut threaded = vec![0u8; total];
            res.remap_image(&image, &mut threaded).unwrap();
            assert_eq!(threaded, single, "mismatch at run_tolerance={tol}");
        }

        // With positive run tolerance, run count along scanlines decreases (or stays equal), never breaks transparent pixels.
        let count_runs = |indices: &[u8]| indices.windows(2).filter(|w| w[0] != w[1]).count();
        res.set_run_tolerance(0.0).unwrap();
        let mut no_tol = vec![0u8; total];
        res.remap_image(&image, &mut no_tol).unwrap();
        res.set_run_tolerance(0.25).unwrap();
        let mut with_tol = vec![0u8; total];
        res.remap_image(&image, &mut with_tol).unwrap();
        assert!(count_runs(&with_tol) < count_runs(&no_tol));

        let palette = res.get_palette();
        for p in 0..total {
            if image.data[p * 4 + 3] == 0 {
                assert_eq!(palette.entries[usize::from(with_tol[p])].a, 0);
            }
        }
    }
}
