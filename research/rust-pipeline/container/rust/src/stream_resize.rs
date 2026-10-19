//! Owned, research-only RGB8/RGBA8 row resampling. PNG is only an adapter: another
//! checked decoder can fill `resize_rows`' reusable source-row slice directly.
//!
//! Pixel centers are `(destination + 0.5) * source / destination - 0.5`.
//! Lanczos3 support widens with shrink ratio; out-of-bounds samples repeat the
//! nearest edge pixel. RESEARCH_PREFILTER=box optionally averages fixed RGB
//! blocks first; the default off path has no intermediate u8 clamp. A reduced
//! grid retains the original image extent instead of stretching its ceil size.
//! Horizontal RGB uses bounded-error Q14 Rust SIMD when suitable, otherwise
//! floating-point filtering. RGBA remains premultiplied float. This is not
//! bit-identical libvips output.
use std::{collections::VecDeque, f64::consts::PI, io::Cursor, mem::size_of};

const MAX_INPUT_BYTES: usize = 100 * 1024 * 1024;
const MAX_PIXELS: u64 = 50_000_000;
const MAX_COEFFICIENT_BYTES: usize = 64 * 1024 * 1024;
const MAX_ROW_WORKING_BYTES: usize = 64 * 1024 * 1024;
const MAX_DECODE_SCRATCH: usize = 64 * 1024 * 1024;

pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub channels: usize,
    pub pixels: Vec<u8>,
}

fn check_stop(stop: &dyn Fn() -> bool) -> Result<(), String> {
    if stop() {
        Err("canceled".into())
    } else {
        Ok(())
    }
}

fn checked_product(values: &[usize]) -> Result<usize, String> {
    values.iter().try_fold(1usize, |product, value| {
        product
            .checked_mul(*value)
            .ok_or_else(|| "owned resize allocation overflow".into())
    })
}

fn zeros<T: Default + Clone>(length: usize) -> Result<Vec<T>, String> {
    let mut buffer = Vec::new();
    buffer
        .try_reserve_exact(length)
        .map_err(|_| "owned resize allocation failed")?;
    buffer.resize(length, T::default());
    Ok(buffer)
}

fn target_dimensions(width: u32, height: u32, requested: u32) -> Result<(u32, u32), String> {
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err("input pixel limit exceeded".into());
    }
    if !(1..=3840).contains(&requested) {
        return Err("invalid transform width".into());
    }
    let target_width = width.min(requested);
    let target_height = ((u64::from(height) * u64::from(target_width) + u64::from(width) / 2)
        / u64::from(width))
    .max(1) as u32;
    if target_width > 16383 || target_height > 16383 {
        return Err("WebP dimension limit exceeded".into());
    }
    Ok((target_width, target_height))
}

#[derive(Clone, Copy)]
struct Tap {
    start: usize,
    length: usize,
    offset: usize,
}

struct Axis {
    source: usize,
    extent: f64,
    destination: usize,
    taps: Vec<Tap>,
    weights: Vec<f32>,
    quantized: Option<Vec<i16>>,
    weight_count: usize,
}

fn lanczos3(position: f64) -> f64 {
    let x = position.abs();
    if x == 0.0 {
        1.0
    } else if x >= 3.0 {
        0.0
    } else {
        let pi_x = PI * x;
        (pi_x.sin() / pi_x) * ((pi_x / 3.0).sin() / (pi_x / 3.0))
    }
}

