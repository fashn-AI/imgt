// Benchmark-only process. AVIF/ICC and production lifecycle are not implemented.
use std::{error::Error, fs, io::{self, BufRead}, time::Instant};
use image::{DynamicImage, ImageDecoder, ImageReader};
use fast_image_resize::{Resizer, ResizeOptions};
use serde_json::json;

fn transform(line: &str) -> Result<serde_json::Value, Box<dyn Error>> {
    let f: Vec<_> = line.split('\t').collect();
    if f.len() != 5 { return Err("invalid protocol".into()); }
    let width: u32 = f[1].parse()?;
    let quality: f32 = f[2].parse()?;
    let effort: i32 = f[3].parse()?;
    let started = Instant::now();
    let bytes = fs::read(f[0])?;
    if bytes.len() > 26214400 { return Err("input limit".into()); }
    let read_ms = started.elapsed().as_secs_f64()*1000.0;
    let mut decoder = ImageReader::new(io::Cursor::new(bytes)).with_guessed_format()?.into_decoder()?;
    let (w,h) = decoder.dimensions();
    if u64::from(w)*u64::from(h) > 50_000_000 { return Err("pixel limit".into()); }
    let orientation = decoder.orientation()?;
    let mut decoded = DynamicImage::from_decoder(decoder)?;
    decoded.apply_orientation(orientation);
    let decode_ms = started.elapsed().as_secs_f64()*1000.0-read_ms;
    let w = width.min(decoded.width());
    let h = ((decoded.height() as f64 * w as f64 / decoded.width() as f64).round() as u32).max(1);
    let rgba = decoded.color().has_alpha();
    let source = if rgba { DynamicImage::ImageRgba8(decoded.to_rgba8()) } else { DynamicImage::ImageRgb8(decoded.to_rgb8()) };
    let mut output = if rgba { DynamicImage::new_rgba8(w,h) } else { DynamicImage::new_rgb8(w,h) };
    Resizer::new().resize(&source, &mut output, &ResizeOptions::new())?;
    let resize_ms = started.elapsed().as_secs_f64()*1000.0-read_ms-decode_ms;
    let mut config = webp::WebPConfig::new().map_err(|_| "WebP config")?;
    config.quality = quality; config.method = effort;
    let encoder = if rgba { webp::Encoder::from_rgba(output.as_bytes(),w,h) } else { webp::Encoder::from_rgb(output.as_bytes(),w,h) };
    let encoded = encoder.encode_advanced(&config).map_err(|e| format!("WebP: {e:?}"))?;
    let ms = started.elapsed().as_secs_f64()*1000.0;
    fs::write(f[4], &*encoded)?;
    Ok(json!({"ok":true,"ms":ms,"readMs":read_ms,"decodeMs":decode_ms,"resizeMs":resize_ms,"encodeMs":ms-read_ms-decode_ms-resize_ms,"bytes":encoded.len()}))
}
fn main() {
    println!("{}",json!({"ready":true,"image":"0.25.10","fast_image_resize":"6.1.0","webp":"0.3.1"}));
    for line in io::stdin().lock().lines() {
        match transform(&line.unwrap()) {
            Ok(v) => println!("{v}"),
            Err(e) => println!("{}",json!({"ok":false,"error":e.to_string()})),
        }
    }
}
