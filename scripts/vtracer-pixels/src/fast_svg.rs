//! Zero-allocation fixed-point & lookup-table SVG serializer for [`VectorDoc`].
//!
//! Derived from `crates/vtracer/src/svg.rs` of `visioncortex/vtracer`
//! at tag `1.0.0-alpha.4` (commit `2500df76b5aea0ac22d15296b22722442f825c5b`,
//! dual-licensed MIT OR Apache-2.0; see `../LICENSE` and `../SOURCE`).
//!
//! Low-level optimizations over upstream `SvgWriter` (`svg.rs:45-367`),
//! preserving byte-for-byte identical output:
//! 1. **Two-digit static lookup table (`DEC_DIGITS_LUT`) + fixed-point integer
//!    formatting**: coordinates within `|v| <= 1e8` at `precision = 0..=8` are
//!    scaled once (`(v * 10^p).round() as i64`), stripped of trailing fractional
//!    zeros by integer division, and serialized two decimal digits per table read
//!    without invoking `core::fmt::float` or allocating heap `String`s.
//! 2. **Deduplicated coordinate formatting & pure-length candidate selection**:
//!    each coordinate (`p.x`, `p.y`, deltas) is formatted once onto the stack,
//!    candidate command byte lengths (`H`/`h`/`V`/`v`/`L`/`l` and `S`/`s`/`C`/`c`)
//!    are evaluated in scalar integer arithmetic without constructing candidate
//!    strings, and only the winning shortest encoding is appended to the single
//!    preallocated output `Vec<u8>`.

use std::io::Write as _;

use visioncortex::{Color, PointF64};
use vtracer::ir::{Paint, PathCmd, Shape, SubPath, VectorDoc};
use vtracer::svg::SvgWriter;

const HEX_UPPER: &[u8; 16] = b"0123456789ABCDEF";
const NUM_CAP: usize = 32;

/// Classic 200-byte two-digit decimal lookup table (`"00".."99"`).
const DEC_DIGITS_LUT: [u8; 200] = {
    let mut table = [0u8; 200];
    let mut i = 0usize;
    while i < 100 {
        table[i * 2] = b'0' + (i / 10) as u8;
        table[i * 2 + 1] = b'0' + (i % 10) as u8;
        i += 1;
    }
    table
};

const POW10_F64: [f64; 9] = [
    1.0,
    10.0,
    100.0,
    1_000.0,
    10_000.0,
    100_000.0,
    1_000_000.0,
    10_000_000.0,
    100_000_000.0,
];

const POW10_U64: [u64; 9] = [
    1,
    10,
    100,
    1_000,
    10_000,
    100_000,
    1_000_000,
    10_000_000,
    100_000_000,
];

#[derive(Clone, Copy)]
struct NumToken {
    bytes: [u8; NUM_CAP],
    len: u8,
}

impl NumToken {
    #[inline]
    fn as_slice(&self) -> &[u8] {
        &self.bytes[..self.len as usize]
    }

    #[inline]
    fn is_neg(&self) -> bool {
        self.bytes[0] == b'-'
    }

    #[inline]
    fn len_usize(&self) -> usize {
        self.len as usize
    }
}

/// Writes an unsigned integer into the end of `scratch` using `DEC_DIGITS_LUT`
/// and returns the starting index within `scratch`.
#[inline]
fn write_u64_rev(scratch: &mut [u8; 24], mut n: u64) -> usize {
    let mut pos = 24usize;
    while n >= 100 {
        let rem = ((n % 100) as usize) * 2;
        n /= 100;
        pos -= 2;
        scratch[pos] = DEC_DIGITS_LUT[rem];
        scratch[pos + 1] = DEC_DIGITS_LUT[rem + 1];
    }
    if n >= 10 {
        let rem = (n as usize) * 2;
        pos -= 2;
        scratch[pos] = DEC_DIGITS_LUT[rem];
        scratch[pos + 1] = DEC_DIGITS_LUT[rem + 1];
    } else {
        pos -= 1;
        scratch[pos] = b'0' + (n as u8);
    }
    pos
}