impl Axis {
    // Plan both axes before allocating any coefficient array. Extreme shapes
    // can have a small output but an enormous antialiasing footprint.
    fn plan(
        source: usize,
        destination: usize,
        extent: f64,
        stop: &dyn Fn() -> bool,
    ) -> Result<Self, String> {
        if source == 0
            || destination == 0
            || !extent.is_finite()
            || extent <= 0.0
            || extent > source as f64
            || extent <= source.saturating_sub(1) as f64
        {
            return Err("invalid filter source extent".into());
        }
        let mut taps = Vec::new();
        taps.try_reserve_exact(destination)
            .map_err(|_| "owned tap allocation failed")?;
        let mut weight_count = 0usize;
        let scale = extent / destination as f64;
        let support = 3.0 * scale.max(1.0);
        for d in 0..destination {
            check_stop(stop)?;
            let (start, end) = if source == destination && extent == source as f64 {
                (d, d + 1)
            } else {
                let center = (d as f64 + 0.5) * scale - 0.5;
                let start = (center - support).ceil().max(0.0) as usize;
                let end = ((center + support).floor() + 1.0).min(source as f64) as usize;
                (start, end)
            };
            let length = end
                .checked_sub(start)
                .filter(|n| *n != 0)
                .ok_or("invalid filter span")?;
            taps.push(Tap {
                start,
                length,
                offset: weight_count,
            });
            weight_count = weight_count
                .checked_add(length)
                .ok_or("owned coefficient overflow")?;
        }
        Ok(Self {
            source,
            extent,
            destination,
            taps,
            weights: Vec::new(),
            quantized: None,
            weight_count,
        })
    }

    fn allocation_bytes(&self) -> Result<usize, String> {
        checked_product(&[self.weight_count, size_of::<f32>()])?
            .checked_add(checked_product(&[self.taps.len(), size_of::<Tap>()])?)
            .ok_or_else(|| "owned coefficient allocation overflow".into())
    }

    // Quantize only when the total coefficient error bounds the horizontal
    // error below 0.25 channel values for any u8 source. Exact unit sum keeps
    // constant colors exact. Very wide spans retain the floating-point path.
    fn quantize(&mut self, stop: &dyn Fn() -> bool) -> Result<(), String> {
        if std::env::var("RESEARCH_KERNEL").as_deref() == Ok("float") {
            return Ok(());
        }
        let mut quantized = zeros::<i16>(self.weight_count)?;
        for tap in &self.taps {
            check_stop(stop)?;
            let values = &self.weights[tap.offset..tap.offset + tap.length];
            let out = &mut quantized[tap.offset..tap.offset + tap.length];
            let mut sum = 0i64;
            let mut pivot = 0;
            for (index, (&value, q)) in values.iter().zip(out.iter_mut()).enumerate() {
                let scaled = (value * 16384.0).round();
                if scaled < i16::MIN as f32 || scaled > i16::MAX as f32 {
                    return Ok(());
                }
                *q = scaled as i16;
                sum += i64::from(*q);
                if value > values[pivot] {
                    pivot = index;
                }
            }
            let corrected = i64::from(out[pivot]) + 16384 - sum;
            if !(i64::from(i16::MIN)..=i64::from(i16::MAX)).contains(&corrected) {
                return Ok(());
            }
            out[pivot] = corrected as i16;
            let absolute: i64 = out.iter().map(|q| i64::from(*q).abs()).sum();
            let error: f64 = values
                .iter()
                .zip(out.iter())
                .map(|(&f, &q)| (f64::from(f) - f64::from(q) / 16384.0).abs())
                .sum();
            if absolute > 65536 || error > 1.0 / 1024.0 {
                return Ok(());
            }
        }
        self.quantized = Some(quantized);
        Ok(())
    }

    fn fill(&mut self, stop: &dyn Fn() -> bool) -> Result<(), String> {
        self.weights = zeros(self.weight_count)?;
        let scale = self.extent / self.destination as f64;
        let filter_scale = scale.max(1.0);
        let support = 3.0 * filter_scale;
        let identity = self.is_identity();
        for (d, tap) in self.taps.iter().enumerate() {
            check_stop(stop)?;
            let values = &mut self.weights[tap.offset..tap.offset + tap.length];
            if identity {
                values[0] = 1.0;
                continue;
            }
            let center = (d as f64 + 0.5) * scale - 0.5;
            let first = (center - support).ceil() as i64;
            let last = (center + support).floor() as i64;
            for (index, coordinate) in (first..=last).enumerate() {
                if index & 4095 == 0 {
                    check_stop(stop)?;
                }
                let value = lanczos3((coordinate as f64 - center) / filter_scale);
                let source = coordinate.clamp(0, self.source as i64 - 1) as usize;
                values[source - tap.start] += value as f32;
            }
            let sum: f64 = values.iter().map(|value| f64::from(*value)).sum();
            if !sum.is_finite() || sum <= 0.0 {
                return Err("invalid filter normalization".into());
            }
            for value in values {
                *value = (f64::from(*value) / sum) as f32;
            }
        }
        Ok(())
    }

