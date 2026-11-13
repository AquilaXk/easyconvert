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

// Result of quantization
pub struct QuantizeResult {
    error: f32,
    dithering_level: f32,
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
        let mut cache = NearestCache::new();

        #[allow(clippy::needless_range_loop)]
        for point in 0..image.width * image.height {
            let data_point = point * 4;

            let pix = pix_or_empty(&image.data[data_point..data_point + 4]);
            let colour = [pix[0] as f32, pix[1] as f32, pix[2] as f32, pix[3] as f32];

            buf[point] = cache.index_of(colour_key(pix), &self.colormap, &colour);
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
