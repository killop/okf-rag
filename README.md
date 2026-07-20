<h1 align="center">okf-rag</h1>

<p align="center">
  <strong>Turn raw Markdown into deduplicated, linked OKF knowledge and query it locally through MCP.</strong>
  <br />
  <em>llm-wiki production pipeline · Rust consumption runtime · Local MiniLM · zvec hybrid retrieval</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Rust-1.88%2B-000000?style=flat&logo=rust&logoColor=white" alt="Rust 1.88+" />
  <img src="https://img.shields.io/badge/Protocol-MCP-2563EB?style=flat" alt="MCP" />
  <img src="https://img.shields.io/badge/Embedding-Local_MiniLM-10B981?style=flat" alt="Local MiniLM" />
  <img src="https://img.shields.io/badge/Vector_Index-zvec-8B5CF6?style=flat" alt="zvec" />
  <img src="https://img.shields.io/badge/Runtime-Windows_x64-0078D4?style=flat&logo=windows&logoColor=white" alt="Windows x64" />
  <a href="https://github.com/killop/okf-rag/actions/workflows/ci.yml"><img src="https://github.com/killop/okf-rag/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/killop/okf-rag" alt="Apache-2.0" /></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="README-CN.md">中文</a>
</p>

## Why okf-rag

| Capability | What it provides |
|---|---|
| Markdown truth | OKF v0.1 concept files remain readable, diffable, portable, and independent of the vector index. |
| Automatic knowledge production | A supervised daemon turns Raw Markdown into topic bundles through `llm-wiki-compiler`, ownership reconciliation, exact dedupe, link extraction, validation, and atomic publication. |
| Wiki-like knowledge graph | Obsidian wikilinks, outgoing relations, incoming backlinks, confidence, and evidence are preserved in published concepts and manifests. |
| Local retrieval | Rust uses local ONNX MiniLM embeddings, an embedding cache, zvec vector/full-text fields, and lexical reranking. No remote embedding API is used. |
| Non-blocking incremental updates | MCP completes `initialize` and `tools/list` before starting its watcher. Rebuilds target the inactive A/B slot while queries continue using the active slot. |
| Portable agent integration | Project-scoped MCP config, workspace-local binaries, installed skills, stream-only OpenAI compatibility, rollback snapshots, and workspace mirroring are included. |

## Quick Start

### Build the runtime

```powershell
git clone https://github.com/killop/okf-rag.git
Set-Location okf-rag
cargo build -p okf-rag --release
```

Release-package users can skip this step and use the bundled executable.

Source checkouts also need the local embedding model before installation:

```powershell
python -m pip install "huggingface-hub>=1.5"
hf download sentence-transformers/all-MiniLM-L6-v2 tokenizer.json onnx/model.onnx `
  --local-dir .okf-rag/models/all-MiniLM-L6-v2
```

Release packages can include this model and do not require the download step.

### Install into a project workspace

```powershell
$WORKDIR = "F:\path\to\your-project"
node scripts\setup_okf_rag_workspace.js --target $WORKDIR --runtime-source target\release
Set-Location $WORKDIR
```

### Build the initial local index

```powershell
okf-rag-workspace\bin\okf-rag.exe ingest --root . --force
okf-rag-workspace\bin\okf-rag.exe query --root . "domain memory zvec" --top-k 5 --candidate-k 50
```

### Start automatic Raw Markdown consumption

```powershell
node okf-rag-workspace\tools\okf_llmwiki_daemon.js start `
  --bundle project-knowledge
```

Add `.md` files under `okf-rag-workspace/raw/project-knowledge/`. Successful daemon runs publish `okf-rag-workspace/okfs/project-knowledge/` and run Rust ingest automatically.

## Architecture (ASCII)

`okf-rag` separates knowledge production from local knowledge consumption. The Node/LLM plane proposes and reconciles OKF; the Rust plane indexes and serves only the published Markdown truth.

### End-to-End Knowledge Flow

