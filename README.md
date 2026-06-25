# okf-rag

[中文 README](README-CN.md)

Local-first OKF retrieval with Markdown as the only truth.

`okf-rag` is a Rust CLI and stdio MCP server. It indexes OKF Markdown with local ONNX MiniLM embeddings and zvec, then serves hybrid retrieval to agents.

## Directory Contract

- `.okf-rag/`: temporary runtime state. It can be deleted and may contain stale indexes, reports, caches, local model state, and watcher state.
- `okf-rag-workspace/`: user workspace and runtime install location. OKF Markdown truth files live under `okf-rag-workspace/okfs/`, and the workspace-local executable lives under `okf-rag-workspace/bin/`.

For setup demos and agent handoff, copy the two workspace directories together:

```text
.okf-rag/
okf-rag-workspace/
```

The Rust source repository is the cloned `okf-rag` repo itself. Do not create a nested `okf-rag/` directory inside a user workspace. `.okf-rag/` is included as a scaffold but its generated contents are disposable. Rebuild it after copying with `okf-rag ingest --force`.

Release packages must also include the prebuilt Windows runtime so users do not need to compile Rust:

```text
okf-rag-workspace/bin/okf-rag.exe
okf-rag-workspace/bin/onnxruntime.dll
okf-rag-workspace/bin/onnxruntime_providers_shared.dll
okf-rag-workspace/bin/zvec_c_api.dll
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

The package is written under `dist/` and includes docs, `okf-rag-workspace/`, the `.okf-rag` scaffold, local model files when present, and `okf-rag-workspace/bin/okf-rag.exe`.

After extracting a package on another machine, build the workspace-local index once with the bundled executable. This does not require Rust or Cargo:

```powershell
okf-rag-workspace\bin\okf-rag.exe ingest --force
```

Packaging scripts do not create or edit project-local Codex config. See [setup-for-agent.md](setup-for-agent.md) for the manual Codex MCP config.

## Setup After Clone

Initialize OKF-RAG from the project root where the agent is working:

```powershell
$WORKDIR = (Get-Location).Path
node scripts/setup_okf_rag_workspace.js --target $WORKDIR
```

The setup script refuses to run without `--target`, and it refuses to install into the `okf-rag` source repo. Do not point `--target` at the source repo when installing for another project. This script creates missing runtime/workspace directories, copies the bundled MiniLM model when present, removes stale non-MiniLM derived index state, installs the OKF skill into `.agents/skills/`, writes the tracked `.gitignore` rules, and creates one demo OKF file. It does not create or edit `.codex/config.toml`; copy the TOML snippet from [setup-for-agent.md](setup-for-agent.md).

## CLI

```powershell
okf-rag-workspace\bin\okf-rag.exe init
okf-rag-workspace\bin\okf-rag.exe ingest
okf-rag-workspace\bin\okf-rag.exe ingest --force
okf-rag-workspace\bin\okf-rag.exe query "domain driven memory zvec" --top-k 5 --candidate-k 50
okf-rag-workspace\bin\okf-rag.exe status
okf-rag-workspace\bin\okf-rag.exe bench data\okf-memory-benchmark\okf-hybrid-20260623-211957\eval.json --top-k 10 --candidate-k 100
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
okf-rag-workspace\bin\okf-rag.exe mcp --root .
```

Install the MCP config in the current workspace's project-local Codex config:

```text
<WORKDIR>\.codex\config.toml
```

Do not install this project's MCP entry into `%USERPROFILE%\.codex\config.toml` unless you explicitly want it available in every Codex workspace.

Recommended config uses paths relative to the current workspace:

```toml
[mcp_servers.okf-rag]
type = "stdio"
command = ".\\okf-rag-workspace\\bin\\okf-rag.exe"
args = ["mcp", "--root", ".", "--no-watch"]
```

Generic MCP config:

```json
{
  "mcpServers": {
    "okf-rag": {
      "command": ".\\okf-rag-workspace\\bin\\okf-rag.exe",
      "args": ["mcp", "--root", ".", "--no-watch"]
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

`okf-rag mcp` starts a background watcher by default. Codex stdio MCP config should use `--no-watch` for fast `tools/list` startup; run watcher mode only when you intentionally want a long-running process outside Codex startup.

```powershell
okf-rag-workspace\bin\okf-rag.exe mcp --root . --no-watch
okf-rag-workspace\bin\okf-rag.exe mcp --root .
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

`setup_okf_rag_workspace.js` copies this model directory from the okf-rag source or release package into the target workspace when the source includes it.

`ingest`, `query`, and `mcp` do not call a remote embedding API. Local ONNX MiniLM is required; there is no hash embedding fallback. If `onnx/model.onnx` or `tokenizer.json` is missing under the model directory, indexing and querying fail with a setup error.

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
$SMOKE = Join-Path $env:TEMP "okf-rag-smoke"
node scripts/setup_okf_rag_workspace.js --target $SMOKE --runtime-source target\release
& "$SMOKE\okf-rag-workspace\bin\okf-rag.exe" ingest --root $SMOKE
& "$SMOKE\okf-rag-workspace\bin\okf-rag.exe" query --root $SMOKE "domain memory zvec" --top-k 5 --candidate-k 50
```

## Ignore Policy

Generated runtime files stay out of source control, while the demo OKF truth stays visible:

```gitignore
/.okf-rag/
!/okf-rag-workspace/
!/okf-rag-workspace/**
```

Do not ignore `okf-rag-workspace/`.
