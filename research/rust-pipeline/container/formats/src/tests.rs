use super::*;
use image::ImageEncoder;
use std::sync::atomic::{AtomicUsize, Ordering};

fn exif(value: u8) -> Vec<u8> {
    vec![
        b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, value, 0, 0, 0, 0, 0, 0, 0,
    ]
}
fn png_image(info: png::Info<'static>, data: &[u8], late_exif: Option<&[u8]>) -> Vec<u8> {
    let mut output = vec![];
    {
        let encoder = png::Encoder::with_info(&mut output, info).unwrap();
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(data).unwrap();
        if let Some(exif) = late_exif {
            writer.write_chunk(png::chunk::eXIf, exif).unwrap();
        }
        writer.finish().unwrap();
    }
    output
}
fn rgb_info(width: u32, height: u32) -> png::Info<'static> {
    let mut info = png::Info::with_size(width, height);
    info.color_type = png::ColorType::Rgb;
    info.bit_depth = png::BitDepth::Eight;
    info
}
fn read(input: &[u8]) -> Decoded {
    decode(input, &|| false).unwrap()
}

#[test]
fn rgb_png_preserves_pixels() {
    let bytes = [4, 9, 21, 200, 140, 62];
    let result = read(&png_image(rgb_info(2, 1), &bytes, None));
    assert_eq!(result.frame.layout, PixelLayout::Rgb8);
    assert_eq!(result.frame.pixels, bytes);
    assert_eq!(result.info.color_handling, ColorHandling::AssumedSrgb);
}
#[test]
fn palette_one_bit_and_transparency_expand() {
    let mut info = png::Info::with_size(2, 1);
    info.color_type = png::ColorType::Indexed;
    info.bit_depth = png::BitDepth::One;
    info.palette = Some(vec![255, 0, 0, 0, 255, 0].into());
    info.trns = Some(vec![0, 128].into());
    let result = read(&png_image(info, &[0x40], None));
    assert_eq!(result.frame.layout, PixelLayout::Rgba8);
    assert_eq!(result.frame.pixels, [255, 0, 0, 0, 0, 255, 0, 128]);
}
#[test]
fn grayscale_sixteen_bit_alpha_normalizes() {
    let mut info = png::Info::with_size(2, 1);
    info.color_type = png::ColorType::GrayscaleAlpha;
    info.bit_depth = png::BitDepth::Sixteen;
    let result = read(&png_image(
        info,
        &[0, 0, 0x12, 0x34, 255, 255, 255, 255],
        None,
    ));
    assert_eq!(result.frame.layout, PixelLayout::Rgba8);
    assert_eq!(result.frame.pixels, [0, 0, 0, 18, 255, 255, 255, 255]);
}
#[test]
fn every_exif_orientation_including_late_metadata() {
    let source: Vec<u8> = [10u8, 20, 30, 40, 50, 60]
        .into_iter()
        .flat_map(|x| [x, x, x])
        .collect();
    let cases = [
        (1, 2, 3, vec![10, 20, 30, 40, 50, 60]),
        (2, 2, 3, vec![20, 10, 40, 30, 60, 50]),
        (3, 2, 3, vec![60, 50, 40, 30, 20, 10]),
        (4, 2, 3, vec![50, 60, 30, 40, 10, 20]),
        (5, 3, 2, vec![10, 30, 50, 20, 40, 60]),
        (6, 3, 2, vec![50, 30, 10, 60, 40, 20]),
        (7, 3, 2, vec![60, 40, 20, 50, 30, 10]),
        (8, 3, 2, vec![20, 40, 60, 10, 30, 50]),
    ];
    for (orientation, width, height, expected) in cases {
        let result = read(&png_image(
            rgb_info(2, 3),
            &source,
            Some(&exif(orientation)),
        ));
        assert_eq!((result.frame.width, result.frame.height), (width, height));
        assert_eq!(
            result
                .frame
                .pixels
                .chunks_exact(3)
                .map(|p| p[0])
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(result.info.orientation_applied, orientation != 1);
    }
}
#[test]
fn jpeg_exif_orientation_is_applied() {
    let mut output = vec![];
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 100);
    encoder.set_exif_metadata(exif(6)).unwrap();
    encoder
        .write_image(&[100; 18], 2, 3, image::ExtendedColorType::Rgb8)
        .unwrap();
    let result = read(&output);
    assert_eq!(result.info.format, Format::Jpeg);
    assert_eq!((result.frame.width, result.frame.height), (3, 2));
    assert!(result.info.orientation_applied);
}
#[test]
fn webp_lossless_alpha_icc_and_orientation() {
    let mut output = vec![];
    let mut encoder = image::codecs::webp::WebPEncoder::new_lossless(&mut output);
    encoder
        .set_icc_profile(ColorProfile::new_srgb().encode().unwrap())
        .unwrap();
    encoder.set_exif_metadata(exif(6)).unwrap();
    let source = [
        10, 20, 30, 0, 40, 50, 60, 64, 70, 80, 90, 128, 100, 110, 120, 192, 130, 140, 150, 254,
        160, 170, 180, 255,
    ];
    encoder
        .write_image(&source, 2, 3, image::ExtendedColorType::Rgba8)
        .unwrap();
    let result = read(&output);
    assert_eq!(result.frame.layout, PixelLayout::Rgba8);
    assert_eq!((result.frame.width, result.frame.height), (3, 2));
    assert_eq!(result.info.color_handling, ColorHandling::IccToSrgb);
    assert_eq!(
        result
            .frame
            .pixels
            .chunks_exact(4)
            .map(|p| p[3])
            .collect::<Vec<_>>(),
        [254, 128, 0, 255, 192, 64]
    );
    // WebP may discard RGB below alpha zero; alpha itself must remain exact.
}
#[test]
fn icc_is_converted_and_invalid_profiles_fail() {
    let mut info = rgb_info(1, 1);
    info.icc_profile = Some(ColorProfile::new_display_p3().encode().unwrap().into());
    let result = read(&png_image(info, &[200, 100, 50], None));
    assert_eq!(result.info.color_handling, ColorHandling::IccToSrgb);
    assert_ne!(result.frame.pixels, [200, 100, 50]);
    let mut info = rgb_info(1, 1);
    info.icc_profile = Some(vec![1, 2, 3].into());
    assert_eq!(
        decode(&png_image(info, &[1, 2, 3], None), &|| false)
            .unwrap_err()
            .kind,
        ErrorKind::Invalid
    );
}