    fn is_identity(&self) -> bool {
        self.source == self.destination && self.extent == self.source as f64
    }
}

fn horizontal_row(
    source: &[u8],
    destination: &mut [f32],
    axis: &Axis,
    stop: &dyn Fn() -> bool,
) -> Result<(), String> {
    if axis.is_identity() {
        for (out, value) in destination.iter_mut().zip(source) {
            *out = f32::from(*value);
        }
        return Ok(());
    }
    for (x, tap) in axis.taps.iter().enumerate() {
        if x & 127 == 0 {
            check_stop(stop)?;
        }
        let pixels = &source[tap.start * 3..(tap.start + tap.length) * 3];
        if let Some(weights) = &axis.quantized {
            let value =
                crate::simd_rgb::rgb_dot(pixels, &weights[tap.offset..tap.offset + tap.length]);
            destination[x * 3..x * 3 + 3].copy_from_slice(&value);
            continue;
        }
        let weights = &axis.weights[tap.offset..tap.offset + tap.length];
        let mut sum = [0.0f32; 4];
        for (chunk_index, (pixel_chunk, weight_chunk)) in pixels
            .chunks(4096 * 3)
            .zip(weights.chunks(4096))
            .enumerate()
        {
            if chunk_index != 0 {
                check_stop(stop)?;
            }
            crate::simd_rgb::rgb_float_accumulate(pixel_chunk, weight_chunk, &mut sum);
        }
        destination[x * 3..x * 3 + 3].copy_from_slice(&sum[..3]);
    }
    Ok(())
}

fn horizontal_row_rgba(
    source: &[u8],
    destination: &mut [f32],
    axis: &Axis,
    stop: &dyn Fn() -> bool,
) -> Result<(), String> {
    if axis.is_identity() {
        for (pixel, out) in source.chunks_exact(4).zip(destination.chunks_exact_mut(4)) {
            let alpha = f32::from(pixel[3]);
            let coverage = alpha / 255.0;
            out[0] = f32::from(pixel[0]) * coverage;
            out[1] = f32::from(pixel[1]) * coverage;
            out[2] = f32::from(pixel[2]) * coverage;
            out[3] = alpha;
        }
        return Ok(());
    }
    for (x, tap) in axis.taps.iter().enumerate() {
        if x & 127 == 0 {
            check_stop(stop)?;
        }
        let pixels = &source[tap.start * 4..(tap.start + tap.length) * 4];
        let weights = &axis.weights[tap.offset..tap.offset + tap.length];
        let mut sum = [0.0f32; 4];
        for (index, (pixel, weight)) in pixels.chunks_exact(4).zip(weights).enumerate() {
            if index != 0 && index & 4095 == 0 {
                check_stop(stop)?;
            }
            let alpha = f32::from(pixel[3]);
            let weighted_coverage = (alpha / 255.0) * weight;
            sum[0] += f32::from(pixel[0]) * weighted_coverage;
            sum[1] += f32::from(pixel[1]) * weighted_coverage;
            sum[2] += f32::from(pixel[2]) * weighted_coverage;
            sum[3] += alpha * weight;
        }
        destination[x * 4..x * 4 + 4].copy_from_slice(&sum);
    }
    Ok(())
}

