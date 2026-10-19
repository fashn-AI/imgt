//! Local research adapter. Decoded output is tightly packed, straight-alpha sRGB8.
//! It is intentionally not a claim of libvips color/rendering parity.
use image::{metadata::Orientation, ColorType, DynamicImage, ImageDecoder, ImageFormat};
use moxcms::{ColorProfile, DataColorSpace, Layout, TransformOptions};
use std::{fmt, io::Cursor};

pub const MAX_INPUT_BYTES: usize = 100 * 1024 * 1024;
pub const MAX_PIXELS: u64 = 50_000_000;
const MAX_METADATA_BYTES: usize = 4 * 1024 * 1024;
const PNG_SCRATCH_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelLayout {
    Rgb8,
    Rgba8,
}
impl PixelLayout {
    pub const fn channels(self) -> usize {
        match self {
            Self::Rgb8 => 3,
            Self::Rgba8 => 4,
        }
    }
}
#[derive(Debug)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub layout: PixelLayout,
    pub pixels: Vec<u8>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Jpeg,
    Png,
    WebP,
    Avif,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorHandling {
    AssumedSrgb,
    TaggedSrgb,
    IccToSrgb,
    CicpToSrgb,
}
#[derive(Debug)]
pub struct DecodeInfo {
    pub format: Format,
    pub orientation_applied: bool,
    pub color_handling: ColorHandling,
}
#[derive(Debug)]
pub struct Decoded {
    pub frame: Frame,
    pub info: DecodeInfo,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    Invalid,
    Unsupported,
    Limit,
    Canceled,
}
#[derive(Debug)]
pub struct DecodeError {
    pub kind: ErrorKind,
    pub message: String,
}
impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for DecodeError {}
type Result<T> = std::result::Result<T, DecodeError>;
type Cancel<'a> = &'a (dyn Fn() -> bool + Sync);
fn error(kind: ErrorKind, message: impl Into<String>) -> DecodeError {
    DecodeError {
        kind,
        message: message.into(),
    }
}
fn invalid(e: impl fmt::Display) -> DecodeError {
    error(ErrorKind::Invalid, e.to_string())
}
fn check(canceled: Cancel<'_>) -> Result<()> {
    if canceled() {
        Err(error(ErrorKind::Canceled, "canceled"))
    } else {
        Ok(())
    }
}
fn dimensions(width: u32, height: u32) -> Result<()> {
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(error(ErrorKind::Limit, "input pixel limit exceeded"));
    }
    Ok(())
}
fn metadata(bytes: &[u8]) -> Result<()> {
    if bytes.len() > MAX_METADATA_BYTES {
        return Err(error(ErrorKind::Limit, "metadata byte limit exceeded"));
    }
    Ok(())
}

/// Checks input/pixel bounds; cancellation is cooperative between codec stages,
/// per color-transform row, and before/after orientation. JPEG/WebP decode calls
/// are not hard-preemptible. The HTTP caller must retain its permit until return.
pub fn decode(input: &[u8], canceled: Cancel<'_>) -> Result<Decoded> {
    check(canceled)?;
    if input.len() > MAX_INPUT_BYTES {
        return Err(error(ErrorKind::Limit, "input byte limit exceeded"));
    }
    match image::guess_format(input).map_err(invalid)? {
        ImageFormat::Png => decode_png(input, canceled),
        ImageFormat::Jpeg => decode_image(input, ImageFormat::Jpeg, canceled),
        ImageFormat::WebP => decode_image(input, ImageFormat::WebP, canceled),
        ImageFormat::Avif => {
            #[cfg(feature = "avif")]
            {
                avif::decode_avif(input, canceled)
            }
            #[cfg(not(feature = "avif"))]
            {
                Err(error(
                    ErrorKind::Unsupported,
                    "AVIF requires the optional pure-Rust avif feature",
                ))
            }
        }
        _ => Err(error(ErrorKind::Unsupported, "unsupported input format")),
    }
}

fn orientation(exif: Option<&[u8]>) -> Result<Orientation> {
    if let Some(exif) = exif {
        metadata(exif)?;
    }
    Ok(exif
        .and_then(Orientation::from_exif_chunk)
        .unwrap_or(Orientation::NoTransforms))
}

