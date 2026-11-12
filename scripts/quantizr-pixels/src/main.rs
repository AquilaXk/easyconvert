// quantizr-pixels: reduces raw RGBA pixels to a palette of at most 256 colours with the quantizr library (https://github.com/DarthSim/quantizr,
// MIT, Copyright (c) 2017 Sergey Alexandrovich; tag v1.4.3, commit cfb26aaf3039ac1179d42a66cc7988c8c6feeba9; see ./SOURCE).
//
// The calls into the library are the ones of its example program (example/src/main.rs: Options, QuantizeResult::quantize,
// set_dithering_level, remap_image, get_palette); the program around them is ours. It is a filter: the pixels come in on standard input
// and the result goes out on standard output, so it opens no file and needs none.
//
// Input:  the width and the height (two little-endian u32), then width * height RGBA bytes (8 bits a sample, straight alpha).
// Output: the number of palette entries (little-endian u32), the entries as RGBA bytes, then width * height palette indices, one byte each.
// Usage:  quantizr-pixels [--colors 2..256] [--dither 0..1]     (defaults: 256 colours, dithering level 1.0, the library's own)
use std::io::{Read, Write};
use std::process::ExitCode;

use quantizr::{Image, Options, QuantizeResult};

/// The most pixels the program reads. The worker sends 36 megapixels at the most (its budget for this program); a header that names more is
/// refused before anything is allocated.
const MAX_PIXELS: usize = 36_000_000;
const HEADER_BYTES: usize = 8;
const CHANNELS: usize = 4;

struct Settings {
    colors: i32,
    dither: f32,
}

fn parse_arguments() -> Result<Settings, String> {
    let mut settings = Settings { colors: 256, dither: 1.0 };
    let mut arguments = std::env::args().skip(1);
    while let Some(name) = arguments.next() {
        let value = arguments.next().ok_or_else(|| format!("{name} needs a value"))?;
        match name.as_str() {
            "--colors" => settings.colors = value.parse().map_err(|_| "--colors is not a number".to_string())?,
            "--dither" => settings.dither = value.parse().map_err(|_| "--dither is not a number".to_string())?,
            _ => return Err(format!("unknown argument {name}")),
        }
    }
    Ok(settings)
}

/// The picture on standard input: its size and its RGBA bytes, which must be exactly as many as the header says.
fn read_picture() -> Result<(usize, usize, Vec<u8>), String> {
    let mut input = std::io::stdin().lock();
    let mut header = [0u8; HEADER_BYTES];
    input.read_exact(&mut header).map_err(|_| "the pixel data is shorter than its header".to_string())?;
    let width = u32::from_le_bytes([header[0], header[1], header[2], header[3]]) as usize;
    let height = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
    let size_error = || "the pixel data does not match its width and height".to_string();
    let pixel_count = width.checked_mul(height).filter(|&count| count > 0 && count <= MAX_PIXELS).ok_or_else(size_error)?;
    let mut pixels = vec![0u8; pixel_count * CHANNELS];
    input.read_exact(&mut pixels).map_err(|_| size_error())?;
    if input.read(&mut [0u8; 1]).map_err(|_| size_error())? != 0 {
        return Err(size_error());
    }
    Ok((width, height, pixels))
}

fn run() -> Result<(), String> {
    let settings = parse_arguments()?;
    let (width, height, pixels) = read_picture()?;
    let failed = |error: quantizr::Error| format!("quantizr refused the request: {error}");

    let image = Image::new(&pixels, width, height).map_err(failed)?;
    let mut options = Options::default();
    options.set_max_colors(settings.colors).map_err(failed)?;
    let mut result = QuantizeResult::quantize(&image, &options);
    result.set_dithering_level(settings.dither).map_err(failed)?;
    let mut indices = vec![0u8; width * height];
    result.remap_image(&image, &mut indices).map_err(failed)?;
    let palette = result.get_palette();

    let mut head = Vec::with_capacity(4 + palette.count as usize * CHANNELS);
    head.extend_from_slice(&palette.count.to_le_bytes());
    for entry in &palette.entries[..palette.count as usize] {
        head.extend_from_slice(&[entry.r, entry.g, entry.b, entry.a]);
    }
    let mut output = std::io::stdout().lock();
    output.write_all(&head).and_then(|()| output.write_all(&indices)).map_err(|error| format!("the result could not be written: {error}"))
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("quantizr-pixels: {message}");
            ExitCode::from(2)
        }
    }
}
