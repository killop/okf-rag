# okr-rag

Local-first OKR retrieval with Markdown as the only truth.

`okr-rag` is a Rust CLI and stdio MCP server. It indexes OKR Markdown with local ONNX MiniLM embeddings and zvec, then serves hybrid retrieval to agents.

## Directory Contract

- `.okr-rag/`: temporary runtime state. It can be deleted and may contain stale indexes, reports, caches, local model state, and watcher state.
- `okr-rag/`: the Rust source repository name when published.
- `okr-rag-workspace/`: user workspace. By default, OKR Markdown truth files live under `okr-rag-workspace/okrs/`.

For setup demos and agent handoff, copy all three core directories together:

```text
.okr-rag/
okr-rag/
okr-rag-workspace/
```

`.okr-rag/` is included as a scaffold but its generated contents are disposable. Rebuild it after copying with `okr-rag ingest --force`.

Release packages must also include the prebuilt Windows runtime so users do not need to compile Rust:

```text
target/release/okr-rag.exe
target/release/onnxruntime.dll
target/release/onnxruntime_providers_shared.dll
target/release/zvec_c_api.dll
```

## Build

```powershell
cargo build -p okr-rag --release
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
node scripts/package_okr_rag_release.js
```

The package is written under `dist/` and includes docs, `okr-rag-workspace/`, the `.okr-rag` scaffold, local model files when present, and `target/release/okr-rag.exe`.

After extracting a package on another machine, build the workspace-local index once with the bundled executable. This does not require Rust or Cargo:

```powershell
target\release\okr-rag.exe ingest --force
```

Packaging scripts do not create or edit project-local Codex config. See [setup-for-agent.md](setup-for-agent.md) for the manual Codex MCP config.

## Setup After Clone

After `git clone`, initialize the local directory scaffold:

```powershell
node scripts/setup_okr_rag_workspace.js
```

This script creates missing runtime/workspace directories, a demo OKR, and placeholder Markdown files only. It does not create or edit the machine-local `.codex/config.toml`; use `.codex/config.toml.example` as the template.

## CLI

```powershell
target\release\okr-rag.exe init
target\release\okr-rag.exe ingest
target\release\okr-rag.exe ingest --force
target\release\okr-rag.exe query "domain driven memory zvec" --top-k 5 --candidate-k 50
target\release\okr-rag.exe status
target\release\okr-rag.exe bench data\okr-memory-benchmark\okr-hybrid-20260623-211957\eval.json --top-k 10 --candidate-k 100
```

Without an explicit `SOURCE_DIR`, `ingest` reads:

```text
okr-rag-workspace/okrs
```

## MCP

Start the stdio MCP server:

```powershell
target\release\okr-rag.exe mcp --root .
```

Install the MCP config in the project-local Codex config:

```text
<CLONE_ROOT>\.codex\config.toml
```

Do not install this project's MCP entry into `%USERPROFILE%\.codex\config.toml` unless you explicitly want it available in every Codex workspace.

Copy the template from `.codex/config.toml.example`:

```toml
[mcp_servers.okr-rag]
type = "stdio"
command = ".\\target\\release\\okr-rag.exe"
args = ["mcp", "--root", "."]
```

Generic MCP config:

```json
{
  "mcpServers": {
    "okr-rag": {
      "command": "<CLONE_ROOT>\\target\\release\\okr-rag.exe",
      "args": ["mcp", "--root", "<CLONE_ROOT>"]
    }
  }
}
```

Tools:

- `okr_rag_status`: show workspace, active slot, index path, concept count, and embedding provider.
- `okr_rag_ingest`: index OKR Markdown into the inactive A/B zvec slot, then make it active.
- `okr_rag_query`: run full hybrid retrieval over the active local index.

See [setup-for-agent.md](setup-for-agent.md) for agent-oriented MCP instructions.

## Hot Sync

`okr-rag mcp` starts a background watcher by default. It watches `okr-rag-workspace/okrs`, debounces changes, rebuilds the inactive A/B slot, and switches active slot only after a successful rebuild.

```powershell
target\release\okr-rag.exe mcp --root .
target\release\okr-rag.exe mcp --root . --no-watch
```

Runtime slot state:

```text
.okr-rag/index/zvec-a/
.okr-rag/index/zvec-b/
.okr-rag/active-slot.json
.okr-rag/ingest-state.json
.okr-rag/watcher-state.json
.okr-rag/ingest.lock
```

The watcher stores a source snapshot, diffs `mtime + size`, accumulates pending changes, debounces them, rebuilds the inactive slot, and scans again to catch changes that happened while rebuilding. `ingest.lock` prevents concurrent rebuilds from multiple MCP or CLI processes.

## Embedding

Runtime embedding is local ONNX MiniLM:

```text
sentence-transformers/all-MiniLM-L6-v2
```

Model files are stored under:

```text
.okr-rag/models/all-MiniLM-L6-v2/
```

`ingest`, `query`, and `mcp` do not call a remote embedding API when the local ONNX model and tokenizer are present. The fallback provider is deterministic local `hash-v1`.

## Performance Knobs

```powershell
$env:OKR_RAG_ONNX_BATCH_SIZE = "16"
$env:OKR_RAG_ONNX_THREADS = "4"
```

MiniLM tokenization uses batch-longest dynamic padding with a 256-token truncation limit.

## Verification

```powershell
cargo fmt
cargo test -p okr-rag
cargo clippy -p okr-rag -- -D warnings
cargo build -p okr-rag --release
target\release\okr-rag.exe ingest
target\release\okr-rag.exe query "domain memory zvec" --top-k 5 --candidate-k 50
```

## Ignore Policy

Generated runtime files stay out of source control, while the demo scaffold and OKR truth stay visible:

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
