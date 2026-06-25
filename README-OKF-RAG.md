# okf-rag

Local-first OKF retrieval with Markdown as the only truth.

## Directory Contract

Use these two workspace folders consistently:

- `.okf-rag/`: temporary derived state. It can be deleted and may contain stale indexes, reports, caches, and local model state.
- `okf-rag-workspace/`: the user workspace and runtime install location. OKF Markdown truth files live under `okf-rag-workspace/okfs/`, and the workspace-local executable lives under `okf-rag-workspace/bin/`.

For setup demos and agent handoff, copy both workspace directories:

```text
.okf-rag/
okf-rag-workspace/
```

The Rust source repository is the cloned `okf-rag` repo itself. Do not create a nested `okf-rag/` directory inside a user workspace. Keep `.okf-rag/` as a scaffold, but rebuild its generated runtime state after copying:

```powershell
okf-rag-workspace\bin\okf-rag.exe ingest --force
```

Release packages must also include the prebuilt Windows runtime so users do not need to compile Rust:

```text
okf-rag-workspace/bin/okf-rag.exe
okf-rag-workspace/bin/onnxruntime.dll
okf-rag-workspace/bin/onnxruntime_providers_shared.dll
okf-rag-workspace/bin/zvec_c_api.dll
```

## Rules

- Truth lives in OKF/OKF Markdown files.
- Derived state lives under `.okf-rag/`.
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
cargo run -p okf-rag -- init
cargo run -p okf-rag -- ingest
cargo run -p okf-rag -- ingest --force
cargo run -p okf-rag -- query "which OKF tracks churn and retention" --top-k 5 --candidate-k 30
cargo run -p okf-rag -- status
cargo run -p okf-rag -- mcp
```

For publishing, create a ready-to-run package from the existing release artifacts:

```powershell
node scripts/package_okf_rag_release.js
```

The generated package does not create or edit `.codex/config.toml`; Codex project-local setup is documented in `setup-for-agent.md`.
After extracting it elsewhere, run `okf-rag-workspace\bin\okf-rag.exe ingest --force` once to build the local index without compiling.

Initialize OKF-RAG from the project root where the agent is working:

```powershell
$WORKDIR = (Get-Location).Path
node scripts/setup_okf_rag_workspace.js --target $WORKDIR
```

The setup script refuses to run without `--target`, and it refuses to install into the `okf-rag` source repo. Do not point `--target` at the source repo when installing for another project.

Without an explicit `SOURCE_DIR`, `ingest` reads `okf-rag-workspace/okfs`.

## Benchmark

Release benchmark on 2026-06-24, using local `minilm-l6-v2-onnx`, local zvec, 53 OKF Markdown concepts, 258 queries, `top-k=10`, and effective `candidate-k=53`.

| Metric | Result |
|---|---:|
| Recall@1 / Hit@1 | 0.9535 |
| Recall@3 / Hit@3 | 0.9845 |
| Recall@5 / Hit@5 | 0.9922 |
| Recall@10 / Hit@10 | 1.0000 |
| MRR@10 | 0.9700 |

Hot query path:

| Stage | Avg ms | P50 ms | P95 ms |
|---|---:|---:|---:|
| Total query | 5.327 | 5.280 | 6.285 |
| ONNX embedding | 3.474 | 3.419 | 4.355 |
| zvec + rerank | 1.853 | 1.845 | 2.016 |

Ingest:

| Run | Cache Hits | Cache Misses | Total ms |
|---|---:|---:|---:|
| Cold embedding cache, forced rebuild | 0 | 53 | 1834.119 |
| Warm embedding cache, forced rebuild | 53 | 0 | 190.061 |
| Unchanged source, skipped rebuild | 0 | 0 | 71.584 |

Full details are in [OKF-RAG-BENCHMARK.md](OKF-RAG-BENCHMARK.md).

## MCP Tools

The Rust binary also exposes a stdio MCP server:

```powershell
okf-rag-workspace\bin\okf-rag.exe mcp --root .
```

For Codex, install this MCP entry in the project-local config:

```text
<WORKDIR>\.codex\config.toml
```

Do not use the user-level config (`C:\Users\<USER>\.codex\config.toml`) unless the user explicitly asks for a global install.

Recommended config uses paths relative to the current workspace:

```toml
[mcp_servers.okf-rag]
type = "stdio"
command = ".\\okf-rag-workspace\\bin\\okf-rag.exe"
args = ["mcp", "--root", "."]
```

Available tools:

- `okf_rag_status`: show `.okf-rag` status for a workspace.
- `okf_rag_ingest`: index OKF Markdown into the inactive A/B zvec slot, then make it active. Without `source`, it reads `okf-rag-workspace/okfs`.
- `okf_rag_query`: run `full_hybrid` retrieval over the local index.

## Hot Sync

`okf-rag mcp` starts a background watcher by default. It polls `okf-rag-workspace/okfs`, waits for changes to stay stable briefly, then runs ingest automatically.

```powershell
okf-rag-workspace\bin\okf-rag.exe mcp --root .
okf-rag-workspace\bin\okf-rag.exe mcp --root . --no-watch
```

The derived zvec index uses A/B slots:

```text
.okf-rag/index/zvec-a/
.okf-rag/index/zvec-b/
.okf-rag/active-slot.json
.okf-rag/ingest-state.json
.okf-rag/watcher-state.json
.okf-rag/ingest.lock
```

Ingest writes the inactive slot first. After a successful rebuild, it updates `active-slot.json`. Queries read only the active slot, so added, modified, and deleted OKF Markdown files become visible after the watcher rebuild finishes.

The watcher follows the same robust shape as the `ai-harness` daemon: it stores a source snapshot, diffs `mtime + size`, accumulates pending changes, debounces them, rebuilds the inactive slot, and then scans again to catch edits that happened while the rebuild was running. `ingest.lock` prevents multiple MCP or CLI processes from rebuilding the inactive slot concurrently.

## Embedding

Runtime embedding is local ONNX MiniLM:

```text
sentence-transformers/all-MiniLM-L6-v2
```

Model files are stored under:

```text
.okf-rag/models/all-MiniLM-L6-v2/
```

`ingest`, `query`, and `mcp` do not call a remote embedding API. If the local ONNX model and tokenizer are present, the provider is `minilm-l6-v2-onnx`; otherwise the CLI can still fall back to deterministic local `hash-v1`.

The active index provider is recorded in:

```text
.okf-rag/embedding.json
```

After changing embedding providers, rebuild the index with `okf-rag ingest`.

## Performance Knobs

Ingest uses an embedding cache under:

```text
.okf-rag/cache/embeddings/
```

If a Markdown concept's embedding text is unchanged, `ingest` reuses the cached vector and avoids ONNX inference.

`ingest` also records a source fingerprint in:

```text
.okf-rag/ingest-state.json
```

When Markdown content and embedding metadata are unchanged, the default `ingest` skips rebuilding the derived zvec index. Use `--force` to rebuild anyway.

Optional environment variables:

```powershell
$env:OKF_RAG_ONNX_BATCH_SIZE = "16"
$env:OKF_RAG_ONNX_THREADS = "4"
```

The defaults are batch size `16` and ONNX intra-op threads `4`.

MiniLM tokenization uses batch-longest dynamic padding with a 256-token truncation limit, so short queries do not pay for fixed 256-token ONNX inference.

The GitHub remote is `killop/okf-rag`.

## Ignore Policy

Use this policy so demo OKF truth is visible while generated runtime state stays disposable:

```gitignore
/.okf-rag/
```

Do not ignore `okf-rag-workspace/`.