fn finish(
    mut frame: Frame,
    format: Format,
    transform: Orientation,
    color_handling: ColorHandling,
    canceled: Cancel<'_>,
) -> Result<Decoded> {
    check(canceled)?;
    if transform != Orientation::NoTransforms {
        let mut image = match frame.layout {
            PixelLayout::Rgb8 => DynamicImage::ImageRgb8(
                image::RgbImage::from_raw(frame.width, frame.height, frame.pixels)
                    .ok_or_else(|| invalid("invalid RGB layout"))?,
            ),
            PixelLayout::Rgba8 => DynamicImage::ImageRgba8(
                image::RgbaImage::from_raw(frame.width, frame.height, frame.pixels)
                    .ok_or_else(|| invalid("invalid RGBA layout"))?,
            ),
        };
        image.apply_orientation(transform);
        frame.width = image.width();
        frame.height = image.height();
        frame.pixels = image.into_bytes();
    }
    check(canceled)?;
    Ok(Decoded {
        frame,
        info: DecodeInfo {
            format,
            orientation_applied: transform != Orientation::NoTransforms,
            color_handling,
        },
    })
}

// image's JPEG adapter converts CMYK to RGB before exposing ICC. Reject such
// sources until a raw-CMYK decoder/profile path is implemented and qualified.
fn inspect_jpeg(input: &[u8], canceled: Cancel<'_>) -> Result<bool> {
    let mut offset = 2;
    let mut icc_bytes = 0usize;
    let mut has_icc = false;
    while offset < input.len() {
        check(canceled)?;
        if input[offset] != 0xff {
            return Err(invalid("invalid JPEG marker"));
        }
        while offset < input.len() && input[offset] == 0xff {
            offset += 1;
        }
        let marker = *input
            .get(offset)
            .ok_or_else(|| invalid("truncated JPEG marker"))?;
        offset += 1;
        if matches!(marker, 0xda | 0xd9) {
            break;
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        let size = input
            .get(offset..offset + 2)
            .ok_or_else(|| invalid("truncated JPEG segment"))?;
        let length = u16::from_be_bytes(size.try_into().unwrap()) as usize;
        let end = offset
            .checked_add(length)
            .filter(|end| length >= 2 && *end <= input.len())
            .ok_or_else(|| invalid("invalid JPEG segment length"))?;
        let payload = &input[offset + 2..end];
        if marker == 0xe2 && payload.starts_with(b"ICC_PROFILE\0") {
            has_icc = true;
            icc_bytes = icc_bytes
                .checked_add(payload.len())
                .ok_or_else(|| invalid("ICC size overflow"))?;
            if icc_bytes > MAX_METADATA_BYTES {
                return Err(error(ErrorKind::Limit, "metadata byte limit exceeded"));
            }
        }
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
            if *input
                .get(offset + 7)
                .filter(|_| offset + 7 < end)
                .ok_or_else(|| invalid("truncated JPEG frame"))?
                == 4
            {
                return Err(error(
                    ErrorKind::Unsupported,
                    "CMYK/YCCK JPEG needs a raw-color decoder path",
                ));
            }
        }
        offset = end;
    }
    Ok(has_icc)
}

fn inspect_webp(input: &[u8], canceled: Cancel<'_>) -> Result<bool> {
    let size = input
        .get(4..8)
        .ok_or_else(|| invalid("truncated WebP RIFF header"))?;
    let end = (u32::from_le_bytes(size.try_into().unwrap()) as usize)
        .checked_add(8)
        .filter(|end| *end <= input.len() && *end >= 12)
        .ok_or_else(|| invalid("invalid WebP RIFF size"))?;
    let mut offset = 12usize;
    let mut has_icc = false;
    while offset < end {
        check(canceled)?;
        let header = input
            .get(offset..offset + 8)
            .filter(|_| offset + 8 <= end)
            .ok_or_else(|| invalid("truncated WebP chunk"))?;
        let length = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
        let next = offset
            .checked_add(8)
            .and_then(|x| x.checked_add(length))
            .and_then(|x| x.checked_add(length & 1))
            .filter(|x| *x <= end)
            .ok_or_else(|| invalid("invalid WebP chunk length"))?;
        if matches!(&header[..4], b"ICCP" | b"EXIF") && length > MAX_METADATA_BYTES {
            return Err(error(ErrorKind::Limit, "metadata byte limit exceeded"));
        }
        if &header[..4] == b"ICCP" {
            if has_icc {
                return Err(invalid("duplicate WebP ICC profile"));
            }
            has_icc = true;
        }
        offset = next;
    }
    Ok(has_icc)
}

