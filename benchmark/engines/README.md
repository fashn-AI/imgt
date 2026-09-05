# Common-input engine comparison

These are benchmark processes, not production servers. Every engine reads the
same source file into memory and writes WebP to a local output file. Timing
includes source read, decode, orientation, resizing and encoding; output-file
write, HTTP, queueing, origin, R2 and Cloudflare startup are excluded.

Sharp and the C++ libvips thumbnail prototype link the exact same Sharp-provided
libvips 8.18.6 / WebP 1.6.0 bundle. Two Sharp runs isolate its intermediate
operation cache. Rust uses image 0.25.10, fast_image_resize 6.1.0 and webp 0.3.1;
Cargo.lock pins its transitive codec dependencies. It currently lacks AVIF and
ICC conversion and must not be treated as a drop-in service replacement.

Run with a native-architecture Docker engine:

```bash
npm ci
npm ci --prefix benchmark/engines
docker build -f benchmark/engines/Dockerfile -t imgt-engines:local .
docker build -t imgt-rust:local benchmark/engines/rust
node benchmark/engines/fixtures.mjs
node benchmark/engines/run.mjs
node benchmark/engines/quality.mjs
```

Sources and encoded files stay under `/tmp`. The checked-in JSON reports record
source hashes, dimensions, codec information, sample timings and cgroup memory.
The shared libvips benchmark image intentionally includes both executables and
Node, so its disk size is not a production-size comparison. Each engine uses a
separate container limited to 1 vCPU / 3 GiB with swap disabled.

Quality uses full-resolution SSIM against a lossless resize from the existing
Sharp pipeline, plus file hashes and dimension/alpha checks. This reference
favors matching existing resampling behavior. Neither SSIM nor matching quality
numbers alone establishes equivalent visual quality. Inspect representative
outputs before changing the renderer. Benchmark prototypes do not implement the
production upload, cancellation, queue, or deadline contract.

The Engine benchmark workflow repeats these tests on native AMD64 GitHub
hardware and uploads JSON artifacts. It does not deploy any Worker or container
to Cloudflare. CPU model and architecture are recorded; GitHub CPUs are not a
substitute for final measurements on Cloudflare.

Color qualification subsequently found that the initial native prototype needed
an explicit sRGB output profile. `native.cpp` now sets that profile and perceptual
intent. Historical result files preceding that fix are exploratory, not a
qualified color-managed renderer comparison. P3/CMYK transforms match Sharp at
the original dimensions but resizing before ICC conversion still produces
different pixels; `qualify-http.mjs` records that distinction. This is not yet a
drop-in production encoder.

Overrides: `FIXTURES`, `ENGINE_OUTPUT_DIR`, `ENGINE_REPORT`, `QUALITY_REPORT`,
`ENGINE_SAMPLES`, and comma-separated `ENGINE_PROFILE` names. Fixture generation
accepts an output-directory argument. No source images are committed to Git.

`sharp-late-icc` runs the production `container/transform.ts` with the operation
cache disabled. `baseline.ts` preserves the pre-optimization path for color
regression tests and the HTTP lab; changing production does not change that
reference. Both paths include color conversion.

The optional isolated Cloudflare experiment uses `benchmark/cloudflare/wrangler.jsonc`
and a separate GitHub-integrated Worker. It has one 1-CPU container, only a fixed
public source, no R2 and no managed Images binding. All engines share port 8080;
requests run sequentially with rotating order. Run `node benchmark/cloudflare/run.mjs`
only against an enabled lab whose build marker matches the script. A mismatched
marker stops the run; never label responses from an old image as a new engine.
The 27-request run fits the 30/minute limiter when no other probes overlap it.