// A reduced RGB row uses one original-row buffer and one u64 sum per reduced
// channel. Partial blocks repeat the final source pixel/row to their full size;
// neither a full source frame nor a full reduced frame is materialized.
struct BoxRows {
    source_row: Vec<u8>,
    sums: Vec<u64>,
    source_height: usize,
    source_rows: usize,
    factor_x: usize,
    factor_y: usize,
}

impl BoxRows {
    fn new(width: u32, height: u32, factor_x: u32, factor_y: u32) -> Result<Self, String> {
        let source_stride = checked_product(&[width as usize, 3])?;
        let reduced_stride = checked_product(&[width.div_ceil(factor_x) as usize, 3])?;
        Ok(Self {
            source_row: zeros(source_stride)?,
            sums: zeros(reduced_stride)?,
            source_height: height as usize,
            source_rows: 0,
            factor_x: factor_x as usize,
            factor_y: factor_y as usize,
        })
    }

    fn read(
        &mut self,
        destination: &mut [u8],
        read_row: &mut dyn FnMut(&mut [u8]) -> Result<(), String>,
        stop: &dyn Fn() -> bool,
    ) -> Result<(), String> {
        if destination.len() != self.sums.len() || self.source_rows >= self.source_height {
            return Err("owned box row contract failed".into());
        }
        self.sums.fill(0);
        let real_rows = self.factor_y.min(self.source_height - self.source_rows);
        for y in 0..real_rows {
            check_stop(stop)?;
            read_row(&mut self.source_row)?;
            self.source_rows += 1;
            // Weight the last real row as if it were read repeatedly, without
            // polling the decoder again or storing additional rows.
            let repeat = if y + 1 == real_rows {
                self.factor_y - real_rows + 1
            } else {
                1
            } as u64;
            for (x, (block, sums)) in self
                .source_row
                .chunks(self.factor_x * 3)
                .zip(self.sums.chunks_exact_mut(3))
                .enumerate()
            {
                if x & 127 == 0 {
                    check_stop(stop)?;
                }
                let mut sum = [0u64; 3];
                for (i, pixel) in block.chunks_exact(3).enumerate() {
                    if i & 4095 == 0 {
                        check_stop(stop)?;
                    }
                    for channel in 0..3 {
                        sum[channel] += u64::from(pixel[channel]);
                    }
                }
                let missing = self.factor_x - block.len() / 3;
                let last = &block[block.len() - 3..];
                for channel in 0..3 {
                    sum[channel] += u64::from(last[channel]) * missing as u64;
                    sums[channel] += sum[channel] * repeat;
                }
            }
        }
        // The 50-MP source bound also bounds factor_x * factor_y and each sum.
        let count = self.factor_x as u64 * self.factor_y as u64;
        for (i, (out, sum)) in destination.iter_mut().zip(&self.sums).enumerate() {
            if i & 4095 == 0 {
                check_stop(stop)?;
            }
            *out = ((sum + count / 2) / count) as u8;
        }
        Ok(())
    }
}

