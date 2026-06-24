# okf-rag

Local-first OKF retrieval with Markdown as the only truth.

`okf-rag` is a Rust CLI and stdio MCP server. It indexes OKF Markdown with local ONNX MiniLM embeddings and zvec, then serves hybrid retrieval to agents.

## Directory Contract

- `.okf-rag/`: temporary runtime state. It can be deleted and may contain stale indexes, reports, caches, local model state, and watcher state.
- `okf-rag/`: the Rust source repository name when published.
- `okf-rag-workspace/`: user workspace. By default, OKF Markdown truth files live under `okf-rag-workspace/okfs/`.

For setup demos and agent handoff, copy all three core directories together:

```text
.okf-rag/
okf-rag/
okf-rag-workspace/
```

`.okf-rag/` is included as a scaffold but its generated contents are disposable. Rebuild it after copying with `okf-rag ingest --force`.

Release packages must also include the prebuilt Windows runtime so users do not need to compile Rust:

```text
target/release/okf-rag.exe
target/release/onnxruntime.dll
target/release/onnxruntime_providers_shared.dll
target/release/zvec_c_api.dll
```

## Build

```powershell
cargo build -p okf-rag --release
```

Local zvec Rust bindings and native runtime dependencies are vendored under:

```text
third_party/zvec-rust/
third_party/zvec-prebuilt-x86_64-pc-windows-msvc/
third_party/onnxruntime/
```

## Release Package

When publishing, build once as the maintainer and ship the release binary with its required DLLs:

```powershell
node scripts/package_okf_rag_release.js
```

The package is written under `dist/` and includes docs, `okf-rag-workspace/`, the `.okf-rag` scaffold, local model files when present, and `target/release/okf-rag.exe`.

After extracting a package on another machine, build the workspace-local index once with the bundled executable. This does not require Rust or Cargo:

```powershell
target\release\okf-rag.exe ingest --force
```

Packaging scripts do not create or edit project-local Codex config. See [setup-for-agent.md](setup-for-agent.md) for the manual Codex MCP config.

## Setup After Clone

After `git clone`, initialize the local directory scaffold:

```powershell
node scripts/setup_okf_rag_workspace.js
```

This script creates missing runtime/workspace directories, a demo OKF, and placeholder Markdown files only. It does not create or edit the machine-local `.codex/config.toml`; use `.codex/config.toml.example` as the template.

## CLI

```powershell
target\release\okf-rag.exe init
target\release\okf-rag.exe ingest
target\release\okf-rag.exe ingest --force
target\release\okf-rag.exe query "domain driven memory zvec" --top-k 5 --candidate-k 50
target\release\okf-rag.exe status
target\release\okf-rag.exe bench data\okf-memory-benchmark\okf-hybrid-20260623-211957\eval.json --top-k 10 --candidate-k 100
```

Without an explicit `SOURCE_DIR`, `ingest` reads:

```text
okf-rag-workspace/okfs
```

## Benchmark

Release benchmark on 2026-06-24, using local `minilm-l6-v2-onnx`, local zvec, 53 OKF Markdown concepts, 258 queries, `top-k=10`, and effective `candidate-k=53`.

| Metric | Result |
|---|---:|
| Recall@1 / Hit@1 | 0.9535 |
| Recall@3 / Hit@3 | 0.9845 |
| Recall@5 / Hit@5 | 0.9922 |
| Recall@10 / Hit@10 | 1.0000 |
| MRR@10 | 0.9700 |

Hot query path loads ONNX and zvec once, then runs all queries:

| Stage | Avg ms | P50 ms | P95 ms |
|---|---:|---:|---:|
| Total query | 5.327 | 5.280 | 6.285 |
| ONNX embedding | 3.474 | 3.419 | 4.355 |
| zvec + rerank | 1.853 | 1.845 | 2.016 |

Ingest benchmark:

| Run | Cache Hits | Cache Misses | Total ms |
|---|---:|---:|---:|
| Cold embedding cache, forced rebuild | 0 | 53 | 1834.119 |
| Warm embedding cache, forced rebuild | 53 | 0 | 190.061 |
| Unchanged source, skipped rebuild | 0 | 0 | 71.584 |

Full details, query-type breakdown, and ONNX thread sweep are in [OKF-RAG-BENCHMARK.md](OKF-RAG-BENCHMARK.md).

## MCP

Start the stdio MCP server:

```powershell
target\release\okf-rag.exe mcp --root .
```

Install the MCP config in the project-local Codex config:

```text
<CLONE_ROOT>\.codex\config.toml
```

Do not install this project's MCP entry into `%USERPROFILE%\.codex\config.toml` unless you explicitly want it available in every Codex workspace.

Copy the template from `.codex/config.toml.example`:

```toml
[mcp_servers.okf-rag]
type = "stdio"
command = ".\\target\\release\\okf-rag.exe"
args = ["mcp", "--root", "."]
```

Generic MCP config:

```json
{
  "mcpServers": {
    "okf-rag": {
      "command": "<CLONE_ROOT>\\target\\release\\okf-rag.exe",
      "args": ["mcp", "--root", "<CLONE_ROOT>"]
    }
  }
}
```

Tools:

- `okf_rag_status`: show workspace, active slot, index path, concept count, and embedding provider.
- `okf_rag_ingest`: index OKF Markdown into the inactive A/B zvec slot, then make it active.
- `okf_rag_query`: run full hybrid retrieval over the active local index.

See [setup-for-agent.md](setup-for-agent.md) for agent-oriented MCP instructions.

## Hot Sync

`okf-rag mcp` starts a background watcher by default. It watches `okf-rag-workspace/okfs`, debounces changes, rebuilds the inactive A/B slot, and switches active slot only after a successful rebuild.

```powershell
target\release\okf-rag.exe mcp --root .
target\release\okf-rag.exe mcp --root . --no-watch
```

Runtime slot state:

```text
.okf-rag/index/zvec-a/
.okf-rag/index/zvec-b/
.okf-rag/active-slot.json
.okf-rag/ingest-state.json
.okf-rag/watcher-state.json
.okf-rag/ingest.lock
```

The watcher stores a source snapshot, diffs `mtime + size`, accumulates pending changes, debounces them, rebuilds the inactive slot, and scans again to catch changes that happened while rebuilding. `ingest.lock` prevents concurrent rebuilds from multiple MCP or CLI processes.

## Embedding

Runtime embedding is local ONNX MiniLM:

```text
sentence-transformers/all-MiniLM-L6-v2
```

Model files are stored under:

```text
.okf-rag/models/all-MiniLM-L6-v2/
```

`ingest`, `query`, and `mcp` do not call a remote embedding API when the local ONNX model and tokenizer are present. The fallback provider is deterministic local `hash-v1`.

## Performance Knobs

```powershell
$env:OKF_RAG_ONNX_BATCH_SIZE = "16"
$env:OKF_RAG_ONNX_THREADS = "4"
```

MiniLM tokenization uses batch-longest dynamic padding with a 256-token truncation limit.

## Verification

```powershell
cargo fmt
cargo test -p okf-rag
cargo clippy -p okf-rag -- -D warnings
cargo build -p okf-rag --release
target\release\okf-rag.exe ingest
target\release\okf-rag.exe query "domain memory zvec" --top-k 5 --candidate-k 50
```

## Ignore Policy

Generated runtime files stay out of source control, while the demo scaffold and OKF truth stay visible:

```gitignore
/.okf-rag/*
!/.okf-rag/README.md
!/.okf-rag/.gitkeep
/.codex/*
!/.codex/
!/.codex/config.toml.example
!/okf-rag/
!/okf-rag-workspace/
```