fn decode_image(input: &[u8], format: ImageFormat, canceled: Cancel<'_>) -> Result<Decoded> {
    let expects_icc = if format == ImageFormat::Jpeg {
        inspect_jpeg(input, canceled)?
    } else {
        inspect_webp(input, canceled)?
    };
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_PIXELS as u32);
    limits.max_image_height = Some(MAX_PIXELS as u32);
    limits.max_alloc = Some(512 * 1024 * 1024);
    let mut decoder: Box<dyn ImageDecoder> = match format {
        ImageFormat::Jpeg => {
            Box::new(image::codecs::jpeg::JpegDecoder::new(Cursor::new(input)).map_err(invalid)?)
        }
        ImageFormat::WebP => {
            let decoder =
                image::codecs::webp::WebPDecoder::new(Cursor::new(input)).map_err(invalid)?;
            if decoder.has_animation() {
                return Err(error(
                    ErrorKind::Unsupported,
                    "animated WebP frame selection is not qualified",
                ));
            }
            Box::new(decoder)
        }
        _ => unreachable!(),
    };
    decoder.set_limits(limits).map_err(invalid)?;
    let (width, height) = decoder.dimensions();
    dimensions(width, height)?;
    let channels = match decoder.color_type() {
        ColorType::L8 => 1,
        ColorType::La8 => 2,
        ColorType::Rgb8 => 3,
        ColorType::Rgba8 => 4,
        _ => {
            return Err(error(
                ErrorKind::Unsupported,
                "unsupported decoded sample type",
            ))
        }
    };
    let icc = decoder.icc_profile().map_err(invalid)?;
    if expects_icc && icc.is_none() {
        return Err(invalid("embedded ICC profile could not be assembled"));
    }
    if let Some(icc) = &icc {
        metadata(icc)?;
    }
    let exif = decoder.exif_metadata().map_err(invalid)?;
    let transform = orientation(exif.as_deref())?;
    check(canceled)?;
    let bytes = usize::try_from(decoder.total_bytes()).map_err(invalid)?;
    if bytes != width as usize * height as usize * channels {
        return Err(invalid("unexpected decoded layout"));
    }
    let mut pixels = vec![0; bytes];
    decoder.read_image(&mut pixels).map_err(invalid)?;
    check(canceled)?;
    let (frame, color) = normalize8(
        pixels,
        width,
        height,
        channels,
        icc.as_deref(),
        false,
        canceled,
    )?;
    finish(
        frame,
        if format == ImageFormat::Jpeg {
            Format::Jpeg
        } else {
            Format::WebP
        },
        transform,
        color,
        canceled,
    )
}

