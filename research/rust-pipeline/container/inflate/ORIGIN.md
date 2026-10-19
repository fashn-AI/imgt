# Minimal local fdeflate extension

Exact crates.io fdeflate0.3.7 source; MIT/Apache notices retained. Only source
change is Decompressor::buffered_trailing_bytes(), an additive accessor for
already-buffered bytes after the verified zlib trailer. Existing decompression,
read consumption, output and checksum behavior is unchanged. The strict owned
PNG reader rejects these read-ahead bytes, tested with1–16 repaired-CRC extra
payload bytes and split/empty IDATs. No ownership of upstream code is claimed.
