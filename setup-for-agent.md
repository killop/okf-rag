# Setup For Agent

This file teaches an agent how to use `okr-rag` as a local MCP memory service.

## Mental Model

Use three directories consistently:

- `.okr-rag/`: derived runtime state. It is temporary and may be deleted.
- `okr-rag/`: the Rust source repository when published.
- `okr-rag-workspace/`: user workspace. OKR Markdown truth files live in `okr-rag-workspace/okrs/`.

Do not treat `.okr-rag/` as truth. Only Markdown under `okr-rag-workspace/okrs/` is user-authored OKR memory.

## Demo Copy Contract

When setting up or copying this project for another agent, copy the three core directories together:

```text
.okr-rag/
okr-rag/
okr-rag-workspace/
```

Their roles are different:

- `.okr-rag/` is the runtime scaffold and derived cache area. It exists in the demo so agents know the directory name, but its generated contents are disposable.
- `okr-rag/` is the source repository location. In this prototype, it is a scaffold; the active Rust crate currently lives under `crates/okr-rag/`.
- `okr-rag-workspace/` is the user workspace and must include demo OKR truth files under `okr-rag-workspace/okrs/`.

For a user-facing release package, also include the prebuilt runtime artifacts so consumers do not need to compile Rust:

```text
target/release/okr-rag.exe
target/release/onnxruntime.dll
target/release/onnxruntime_providers_shared.dll
target/release/zvec_c_api.dll
```

Use the packaging script when publishing:

```powershell
node scripts/package_okr_rag_release.js
```

After extraction, run the bundled executable once to build the local index:

```powershell
target\release\okr-rag.exe ingest --force
```

## Clone Setup Script

After `git clone`, initialize the local scaffold:

```powershell
node scripts/setup_okr_rag_workspace.js
```

The setup script creates only basic directories and missing placeholder Markdown:

```text
.okr-rag/
.okr-rag/models/
.codex/
.codex/config.toml.example
okr-rag/
okr-rag-workspace/
okr-rag-workspace/okrs/
okr-rag-workspace/okrs/local-first-okr-rag-demo.md
dist/
```

It must not create, edit, or validate the machine-local `.codex/config.toml`. Project-local Codex config is an explicit manual setup step documented below.

After copying the demo or extracting a release package, rebuild the runtime index instead of trusting copied stale state:

```powershell
target\release\okr-rag.exe ingest --root . --force
```

The ignore policy should keep source and OKR truth trackable, while ignoring generated runtime files:

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

Do not install this project's `okr-rag` MCP server into the user-level Codex config unless the user explicitly asks for a global install:

```text
C:\Users\<USER>\.codex\config.toml
```

Project-local install keeps `okr-rag` scoped to this workspace and prevents it from appearing in unrelated Codex sessions.

Preferred project-local TOML uses paths relative to the clone root:

```toml
[mcp_servers.okr-rag]
type = "stdio"
command = ".\\target\\release\\okr-rag.exe"
args = ["mcp", "--root", "."]
```

If your Codex host does not resolve relative paths from the project root, use absolute paths for `command` and `--root`. After changing this file, restart the Codex session so the MCP server list is reloaded.

## Start MCP

Use the release binary when available:

```powershell
target\release\okr-rag.exe mcp --root .
```

Generic stdio MCP config:

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

The MCP server starts a background watcher by default. If the host needs manual indexing only:

```powershell
target\release\okr-rag.exe mcp --root . --no-watch
```

## MCP Tools

Use `okr_rag_status` first.

Arguments:

```json
{ "root": "." }
```

Use `okr_rag_query` to retrieve OKR memory.

Arguments:

```json
{
  "query": "domain driven memory retrieval zvec",
  "top_k": 5,
  "candidate_k": 50,
  "root": "."
}
```

Use `okr_rag_ingest` only when you need to force or manually trigger indexing.

Arguments:

```json
{
  "root": ".",
  "source": "okr-rag-workspace\\okrs",
  "force": false
}
```

If `source` is omitted, it defaults to `okr-rag-workspace/okrs`.

## Agent Workflow

1. Call `okr_rag_status`.
2. Query before editing if you need project memory.
3. Create, edit, or delete OKR Markdown only under `okr-rag-workspace/okrs/`.
4. If MCP watcher is running, wait briefly and query again. Added, modified, and deleted files are indexed automatically.
5. If watcher is disabled or status looks stale, call `okr_rag_ingest`.
6. Never edit `.okr-rag/index/*`, `.okr-rag/cache/*`, `.okr-rag/active-slot.json`, or `.okr-rag/ingest-state.json` directly.

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
.okr-rag/active-slot.json
.okr-rag/ingest-state.json
.okr-rag/watcher-state.json
.okr-rag/ingest.lock
```

## CLI Fallback

When MCP is unavailable:

```powershell
target\release\okr-rag.exe status
target\release\okr-rag.exe ingest
target\release\okr-rag.exe query "domain memory zvec" --top-k 5 --candidate-k 50
```

## Local Embedding

Runtime embedding is local-first:

- Provider: `minilm-l6-v2-onnx`
- Model path: `.okr-rag/models/all-MiniLM-L6-v2/`
- Vector store: local zvec

No remote embedding API is required for `ingest`, `query`, or `mcp` when the local ONNX model exists.