#[test]
fn broken_jpeg_icc_sequence_does_not_silently_drop_profile() {
    let mut output = vec![];
    let mut encoder = image::codecs::jpeg::JpegEncoder::new(&mut output);
    encoder
        .set_icc_profile(ColorProfile::new_srgb().encode().unwrap())
        .unwrap();
    encoder
        .write_image(&[80; 18], 2, 3, image::ExtendedColorType::Rgb8)
        .unwrap();
    let offset = output
        .windows(12)
        .position(|b| b == b"ICC_PROFILE\0")
        .unwrap();
    output[offset + 12] = 0;
    assert_eq!(
        decode(&output, &|| false).unwrap_err().kind,
        ErrorKind::Invalid
    );
}
#[test]
fn non_srgb_gamma_does_not_silently_become_srgb() {
    let mut info = rgb_info(1, 1);
    info.source_gamma = Some(png::ScaledFloat::new(1.0));
    assert_eq!(
        decode(&png_image(info, &[100, 100, 100], None), &|| false)
            .unwrap_err()
            .kind,
        ErrorKind::Unsupported
    );
}
#[test]
fn input_and_pixel_limits_are_checked_before_decode() {
    assert_eq!(
        decode(&vec![0; MAX_INPUT_BYTES + 1], &|| false)
            .unwrap_err()
            .kind,
        ErrorKind::Limit
    );
    let mut output = vec![];
    {
        let _writer = png::Encoder::with_info(&mut output, rgb_info(10_000, 10_000))
            .unwrap()
            .write_header()
            .unwrap();
    }
    assert_eq!(
        decode(&output, &|| false).unwrap_err().kind,
        ErrorKind::Limit
    );
}
#[test]
fn cancellation_is_reported_before_and_between_stages() {
    assert_eq!(decode(&[], &|| true).unwrap_err().kind, ErrorKind::Canceled);
    let output = png_image(rgb_info(1, 1), &[0, 0, 0], None);
    let calls = AtomicUsize::new(0);
    assert_eq!(
        decode(&output, &|| calls.fetch_add(1, Ordering::Relaxed) > 0)
            .unwrap_err()
            .kind,
        ErrorKind::Canceled
    );
}
#[test]
fn crc_failure_and_missing_end_are_not_accepted() {
    let mut output = png_image(rgb_info(1, 1), &[1, 2, 3], Some(&exif(6)));
    let pos = output.windows(4).position(|x| x == b"eXIf").unwrap();
    output[pos + 5] ^= 1;
    assert!(decode(&output, &|| false).is_err());
    let mut output = png_image(rgb_info(1, 1), &[1, 2, 3], None);
    output.truncate(output.len() - 12);
    assert!(decode(&output, &|| false).is_err());
}

#[test]
fn valid_chunk_crc_does_not_hide_corrupt_zlib_adler() {
    let mut output = png_image(rgb_info(1, 1), &[1, 2, 3], None);
    let offset = output.windows(4).position(|x| x == b"IDAT").unwrap();
    let length = u32::from_be_bytes(output[offset - 4..offset].try_into().unwrap()) as usize;
    assert!(length >= 6);
    let end = offset + 4 + length;
    // The tiny fixture has one IDAT containing the complete zlib stream.
    // Change Adler-32, then repair the outer chunk's CRC-32 deliberately.
    output[end - 1] ^= 1;
    let crc = crc32fast::hash(&output[offset..end]);
    output[end..end + 4].copy_from_slice(&crc.to_be_bytes());
    assert_eq!(crc32fast::hash(&output[offset..end]), crc);
    assert!(decode(&output, &|| false).is_err());
}
#[test]
fn rgba_png_keeps_straight_alpha_and_hidden_rgb() {
    let mut info = rgb_info(2, 1);
    info.color_type = png::ColorType::Rgba;
    let source = [255, 0, 0, 0, 0, 255, 0, 128];
    let result = read(&png_image(info, &source, None));
    assert_eq!(result.frame.pixels, source);
}

