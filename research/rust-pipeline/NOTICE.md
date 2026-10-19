# Source provenance and licensing

This prototype includes third-party code with its own license terms. The root
MIT license covers imgt-authored code; it does not relicense these dependencies
or establish that the combined research executable can be distributed as MIT.
Licensing is an explicit release blocker for adopting this pipeline.

## Vendored code

- `container/codec`: ZenWebP 0.5.0, based on upstream commit `a3fec3fec04cad9322af0a9e6bed023e72f1929c` of
  <https://github.com/imazen/zenwebp>, with local encoder optimizations selected
  on October 18, 2026. The manifest declares
  `(AGPL-3.0-only OR LicenseRef-Imazen-Commercial) AND (MIT OR Apache-2.0)`.
  `LICENSE-AGPL3`, `LICENSE-COMMERCIAL`, upstream notices and source copyright
  headers are preserved. Changes include ARM quantization and reconstruction,
  residual-cost specialization,
  deferred coefficient layout, and safe candidate-score bounds. The upstream
  project owns the original codec implementation.
- `container/inflate`: fdeflate 0.3.7 from crates.io, upstream source commit
  `c365c7e6ffa81feb2e1fb762eed7299f05c9b0ca`, MIT OR Apache-2.0. Both license
  texts are preserved. The additive `buffered_trailing_bytes()` accessor and
  its purpose are documented in `ORIGIN.md`.

`container/formats` is an imgt decoder adapter using pinned published libraries.
The enabled AVIF path includes ZenAVIF and rav1d-safe, whose metadata declares
AGPL-3.0-only or an Imazen commercial license. The decoder README records direct
versions, capabilities and other dependency licenses. `container/rust/Cargo.lock`
pins the complete application graph, including the zencodec Git revision.

No commercial license entitlement is claimed by this PR. Preserve upstream
notices when reviewing, modifying or redistributing this prototype. Resolve the
licensing strategy before integrating it into the production MIT project.