/// Formats `v` identically to `vtracer::svg::fmt_num` (`svg.rs:333-367`).
#[inline]
fn fmt_num(v: f64, precision: Option<u32>) -> NumToken {
    if let Some(p) = precision {
        if p <= 8 && v.is_finite() && v.abs() <= 1e8 {
            let p_idx = p as usize;
            let scaled = (v * POW10_F64[p_idx]).round();
            if scaled == 0.0 {
                let mut bytes = [0u8; NUM_CAP];
                bytes[0] = b'0';
                return NumToken { bytes, len: 1 };
            }
            let neg = scaled < 0.0;
            let abs_scaled = scaled.abs() as u64;
            let scale_u = POW10_U64[p_idx];
            let int_part = abs_scaled / scale_u;
            let mut frac_part = abs_scaled % scale_u;

            let mut bytes = [0u8; NUM_CAP];
            let mut out_len = 0usize;
            if neg {
                bytes[0] = b'-';
                out_len = 1;
            }

            if frac_part == 0 {
                let mut scratch = [0u8; 24];
                let start = write_u64_rev(&mut scratch, int_part);
                let digits = &scratch[start..];
                bytes[out_len..out_len + digits.len()].copy_from_slice(digits);
                out_len += digits.len();
                return NumToken {
                    bytes,
                    len: out_len as u8,
                };
            }

            // Strip trailing fractional zeros via integer division.
            let mut frac_width = p_idx;
            while frac_width > 0 && frac_part % 10 == 0 {
                frac_part /= 10;
                frac_width -= 1;
            }

            if int_part > 0 {
                let mut scratch = [0u8; 24];
                let start = write_u64_rev(&mut scratch, int_part);
                let digits = &scratch[start..];
                bytes[out_len..out_len + digits.len()].copy_from_slice(digits);
                out_len += digits.len();
            }
            // Note: when int_part == 0 and frac_part > 0, omitting '0' produces
            // `.5` and `-.5`, matching upstream `strip_prefix("0.")` / `"-0."`.
            bytes[out_len] = b'.';
            out_len += 1;

            let mut frac_scratch = [b'0'; 8];
            let mut f = frac_part;
            let mut pos = frac_width;
            while f > 0 && pos > 0 {
                pos -= 1;
                frac_scratch[pos] = b'0' + (f % 10) as u8;
                f /= 10;
            }
            bytes[out_len..out_len + frac_width].copy_from_slice(&frac_scratch[..frac_width]);
            out_len += frac_width;
            return NumToken {
                bytes,
                len: out_len as u8,
            };
        }
    }

    fmt_num_fallback(v, precision)
}

#[cold]
fn fmt_num_fallback(v: f64, precision: Option<u32>) -> NumToken {
    let v = match precision {
        Some(p) => {
            let factor = 10f64.powi(p as i32);
            (v * factor).round() / factor
        }
        None => v,
    };
    let mut bytes = [0u8; NUM_CAP];
    if v == 0.0 {
        bytes[0] = b'0';
        return NumToken { bytes, len: 1 };
    }
    let mut raw = [0u8; 64];
    let raw_len = {
        let mut cursor = &mut raw[..];
        match precision {
            Some(p) => {
                let _ = write!(cursor, "{:.*}", p as usize, v);
            }
            None => {
                let _ = write!(cursor, "{v}");
            }
        }
        let rem = cursor.len();
        64 - rem
    };
    let mut end = raw_len;
    if raw[..end].contains(&b'.') {
        while end > 0 && raw[end - 1] == b'0' {
            end -= 1;
        }
        if end > 0 && raw[end - 1] == b'.' {
            end -= 1;
        }
    }
    let slice = &raw[..end];
    if slice.len() >= 2 && slice[0] == b'0' && slice[1] == b'.' {
        let len = end - 1;
        bytes[..len].copy_from_slice(&slice[1..]);
        NumToken {
            bytes,
            len: len as u8,
        }
    } else if slice.len() >= 3 && slice[0] == b'-' && slice[1] == b'0' && slice[2] == b'.' {
        let len = end - 1;
        bytes[0] = b'-';
        bytes[1..len].copy_from_slice(&slice[2..]);
        NumToken {
            bytes,
            len: len as u8,
        }
    } else {
        let len = end.min(NUM_CAP);
        bytes[..len].copy_from_slice(&slice[..len]);
        NumToken {
            bytes,
            len: len as u8,
        }
    }
}

#[inline]
fn joined_len(op_bytes: usize, nums: &[NumToken]) -> usize {
    let mut total = op_bytes;
    for (i, n) in nums.iter().enumerate() {
        if i > 0 && !n.is_neg() {
            total += 1;
        }
        total += n.len_usize();
    }
    total
}

#[inline]
fn emit_joined(out: &mut Vec<u8>, op: u8, nums: &[NumToken]) {
    out.push(op);
    for (i, n) in nums.iter().enumerate() {
        if i > 0 && !n.is_neg() {
            out.push(b',');
        }
        out.extend_from_slice(n.as_slice());
    }
}

#[inline]
fn shape_color(shape: &Shape) -> Color {
    match shape.paint {
        Paint::Solid(c) => c,
    }
}