```text
+---------------------------- Producer plane: Node + LLM -----------------------------+
|                                                                                      |
|  Agent / user                                                                        |
|      |                                                                               |
|      v                                                                               |
|  raw/<topic>/*.md                                                                    |
|      |  fs.watch + debounce                                                          |
|      v                                                                               |
|  daemon supervisor -> worker -> source manifest v2                                  |
|                                      |                                               |
|                                      v                                               |
|                         llm-wiki-compiler candidates + links                         |
|                                      |                                               |
|                                      v                                               |
|  ownership/prune -> exact dedupe -> directed graph -> validate -> staged publish    |
|                                      |                                               |
+--------------------------------------|-----------------------------------------------+
                                       v
                     okfs/<topic>/index.md + concept Markdown
                                       |
+--------------------------------------|-----------------------------------------------+
|                       Consumer plane: Rust, local only                               |
|                                      v                                               |
|  ingest -> MiniLM ONNX -> embedding cache -> inactive zvec slot                     |
|                                                   | successful build                 |
|                                                   v                                  |
|  Codex / agent <- MCP query <- hybrid recall + lexical rerank <- active slot pointer |
|                                                                                      |
+--------------------------------------------------------------------------------------+
```

For stream-only OpenAI-compatible providers, `openai_stream_adapter.js` runs on loopback, converts llmwiki requests to streamed upstream calls, and reassembles text and tool-call responses. Secrets stay in environment variables and are redacted from daemon state and diagnostics.

### MCP Startup and Background A/B Refresh

```text
Codex / MCP client          okf-rag MCP process         watcher thread         zvec
        |                           |                         |                   |
        |------ initialize -------> |                         |                   |
        | <---- initialize result - |                         |                   |
        |------ tools/list -------->|                         |                   |
        | <------- tool list -------|                         |                   |
        |                           |------ spawn ----------->|                   |
        |                           |                         | snapshot + diff   |
        |------ query ------------->|------------------------------ read active A |
        | <------- old truth -------|                         |                   |
        |                           |                         | debounce          |
        |                           |                         | ingest.lock       |
        |                           |                         |---- build B ----->|
        |------ query ------------->|------------------------------ read active A |
        |                           |                         |                   |
        |                           |                         | atomic switch A->B|
        |------ query ------------->|------------------------------ read active B |
```

Automatic refresh is background work. Explicit `okf_rag_ingest` remains synchronous so its caller receives a definitive completion result.

### Workspace and State Boundaries

```text
project-root/
|
+-- .codex/config.toml                    project-scoped MCP registration
+-- .agents/skills/okf-rag-okf-format/   agent instructions + OKF spec reference
+-- okf-rag-workspace/
|   +-- raw/<topic>/*.md                  daemon input
|   +-- okfs/
|   |   +-- index.md                      bundle catalog, not concept truth
|   |   +-- <topic>/
|   |       +-- index.md                  progressive disclosure
|   |       +-- overview.md               concept truth
|   |       +-- <concept>.md              concept truth + directed links
|   +-- bin/                               okf-rag.exe + native DLLs
|   +-- tools/                             pipeline, daemon, maintenance, benchmark
|
+-- .okf-rag/                             disposable derived/runtime state
    +-- models/all-MiniLM-L6-v2/          local embedding model
    +-- index/zvec-a|zvec-b/               A/B indexes
    +-- cache/embeddings/                  content-addressed embedding cache
    +-- llmwiki-projects|exports|sync/     compiler and reconciliation state
    +-- generations/<topic>/               five rollback snapshots
    +-- llmwiki-daemon/                    PID, heartbeat, stage, errors, logs
```

### Component Responsibilities

| Component | Responsibility |
|---|---|
| `okf_llmwiki_daemon.js` | Watches a topic inbox, supervises the worker, debounces changes, exposes status, and reruns the full bridge. |
| `compile_okf_with_llmwiki.js` | Synchronizes Raw Markdown, manages the persistent llmwiki runtime/project, exports candidates, reconciles ownership and duplicates, validates, publishes, mirrors, and invokes ingest. |
| `openai_stream_adapter.js` | Adapts non-stream llmwiki calls to an upstream API that only accepts `stream: true`, including streamed tool calls. |
| `okf_maintain.js` / `okf_relationships.js` | Validate OKF, refresh indexes, audit duplicates/orphans, and build evidence-backed directed relationships. |
| Rust `okf-rag` | Parse OKF, embed locally, build zvec A/B indexes, serve CLI/MCP status, ingest, query, and benchmark commands. |
| zvec | Store vectors and searchable metadata used by hybrid recall and local reranking. |

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

