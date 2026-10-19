//! Local-only pure Rust codec, color, resize and WebP pipeline.
use crate::stream_resize::Frame;
use axum::body::Bytes;
use std::{
    sync::atomic::{AtomicBool, Ordering},
    sync::OnceLock,
    time::Instant,
};
use zenwebp::{EncodeRequest, LossyConfig, PixelLayout, Preset};

const MAX_INPUT_BYTES: usize = 100 * 1024 * 1024;
#[derive(Clone, Copy, Debug)]
enum Reader {
    Owned,
    PngCrate,
}
static READER: OnceLock<Reader> = OnceLock::new();
pub fn initialize() -> Result<String, String> {
    let reader = match std::env::var("RESEARCH_READER")
        .as_deref()
        .unwrap_or("owned")
    {
        "owned" => Reader::Owned,
        "png" => Reader::PngCrate,
        _ => return Err("RESEARCH_READER must be owned or png".into()),
    };
    let kernel = std::env::var("RESEARCH_KERNEL").unwrap_or_else(|_| "q14".into());
    if !matches!(kernel.as_str(), "float" | "q14") {
        return Err("RESEARCH_KERNEL must be float or q14".into());
    }
    READER.set(reader).map_err(|_| "already initialized")?;
    Ok(format!("owned-stream-rowdecode-v1; fdeflate0.3.7+strict-trailer; ZenWebP-a3fec3fe+ARM-I4-winner-carry+wide-IDCT; owned-vertical-SIMD; cached-quant+unrolled-cost+deferred-zigzag+direct-IDCT; pure-Rust PNG/JPEG/WebP/AVIF; reader={reader:?}; kernel={kernel}"))
}
pub fn shutdown() {}
#[derive(Default)]
pub struct Control {
    canceled: AtomicBool,
}
impl Control {
    pub fn cancel(&self) {
        self.canceled.store(true, Ordering::Relaxed);
    }
    pub fn canceled(&self) -> bool {
        self.canceled.load(Ordering::Relaxed)
    }
    fn check(&self) -> Result<(), String> {
        if self.canceled() {
            Err("canceled".into())
        } else {
            Ok(())
        }
    }
}
impl enough::Stop for Control {
    fn check(&self) -> Result<(), enough::StopReason> {
        if self.canceled() {
            Err(enough::StopReason::Cancelled)
        } else {
            Ok(())
        }
    }
}
pub struct Encoded {
    pub data: Bytes,
    pub prepare_ms: f64,
    pub encode_ms: f64,
    pub output_ms: f64,
}

// Select only metadata-free RGB/RGBA8 noninterlaced PNG. This selector never
// decodes or accepts a file: the selected decoder still validates all framing,
// checksums and dimensions. All other files use the strict generic adapter.
fn streaming_png(input: &[u8], control: &Control) -> Result<bool, String> {
    if !input.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok(false);
    }
    let mut offset = 8usize;
    let mut count = 0usize;
    while offset < input.len() {
        control.check()?;
        count += 1;
        if count > 65536 {
            return Err("PNG chunk count limit exceeded".into());
        }
        let header = input.get(offset..offset + 8).ok_or("truncated PNG chunk")?;
        let length = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
        let end = offset
            .checked_add(12)
            .and_then(|n| n.checked_add(length))
            .filter(|n| *n <= input.len())
            .ok_or("truncated PNG chunk")?;
        match &header[4..8] {
            b"IHDR" if offset == 8 && length == 13 => {
                let data = &input[offset + 8..end - 4];
                if data[8] != 8 || !matches!(data[9], 2 | 6) || data[10..] != [0, 0, 0] {
                    return Ok(false);
                }
            }
            b"IDAT" => {}
            b"IEND" if length == 0 => return Ok(true),
            _ => return Ok(false),
        }
        offset = end;
    }
    Err("missing PNG IEND".into())
}
fn prepare(input: &[u8], width: u32, control: &Control) -> Result<Frame, String> {
    let stop = || control.canceled();
    if streaming_png(input, control)? {
        match READER.get().ok_or("renderer not initialized")? {
            Reader::PngCrate => crate::stream_resize::resize_png(input, width, &stop),
            Reader::Owned => {
                let mut reader = crate::png_rows::Rows::new(input, &stop)?;
                let frame = crate::stream_resize::resize_rows(
                    reader.width,
                    reader.height,
                    width,
                    reader.channels,
                    &mut |row| reader.read_row(row, &stop),
                    &stop,
                )?;
                reader.finish(&stop)?;
                Ok(frame)
            }
        }
    } else {
        let decoded = imgt_research_formats::decode(input, &stop).map_err(|e| e.to_string())?;
        let frame = decoded.frame;
        let channels = frame.layout.channels();
        let stride = frame.width as usize * channels;
        let mut rows = frame.pixels.chunks_exact(stride);
        crate::stream_resize::resize_rows(
            frame.width,
            frame.height,
            width,
            channels,
            &mut |destination| {
                let row = rows.next().ok_or("missing decoded row")?;
                if row.len() != destination.len() {
                    return Err("unexpected decoded row layout".into());
                }
                destination.copy_from_slice(row);
                Ok(())
            },
            &stop,
        )
    }
}
pub fn encode(
    input: Bytes,
    width: i32,
    quality: i32,
    effort: i32,
    control: &Control,
) -> Result<Encoded, String> {
    if !(1..=3840).contains(&width) || !(1..=100).contains(&quality) || !(0..=6).contains(&effort) {
        return Err("invalid transform parameters".into());
    }
    if input.len() > MAX_INPUT_BYTES {
        return Err("input byte limit exceeded".into());
    }
    control.check()?;
    let start = Instant::now();
    let frame = prepare(&input, width as u32, control)?;
    drop(input);
    control.check()?;
    let prepare_ms = start.elapsed().as_secs_f64() * 1000.;
    let encode_start = Instant::now();
    let layout = match frame.channels {
        3 => PixelLayout::Rgb8,
        4 => PixelLayout::Rgba8,
        _ => return Err("invalid frame layout".into()),
    };
    let config = LossyConfig::with_preset(Preset::Default, quality as f32)
        .with_method(effort as u8)
        .with_alpha_quality(100)
        .with_sharp_yuv(false)
        .with_sns_strength(50)
        .with_filter_strength(60)
        .with_filter_sharpness(0)
        .with_segments(4);
    let output = EncodeRequest::lossy(&config, &frame.pixels, layout, frame.width, frame.height)
        .with_stop(control)
        .encode()
        .map_err(|e| e.to_string())?;
    control.check()?;
    if output.is_empty() {
        return Err("empty WebP output".into());
    }
    let encode_ms = encode_start.elapsed().as_secs_f64() * 1000.;
    let output_start = Instant::now();
    let data = Bytes::from(output);
    Ok(Encoded {
        data,
        prepare_ms,
        encode_ms,
        output_ms: output_start.elapsed().as_secs_f64() * 1000.,
    })
}