/// Consume exactly `source_height` RGB8/RGBA8 rows through a reusable slice.
/// RESEARCH_PREFILTER=box enables an RGB-only fixed-block average; off (default)
/// and RGBA retain the original owned Lanczos path. The reader validates its
/// own format, checksums and end-of-stream framing.
pub fn resize_rows(
    source_width: u32,
    source_height: u32,
    requested_width: u32,
    channels: usize,
    read_row: &mut dyn FnMut(&mut [u8]) -> Result<(), String>,
    stop: &dyn Fn() -> bool,
) -> Result<Frame, String> {
    check_stop(stop)?;
    if channels != 3 && channels != 4 {
        return Err("owned streaming resize supports RGB8/RGBA8 only".into());
    }
    let (width, height) = target_dimensions(source_width, source_height, requested_width)?;
    let source_stride = checked_product(&[source_width as usize, channels])?;
    if source_stride > MAX_ROW_WORKING_BYTES {
        return Err("owned source-row memory limit exceeded".into());
    }
    let prefilter = match std::env::var("RESEARCH_PREFILTER") {
        Err(std::env::VarError::NotPresent) => false,
        Ok(value) if value == "off" => false,
        Ok(value) if value == "box" => true,
        _ => return Err("RESEARCH_PREFILTER must be off or box".into()),
    };
    if prefilter && channels == 3 && source_width != width {
        let factor_x = (source_width / (width * 2)).max(1);
        let factor_y = (source_height / (height * 2)).max(1);
        if factor_x > 1 || factor_y > 1 {
            let reduced_width = source_width.div_ceil(factor_x);
            let reduced_height = source_height.div_ceil(factor_y);
            let sums_bytes = checked_product(&[reduced_width as usize, 3, size_of::<u64>()])?;
            let external_bytes = source_stride
                .checked_add(sums_bytes)
                .ok_or("owned box row allocation overflow")?;
            // Allocate prefilter scratch lazily, after the row core has checked
            // its combined ring + prefilter working-memory requirement.
            let mut prefilter = None;
            return resize_rows_core(
                reduced_width,
                reduced_height,
                width,
                height,
                channels,
                source_width as f64 / factor_x as f64,
                source_height as f64 / factor_y as f64,
                external_bytes,
                &mut |row| {
                    if prefilter.is_none() {
                        prefilter = Some(BoxRows::new(
                            source_width,
                            source_height,
                            factor_x,
                            factor_y,
                        )?);
                    }
                    prefilter.as_mut().unwrap().read(row, read_row, stop)
                },
                stop,
            );
        }
    }
    resize_rows_core(
        source_width,
        source_height,
        width,
        height,
        channels,
        source_width as f64,
        source_height as f64,
        0,
        read_row,
        stop,
    )
}

