//! Owned RGB convolution kernel. Input weights are a normalized Q14 Lanczos
//! span with sum(abs(weights)) <= 65536. This bounds every i32 lane/sum for u8
//! pixels. SIMD is Rust intrinsics; no C implementation or external assembler.
const NORMALIZE: f32 = 1.0 / 16384.0;

#[inline]
pub fn rgb_dot(pixels: &[u8], weights: &[i16]) -> [f32; 3] {
    assert_eq!(pixels.len(), weights.len() * 3);
    debug_assert!(weights.iter().map(|v| i64::from(*v).abs()).sum::<i64>() <= 65536);
    #[cfg(target_arch = "aarch64")]
    {
        // Advanced SIMD is available on the supported AArch64 Linux/macOS
        // targets. Every vector load is guarded by eight complete RGB taps.
        return unsafe { neon_dot(pixels, weights) };
    }
    #[cfg(not(target_arch = "aarch64"))]
    scalar_dot(pixels, weights)
}

#[inline]
#[allow(dead_code)]
fn scalar_dot(pixels: &[u8], weights: &[i16]) -> [f32; 3] {
    let mut result = [0i32; 3];
    for (pixel, weight) in pixels.chunks_exact(3).zip(weights) {
        let weight = i32::from(*weight);
        result[0] += i32::from(pixel[0]) * weight;
        result[1] += i32::from(pixel[1]) * weight;
        result[2] += i32::from(pixel[2]) * weight;
    }
    result.map(|value| value as f32 * NORMALIZE)
}