#[inline]
fn write_hex_color(out: &mut Vec<u8>, c: Color) {
    out.extend_from_slice(&[
        b'#',
        HEX_UPPER[(c.r >> 4) as usize],
        HEX_UPPER[(c.r & 0x0f) as usize],
        HEX_UPPER[(c.g >> 4) as usize],
        HEX_UPPER[(c.g & 0x0f) as usize],
        HEX_UPPER[(c.b >> 4) as usize],
        HEX_UPPER[(c.b & 0x0f) as usize],
    ]);
}

#[inline]
fn approx(a: PointF64, b: PointF64) -> bool {
    (a.x - b.x).abs() < 1e-6 && (a.y - b.y).abs() < 1e-6
}

struct FastEmitter<'a> {
    relative: bool,
    shorthands: bool,
    precision: Option<u32>,
    out: &'a mut Vec<u8>,
    cur: PointF64,
    subpath_start: PointF64,
    started: bool,
    prev_cubic_c2: Option<PointF64>,
}

impl<'a> FastEmitter<'a> {
    #[inline]
    fn new(writer: &SvgWriter, out: &'a mut Vec<u8>) -> Self {
        Self {
            relative: writer.relative,
            shorthands: writer.shorthands,
            precision: writer.precision,
            out,
            cur: PointF64::default(),
            subpath_start: PointF64::default(),
            started: false,
            prev_cubic_c2: None,
        }
    }

    fn subpath(&mut self, sub: &SubPath) {
        for cmd in &sub.commands {
            match *cmd {
                PathCmd::MoveTo(p) => self.move_to(p),
                PathCmd::LineTo(p) => self.line_to(p),
                PathCmd::CubicTo(c1, c2, e) => self.cubic_to(c1, c2, e),
                PathCmd::Close => {
                    self.out.push(b'Z');
                    self.cur = self.subpath_start;
                    self.prev_cubic_c2 = None;
                }
            }
        }
    }

    fn move_to(&mut self, p: PointF64) {
        let abs = [fmt_num(p.x, self.precision), fmt_num(p.y, self.precision)];
        if !self.started || !self.relative {
            emit_joined(self.out, b'M', &abs);
            self.started = true;
        } else {
            let rel = [
                fmt_num(p.x - self.cur.x, self.precision),
                fmt_num(p.y - self.cur.y, self.precision),
            ];
            if joined_len(1, &rel) < joined_len(1, &abs) {
                emit_joined(self.out, b'm', &rel);
            } else {
                emit_joined(self.out, b'M', &abs);
            }
        }
        self.cur = p;
        self.subpath_start = p;
        self.prev_cubic_c2 = None;
    }

    fn line_to(&mut self, p: PointF64) {
        let ax = fmt_num(p.x, self.precision);
        let ay = fmt_num(p.y, self.precision);
        let rx = if self.relative {
            Some(fmt_num(p.x - self.cur.x, self.precision))
        } else {
            None
        };
        let ry = if self.relative {
            Some(fmt_num(p.y - self.cur.y, self.precision))
        } else {
            None
        };

        // Candidate tags: 0=H, 1=h, 2=V, 3=v, 4=L, 5=l (evaluated in exact upstream order).
        let mut best_tag = 4u8;
        let mut best_len = usize::MAX;
        let mut consider = |tag: u8, len: usize| {
            if len < best_len {
                best_len = len;
                best_tag = tag;
            }
        };

        if self.shorthands {
            if p.y == self.cur.y {
                consider(0, 1 + ax.len_usize());
                if let Some(dx) = rx {
                    consider(1, 1 + dx.len_usize());
                }
            }
            if p.x == self.cur.x {
                consider(2, 1 + ay.len_usize());
                if let Some(dy) = ry {
                    consider(3, 1 + dy.len_usize());
                }
            }
        }

        let abs_pair = [ax, ay];
        consider(4, joined_len(1, &abs_pair));
        if let (Some(dx), Some(dy)) = (rx, ry) {
            let rel_pair = [dx, dy];
            consider(5, joined_len(1, &rel_pair));
        }

        match best_tag {
            0 => emit_joined(self.out, b'H', &[ax]),
            1 => emit_joined(self.out, b'h', &[rx.unwrap()]),
            2 => emit_joined(self.out, b'V', &[ay]),
            3 => emit_joined(self.out, b'v', &[ry.unwrap()]),
            4 => emit_joined(self.out, b'L', &abs_pair),
            _ => emit_joined(self.out, b'l', &[rx.unwrap(), ry.unwrap()]),
        }

        self.cur = p;
        self.prev_cubic_c2 = None;
    }