#[cfg(feature = "avif")]
#[test]
fn avif_rgb_and_rgba_decode_with_alpha() {
    let rgb = read(include_bytes!("../tests/fixtures/rgb.avif"));
    assert_eq!(
        (rgb.frame.width, rgb.frame.height, rgb.frame.layout),
        (8, 6, PixelLayout::Rgb8)
    );
    let rgba = read(include_bytes!("../tests/fixtures/rgba.avif"));
    assert_eq!(
        (rgba.frame.width, rgba.frame.height, rgba.frame.layout),
        (8, 6, PixelLayout::Rgba8)
    );
    for (i, pixel) in rgba.frame.pixels.chunks_exact(4).enumerate() {
        assert!((i16::from(pixel[3]) - i16::from([0u8, 64, 128, 255][i % 4])).abs() <= 1);
    }
}

#[cfg(feature = "avif")]
#[test]
fn avif_icc_and_orientation_decode() {
    let decoded = read(include_bytes!("../tests/fixtures/oriented-icc.avif"));
    assert_eq!((decoded.frame.width, decoded.frame.height), (6, 8));
    assert!(decoded.info.orientation_applied);
    assert_eq!(decoded.info.color_handling, ColorHandling::IccToSrgb);
}

#[cfg(feature = "avif")]
#[test]
fn every_avif_container_orientation_matches_standard_mapping() {
    let fixtures: [&[u8]; 8] = [
        include_bytes!("../tests/fixtures/orientation-1.avif"),
        include_bytes!("../tests/fixtures/orientation-2.avif"),
        include_bytes!("../tests/fixtures/orientation-3.avif"),
        include_bytes!("../tests/fixtures/orientation-4.avif"),
        include_bytes!("../tests/fixtures/orientation-5.avif"),
        include_bytes!("../tests/fixtures/orientation-6.avif"),
        include_bytes!("../tests/fixtures/orientation-7.avif"),
        include_bytes!("../tests/fixtures/orientation-8.avif"),
    ];
    let source = read(fixtures[0]).frame;
    for (i, fixture) in fixtures.into_iter().enumerate() {
        let o = i + 1;
        let frame = read(fixture).frame;
        let (w, h) = if o >= 5 { (6, 8) } else { (8, 6) };
        assert_eq!((frame.width, frame.height), (w, h));
        for y in 0..h {
            for x in 0..w {
                let (sx, sy) = match o {
                    1 => (x, y),
                    2 => (7 - x, y),
                    3 => (7 - x, 5 - y),
                    4 => (x, 5 - y),
                    5 => (y, x),
                    6 => (y, 5 - x),
                    7 => (7 - y, 5 - x),
                    8 => (7 - y, x),
                    _ => unreachable!(),
                };
                let a = ((y * w + x) * 3) as usize;
                let b = ((sy * 8 + sx) * 3) as usize;
                for c in 0..3 {
                    assert!(
                        (i16::from(frame.pixels[a + c]) - i16::from(source.pixels[b + c])).abs()
                            <= 2,
                        "orientation {o} mismatch at {x},{y}"
                    );
                }
            }
        }
    }
}

#[test]
fn adam7_and_progressive_jpeg_decode() {
    let png = read(include_bytes!("../tests/fixtures/interlaced.png"));
    assert_eq!((png.frame.width, png.frame.height), (8, 6));
    for y in 0..6 {
        for x in 0..8 {
            let p = ((y * 8 + x) * 3) as usize;
            assert_eq!(
                &png.frame.pixels[p..p + 3],
                &[30 + x as u8 * 25, 20 + y as u8 * 35, 80]
            );
        }
    }
    let jpeg = read(include_bytes!("../tests/fixtures/progressive.jpg"));
    assert_eq!(
        (jpeg.frame.width, jpeg.frame.height, jpeg.frame.layout),
        (8, 6, PixelLayout::Rgb8)
    );
}

#[test]
fn sixteen_bit_gray_profile_converts_before_quantizing() {
    let mut info = png::Info::with_size(2, 1);
    info.color_type = png::ColorType::GrayscaleAlpha;
    info.bit_depth = png::BitDepth::Sixteen;
    info.icc_profile = Some(
        ColorProfile::new_gray_with_gamma(2.2)
            .encode()
            .unwrap()
            .into(),
    );
    let result = read(&png_image(
        info,
        &[0x80, 0, 0x12, 0x34, 0xff, 0xff, 0xff, 0xff],
        None,
    ));
    assert_eq!(result.info.color_handling, ColorHandling::IccToSrgb);
    assert_eq!(result.frame.pixels[3], 18);
    assert_eq!(result.frame.pixels[7], 255);
    assert!(result.frame.pixels[0].abs_diff(result.frame.pixels[1]) <= 1);
}
