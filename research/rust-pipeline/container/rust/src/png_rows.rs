//! Owned, bounded RGB8/RGBA8 PNG row reader. Only DEFLATE is delegated to
//! the pure-Rust fdeflate backend, with a bounded raw-history buffer. PNG framing, validation and filters live here.
use fdeflate::Decompressor;
const HISTORY: usize = 32 * 1024;
const INFLATE_BUFFER: usize = 128 * 1024;

const MAX_INPUT: usize = 100 * 1024 * 1024;
const MAX_PIXELS: u64 = 50_000_000;
const MAX_CHUNKS: usize = 65_536;

pub struct Rows<'a> {
    pub width: u32,
    pub height: u32,
    pub channels: usize,
    chunks: Vec<&'a [u8]>,
    chunk: usize,
    offset: usize,
    inflate: Decompressor,
    // DEFLATE backreferences refer to filtered bytes, so unfilter only copied
    // rows. Keep the most recent32KiB raw bytes when this buffer is recycled.
    raw: Vec<u8>,
    raw_start: usize,
    raw_end: usize,
    ended: bool,
    row: u32,
    current: Vec<u8>,
    previous: Vec<u8>,
}

fn allocate(size: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(size)
        .map_err(|_| "PNG allocation failed")?;
    bytes.resize(size, 0);
    Ok(bytes)
}

fn check(stop: &dyn Fn() -> bool) -> Result<(), String> {
    if stop() {
        Err("canceled".into())
    } else {
        Ok(())
    }
}