    fn cubic_to(&mut self, c1: PointF64, c2: PointF64, e: PointF64) {
        let abs_all = [
            fmt_num(c1.x, self.precision),
            fmt_num(c1.y, self.precision),
            fmt_num(c2.x, self.precision),
            fmt_num(c2.y, self.precision),
            fmt_num(e.x, self.precision),
            fmt_num(e.y, self.precision),
        ];
        let rel_all = if self.relative {
            Some([
                fmt_num(c1.x - self.cur.x, self.precision),
                fmt_num(c1.y - self.cur.y, self.precision),
                fmt_num(c2.x - self.cur.x, self.precision),
                fmt_num(c2.y - self.cur.y, self.precision),
                fmt_num(e.x - self.cur.x, self.precision),
                fmt_num(e.y - self.cur.y, self.precision),
            ])
        } else {
            None
        };

        // Candidate tags: 0=S, 1=s, 2=C, 3=c (evaluated in exact upstream order).
        let mut best_tag = 2u8;
        let mut best_len = usize::MAX;
        let mut consider = |tag: u8, len: usize| {
            if len < best_len {
                best_len = len;
                best_tag = tag;
            }
        };

        if self.shorthands {
            if let Some(prev_c2) = self.prev_cubic_c2 {
                let reflection = PointF64 {
                    x: 2.0 * self.cur.x - prev_c2.x,
                    y: 2.0 * self.cur.y - prev_c2.y,
                };
                if approx(reflection, c1) {
                    consider(0, joined_len(1, &abs_all[2..]));
                    if let Some(ref r) = rel_all {
                        consider(1, joined_len(1, &r[2..]));
                    }
                }
            }
        }

        consider(2, joined_len(1, &abs_all));
        if let Some(ref r) = rel_all {
            consider(3, joined_len(1, r));
        }

        match best_tag {
            0 => emit_joined(self.out, b'S', &abs_all[2..]),
            1 => emit_joined(self.out, b's', &rel_all.unwrap()[2..]),
            2 => emit_joined(self.out, b'C', &abs_all),
            _ => emit_joined(self.out, b'c', &rel_all.unwrap()),
        }

        self.cur = e;
        self.prev_cubic_c2 = Some(c2);
    }
}

fn write_path(writer: &SvgWriter, out: &mut Vec<u8>, shape: &Shape, with_fill: bool) {
    let checkpoint = out.len();
    out.extend_from_slice(b"<path d=\"");
    let d_start = out.len();
    {
        let mut emitter = FastEmitter::new(writer, out);
        for sub in &shape.path.subpaths {
            emitter.subpath(sub);
        }
    }
    if out.len() == d_start {
        out.truncate(checkpoint);
        return;
    }
    if with_fill {
        out.extend_from_slice(b"\" fill=\"");
        write_hex_color(out, shape_color(shape));
        out.extend_from_slice(b"\"/>\n");
    } else {
        out.extend_from_slice(b"\"/>\n");
    }
}

pub fn write_svg_bytes(writer: &SvgWriter, doc: &VectorDoc) -> Vec<u8> {
    let total_cmds: usize = doc
        .shapes
        .iter()
        .flat_map(|s| &s.path.subpaths)
        .map(|sub| sub.commands.len())
        .sum();
    let mut out = Vec::with_capacity(192 + doc.shapes.len() * 28 + total_cmds * 18);

    out.extend_from_slice(b"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    let _ = writeln!(
        out,
        "<!-- Generator: visioncortex VTracer {} -->",
        env!("CARGO_PKG_VERSION")
    );
    let _ = writeln!(
        out,
        "<svg version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\" width=\"{}\" height=\"{}\">",
        doc.width, doc.height
    );

    if writer.shorthands {
        let shapes = &doc.shapes;
        let mut i = 0;
        while i < shapes.len() {
            let fill = shape_color(&shapes[i]);
            let mut j = i + 1;
            while j < shapes.len() && shape_color(&shapes[j]) == fill {
                j += 1;
            }
            let run = &shapes[i..j];
            if run.len() > 1 {
                out.extend_from_slice(b"<g fill=\"");
                write_hex_color(&mut out, fill);
                out.extend_from_slice(b"\">\n");
                for shape in run {
                    write_path(writer, &mut out, shape, false);
                }
                out.extend_from_slice(b"</g>\n");
            } else {
                write_path(writer, &mut out, &run[0], true);
            }
            i = j;
        }
    } else {
        for shape in &doc.shapes {
            write_path(writer, &mut out, shape, true);
        }
    }

    out.extend_from_slice(b"</svg>\n");
    out
}
