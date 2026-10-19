# Local pure-Rust decoder adapter

Research implementation only. This adapter is included in a draft research PR;
production continues to use libvips. The adapter owns format dispatch, resource checks,
ICC conversion and orientation policy; published Rust crates implement the image
codecs and color math. It is not a from-scratch codec implementation or a claim
of libvips pixel/color parity.

## API and integration

```rust
use imgt_research_formats::{decode, Format as DecFmt, PixelLayout, ErrorKind};

let decoded = decode(input, &|| control.canceled())?;
// decoded.frame: width, height, layout (Rgb8 | Rgba8), pixels (Vec<u8>)
// decoded.info: format, orientation_applied, color_handling
```

`Frame` contains tightly packed, top-to-bottom, straight-alpha sRGB8 pixels.
Alpha is preserved separately during ICC conversion. PNG 16-bit samples undergo
ICC conversion at 16 bits before rounding to 8 bits. Untagged inputs assume sRGB;
explicit unsupported color information fails instead of being silently dropped.
`ErrorKind::{Invalid, Unsupported, Limit, Canceled}` is the stable error surface.

To use the complete adapter from the parent's `container/rust` crate:

```toml
imgt-research-formats = { path = "../formats", features = ["avif"] }
```

Copy `Cargo.toml`, `Cargo.lock`, `src/`, `tests/` and this README. Do not copy
`target/` or `sources/`: those are local compilation and source-review caches.
The parent's global dependency pins/patches must still resolve consistently.

## Capabilities and current gaps

| Input | Implemented | Explicit gaps / qualification |
| --- | --- | --- |
| JPEG | 8-bit RGB/grayscale, baseline and progressive, EXIF orientation, RGB/gray ICC to sRGB | CMYK/YCCK rejected before the image adapter converts away the original color samples. Other JPEG precisions and HDR/gain-map semantics are not qualified. |
| PNG | RGB/RGBA/gray/gray-alpha, palette and low-bit-depth expansion, tRNS, Adam7, 16-bit input, EXIF including after IDAT, RGB/gray ICC | APNG, CICP/HDR, and non-sRGB gAMA/cHRM without ICC rejected. Color chunks after IDAT are invalid; late EXIF is supported. Every chunk CRC is checked; bytes after a complete IEND are ignored like the baseline. |
| WebP | Static lossy/lossless RGB/RGBA, EXIF orientation, RGB ICC | Animated WebP rejected. Unit coverage exercises lossless RGBA/profile/orientation; broader lossy/animation compatibility remains an HTTP-fixture task. |
| AVIF (`avif` feature) | Managed pure-Rust AV1 decode, SDR RGB/RGBA, alpha, ICC/CICP to sRGB, container rotation/mirror and EXIF fallback | HDR/gain-map tone mapping, clean aperture/pixel aspect ratio and sequences rejected. Synthetic 8-bit RGB/RGBA/ICC and all eight orientation cases pass. 10/12-bit output is normalized to 8-bit by the codec before ICC conversion and still needs independent fidelity fixtures. |

AVIF `irot`/`imir` properties take precedence over retained EXIF orientation, so a
writer's duplicated orientation is applied once. EXIF is used when neither
container property exists. Mirror handling follows HEIF 2022: axis 0 exchanges
top/bottom; axis 1 exchanges left/right. The pinned parser's prose reverses this,
so all eight orientations have independent coordinate-mapping tests. This is
consistent with [libavif's documented axes](https://github.com/AOMediaCodec/libavif/blob/main/include/avif/avif.h)
and its [change to remove duplicated EXIF transformations](https://chromium.googlesource.com/external/github.com/AOMediaCodec/libavif/+/d3ec9d45116880609b6c0ff38de61a5ab7274836).

Malformed or mismatched ICC profiles return an error. JPEG ICC marker sequences
declared in the container must assemble successfully; PNG profiles discarded by
the underlying decoder are also errors. XMP, text and other non-rendering metadata
are not retained in the returned frame. These choices are deliberate and do not
establish complete compatibility with production libvips.

## Bounds and cancellation

Input is limited to 100 MiB and displayed/source frame dimensions to 50 million
pixels before pixel decode. ICC/EXIF payloads are limited to 4 MiB. PNG decoder
scratch is limited to 64 MiB. Generic image-decoder allocation limits are
best-effort codec limits, not a process-wide allocator budget. Decoded pixels and
color/orientation intermediates also consume memory; the parent's existing
single encoder, admission slots and container memory cap remain necessary.

AVIF has a borrowed parser preflight with a 512-MiB estimated peak, 50-MP total,
and one-frame limit, followed by managed decode with a strict 50-MP frame bound
and one decoding thread. The high-level published codec does not expose its
parser-limit setters, hence the bounded preflight before its owned parse.

Cancellation is checked around codec stages, between PNG chunks and per ICC row.
Codec calls and some orientation/normalization loops are not hard-preemptible.
Retain HTTP admission/encoder permits until the blocking job actually returns.

## Dependency provenance

All direct versions are exact and `Cargo.lock` pins transitive versions.

| Crate | Version / features | License metadata |
| --- | --- | --- |
| image | 0.25.10; defaults off, jpeg + webp | MIT OR Apache-2.0 |
| png | 0.18.1 | MIT OR Apache-2.0 |
| moxcms | 0.8.1, shared with image | BSD-3-Clause OR Apache-2.0 |
| crc32fast | 1.5.2 | MIT OR Apache-2.0 |
| zenavif | 0.1.6, defaults off, optional | AGPL-3.0-only OR Imazen commercial |
| zenavif-parse | 0.6.2, defaults off, optional | MPL-2.0 |
| rav1d-safe | 0.5.7 via zenavif; bitdepth_8 + bitdepth_16 | AGPL-3.0-only OR Imazen commercial |

JPEG resolves zune-jpeg 0.5.15; WebP resolves image-webp 0.2.4. The enabled graph
has no native-linked image codec package, no dav1d/libjpeg/libpng/libwebp, and no
AVIF `unsafe-asm`/rav1d `asm` feature. rav1d-safe lists `cc`/`nasm-rs` build
dependencies even when their assembly build branch is disabled; they do not
mean the enabled decoder executes C/assembly codecs. This is a pure-Rust
image-codec pipeline, not a C-free operating-system process. AVIF's licensing is
an adoption constraint; this research does not approve changing project licensing.

Source references: [image features](https://docs.rs/crate/image/0.25.10),
[moxcms](https://docs.rs/crate/moxcms/0.8.1),
[zenavif managed decode](https://docs.rs/zenavif/0.1.6/zenavif/),
[rav1d-safe](https://github.com/imazen/rav1d-safe).

## Validation

19 tests pass on ARM64 Linux with Rust **1.93.0**, and on the local Rust 1.98.1.
The Linux build uses the published dependencies without system image-codec
packages. Tests cover explicit orientation mappings, alpha, palette/tRNS,
Adam7/progressive input, 16-bit gray ICC, profile conversion/rejection, malformed
ICC sequence/checksum rejection, resource guards and cooperative cancellation.
PNG explicitly enables Adler-32 checking with `ignore_checksums(false)`; a
regression fixture has a repaired chunk CRC but corrupt zlib Adler checksum.
AVIF fixtures are synthetic 8×6 gradients generated with Sharp 0.35.4 / libheif
1.23.2 as an independent fixture producer; Sharp is not part of this Rust crate.

```sh
cargo test --locked --features avif
```

These are decoder tests. Real HTTP integration, adversarial-service memory and
cancellation checks, and independent ICC/format fidelity comparisons are still
required before release or claiming production parity.