#[cfg(target_arch = "aarch64")]
#[target_feature(enable = "neon")]
unsafe fn neon_dot(pixels: &[u8], weights: &[i16]) -> [f32; 3] {
    use std::arch::aarch64::*;
    let mut red = vdupq_n_s32(0);
    let mut green = vdupq_n_s32(0);
    let mut blue = vdupq_n_s32(0);
    let mut at = 0;
    while at + 8 <= weights.len() {
        // Caller length equality and this loop condition prove all 24 source
        // bytes and eight i16 coefficients belong to their borrowed slices.
        let channels = vld3_u8(pixels.as_ptr().add(at * 3));
        let w = vld1q_s16(weights.as_ptr().add(at));
        let r = vreinterpretq_s16_u16(vmovl_u8(channels.0));
        let g = vreinterpretq_s16_u16(vmovl_u8(channels.1));
        let b = vreinterpretq_s16_u16(vmovl_u8(channels.2));
        red = vmlal_s16(red, vget_low_s16(r), vget_low_s16(w));
        red = vmlal_s16(red, vget_high_s16(r), vget_high_s16(w));
        green = vmlal_s16(green, vget_low_s16(g), vget_low_s16(w));
        green = vmlal_s16(green, vget_high_s16(g), vget_high_s16(w));
        blue = vmlal_s16(blue, vget_low_s16(b), vget_low_s16(w));
        blue = vmlal_s16(blue, vget_high_s16(b), vget_high_s16(w));
        at += 8;
    }
    let mut result = [vaddvq_s32(red), vaddvq_s32(green), vaddvq_s32(blue)];
    for (pixel, weight) in pixels[at * 3..].chunks_exact(3).zip(&weights[at..]) {
        let weight = i32::from(*weight);
        result[0] += i32::from(pixel[0]) * weight;
        result[1] += i32::from(pixel[1]) * weight;
        result[2] += i32::from(pixel[2]) * weight;
    }
    result.map(|value| value as f32 * NORMALIZE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neon_matches_independent_i64_convolution_for_tails_and_signed_weights() {
        for length in 1..=97 {
            let pixels: Vec<u8> = (0..length * 3)
                .map(|i| ((i * 79 + i / 5 * 37) % 256) as u8)
                .collect();
            let weights: Vec<i16> = (0..length).map(|i| ((i * 61 % 509) as i16) - 254).collect();
            let mut expected = [0i64; 3];
            for i in 0..length {
                for c in 0..3 {
                    expected[c] += i64::from(pixels[i * 3 + c]) * i64::from(weights[i]);
                }
            }
            let expected = expected.map(|value| value as f32 * NORMALIZE);
            assert_eq!(rgb_dot(&pixels, &weights), expected, "tap count {length}");
            assert_eq!(scalar_dot(&pixels, &weights), expected);
        }
    }

    #[test]
    fn normalized_signed_coefficients_preserve_constant_colors() {
        let weights = [-1024, 2048, 15360];
        let pixels = [55, 123, 251, 55, 123, 251, 55, 123, 251];
        assert_eq!(rgb_dot(&pixels, &weights), [55.0, 123.0, 251.0]);
        let weights = [-512, 1024, -512, 1024, -512, 1024, -512, 15360];
        let pixels = [55, 123, 251].repeat(8);
        assert_eq!(rgb_dot(&pixels, &weights), [55.0, 123.0, 251.0]);
    }
}

/// Four independent outputs preserve each channel's accumulation order.
pub fn accumulate(sum: &mut [f32], row: &[f32], weight: f32) {
    assert_eq!(sum.len(), row.len());
    let count = sum.len() / 4 * 4;
    #[cfg(target_arch = "aarch64")]
    unsafe {
        use std::arch::aarch64::*;
        let w = vdupq_n_f32(weight);
        for (s, r) in sum[..count]
            .chunks_exact_mut(4)
            .zip(row[..count].chunks_exact(4))
        {
            vst1q_f32(
                s.as_mut_ptr(),
                vaddq_f32(vld1q_f32(s.as_ptr()), vmulq_f32(vld1q_f32(r.as_ptr()), w)),
            );
        }
    }
    #[cfg(target_arch = "x86_64")]
    unsafe {
        use std::arch::x86_64::*;
        let w = _mm_set1_ps(weight);
        for (s, r) in sum[..count]
            .chunks_exact_mut(4)
            .zip(row[..count].chunks_exact(4))
        {
            _mm_storeu_ps(
                s.as_mut_ptr(),
                _mm_add_ps(
                    _mm_loadu_ps(s.as_ptr()),
                    _mm_mul_ps(_mm_loadu_ps(r.as_ptr()), w),
                ),
            );
        }
    }
    #[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
    for (s, r) in sum[..count].iter_mut().zip(&row[..count]) {
        *s += r * weight;
    }
    for (s, r) in sum[count..].iter_mut().zip(&row[count..]) {
        *s += r * weight;
    }
}
#[cfg(test)]
mod accumulate_tests {
    use super::*;
    #[test]
    fn vector_accumulation_matches_scalar_signed_taps_and_tails() {
        for length in 0..=97 {
            let row: Vec<_> = (0..length)
                .map(|i| (i * 431 % 999) as f32 * 0.13 - 50.)
                .collect();
            let mut expected: Vec<_> = (0..length).map(|i| i as f32 * 0.03).collect();
            let mut actual = expected.clone();
            for weight in [-0.3, 0.12, 0.7, -0.03, 1.1, 0.00001] {
                for (s, r) in expected.iter_mut().zip(&row) {
                    *s += r * weight;
                }
                accumulate(&mut actual, &row, weight);
                assert_eq!(actual, expected, "length {length}, weight {weight}");
            }
        }
    }
}

/// Accumulate RGB channels independently in their original tap order. Each
/// packed input reads exactly three borrowed bytes; there is no overread.
#[inline]
pub fn rgb_float_accumulate(pixels: &[u8], weights: &[f32], sum: &mut [f32; 4]) {
    assert_eq!(pixels.len(), weights.len() * 3);
    #[cfg(target_arch = "aarch64")]
    unsafe {
        use std::arch::aarch64::*;
        let mut acc = vld1q_f32(sum.as_ptr());
        for (pixel, &weight) in pixels.chunks_exact(3).zip(weights) {
            let packed = u32::from_le_bytes([pixel[0], pixel[1], pixel[2], 0]);
            let bytes = vreinterpret_u8_u64(vcreate_u64(u64::from(packed)));
            let integers = vmovl_u16(vget_low_u16(vmovl_u8(bytes)));
            let values = vcvtq_f32_u32(integers);
            acc = vaddq_f32(acc, vmulq_n_f32(values, weight));
        }
        vst1q_f32(sum.as_mut_ptr(), acc);
    }
    #[cfg(target_arch = "x86_64")]
    unsafe {
        use std::arch::x86_64::*;
        let mut acc = _mm_loadu_ps(sum.as_ptr());
        let zero = _mm_setzero_si128();
        for (pixel, &weight) in pixels.chunks_exact(3).zip(weights) {
            let packed = u32::from_le_bytes([pixel[0], pixel[1], pixel[2], 0]);
            let bytes = _mm_cvtsi32_si128(packed as i32);
            let words = _mm_unpacklo_epi8(bytes, zero);
            let integers = _mm_unpacklo_epi16(words, zero);
            let values = _mm_cvtepi32_ps(integers);
            acc = _mm_add_ps(acc, _mm_mul_ps(values, _mm_set1_ps(weight)));
        }
        _mm_storeu_ps(sum.as_mut_ptr(), acc);
    }
    #[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
    for (pixel, &weight) in pixels.chunks_exact(3).zip(weights) {
        for c in 0..3 {
            sum[c] += f32::from(pixel[c]) * weight;
        }
    }
}