## Project Structure

```text
crates/okf-rag/                     Rust CLI, MCP server, MiniLM and zvec runtime
scripts/                            producer pipeline, daemon, reconcile, tests, benchmarks
skills/okf-rag-okf-format/          installable Agent skill and bundled OKF v0.1 reference
okf-rag-workspace/
|-- raw/                            default daemon inbox root
|-- okfs/                           checked-in OKF Markdown truth
|-- bin/                            portable executable and native DLLs
`-- tools/                          scripts copied into target workspaces
third_party/
|-- zvec-rust/                      vendored Rust binding
|-- zvec-prebuilt-x86_64-pc-windows-msvc/
`-- onnxruntime/                    native ONNX Runtime files
data/                               retrieval benchmark corpora and eval sets
OKF-RAG-BENCHMARK.md                benchmark methods and measured results
setup-for-agent.md                  project-local installation and MCP contract
```

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Knowledge format | OKF v0.1 Markdown + YAML frontmatter | Portable concept truth, indexes, citations, and standard Markdown links. |
| Producer runtime | Node.js, Node 24 portable runtime | Pipeline orchestration, daemon supervision, manifests, validation, atomic publication, and mirroring. |
| Semantic producer | `llm-wiki-compiler@1.1.0` | Extract candidate concepts and explicit links from Raw Markdown. |
| LLM compatibility | OpenAI-compatible streaming adapter | Support upstream APIs that require streamed text and tool calls. |
| Consumer runtime | Rust 1.88+ | CLI, stdio MCP, local ingest, query, watcher, locking, and benchmarks. |
| Embedding | ONNX Runtime + `all-MiniLM-L6-v2` | Local 384-dimensional semantic embeddings with dynamic padding and caching. |
| Retrieval | zvec | Vector and searchable metadata storage for hybrid retrieval. |
| Integration | Model Context Protocol | Project-scoped agent status, ingest, and query tools. |

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

The setup script refuses to run without `--target`, and it refuses to install into the `okf-rag` source repo. Do not point `--target` at the source repo when installing for another project. This script creates missing runtime/workspace directories, copies the bundled MiniLM model when present, removes stale non-MiniLM derived index state, installs the OKF skill into `.agents/skills/`, installs portable orchestration tools into `okf-rag-workspace/tools/`, creates the preserved `.okf-rag/INSTRUCTIONS.md`, updates managed blocks in `AGENTS.md` and `CLAUDE.md`, writes the tracked `.gitignore` rules, and creates one demo OKF file. It does not create or edit `.codex/config.toml`; copy the TOML snippet from [setup-for-agent.md](setup-for-agent.md).

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

## Generate OKF with llm-wiki-compiler

Automatic generation is a proposal-to-truth pipeline. `llm-wiki-compiler` proposes semantic concepts and links; the OKF reconciler decides the published file set; Rust consumes the resulting Markdown. The compiler output is never treated as final truth directly.

From the source repository:

```powershell
node scripts\okf_pipeline.js --source <markdown-file-or-directory> --bundle <topic-slug>
```

From an installed project workspace:

```powershell
node okf-rag-workspace\tools\okf_pipeline.js --source <markdown-file-or-directory> --bundle <topic-slug>
```

The persistent state is split by responsibility:

| Path | Contents |
|---|---|
| `.okf-rag/llmwiki-projects/<topic>/` | Persistent llmwiki source and concept state. |
| `.okf-rag/llmwiki-source-sync/<topic>.json` | Source manifest v2: adapter, stable source identity, raw/compiler hashes, timestamps, ownership, and deletion propagation. |
| `.okf-rag/llmwiki-exports/<topic>/` | Temporary OKF export candidates. |
| `.okf-rag/publish-staging/` | Complete bundle assembled and validated before publication. |
| `.okf-rag/llmwiki-sync/<topic>.json` | Reconcile manifest v3: generations, canonical IDs, aliases, ownership, directed relations, duplicates, orphans, and hashes. |
| `okf-rag-workspace/okfs/<topic>/` | Atomically published OKF bundle. |

