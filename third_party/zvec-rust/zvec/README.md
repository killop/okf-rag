# zvec

Vendored Rust bindings for the local OKR-RAG prototype.

The native zvec C API runtime is not built from this directory. It is provided by:

```text
third_party/zvec-prebuilt-x86_64-pc-windows-msvc/
```

Cargo is configured through `.cargo/config.toml` to link against that prebuilt runtime.