fn decode_png(input: &[u8], canceled: Cancel<'_>) -> Result<Decoded> {
    // The PNG library may discard an ancillary chunk with a bad CRC. A discarded
    // ICC/EXIF chunk would silently change color/orientation, so validate all CRCs.
    let mut offset = 8usize;
    let mut idat_seen = false;
    let mut has_icc = false;
    loop {
        check(canceled)?;
        let header = input
            .get(offset..offset + 8)
            .ok_or_else(|| invalid("truncated PNG chunk"))?;
        let length = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
        let end = offset
            .checked_add(12)
            .and_then(|n| n.checked_add(length))
            .filter(|n| *n <= input.len())
            .ok_or_else(|| invalid("truncated PNG chunk"))?;
        let expected = u32::from_be_bytes(input[end - 4..end].try_into().unwrap());
        if crc32fast::hash(&input[offset + 4..end - 4]) != expected {
            return Err(invalid("PNG chunk checksum mismatch"));
        }
        if &header[4..8] == b"IEND" {
            if length != 0 {
                return Err(invalid("invalid PNG IEND"));
            }
            break;
        }
        if idat_seen && matches!(&header[4..8], b"iCCP" | b"gAMA" | b"cHRM" | b"sRGB") {
            return Err(invalid("PNG color metadata follows IDAT"));
        }
        if &header[4..8] == b"iCCP" {
            if has_icc {
                return Err(invalid("duplicate PNG ICC profile"));
            }
            has_icc = true;
        }
        if &header[4..8] == b"IDAT" {
            idat_seen = true;
        }
        if matches!(&header[4..8], b"cICP" | b"mDCV" | b"cLLI") {
            return Err(error(
                ErrorKind::Unsupported,
                "PNG CICP/HDR color metadata is not qualified",
            ));
        }
        if matches!(&header[4..8], b"acTL" | b"fcTL" | b"fdAT") {
            return Err(error(
                ErrorKind::Unsupported,
                "APNG frame selection is not qualified",
            ));
        }
        offset = end;
    }
    let mut decoder = png::Decoder::new_with_limits(
        Cursor::new(input),
        png::Limits {
            bytes: PNG_SCRATCH_BYTES,
        },
    );
    // png defaults to ignoring zlib Adler-32. Require both inner and outer checksums.
    decoder.ignore_checksums(false);
    decoder.set_ignore_text_chunk(true);
    decoder.set_transformations(png::Transformations::EXPAND);
    let header = decoder.read_header_info().map_err(invalid)?;
    dimensions(header.width, header.height)?;
    let mut reader = decoder.read_info().map_err(invalid)?;
    if reader.info().animation_control.is_some() {
        return Err(error(
            ErrorKind::Unsupported,
            "APNG frame selection is not qualified",
        ));
    }
    let mut pixels = vec![
        0;
        reader
            .output_buffer_size()
            .ok_or_else(|| invalid("PNG output size unavailable"))?
    ];
    check(canceled)?;
    let output = reader.next_frame(&mut pixels).map_err(invalid)?;
    pixels.truncate(output.buffer_size());
    reader.finish().map_err(invalid)?; // Also inspect metadata following IDAT.
    check(canceled)?;
    let info = reader.info();
    if has_icc && info.icc_profile.is_none() {
        return Err(invalid("embedded PNG ICC profile could not be decoded"));
    }
    if info.coding_independent_code_points.is_some()
        || info.mastering_display_color_volume.is_some()
        || info.content_light_level.is_some()
    {
        return Err(error(
            ErrorKind::Unsupported,
            "PNG CICP/HDR color metadata is not qualified",
        ));
    }
    if info.icc_profile.is_none() && info.srgb.is_none() {
        if info
            .gama_chunk
            .or(info.source_gamma)
            .is_some_and(|g| g.into_scaled() != 45455)
        {
            return Err(error(
                ErrorKind::Unsupported,
                "PNG non-sRGB gamma needs a color transform",
            ));
        }
        if info
            .chrm_chunk
            .or(info.source_chromaticities)
            .is_some_and(|c| {
                c.to_be_bytes()
                    != [31270u32, 32900, 64000, 33000, 30000, 60000, 15000, 6000]
                        .into_iter()
                        .flat_map(u32::to_be_bytes)
                        .collect::<Vec<_>>()
                        .as_slice()
            })
        {
            return Err(error(
                ErrorKind::Unsupported,
                "PNG non-sRGB primaries need a color transform",
            ));
        }
    }
    let transform = orientation(info.exif_metadata.as_deref())?;
    let channels = match output.color_type {
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        _ => return Err(invalid("PNG palette was not expanded")),
    };
    let (frame, color) = if output.bit_depth == png::BitDepth::Sixteen {
        let words = pixels
            .chunks_exact(2)
            .map(|p| u16::from_be_bytes([p[0], p[1]]))
            .collect();
        drop(pixels);
        normalize16(
            words,
            output.width,
            output.height,
            channels,
            info.icc_profile.as_deref(),
            info.srgb.is_some(),
            canceled,
        )?
    } else {
        normalize8(
            pixels,
            output.width,
            output.height,
            channels,
            info.icc_profile.as_deref(),
            info.srgb.is_some(),
            canceled,
        )?
    };
    finish(frame, Format::Png, transform, color, canceled)
}

fn profile(icc: Option<&[u8]>, channels: usize) -> Result<Option<ColorProfile>> {
    let Some(icc) = icc else {
        return Ok(None);
    };
    metadata(icc)?;
    let profile = ColorProfile::new_from_slice(icc).map_err(invalid)?;
    let matches = if channels <= 2 {
        profile.color_space == DataColorSpace::Gray
    } else {
        profile.color_space == DataColorSpace::Rgb
    };
    if !matches {
        return Err(error(
            ErrorKind::Unsupported,
            "ICC color space does not match decoded samples",
        ));
    }
    Ok(Some(profile))
}
fn source_layout(channels: usize) -> Layout {
    match channels {
        1 => Layout::Gray,
        2 => Layout::GrayAlpha,
        3 => Layout::Rgb,
        4 => Layout::Rgba,
        _ => unreachable!(),
    }
}
fn color_handling(icc: bool, tagged: bool) -> ColorHandling {
    if icc {
        ColorHandling::IccToSrgb
    } else if tagged {
        ColorHandling::TaggedSrgb
    } else {
        ColorHandling::AssumedSrgb
    }
}