Publication performs authoritative pruning of managed concepts, conservative exact dedupe, source ownership reconciliation, directed relationship extraction, broken-link validation, host-absolute-path rejection, graph audit, deterministic folder indexes, and an atomic directory switch. Generated relationship blocks use Obsidian `[[file|title]]` links with separate Outgoing and Backlinks sections. Semantic direction remains in `outbound_relations` and `inbound_relations`; a navigation backlink does not create a reverse semantic edge. Concept `source_refs` point to bundle-local `references/` documents, while mirrored source documents use portable `okf-source://` URIs. Modified stale generated files are recovered under the bundle's `references/recovered/` directory, which Rust skips during ingest.

Each generated topic contains an OKF v0.1 bundle-root `index.md`; `okfs/index.md` is a deterministic catalog of bundles. `okf-rag-workspace/index.md` is not generated because that workspace also contains runtime artifacts.

### Stream-Only OpenAI-Compatible Provider

Keep credentials in the process environment:

```powershell
$env:OPENAI_BASE_URL = "https://your-gateway.example/v1"
$env:OPENAI_API_KEY = "your-secret-key"
$env:LLMWIKI_MODEL = "your-model-name"
```

Probe both streamed text and streamed tool calls before compiling:

```powershell
node scripts\openai_stream_adapter.js --probe
```

Then run:

```powershell
node scripts\okf_pipeline.js `
  --source E:\repo\docs `
  --bundle repo-docs `
  --provider openai `
  --stream-only-openai `
  --concurrency 1
```

The loopback adapter never prints the API key. If the upstream has no embeddings API, llmwiki skips its optional semantic embeddings; final retrieval embeddings still come from the local Rust MiniLM runtime.

Use `--stage-only` to verify Raw Markdown synchronization and manifests without making LLM calls:

```powershell
node scripts\okf_pipeline.js --source E:\repo\docs --bundle repo-docs --stage-only
```

### Daemon and Raw Inbox

Start one daemon per topic. With no `--source`, it creates and recursively watches `okf-rag-workspace/raw/<topic-slug>/`:

```powershell
node okf-rag-workspace\tools\okf_llmwiki_daemon.js start `
  --bundle <topic-slug>

node okf-rag-workspace\tools\okf_llmwiki_daemon.js status --bundle <topic-slug> --json
node okf-rag-workspace\tools\okf_llmwiki_daemon.js stop --bundle <topic-slug>
```

The background command runs a supervisor plus worker. The supervisor restarts failed workers with increasing backoff. State under `.okf-rag/llmwiki-daemon/` records the supervisor/worker PID, inbox, source paths, heartbeat, pending reason, pipeline stage, last duration, and sanitized error.

Do not manually edit a daemon-managed `okfs/<topic-slug>/` bundle as source input. Put corrections in the Raw Markdown or `.okf-rag/INSTRUCTIONS.md`; the next reconcile may replace generated files. The daemon also compares the published bundle with its sync manifest. If the topic directory, index, or any managed output disappears, it queues background recovery with a 30-second retry backoff.

### Rollback and Workspace Mirror

Successful publication retains the five most recent local generation snapshots:

```powershell
node okf-rag-workspace\tools\okf_generation.js list --bundle <topic-slug>
node okf-rag-workspace\tools\okf_generation.js rollback --bundle <topic-slug> --generation <generation-id>
```

Use `--mirror-workspace <directory>` on the pipeline or daemon to copy the prepared runtime, tools, and OKF workspace to another project after a successful run.

Rust writes `type`, `okf_bundle`, `canonical_id`, `okf_generation`, `parent_id`, `source_document`, `section_path`, `aliases`, `source_refs`, `outbound_relations`, and `inbound_relations` into zvec alongside the embedding and recall fields. Query hits return these values, and `okf_rag_relationships` resolves a canonical ID, path, exact title, URI, or alias into outgoing and incoming neighbors.

## Configuration

Project-local LLM settings live in a Git-ignored file:

```text
.okf-rag/llmwiki.env
```

Setup creates `.okf-rag/llmwiki.env.example`. The pipeline, daemon, and `openai_stream_adapter.js --probe` load the real file automatically from the project root. Explicit process environment variables override file values. The file is not copied by `--mirror-workspace`, is never published as OKF knowledge, and its values are never returned by daemon status.

