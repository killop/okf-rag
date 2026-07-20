# Third-Party Notices

This repository vendors source code and Windows x64 runtime artifacts required for reproducible local builds.

## ONNX Runtime

- Project: Microsoft ONNX Runtime
- Version: 1.26.0
- Commit: `8c546c37b43caaca1fa25db430dab94b901cf277`
- License: MIT
- Location: `third_party/onnxruntime/`

The upstream license and notices are preserved in:

- `third_party/onnxruntime/LICENSE`
- `third_party/onnxruntime/ThirdPartyNotices.txt`
- `third_party/onnxruntime/Privacy.md`

Generated release packages copy the license and third-party notice files into `licenses/`.

## zvec and zvec-rust

- Project: zvec / zvec-rust
- Rust binding version: 0.5.0
- Target: `x86_64-pc-windows-msvc`
- License: Apache License 2.0
- Locations: `third_party/zvec-rust/` and `third_party/zvec-prebuilt-x86_64-pc-windows-msvc/`

The Apache License 2.0 text is preserved in `third_party/zvec-rust/LICENSE`.
Generated release packages copy it to `licenses/zvec-LICENSE`.

## Generated Release Artifacts

`okf-rag-workspace/bin/` is intentionally source-only in Git. Release packaging copies the project executable and the vendored runtime DLLs into that directory for distribution. Those generated copies remain subject to the licenses above.