// Output dimensions always come from the ORIGINAL source aspect ratio. A box
// grid uses ceil dimensions for storage, but original/factor for sampling extent:
// ((d+.5) * original / target / factor) -.5. Using ceil/target here would stretch
// nondivisible images and move their pixel centers.
fn resize_rows_core(
    source_width: u32,
    source_height: u32,
    width: u32,
    height: u32,
    channels: usize,
    extent_x: f64,
    extent_y: f64,
    external_bytes: usize,
    read_row: &mut dyn FnMut(&mut [u8]) -> Result<(), String>,
    stop: &dyn Fn() -> bool,
) -> Result<Frame, String> {
    let source_stride = checked_product(&[source_width as usize, channels])?;
    let destination_stride = checked_product(&[width as usize, channels])?;
    let output_length = checked_product(&[destination_stride, height as usize])?;
    if source_stride > MAX_ROW_WORKING_BYTES {
        return Err("owned source-row memory limit exceeded".into());
    }
    // Identity requests preserve source pixels and skip float coefficients.
    if source_width == width
        && source_height == height
        && extent_x == source_width as f64
        && extent_y == source_height as f64
    {
        let mut pixels = zeros(output_length)?;
        for row in pixels.chunks_exact_mut(destination_stride) {
            check_stop(stop)?;
            read_row(row)?;
        }
        check_stop(stop)?;
        return Ok(Frame {
            width,
            height,
            channels,
            pixels,
        });
    }

    let mut horizontal = Axis::plan(source_width as usize, width as usize, extent_x, stop)?;
    let mut vertical = Axis::plan(source_height as usize, height as usize, extent_y, stop)?;
    let coefficient_bytes = horizontal
        .allocation_bytes()?
        .checked_add(vertical.allocation_bytes()?)
        .and_then(|bytes| {
            bytes.checked_add(if channels == 3 {
                horizontal.weight_count.checked_mul(size_of::<i16>())?
            } else {
                0
            })
        })
        .ok_or("owned coefficient allocation overflow")?;
    if coefficient_bytes > MAX_COEFFICIENT_BYTES {
        return Err("owned coefficient memory limit exceeded".into());
    }
    let maximum_rows = vertical
        .taps
        .iter()
        .map(|tap| tap.length)
        .max()
        .unwrap_or(0);
    let row_bytes = checked_product(&[destination_stride, size_of::<f32>()])?;
    let row_metadata = size_of::<(usize, Vec<f32>)>() + size_of::<Vec<f32>>();
    let working_bytes = row_bytes
        .checked_add(row_metadata)
        .and_then(|bytes| bytes.checked_mul(maximum_rows))
        .and_then(|bytes| bytes.checked_add(row_bytes))
        .and_then(|bytes| bytes.checked_add(source_stride))
        .and_then(|bytes| bytes.checked_add(external_bytes))
        .ok_or("owned ring allocation overflow")?;
    if working_bytes > MAX_ROW_WORKING_BYTES {
        return Err("owned row-ring memory limit exceeded".into());
    }
    horizontal.fill(stop)?;
    if channels == 3 {
        horizontal.quantize(stop)?;
    }
    vertical.fill(stop)?;
    let mut source_row = zeros(source_stride)?;
    let mut sum = zeros::<f32>(destination_stride)?;
    let mut pixels = zeros(output_length)?;
    let mut ring: VecDeque<(usize, Vec<f32>)> = VecDeque::new();
    ring.try_reserve_exact(maximum_rows)
        .map_err(|_| "owned ring allocation failed")?;
    let mut recycled = Vec::<Vec<f32>>::new();
    recycled
        .try_reserve_exact(maximum_rows)
        .map_err(|_| "owned row pool allocation failed")?;
    let mut next_source = 0usize;

    for (y, tap) in vertical.taps.iter().enumerate() {
        check_stop(stop)?;
        while ring.front().is_some_and(|(row, _)| *row < tap.start) {
            recycled.push(ring.pop_front().unwrap().1);
        }
        while next_source < tap.start + tap.length {
            check_stop(stop)?;
            read_row(&mut source_row)?;
            if next_source >= tap.start {
                let mut row = match recycled.pop() {
                    Some(row) => row,
                    None => zeros::<f32>(destination_stride)?,
                };
                if channels == 3 {
                    horizontal_row(&source_row, &mut row, &horizontal, stop)?;
                } else {
                    horizontal_row_rgba(&source_row, &mut row, &horizontal, stop)?;
                }
                ring.push_back((next_source, row));
            }
            next_source += 1;
        }
        sum.fill(0.0);
        let weights = &vertical.weights[tap.offset..tap.offset + tap.length];
        for ((source_y, row), weight) in ring.iter().zip(weights) {
            check_stop(stop)?;
            if *source_y < tap.start || *source_y >= tap.start + tap.length {
                return Err("owned row-ring invariant failed".into());
            }
            // Contiguous independent values allow LLVM to vectorize this pass.
            crate::simd_rgb::accumulate(&mut sum, row, *weight);
        }
        if ring.len() != tap.length {
            return Err("owned row-ring length invariant failed".into());
        }
        let output = &mut pixels[y * destination_stride..(y + 1) * destination_stride];
        if channels == 3 {
            for (out, value) in output.iter_mut().zip(&sum) {
                *out = value.round().clamp(0.0, 255.0) as u8;
            }
        } else {
            for (out, value) in output.chunks_exact_mut(4).zip(sum.chunks_exact(4)) {
                let alpha = value[3].round().clamp(0.0, 255.0) as u8;
                if alpha == 0 {
                    out.fill(0);
                } else {
                    // Divide by the unclipped filtered alpha: Lanczos can
                    // overshoot 255, and clipping it first changes solid RGB.
                    // RGB and alpha stayed premultiplied through both passes.
                    let inverse_coverage = 255.0 / value[3];
                    for channel in 0..3 {
                        out[channel] = (value[channel] * inverse_coverage)
                            .round()
                            .clamp(0.0, 255.0) as u8;
                    }
                    out[3] = alpha;
                }
            }
        }
    }
    // Complete the row contract even if a future filter trims its final support.
    while next_source < source_height as usize {
        check_stop(stop)?;
        read_row(&mut source_row)?;
        next_source += 1;
    }
    check_stop(stop)?;
    Ok(Frame {
        width,
        height,
        channels,
        pixels,
    })
}