```dotenv
LLMWIKI_PROVIDER=openai
OPENAI_BASE_URL=https://your-gateway.example/v1
OPENAI_API_KEY=your-secret-key
LLMWIKI_MODEL=your-model-name
LLMWIKI_STREAM_ONLY_OPENAI=true
LLMWIKI_OUTPUT_LANG=Chinese
LLMWIKI_COMPILE_CONCURRENCY=1
```

| Variable | Used by | Purpose | Default |
|---|---|---|---|
| `LLMWIKI_PROVIDER` | Pipeline/daemon | llmwiki provider such as `claude-agent`, `openai`, or `ollama`. | Provider-specific |
| `LLMWIKI_MODEL` | Pipeline/adapter | Model used for concept extraction and stream probe. | Required by selected provider |
| `OPENAI_BASE_URL` | Stream adapter | OpenAI-compatible upstream base URL. | None |
| `OPENAI_API_KEY` | Stream adapter | Upstream credential; never place it in commands or Markdown. | None |
| `LLMWIKI_STREAM_ONLY_OPENAI` | Pipeline/daemon | Enable the loopback adapter for upstream APIs that require `stream: true`. | `false` |
| `LLMWIKI_OUTPUT_LANG` | Pipeline/daemon | Generated wiki language. | `Chinese` |
| `LLMWIKI_COMPILE_CONCURRENCY` | Pipeline/daemon | Maximum concurrent llmwiki LLM calls. | llmwiki default |
| `OKF_RAG_MIRROR_WORKSPACE` | Pipeline/daemon | Workspace copied after successful publication. | Disabled |
| `OKF_RAG_ONNX_BATCH_SIZE` | Rust ingest | MiniLM embedding batch size. | Runtime default |
| `OKF_RAG_ONNX_THREADS` | Rust ingest/query | ONNX intra-op thread count. | Runtime default |

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
args = ["mcp", "--root", "."]
```

Generic MCP config:

```json
{
  "mcpServers": {
    "okf-rag": {
      "command": ".\\okf-rag-workspace\\bin\\okf-rag.exe",
      "args": ["mcp", "--root", "."]
    }
  }
}
```

Tools:

- `okf_rag_status`: show workspace, active slot, index path, concept count, and embedding provider.
- `okf_rag_ingest`: index OKF Markdown into the inactive A/B zvec slot, then make it active.
- `okf_rag_query`: run full hybrid retrieval over the active local index. Hits include routing and relation metadata plus `route_trace`; `retrieval_policy.mode = "mcp"` tells agents to refine through MCP or read returned paths instead of repeating the corpus search with shell tools.
- `okf_rag_relationships`: return one concept's outgoing relations, incoming backlinks, neighbor titles, and workspace-relative Markdown paths.

See [setup-for-agent.md](setup-for-agent.md) for agent-oriented MCP instructions.

## Hot Sync

`okf-rag mcp` starts background services only after the MCP `tools/list` response has been flushed. It scans `okf-rag-workspace/raw/<topic>/`, idempotently starts the workspace-local llmwiki daemon for every topic containing Markdown, and then starts the OKF watcher. Missing generated bundles are recovered by the daemon; published OKF changes are rebuilt in the inactive zvec slot. None of this work participates in Codex startup timeout. Use `--no-watch` only when both automatic generation and automatic indexing are intentionally disabled.

```powershell
okf-rag-workspace\bin\okf-rag.exe mcp --root .
okf-rag-workspace\bin\okf-rag.exe mcp --root . --no-watch
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

The watcher stores a source snapshot, diffs `mtime + size`, accumulates pending changes, debounces them, rebuilds the inactive slot, and scans again to catch changes that happened while rebuilding. Queries continue using the previous active slot until the new slot is complete. `ingest.lock` prevents concurrent rebuilds from multiple MCP or CLI processes.

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
cargo clippy -p okf-rag --no-deps -- -D warnings
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
/okf-rag-workspace/bin/*
!/okf-rag-workspace/bin/README.md
/okf-rag-workspace/raw/*
!/okf-rag-workspace/raw/.gitkeep
```

Do not ignore `okf-rag-workspace/okfs/`; it contains the portable Markdown truth and demos. Runtime binaries belong in generated release packages rather than Git.

## Contributing and Security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development checks and [SECURITY.md](SECURITY.md) for private vulnerability reporting and credential handling.

## License

okf-rag is licensed under the [Apache License 2.0](LICENSE). Vendored dependency notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