impl<'a> Rows<'a> {
    pub fn new(input: &'a [u8], stop: &dyn Fn() -> bool) -> Result<Self, String> {
        if input.len() > MAX_INPUT {
            return Err("PNG byte limit exceeded".into());
        }
        if !input.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err("not a PNG".into());
        }
        let mut dimensions = None;
        let mut chunks = Vec::new();
        let mut position = 8usize;
        let mut seen_idat = false;
        let mut idat_closed = false;
        let mut end_seen = false;
        let mut chunk_count = 0;
        while position < input.len() {
            check(stop)?;
            chunk_count += 1;
            if chunk_count > MAX_CHUNKS {
                return Err("PNG chunk limit exceeded".into());
            }
            let header = input
                .get(position..position + 8)
                .ok_or("truncated PNG chunk")?;
            let size = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
            let end = position
                .checked_add(12)
                .and_then(|n| n.checked_add(size))
                .filter(|n| *n <= input.len())
                .ok_or("truncated PNG chunk")?;
            let kind: &[u8; 4] = header[4..8].try_into().unwrap();
            if !kind.iter().all(u8::is_ascii_alphabetic) || kind[2].is_ascii_lowercase() {
                return Err("invalid PNG chunk name".into());
            }
            let payload = &input[position + 8..end - 4];
            let crc = u32::from_be_bytes(input[end - 4..end].try_into().unwrap());
            if crc32fast::hash(&input[position + 4..end - 4]) != crc {
                return Err("PNG CRC mismatch".into());
            }
            if dimensions.is_none() && kind != b"IHDR" {
                return Err("missing first PNG IHDR".into());
            }
            if seen_idat && kind != b"IDAT" {
                idat_closed = true;
            }
            match kind {
                b"IHDR" => {
                    if dimensions.is_some() || payload.len() != 13 {
                        return Err("invalid PNG IHDR".into());
                    }
                    let width = u32::from_be_bytes(payload[..4].try_into().unwrap());
                    let height = u32::from_be_bytes(payload[4..8].try_into().unwrap());
                    if width == 0
                        || height == 0
                        || u64::from(width) * u64::from(height) > MAX_PIXELS
                    {
                        return Err("PNG pixel limit exceeded".into());
                    }
                    let channels = match payload[9] {
                        2 => 3,
                        6 => 4,
                        _ => return Err("owned PNG rows require RGB8 or RGBA8".into()),
                    };
                    if payload[8] != 8 || payload[10] != 0 || payload[11] != 0 || payload[12] != 0 {
                        return Err(
                            "owned PNG rows require noninterlaced standard 8-bit PNG".into()
                        );
                    }
                    dimensions = Some((width, height, channels));
                }
                b"IDAT" => {
                    if idat_closed {
                        return Err("nonconsecutive PNG IDAT".into());
                    }
                    chunks
                        .try_reserve(1)
                        .map_err(|_| "PNG chunk allocation failed")?;
                    chunks.push(payload);
                    seen_idat = true;
                }
                b"IEND" => {
                    if !seen_idat || !payload.is_empty() {
                        return Err("invalid PNG IEND".into());
                    }
                    end_seen = true;
                    // Match the existing renderer's tolerance for trailing file bytes.
                    break;
                }
                b"iCCP" | b"eXIf" | b"acTL" | b"fcTL" | b"fdAT" | b"tRNS" | b"cICP" | b"mDCV"
                | b"cLLI" => {
                    return Err("PNG metadata requires generic color/orientation path".into())
                }
                b"sRGB" => {
                    if payload.len() != 1 || payload[0] > 3 || seen_idat {
                        return Err("invalid PNG sRGB metadata".into());
                    }
                }
                b"gAMA" => {
                    if payload != 45455u32.to_be_bytes() || seen_idat {
                        return Err("PNG gamma requires generic color path".into());
                    }
                }
                b"cHRM" => {
                    let expected = [31270u32, 32900, 64000, 33000, 30000, 60000, 15000, 6000];
                    if payload.len() != 32
                        || seen_idat
                        || !payload
                            .chunks_exact(4)
                            .zip(expected)
                            .all(|(a, b)| a == b.to_be_bytes())
                    {
                        return Err("PNG chromaticities require generic color path".into());
                    }
                }
                // An optional true-color palette is unused for decoding.
                b"PLTE" => {
                    if payload.is_empty()
                        || payload.len() > 768
                        || payload.len() % 3 != 0
                        || seen_idat
                    {
                        return Err("invalid PNG palette".into());
                    }
                }
                _ if kind[0].is_ascii_uppercase() => {
                    return Err("unknown critical PNG chunk".into())
                }
                // Ancillary text and physical-resolution metadata are not expanded.
                _ => {}
            }
            position = end;
        }
        if !end_seen {
            return Err("missing PNG IEND".into());
        }
        let (width, height, channels) = dimensions.ok_or("missing PNG dimensions")?;
        let stride = (width as usize)
            .checked_mul(channels)
            .and_then(|n| n.checked_add(1))
            .ok_or("PNG stride overflow")?;
        Ok(Self {
            width,
            height,
            channels,
            chunks,
            chunk: 0,
            offset: 0,
            inflate: Decompressor::new(),
            raw: allocate(INFLATE_BUFFER)?,
            raw_start: 0,
            raw_end: 0,
            ended: false,
            row: 0,
            current: allocate(stride)?,
            previous: allocate(stride)?,
        })
    }

    fn step(&mut self, output: &mut [u8]) -> Result<usize, String> {
        while self.raw_start == self.raw_end && !self.inflate.is_done() {
            // Caller consumed every produced byte. Preserve exactly the
            // available backreference history, never synthetic padding.
            let keep = self.raw_end.min(HISTORY);
            self.raw.copy_within(self.raw_end - keep..self.raw_end, 0);
            self.raw_start = keep;
            self.raw_end = keep;
            while self.chunk < self.chunks.len() && self.offset == self.chunks[self.chunk].len() {
                self.chunk += 1;
                self.offset = 0;
            }
            let input = self
                .chunks
                .get(self.chunk)
                .map_or(&[][..], |b| &b[self.offset..]);
            let (read, written) = self
                .inflate
                .read(input, &mut self.raw, keep, self.chunk >= self.chunks.len())
                .map_err(|e| format!("PNG zlib stream: {e:?}"))?;
            self.offset += read;
            self.raw_end += written;
            if read == 0 && written == 0 && !self.inflate.is_done() {
                return Err("truncated or stalled PNG zlib stream".into());
            }
        }
        let count = output.len().min(self.raw_end - self.raw_start);
        output[..count].copy_from_slice(&self.raw[self.raw_start..self.raw_start + count]);
        self.raw_start += count;
        // The inflater may finish while it still owns unread raw rows. Report
        // EOF only after those rows have been consumed by the row reader.
        self.ended = self.inflate.is_done() && self.raw_start == self.raw_end;
        Ok(count)
    }

    fn fill(&mut self, output: &mut [u8], stop: &dyn Fn() -> bool) -> Result<(), String> {
        let mut written = 0;
        while written < output.len() {
            check(stop)?;
            if self.ended {
                return Err("truncated PNG pixel stream".into());
            }
            let count = self.step(&mut output[written..])?;
            written += count;
        }
        Ok(())
    }

    pub fn read_row(&mut self, output: &mut [u8], stop: &dyn Fn() -> bool) -> Result<(), String> {
        check(stop)?;
        if self.row >= self.height || output.len() + 1 != self.current.len() {
            return Err("invalid PNG row request".into());
        }
        let mut current = std::mem::take(&mut self.current);
        self.fill(&mut current, stop)?;
        unfilter(
            current[0],
            &mut current[1..],
            &self.previous[1..],
            self.channels,
        )?;
        output.copy_from_slice(&current[1..]);
        self.current = std::mem::replace(&mut self.previous, current);
        self.row += 1;
        Ok(())
    }

    pub fn finish(&mut self, stop: &dyn Fn() -> bool) -> Result<(), String> {
        if self.row != self.height {
            return Err("incomplete PNG image".into());
        }
        while !self.ended {
            check(stop)?;
            let written = self.step(&mut [0])?;
            if written != 0 {
                return Err("excess PNG pixel data".into());
            }
        }
        if self.inflate.buffered_trailing_bytes() != 0 {
            return Err("excess PNG compressed data".into());
        }
        if self
            .chunks
            .get(self.chunk)
            .is_some_and(|chunk| self.offset < chunk.len())
            || self
                .chunks
                .iter()
                .skip(self.chunk + 1)
                .any(|chunk| !chunk.is_empty())
        {
            return Err("excess PNG compressed data".into());
        }
        Ok(())
    }
}

