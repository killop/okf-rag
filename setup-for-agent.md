# Setup For Agent

This file teaches an agent how to use `okf-rag` as a local MCP memory service.

## Mental Model

Use two workspace directories consistently:

- `.okf-rag/`: derived runtime state. It is temporary and may be deleted.
- `okf-rag-workspace/`: user workspace and runtime install location. OKF Markdown truth files live in `okf-rag-workspace/okfs/`, and the workspace-local executable lives in `okf-rag-workspace/bin/`.

Do not treat `.okf-rag/` as truth. Only Markdown under `okf-rag-workspace/okfs/` is user-authored OKF memory.

## Demo Copy Contract

When setting up or copying this project for another agent, copy the two workspace directories together:

```text
.okf-rag/
okf-rag-workspace/
```

Their roles are different:

- `.okf-rag/` is the runtime scaffold and derived cache area. It exists in the demo so agents know the directory name, but its generated contents are disposable.
- `okf-rag-workspace/` is the user workspace and must include demo OKF truth files under `okf-rag-workspace/okfs/` plus the workspace-local runtime under `okf-rag-workspace/bin/`.

The Rust source repository is the cloned `okf-rag` repo itself. Do not create or copy a nested `okf-rag/` scaffold directory inside the user workspace.

For a user-facing release package, also include the prebuilt runtime artifacts inside the user workspace so consumers do not need to compile Rust:

```text
okf-rag-workspace/bin/okf-rag.exe
okf-rag-workspace/bin/onnxruntime.dll
okf-rag-workspace/bin/onnxruntime_providers_shared.dll
okf-rag-workspace/bin/zvec_c_api.dll
```

Use the packaging script when publishing:

```powershell
node scripts/package_okf_rag_release.js
```

After extraction, run the bundled executable once to build the local index:

```powershell
okf-rag-workspace\bin\okf-rag.exe ingest --force
```

## Clone Setup Script

After `git clone`, initialize the local scaffold:

```powershell
node scripts/setup_okf_rag_workspace.js
```

The setup script creates basic directories, missing placeholder Markdown, and copies prebuilt runtime artifacts into `okf-rag-workspace/bin/` when they are available from `target/release` or `--runtime-source`:

```text
.okf-rag/
.okf-rag/models/
okf-rag-workspace/
okf-rag-workspace/bin/
okf-rag-workspace/okfs/
okf-rag-workspace/okfs/local-first-okf-rag-demo.md
```

It must not create, edit, or validate any `.codex/config.toml`. Project-local Codex config is an explicit manual setup step documented below.

After copying the demo or extracting a release package, rebuild the runtime index instead of trusting copied stale state:

```powershell
okf-rag-workspace\bin\okf-rag.exe ingest --root . --force
```

The ignore policy should keep source and OKF truth trackable, while ignoring generated runtime files:

```gitignore
/.okf-rag/*
!/.okf-rag/README.md
!/.okf-rag/.gitkeep
/.codex/*
!/.codex/
!/.codex/config.toml.example
!/okf-rag-workspace/
```

## Install Location

Project-local Codex setup is manual. Setup scripts must not create, edit, or validate `.codex/config.toml`.

The MCP executable for agents must be the workspace-local binary:

```text
<WORKDIR>\okf-rag-workspace\bin\okf-rag.exe
```

Do not point normal agent MCP config at a repository build output such as `target\release\okf-rag.exe`. Build outputs are maintainer artifacts; the workspace-local `bin` directory is the install location agents should use.

If Codex should load this MCP server for the cloned workspace, create the project-local config file yourself:

```text
<CLONE_ROOT>\.codex\config.toml
```

If you are inside the `okf-rag` source repo, you can start from the checked-in template:

```text
<CLONE_ROOT>\.codex\config.toml.example
```

For any other user workspace, use the TOML snippet below directly instead of copying extra directories into the workspace.

Do not install this project's `okf-rag` MCP server into the user-level Codex config unless the user explicitly asks for a global install:

```text
C:\Users\<USER>\.codex\config.toml
```

Project-local install keeps `okf-rag` scoped to this workspace and prevents it from appearing in unrelated Codex sessions.

Preferred project-local TOML uses paths relative to the clone root:

```toml
[mcp_servers.okf-rag]
type = "stdio"
command = ".\\okf-rag-workspace\\bin\\okf-rag.exe"
args = ["mcp", "--root", "."]
```

If your Codex host does not resolve relative paths from the project root, use absolute paths for `command` and `--root`. After changing this file, restart the Codex session so the MCP server list is reloaded.

## Start MCP

Use the release binary when available:

```powershell
okf-rag-workspace\bin\okf-rag.exe mcp --root .
```

Generic stdio MCP config:

```json
{
  "mcpServers": {
    "okf-rag": {
      "command": "<WORKDIR>\\okf-rag-workspace\\bin\\okf-rag.exe",
      "args": ["mcp", "--root", "<WORKDIR>"]
    }
  }
}
```

The MCP server starts a background watcher by default. If the host needs manual indexing only:

```powershell
okf-rag-workspace\bin\okf-rag.exe mcp --root . --no-watch
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
okf-rag-workspace\bin\okf-rag.exe status
okf-rag-workspace\bin\okf-rag.exe ingest
okf-rag-workspace\bin\okf-rag.exe query "domain memory zvec" --top-k 5 --candidate-k 50
```

## Local Embedding

Runtime embedding is local-first:

- Provider: `minilm-l6-v2-onnx`
- Model path: `.okf-rag/models/all-MiniLM-L6-v2/`
- Vector store: local zvec

No remote embedding API is required for `ingest`, `query`, or `mcp` when the local ONNX model exists.
