# Setup For Agent

This file teaches an agent how to use `okf-rag` as a local MCP memory service.

## Mental Model

Use three directories consistently:

- `.okf-rag/`: derived runtime state. It is temporary and may be deleted.
- `okf-rag/`: the Rust source repository when published.
- `okf-rag-workspace/`: user workspace. OKF Markdown truth files live in `okf-rag-workspace/okfs/`.

Do not treat `.okf-rag/` as truth. Only Markdown under `okf-rag-workspace/okfs/` is user-authored OKF memory.

## Demo Copy Contract

When setting up or copying this project for another agent, copy the three core directories together:

```text
.okf-rag/
okf-rag/
okf-rag-workspace/
```

Their roles are different:

- `.okf-rag/` is the runtime scaffold and derived cache area. It exists in the demo so agents know the directory name, but its generated contents are disposable.
- `okf-rag/` is the source repository location. In this prototype, it is a scaffold; the active Rust crate currently lives under `crates/okf-rag/`.
- `okf-rag-workspace/` is the user workspace and must include demo OKF truth files under `okf-rag-workspace/okfs/`.

For a user-facing release package, also include the prebuilt runtime artifacts so consumers do not need to compile Rust:

```text
target/release/okf-rag.exe
target/release/onnxruntime.dll
target/release/onnxruntime_providers_shared.dll
target/release/zvec_c_api.dll
```

Use the packaging script when publishing:

```powershell
node scripts/package_okf_rag_release.js
```

After extraction, run the bundled executable once to build the local index:

```powershell
target\release\okf-rag.exe ingest --force
```

## Clone Setup Script

After `git clone`, initialize the local scaffold:

```powershell
node scripts/setup_okf_rag_workspace.js
```

The setup script creates only basic directories and missing placeholder Markdown:

```text
.okf-rag/
.okf-rag/models/
.codex/
.codex/config.toml.example
okf-rag/
okf-rag-workspace/
okf-rag-workspace/okfs/
okf-rag-workspace/okfs/local-first-okf-rag-demo.md
dist/
```

It must not create, edit, or validate the machine-local `.codex/config.toml`. Project-local Codex config is an explicit manual setup step documented below.

After copying the demo or extracting a release package, rebuild the runtime index instead of trusting copied stale state:

```powershell
target\release\okf-rag.exe ingest --root . --force
```

The ignore policy should keep source and OKF truth trackable, while ignoring generated runtime files:

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

## Install Location

Project-local Codex setup is manual. Setup and packaging scripts must not create, edit, or validate `.codex/config.toml`.

If Codex should load this MCP server for the cloned workspace, create the project-local config file yourself:

```text
<CLONE_ROOT>\.codex\config.toml
```

You can start from the checked-in template:

```text
<CLONE_ROOT>\.codex\config.toml.example
```

Do not install this project's `okf-rag` MCP server into the user-level Codex config unless the user explicitly asks for a global install:

```text
C:\Users\<USER>\.codex\config.toml
```

Project-local install keeps `okf-rag` scoped to this workspace and prevents it from appearing in unrelated Codex sessions.

Preferred project-local TOML uses paths relative to the clone root:

```toml
[mcp_servers.okf-rag]
type = "stdio"
command = ".\\target\\release\\okf-rag.exe"
args = ["mcp", "--root", "."]
```

If your Codex host does not resolve relative paths from the project root, use absolute paths for `command` and `--root`. After changing this file, restart the Codex session so the MCP server list is reloaded.

## Start MCP

Use the release binary when available:

```powershell
target\release\okf-rag.exe mcp --root .
```

Generic stdio MCP config:

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

The MCP server starts a background watcher by default. If the host needs manual indexing only:

```powershell
target\release\okf-rag.exe mcp --root . --no-watch
```

## MCP Tools

Use `okf_rag_status` first.

Arguments:

```json
{ "root": "." }
```

Use `okf_rag_query` to retrieve OKF memory.

Arguments:

```json
{
  "query": "domain driven memory retrieval zvec",
  "top_k": 5,
  "candidate_k": 50,
  "root": "."
}
```

Use `okf_rag_ingest` only when you need to force or manually trigger indexing.

Arguments:

```json
{
  "root": ".",
  "source": "okf-rag-workspace\\okfs",
  "force": false
}
```

If `source` is omitted, it defaults to `okf-rag-workspace/okfs`.

## Agent Workflow

1. Call `okf_rag_status`.
2. Query before editing if you need project memory.
3. Create, edit, or delete OKF Markdown only under `okf-rag-workspace/okfs/`.
4. If MCP watcher is running, wait briefly and query again. Added, modified, and deleted files are indexed automatically.
5. If watcher is disabled or status looks stale, call `okf_rag_ingest`.
6. Never edit `.okf-rag/index/*`, `.okf-rag/cache/*`, `.okf-rag/active-slot.json`, or `.okf-rag/ingest-state.json` directly.

## Hot Sync Guarantees

The watcher uses snapshot diffing, debounce, and A/B slots:

- Current queries read the active slot.
- Dirty Markdown triggers rebuild of the inactive slot.
- `active-slot.json` changes only after the inactive slot rebuild succeeds.
- If rebuild fails, queries keep using the previous active slot.
- Follow-up scanning catches changes that happened while rebuild was running.
- `ingest.lock` prevents concurrent rebuilds from multiple MCP or CLI processes.

Useful state files:

```text
.okf-rag/active-slot.json
.okf-rag/ingest-state.json
.okf-rag/watcher-state.json
.okf-rag/ingest.lock
```

## CLI Fallback

When MCP is unavailable:

```powershell
target\release\okf-rag.exe status
target\release\okf-rag.exe ingest
target\release\okf-rag.exe query "domain memory zvec" --top-k 5 --candidate-k 50
```

## Local Embedding

Runtime embedding is local-first:

- Provider: `minilm-l6-v2-onnx`
- Model path: `.okf-rag/models/all-MiniLM-L6-v2/`
- Vector store: local zvec

No remote embedding API is required for `ingest`, `query`, or `mcp` when the local ONNX model exists.
