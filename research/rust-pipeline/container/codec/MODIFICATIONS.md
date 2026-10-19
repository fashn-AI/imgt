# Local research modifications

Snapshot modified October 18, 2026, by the imgt project. Original source:
`imazen/zenwebp` commit `a3fec3fec04cad9322af0a9e6bed023e72f1929c`.
Upstream license texts, copyright headers and third-party notices are retained.

The following packaged files differ from that upstream commit:

- `Cargo.toml`
- `src/common/simd_neon.rs`
- `src/common/transform.rs`
- `src/encoder/quantize.rs`
- `src/encoder/residual_cost.rs`
- `src/encoder/vp8/mod.rs`
- `src/encoder/vp8/mode_selection.rs`
- `src/lib.rs`
- `src/research_profile.rs`

Changes specialize encoder hot paths while retaining prior Rust output bytes:
ARM I4 context/winner reuse, wide IDCT, cached and batched quantization, unrolled
residual-cost loops, deferred coefficient layout, direct IDCT dispatch, and
I16/chroma candidate-score bounds. No lossy approximation was added by these
optimizations. Cargo manifest changes support the pinned research dependency
graph. Unused upstream development targets and assets are omitted; this snapshot
is consumed as a library by the application manifest.