fn normalize8(
    input: Vec<u8>,
    width: u32,
    height: u32,
    channels: usize,
    icc: Option<&[u8]>,
    tagged: bool,
    canceled: Cancel<'_>,
) -> Result<(Frame, ColorHandling)> {
    let source = profile(icc, channels)?;
    let alpha = channels == 2 || channels == 4;
    let layout = if alpha {
        PixelLayout::Rgba8
    } else {
        PixelLayout::Rgb8
    };
    let count = width as usize * height as usize;
    if input.len() != count * channels {
        return Err(invalid("invalid raw sample layout"));
    }
    if source.is_none() && channels >= 3 {
        check(canceled)?;
        return Ok((
            Frame {
                width,
                height,
                layout,
                pixels: input,
            },
            color_handling(false, tagged),
        ));
    }
    let mut rgb = vec![0; count * 3];
    if let Some(profile) = &source {
        let transform = profile
            .create_transform_8bit(
                source_layout(channels),
                &ColorProfile::new_srgb(),
                Layout::Rgb,
                TransformOptions::default(),
            )
            .map_err(invalid)?;
        for (src, dst) in input
            .chunks_exact(width as usize * channels)
            .zip(rgb.chunks_exact_mut(width as usize * 3))
        {
            check(canceled)?;
            transform.transform(src, dst).map_err(invalid)?;
        }
    } else {
        for (i, (src, dst)) in input
            .chunks_exact(channels)
            .zip(rgb.chunks_exact_mut(3))
            .enumerate()
        {
            if i % width as usize == 0 {
                check(canceled)?;
            }
            if channels <= 2 {
                dst.fill(src[0]);
            } else {
                dst.copy_from_slice(&src[..3]);
            }
        }
    }
    let pixels = if alpha {
        let mut rgba = Vec::with_capacity(count * 4);
        for (src, color) in input.chunks_exact(channels).zip(rgb.chunks_exact(3)) {
            rgba.extend_from_slice(color);
            rgba.push(src[channels - 1]);
        }
        rgba
    } else {
        rgb
    };
    Ok((
        Frame {
            width,
            height,
            layout,
            pixels,
        },
        color_handling(source.is_some(), tagged),
    ))
}

fn normalize16(
    input: Vec<u16>,
    width: u32,
    height: u32,
    channels: usize,
    icc: Option<&[u8]>,
    tagged: bool,
    canceled: Cancel<'_>,
) -> Result<(Frame, ColorHandling)> {
    let source = profile(icc, channels)?;
    let alpha = channels == 2 || channels == 4;
    let count = width as usize * height as usize;
    if input.len() != count * channels {
        return Err(invalid("invalid raw sample layout"));
    }
    let mut rgb = vec![0u16; count * 3];
    if let Some(profile) = &source {
        let transform = profile
            .create_transform_16bit(
                source_layout(channels),
                &ColorProfile::new_srgb(),
                Layout::Rgb,
                TransformOptions::default(),
            )
            .map_err(invalid)?;
        for (src, dst) in input
            .chunks_exact(width as usize * channels)
            .zip(rgb.chunks_exact_mut(width as usize * 3))
        {
            check(canceled)?;
            transform.transform(src, dst).map_err(invalid)?;
        }
    } else {
        for (i, (src, dst)) in input
            .chunks_exact(channels)
            .zip(rgb.chunks_exact_mut(3))
            .enumerate()
        {
            if i % width as usize == 0 {
                check(canceled)?;
            }
            if channels <= 2 {
                dst.fill(src[0]);
            } else {
                dst.copy_from_slice(&src[..3]);
            }
        }
    }
    let byte = |v: u16| ((u32::from(v) * 255 + 32767) / 65535) as u8;
    let mut pixels = Vec::with_capacity(count * if alpha { 4 } else { 3 });
    for (src, color) in input.chunks_exact(channels).zip(rgb.chunks_exact(3)) {
        pixels.extend(color.iter().copied().map(byte));
        if alpha {
            pixels.push(byte(src[channels - 1]));
        }
    }
    Ok((
        Frame {
            width,
            height,
            layout: if alpha {
                PixelLayout::Rgba8
            } else {
                PixelLayout::Rgb8
            },
            pixels,
        },
        color_handling(source.is_some(), tagged),
    ))
}

#[cfg(feature = "avif")]
mod avif;

#[cfg(test)]
mod tests;