#[inline]
fn paeth(left: u8, above: u8, upper_left: u8) -> u8 {
    let a = i32::from(left);
    let b = i32::from(above);
    let c = i32::from(upper_left);
    let p = a + b - c;
    let pa = (p - a).abs();
    let pb = (p - b).abs();
    let pc = (p - c).abs();
    if pa <= pb && pa <= pc {
        left
    } else if pb <= pc {
        above
    } else {
        upper_left
    }
}

// Independent channels of one RGB/RGBA pixel share a NEON operation. Pixels
// remain sequential: each pixel needs the fully decoded pixel to its left.
// The predictor distances are bounded by 510, so signed 16-bit arithmetic is
// exact. Equal-distance selection retains PNG's left, above, upper-left order.
#[cfg(all(target_arch = "aarch64", target_endian = "little"))]
#[target_feature(enable = "neon")]
unsafe fn unfilter_paeth_neon(row: &mut [u8], previous: &[u8], channels: usize) {
    use std::arch::aarch64::*;
    let mut left = vdupq_n_s16(0);
    let mut upper_left = vdupq_n_s16(0);
    let mask = vcreate_u8(if channels == 3 {
        0x00ff_ffff
    } else {
        0xffff_ffff
    });
    let mut index = 0usize;
    while index + 4 <= row.len() {
        // Four-byte unaligned loads are in bounds, even for RGB. Its fourth
        // byte is the next pixel's still-filtered R, masked to a zero predictor
        // and written back unchanged. The last RGB pixel is handled below.
        let encoded_word = std::ptr::read_unaligned(row.as_ptr().add(index).cast::<u32>());
        let above_word = std::ptr::read_unaligned(previous.as_ptr().add(index).cast::<u32>());
        let encoded = vcreate_u8(u64::from(encoded_word));
        let above = vreinterpretq_s16_u16(vmovl_u8(vcreate_u8(u64::from(above_word))));
        let pa = vabsq_s16(vsubq_s16(above, upper_left));
        let pb = vabsq_s16(vsubq_s16(left, upper_left));
        let pc = vabsq_s16(vsubq_s16(
            vaddq_s16(left, above),
            vaddq_s16(upper_left, upper_left),
        ));
        let use_left = vandq_u16(vcleq_s16(pa, pb), vcleq_s16(pa, pc));
        let other = vbslq_s16(vcleq_s16(pb, pc), above, upper_left);
        let predictor = vbslq_s16(use_left, left, other);
        let predictor = vand_u8(vmovn_u16(vreinterpretq_u16_s16(predictor)), mask);
        let decoded = vadd_u8(encoded, predictor);
        let word = vget_lane_u32::<0>(vreinterpret_u32_u8(decoded));
        std::ptr::write_unaligned(row.as_mut_ptr().add(index).cast::<u32>(), word);
        left = vreinterpretq_s16_u16(vmovl_u8(decoded));
        upper_left = above;
        index += channels;
    }
    for i in index..row.len() {
        let left = if i >= channels { row[i - channels] } else { 0 };
        let upper_left = if i >= channels {
            previous[i - channels]
        } else {
            0
        };
        row[i] = row[i].wrapping_add(paeth(left, previous[i], upper_left));
    }
}

