# Rust pipeline results

Measured October 18, 2026, in native ARM64 Linux Docker on Apple M4. Each
container had one CPU, a 3 GiB memory limit, one encoder, four callers and eight
admission slots. The reference is the actual main-branch Rust/libvips container
from `a0ac2a01992ef18ea16eded40c80e9617e9ad0f5`, built locally with Rust 1.90
and libvips 8.18.6. The research builds use Rust 1.93.0.

## Throughput

Images per second, higher is better. Width, requested quality and effort 4 are
the same for both implementations. Equal quality numbers do not establish equal
perceptual quality.

| Width / quality | Main libvips | Rust without PGO | Rust with PGO | PGO versus libvips |
| --- | ---: | ---: | ---: | ---: |
| 256 / 85 | 11.17 | 19.59 | 19.98 | +78.9% |
| 640 / 75 | 9.00 | 9.90 | 10.79 | +19.9% |
| 640 / 98 | 7.54 | 8.38 | 9.24 | +22.5% |
| 1080 / 98 | 4.19 | 4.35 | 4.92 | +17.5% |

Twenty-five original PNG images were reserved for evaluation and excluded from
training. They were duplicated into the harness's 50 input slots. Each build ran
twice, with 25 warmups and 50 timed transforms per workload per run. This gives
100 timed transforms from 25 unique sources per build/workload, not 100
independent source examples. Order was libvips A, Rust A, PGO A, PGO B, Rust B,
libvips B. Full output decoding ran after timing; no builds or quality analyses
ran during timed phases. This compares complete container implementations,
including their different Rust compiler versions.

## Quality and memory

PGO preserves the preceding Rust implementation's image bytes. Compared with
libvips, the Rust pipeline has slightly different resampling and encoding.
Fifty sources were screened against a common Sharp/libvips Lanczos3 sRGB resize,
which favors the libvips resampler. Uniform 8x8 luma SSIM and pooled RGB PSNR are
screening metrics, not proof of perceptual equivalence.

| Width / quality | Libvips SSIM | Rust SSIM | Libvips PSNR | Rust PSNR | Rust/libvips bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 256 / 85 | 0.988411 | 0.988239 | 39.91 dB | 39.36 dB | 1.004x |
| 640 / 75 | 0.983203 | 0.983333 | 39.70 dB | 39.63 dB | 1.007x |
| 640 / 98 | 0.994427 | 0.993918 | 45.24 dB | 44.78 dB | 0.999x |
| 1080 / 98 | 0.994356 | 0.993993 | 46.24 dB | 45.99 dB | 0.995x |

A simultaneous 50-request burst at 640/q98 finished in **5.037 seconds** with
**261.7 MiB peak cgroup memory**, no failed requests and no OOM. This used one
CPU, one encoder, a 1.5 GiB limit and test-only admission 64. Requests queued;
50 concurrent requests do not mean 50 simultaneous encoders.

The corpus is opaque RGB PNG, up to approximately 4.29 MP. These memory results
do not qualify the 50 MP/100 MiB limits or establish a smaller production VM size.

## Qualification already completed

- 2,200 timed transforms in the PGO selection round, all successful and decoded.
- 200 real-image outputs and 1,800 synthetic RGB/RGBA outputs matched the
  preceding Rust build byte for byte. Synthetic checks covered small/odd shapes,
  multiple patterns, methods 0/4/6 and qualities 25/75/98/100.
- Fifteen HTTP tests passed, including cancellation, admission, upload bounds,
  drain/shutdown, supported formats and alpha. The deterministic delay fixture
  was unprofiled with the existing test-only feature.
- Nine subsequent candidates produced no reliable overall improvement and were
  excluded. That round completed another 4,400 successful timed transforms,
  900 gallery byte comparisons and exhaustive ARM/x86 arithmetic checks.

The included HTTP suite is portable. The private gallery corpus and raw results
remain outside Git. Historical measurements are summarized here, not fabricated
as a public reproducible dataset.

## Remaining before adoption

- Resolve AGPL/commercial codec licensing.
- Measure native x86 performance and concurrency. Emulation proves no speedup.
- Qualify CMYK, animation, HDR and other documented color/format gaps, or define
  a supported fallback strategy.
- Test adversarial inputs and worst-case memory, and validate under the target
  Cloudflare workload before making any capacity or cost recommendation.
- Integrate a new renderer/cache version only after output and runtime approval.

No production deployment or container sizing change is part of this PR.

## Artifact identities

- ARM64 profile SHA-256:
  `e4312e4f2fdd5b5c64680facd6595d90bcf2864634bb31c1e24fac6e6dc134d6`
- Measured PGO executable SHA-256:
  `892e331311745aeb27f23a523645f3ba76f9fca9c01eb10d20336894324ed351`
- Measured unprofiled Rust executable SHA-256:
  `6d1edab8863ed2602c87058b8282f085e0e45be000974f36f612e46301e208aa`

`SNAPSHOT.sha256` identifies the packaged files. Build output may vary as base
image tags change; source and profile identity alone do not pin a whole toolchain.
