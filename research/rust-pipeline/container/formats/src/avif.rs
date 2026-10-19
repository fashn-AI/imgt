use super::*;

struct Stop<'a>(Cancel<'a>);
impl zenavif::Stop for Stop<'_> {
    fn check(&self) -> std::result::Result<(), zenavif::StopReason> {
        if (self.0)() {
            Err(zenavif::StopReason::Cancelled)
        } else {
            Ok(())
        }
    }
}

fn validate(info: &zenavif::ImageInfo) -> Result<()> {
    dimensions(info.width, info.height)?;
    if let Some(icc) = &info.icc_profile {
        metadata(icc)?;
    }
    if let Some(exif) = &info.exif {
        metadata(exif)?;
    }
    if matches!(info.transfer_characteristics.0, 16 | 18)
        || info.gain_map.is_some()
        || info.mastering_display.is_some()
        || info.content_light_level.is_some()
    {
        return Err(error(
            ErrorKind::Unsupported,
            "AVIF HDR/tone mapping is not qualified",
        ));
    }
    if info.clean_aperture.is_some() || info.pixel_aspect_ratio.is_some() {
        return Err(error(
            ErrorKind::Unsupported,
            "AVIF clean aperture/pixel aspect ratio is not qualified",
        ));
    }
    Ok(())
}

pub(super) fn decode_avif(input: &[u8], canceled: Cancel<'_>) -> Result<Decoded> {
    // The high-level decoder does not expose parser-limit setters. A borrowed,
    // bounded preflight validates the same container before its owned parse.
    let limits = zenavif_parse::DecodeConfig::default()
        .with_peak_memory_limit(512 * 1024 * 1024)
        .with_total_megapixels_limit(50)
        .with_max_animation_frames(1);
    let parser = zenavif_parse::AvifParser::from_bytes_with_config(input, &limits, &Stop(canceled))
        .map_err(|e| {
            if canceled() {
                error(ErrorKind::Canceled, "canceled")
            } else if matches!(e, zenavif_parse::Error::ResourceLimitExceeded(_)) {
                error(ErrorKind::Limit, e.to_string())
            } else {
                invalid(e)
            }
        })?;
    if parser.animation_info().is_some() {
        return Err(error(
            ErrorKind::Unsupported,
            "animated AVIF frame selection is not qualified",
        ));
    }
    drop(parser);
    let config = zenavif::DecoderConfig::new()
        .threads(1)
        .frame_size_limit(MAX_PIXELS as u32)
        .prefer_8bit(true);
    check(canceled)?;
    let mut decoder = zenavif::ManagedAvifDecoder::new(input, &config).map_err(invalid)?;
    validate(&decoder.probe_info().map_err(invalid)?)?;
    check(canceled)?;
    let (pixels, info) = decoder.decode_full(&Stop(canceled)).map_err(|e| {
        if canceled() {
            error(ErrorKind::Canceled, "canceled")
        } else {
            invalid(e)
        }
    })?;
    validate(&info)?;
    dimensions(pixels.width(), pixels.height())?;
    if pixels.width() != info.width
        || pixels.height() != info.height
        || !pixels.descriptor().channel_type().is_u8()
    {
        return Err(invalid("unexpected AVIF decoded layout"));
    }
    let channels = if pixels.has_alpha() { 4 } else { 3 };
    if pixels.descriptor().layout().channels() != channels || pixels.is_grayscale() {
        return Err(error(
            ErrorKind::Unsupported,
            "AVIF decoded color layout is not qualified",
        ));
    }
    // AVIF container properties are authoritative. Some writers retain the
    // original EXIF orientation after translating it to irot/imir; applying both
    // would rotate twice. EXIF is a compatibility fallback when neither exists.
    let exif = if info.rotation.is_some() || info.mirror.is_some() {
        Orientation::NoTransforms
    } else {
        orientation(info.exif.as_deref())?
    };
    let mut derived_profile = None;
    let mut color_override = None;
    if info.icc_profile.is_none() {
        let primaries = info.color_primaries.0;
        let transfer = info.transfer_characteristics.0;
        if matches!(primaries, 1 | 2) && matches!(transfer, 2 | 13) {
            color_override = Some(if primaries == 1 && transfer == 13 {
                ColorHandling::TaggedSrgb
            } else {
                ColorHandling::AssumedSrgb
            });
        } else {
            let cp = moxcms::CicpProfile {
                color_primaries: moxcms::CicpColorPrimaries::try_from(if primaries == 2 {
                    1
                } else {
                    primaries
                })
                .map_err(invalid)?,
                transfer_characteristics: moxcms::TransferCharacteristics::try_from(
                    if transfer == 2 { 13 } else { transfer },
                )
                .map_err(invalid)?,
                // The AV1 decoder has already converted YUV range/matrix to RGB.
                matrix_coefficients: moxcms::MatrixCoefficients::Identity,
                full_range: true,
            };
            let mut profile = ColorProfile::new_srgb();
            if !profile.update_rgb_colorimetry_from_cicp(cp) {
                return Err(error(
                    ErrorKind::Unsupported,
                    "unsupported AVIF CICP color transform",
                ));
            }
            derived_profile = Some(profile.encode().map_err(invalid)?);
            color_override = Some(ColorHandling::CicpToSrgb);
        }
    }
    let raw = pixels.copy_to_contiguous_bytes();
    drop(pixels);
    let (frame, mut color) = normalize8(
        raw,
        info.width,
        info.height,
        channels,
        info.icc_profile.as_deref().or(derived_profile.as_deref()),
        false,
        canceled,
    )?;
    if let Some(value) = color_override {
        color = value;
    }
    let rotation = match info.rotation.map(|r| r.angle).unwrap_or(0) {
        0 => Orientation::NoTransforms,
        90 => Orientation::Rotate270,
        180 => Orientation::Rotate180,
        270 => Orientation::Rotate90,
        _ => return Err(invalid("invalid AVIF rotation")),
    };
    let mirror = match info.mirror.map(|m| m.axis) {
        // HEIF 2022: axis0 exchanges top/bottom, axis1 exchanges left/right.
        // zenavif-parse 0.6.2's prose describes these axes in reverse.
        None => Orientation::NoTransforms,
        Some(0) => Orientation::FlipVertical,
        Some(1) => Orientation::FlipHorizontal,
        _ => return Err(invalid("invalid AVIF mirror")),
    };
    let a = finish(frame, Format::Avif, rotation, color, canceled)?;
    let b = finish(a.frame, Format::Avif, mirror, color, canceled)?;
    let mut result = finish(b.frame, Format::Avif, exif, color, canceled)?;
    result.info.orientation_applied |= a.info.orientation_applied || b.info.orientation_applied;
    Ok(result)
}