fn inspect_png(input: &[u8], stop: &dyn Fn() -> bool) -> Result<(u32, u32, usize), String> {
    check_stop(stop)?;
    if input.len() > MAX_INPUT_BYTES {
        return Err("input byte limit exceeded".into());
    }
    if !input.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("owned streaming resize requires PNG".into());
    }
    let mut offset = 8usize;
    let mut dimensions = None;
    let mut saw_idat = false;
    while offset < input.len() {
        check_stop(stop)?;
        let header = input.get(offset..offset + 8).ok_or("truncated PNG chunk")?;
        let length = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
        let end = offset
            .checked_add(12)
            .and_then(|start| start.checked_add(length))
            .filter(|end| *end <= input.len())
            .ok_or("truncated PNG chunk")?;
        let data = &input[offset + 8..end - 4];
        match &header[4..8] {
            b"IHDR" if offset == 8 && length == 13 => {
                let width = u32::from_be_bytes(data[..4].try_into().unwrap());
                let height = u32::from_be_bytes(data[4..8].try_into().unwrap());
                if data[8] != 8 || !matches!(data[9], 2 | 6) || data[10..] != [0, 0, 0] {
                    return Err(
                        "owned streaming resize requires noninterlaced RGB8/RGBA8 PNG".into(),
                    );
                }
                dimensions = Some((width, height, if data[9] == 2 { 3 } else { 4 }));
            }
            b"IDAT" if dimensions.is_some() => saw_idat = true,
            b"IEND" if dimensions.is_some() && saw_idat && length == 0 => {
                // The image ends here. Like the baseline and owned row reader,
                // tolerate file padding after a fully validated IEND.
                return Ok(dimensions.unwrap());
            }
            // Reject all ancillary chunks, including ICC, EXIF, gAMA/cHRM,
            // text and APNG. No color/orientation metadata is silently dropped.
            _ => return Err("owned streaming resize requires IHDR/IDAT/IEND-only PNG".into()),
        }
        offset = end;
    }
    Err("missing PNG IEND".into())
}

/// Strict PNG adapter for the owned row pipeline. All chunks are inspected
/// before decoding, and CRC plus the zlib Adler checksum remain mandatory.
pub fn resize_png(input: &[u8], width: u32, stop: &dyn Fn() -> bool) -> Result<Frame, String> {
    let (source_width, source_height, channels) = inspect_png(input, stop)?;
    target_dimensions(source_width, source_height, width)?;
    let mut decoder = png::Decoder::new_with_limits(
        Cursor::new(input),
        png::Limits {
            bytes: MAX_DECODE_SCRATCH,
        },
    );
    decoder.ignore_checksums(false);
    let mut reader = decoder.read_info().map_err(|error| error.to_string())?;
    if reader.info().width != source_width
        || reader.info().height != source_height
        || reader.info().color_type
            != if channels == 3 {
                png::ColorType::Rgb
            } else {
                png::ColorType::Rgba
            }
        || reader.info().bit_depth != png::BitDepth::Eight
        || reader.info().interlaced
    {
        return Err("unexpected owned PNG decoder layout".into());
    }
    let frame = resize_rows(
        source_width,
        source_height,
        width,
        channels,
        &mut |destination| {
            reader
                .read_row(destination)
                .map_err(|error| error.to_string())?
                .ok_or("missing PNG row")?;
            Ok(())
        },
        stop,
    )?;
    check_stop(stop)?;
    // Polling once after the last row finishes the IDAT stream and verifies
    // Adler; finish() then validates the remaining chunk framing/CRC through IEND.
    if reader
        .next_row()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Err("unexpected extra PNG row".into());
    }
    reader.finish().map_err(|error| error.to_string())?;
    check_stop(stop)?;
    Ok(frame)
}