#[cfg(all(target_arch = "aarch64", target_endian = "little"))]
fn use_paeth_neon() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        // Research A/B override, chosen once per process. The same candidate
        // binary retains the original scalar path without changing the parser.
        std::env::var("RESEARCH_PNG_PAETH").as_deref() != Ok("scalar")
            && std::arch::is_aarch64_feature_detected!("neon")
    })
}

fn unfilter(filter: u8, row: &mut [u8], previous: &[u8], channels: usize) -> Result<(), String> {
    match filter {
        0 => {}
        1 => {
            for i in channels..row.len() {
                row[i] = row[i].wrapping_add(row[i - channels]);
            }
        }
        2 => {
            for (pixel, above) in row.iter_mut().zip(previous) {
                *pixel = pixel.wrapping_add(*above);
            }
        }
        3 => {
            for i in 0..row.len() {
                let left = if i >= channels { row[i - channels] } else { 0 };
                row[i] =
                    row[i].wrapping_add(((u16::from(left) + u16::from(previous[i])) / 2) as u8);
            }
        }
        4 => {
            #[cfg(all(target_arch = "aarch64", target_endian = "little"))]
            if matches!(channels, 3 | 4) && row.len() == previous.len() && use_paeth_neon() {
                // Runtime detection establishes NEON availability. Equal slice
                // lengths and the four-byte loop bound establish every load
                // and store; RGB tails use the original bytewise predictor.
                unsafe { unfilter_paeth_neon(row, previous, channels) };
                return Ok(());
            }
            for i in 0..row.len() {
                let left = if i >= channels { row[i - channels] } else { 0 };
                let upper_left = if i >= channels {
                    previous[i - channels]
                } else {
                    0
                };
                row[i] = row[i].wrapping_add(paeth(left, previous[i], upper_left));
            }
        }
        _ => return Err("invalid PNG filter".into()),
    }
    Ok(())
}

#[cfg(all(test, target_arch = "aarch64", target_endian = "little"))]
mod neon_checks {
    use super::*;

    fn compare(encoded: &[u8], previous: &[u8], channels: usize) {
        let mut expected = encoded.to_vec();
        for i in 0..expected.len() {
            let a = if i >= channels {
                expected[i - channels]
            } else {
                0
            };
            let b = previous[i];
            let c = if i >= channels {
                previous[i - channels]
            } else {
                0
            };
            let p = i32::from(a) + i32::from(b) - i32::from(c);
            let da = (p - i32::from(a)).abs();
            let db = (p - i32::from(b)).abs();
            let dc = (p - i32::from(c)).abs();
            let prediction = if da <= db && da <= dc {
                a
            } else if db <= dc {
                b
            } else {
                c
            };
            expected[i] = expected[i].wrapping_add(prediction);
        }
        let mut actual = encoded.to_vec();
        unsafe { unfilter_paeth_neon(&mut actual, previous, channels) };
        assert_eq!(actual, expected);
    }

    #[test]
    fn paeth_neon_matches_independent_scalar_for_tails_and_first_rows() {
        if !std::arch::is_aarch64_feature_detected!("neon") {
            return;
        }
        let mut seed = 0x12345678u32;
        let mut random = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed as u8
        };
        for channels in [3, 4] {
            for width in (1..=65).chain([1792, 1536, 1696]) {
                let previous: Vec<_> = (0..width * channels).map(|_| random()).collect();
                let encoded: Vec<_> = (0..width * channels).map(|_| random()).collect();
                compare(&encoded, &previous, channels);
                compare(&encoded, &vec![0; previous.len()], channels);
            }
        }
    }

    #[test]
    fn paeth_neon_preserves_predictor_ties_and_extreme_distances() {
        if !std::arch::is_aarch64_feature_detected!("neon") {
            return;
        }
        let values = [0u8, 1, 63, 127, 128, 192, 254, 255];
        for channels in [3, 4] {
            for a in values {
                for b in values {
                    for c in values {
                        // First decoded pixel is a; second predictor sees exactly
                        // left=a, above=b, upper-left=c in every independent lane.
                        let mut previous = vec![c; channels];
                        previous.extend(vec![b; channels]);
                        let mut encoded = vec![a.wrapping_sub(c); channels];
                        encoded.extend(vec![113; channels]);
                        compare(&encoded, &previous, channels);
                    }
                }
            }
        }
    }
}
