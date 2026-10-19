# Rust image pipeline prototype

Review snapshot of the fastest retained local Rust pipeline, selected on October
18, 2026. It replaces the image-processing portion of the Rust/libvips service
with Rust decoding, color handling, streaming Lanczos3 resizing, and an optimized
ZenWebP encoder fork. It uses existing Rust libraries as well as imgt code.

This is a research branch, separate from `container/`. Wrangler and the deployed
Worker still use the production Rust/libvips container. This prototype has its
own renderer identifier because its output differs from production.

**Release blockers:** resolve the codecs' AGPL/commercial licensing, qualify the
format/color differences in [the decoder notes](container/formats/README.md), and
measure on native x86 hardware before choosing a Cloudflare configuration.
See [NOTICE.md](NOTICE.md); the repository's MIT license does not replace upstream
codec licenses.

## Build and test locally

Run from the repository root with Docker and Node.js 24. `npm ci` supplies Sharp
for independent test-fixture generation and output decoding, not for the runtime.

Build the measured ARM64 PGO version:

```sh
docker build --platform linux/arm64 \
  --build-arg 'IMGT_PGO_FLAGS=-Cprofile-use=/pgo-data/merged.profdata -Cllvm-args=-pgo-warn-missing-function' \
  -t imgt-research-pgo research/rust-pipeline/container
```

Omit `IMGT_PGO_FLAGS` to build the same ARM64 source without PGO. The profile only
applies to the pinned Rust 1.93.0 ARM64 build. An x86 build uses the same Rust
source without that profile:

```sh
# Build on a native x86 Linux host for performance measurements.
docker build --platform linux/amd64 \
  -f research/rust-pipeline/container/Dockerfile.amd64 \
  -t imgt-research-amd64 research/rust-pipeline/container
```

`Dockerfile.cross-amd64` also builds x86 from an ARM host. Emulated execution is
useful for correctness checks; its timing does not predict Cloudflare performance.

Build the deterministic delay fixture and run the HTTP contract suite on ARM64:

```sh
docker build --platform linux/arm64 \
  --build-arg IMGT_TEST_FEATURES=test-delay \
  -t imgt-research-delay research/rust-pipeline/container
IMGT_CONTAINER_IMAGE=imgt-research-pgo IMGT_TEST_IMAGE=imgt-research-delay \
  node --test research/rust-pipeline/http-contract.mjs
```

The suite starts and removes its own local Docker containers. It checks upload
limits, validation, bounded admission, deadlines, cancellation, drain/shutdown,
supported formats, EXIF orientation, resize dimensions, and transparency.

Run an individual image manually:

```sh
docker run --rm --name imgt-research --cpus 1 --memory 1536m \
  -p 127.0.0.1:8081:8080 \
  -e TRANSFORM_CONCURRENCY=1 -e MAX_IN_FLIGHT=8 \
  -e TRANSFORM_TIMEOUT_MS=60000 -e WEBP_EFFORT=4 imgt-research-pgo
```

In another terminal:

```sh
curl --fail http://127.0.0.1:8081/health
curl --fail -H "x-imgt-deadline: $(node -p 'Date.now()+60000')" \
  --data-binary @input.png 'http://127.0.0.1:8081/transform?w=640&q=98' \
  --output output.webp
```

## What PGO changes

Profile-guided optimization records execution frequencies during training and
uses them for compiler optimization. The binary accepts arbitrary supported
images. It does not contain training images, URLs, or cached outputs. The merged
profile contains compiler function identities and counters.

Training used 25 PNG images at six size/quality combinations, auxiliary formats
derived from a training image, and synthetic transparency. The timing comparison
used 25 different source images. Private source images and raw benchmark results
are excluded from this PR. Rebuilding with the included profile is supported;
independently repeating the exact training corpus requires those private inputs.

The profile is tied to the source, compiler and target. Regenerate it after
meaningful changes using Rust's [instrument/train/merge/build workflow](https://doc.rust-lang.org/rustc/profile-guided-optimization.html).
Use matching `llvm-profdata` from Rust 1.93.0's `llvm-tools-preview`; instrument
with `-Cprofile-generate=/profiles`, train with representative inputs, shut down
cleanly, merge `.profraw` files, then replace `pgo-data/merged.profdata`. Retrain
and evaluate on separate inputs. ARM64 results do not establish x86 PGO gains.

## Snapshot contents

- `container/rust`: HTTP runtime and the selected image-processing pipeline.
- `container/codec`: runtime-source snapshot of the optimized ZenWebP fork.
- `container/formats`: format, ICC and orientation adapter, including fixtures.
- `container/inflate`: minimal fdeflate extension used by the owned-reader control.
- `container/pgo-data`: the retained ARM64 compiler profile.
- `SNAPSHOT.sha256`: source, manifest, profile and build-recipe identities.
- [BENCHMARK.md](BENCHMARK.md): measurements, methodology and release gaps.

The selected defaults are `RESEARCH_READER=png`, `RESEARCH_KERNEL=float`,
`RESEARCH_PREFILTER=box`, and `RESEARCH_PNG_PAETH=scalar`. Alternative research
controls remain in the frozen source to preserve profile compatibility. They are
not proposed public configuration options. No rejected optimization is enabled.

The vendored codec is consumed as a library dependency. Unused upstream dev
programs, benchmark data and test assets are omitted; its standalone development
targets are not part of this snapshot. Its runtime source and manifest are
unchanged from the measured fork. Source images, raw timing records, binaries,
build caches and private credentials are excluded.
