# okr-rag

Local-first OKR retrieval with Markdown as the only truth.

## Directory Contract

Use these three folders consistently:

- `.okr-rag/`: temporary derived state. It can be deleted and may contain stale indexes, reports, caches, and local model state.
- `okr-rag/`: the Rust source repository name when this project is published to GitHub.
- `okr-rag-workspace/`: the user workspace. By default, OKR Markdown truth files live under `okr-rag-workspace/okrs/`.

For setup demos and agent handoff, copy all three core directories:

```text
.okr-rag/
okr-rag/
okr-rag-workspace/
```

Keep `.okr-rag/` as a scaffold, but rebuild its generated runtime state after copying:

```powershell
target\release\okr-rag.exe ingest --force
```

Release packages must also include the prebuilt Windows runtime so users do not need to compile Rust:

```text
target/release/okr-rag.exe
target/release/onnxruntime.dll
target/release/onnxruntime_providers_shared.dll
target/release/zvec_c_api.dll
```

## Rules

- Truth lives in OKR/OKF Markdown files.
- Derived state lives under `.okr-rag/`.
- Retrieval uses `full_hybrid`: Zvec vector candidates plus structured field rerank.
- Core implementation is Rust. Python remains only for prototype benchmarks and tests.

## Local Native Libraries

The local zvec Rust bindings and required Windows MSVC native libraries are vendored under:

```text
third_party/zvec-rust/
third_party/zvec-prebuilt-x86_64-pc-windows-msvc/
third_party/onnxruntime/
```

Cargo is configured to use those local prebuilt packages through `.cargo/config.toml`.
`build.rs` copies the required DLLs beside the CLI and test binaries.

## Commands

```powershell
cargo run -p okr-rag -- init
cargo run -p okr-rag -- ingest
cargo run -p okr-rag -- ingest --force
cargo run -p okr-rag -- query "which OKR tracks churn and retention" --top-k 5 --candidate-k 30
cargo run -p okr-rag -- status
cargo run -p okr-rag -- mcp
```

For publishing, create a ready-to-run package from the existing release artifacts:

```powershell
node scripts/package_okr_rag_release.js
```

The generated package does not create or edit `.codex/config.toml`; Codex project-local setup is documented in `setup-for-agent.md`.
After extracting it elsewhere, run `target\release\okr-rag.exe ingest --force` once to build the local index without compiling.

After `git clone`, initialize the local scaffold with:

```powershell
node scripts/setup_okr_rag_workspace.js
```

Without an explicit `SOURCE_DIR`, `ingest` reads `okr-rag-workspace/okrs`.

## MCP Tools

The Rust binary also exposes a stdio MCP server:

```powershell
target\release\okr-rag.exe mcp --root .
```

For Codex, install this MCP entry in the project-local config:

```text
<CLONE_ROOT>\.codex\config.toml
```

Do not use the user-level config (`C:\Users\<USER>\.codex\config.toml`) unless the user explicitly asks for a global install.

Copy the template from `.codex/config.toml.example`:

```toml
[mcp_servers.okr-rag]
type = "stdio"
command = ".\\target\\release\\okr-rag.exe"
args = ["mcp", "--root", "."]
```

Available tools:

- `okr_rag_status`: show `.okr-rag` status for a workspace.
- `okr_rag_ingest`: index OKR Markdown into the inactive A/B zvec slot, then make it active. Without `source`, it reads `okr-rag-workspace/okrs`.
- `okr_rag_query`: run `full_hybrid` retrieval over the local index.

## Hot Sync

`okr-rag mcp` starts a background watcher by default. It polls `okr-rag-workspace/okrs`, waits for changes to stay stable briefly, then runs ingest automatically.

```powershell
target\release\okr-rag.exe mcp --root .
target\release\okr-rag.exe mcp --root . --no-watch
```

The derived zvec index uses A/B slots:

```text
.okr-rag/index/zvec-a/
.okr-rag/index/zvec-b/
.okr-rag/active-slot.json
.okr-rag/ingest-state.json
.okr-rag/watcher-state.json
.okr-rag/ingest.lock
```

Ingest writes the inactive slot first. After a successful rebuild, it updates `active-slot.json`. Queries read only the active slot, so added, modified, and deleted OKR Markdown files become visible after the watcher rebuild finishes.

The watcher follows the same robust shape as the `ai-harness` daemon: it stores a source snapshot, diffs `mtime + size`, accumulates pending changes, debounces them, rebuilds the inactive slot, and then scans again to catch edits that happened while the rebuild was running. `ingest.lock` prevents multiple MCP or CLI processes from rebuilding the inactive slot concurrently.

## Embedding

Runtime embedding is local ONNX MiniLM:

```text
sentence-transformers/all-MiniLM-L6-v2
```

Model files are stored under:

```text
.okr-rag/models/all-MiniLM-L6-v2/
```

`ingest`, `query`, and `mcp` do not call a remote embedding API. If the local ONNX model and tokenizer are present, the provider is `minilm-l6-v2-onnx`; otherwise the CLI can still fall back to deterministic local `hash-v1`.

The active index provider is recorded in:

```text
.okr-rag/embedding.json
```

After changing embedding providers, rebuild the index with `okr-rag ingest`.

## Performance Knobs

Ingest uses an embedding cache under:

```text
.okr-rag/cache/embeddings/
```

If a Markdown concept's embedding text is unchanged, `ingest` reuses the cached vector and avoids ONNX inference.

`ingest` also records a source fingerprint in:

```text
.okr-rag/ingest-state.json
```

When Markdown content and embedding metadata are unchanged, the default `ingest` skips rebuilding the derived zvec index. Use `--force` to rebuild anyway.

Optional environment variables:

```powershell
$env:OKR_RAG_ONNX_BATCH_SIZE = "16"
$env:OKR_RAG_ONNX_THREADS = "4"
```

The defaults are batch size `16` and ONNX intra-op threads `4`.

MiniLM tokenization uses batch-longest dynamic padding with a 256-token truncation limit, so short queries do not pay for fixed 256-token ONNX inference.

The future GitHub target is `ai-harnees/okr-rag`.

## Ignore Policy

Use this policy so demo structure is visible while generated runtime state stays disposable:

```gitignore
/.okr-rag/*
!/.okr-rag/README.md
!/.okr-rag/.gitkeep
/.codex/*
!/.codex/
!/.codex/config.toml.example
!/okr-rag/
!/okr-rag-workspace/
```
