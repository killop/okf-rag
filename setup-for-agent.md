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

## Target Workspace

Install OKF-RAG into the project root where the current agent is working. Call this path `WORKDIR`.

Capture `WORKDIR` before changing directory to read or build the `okf-rag` source repo. In Codex, this is the directory shown in the session header, not the directory that contains this README.

```powershell
$WORKDIR = (Get-Location).Path
```

Do not use the `okf-rag` source repository path, a previous project path, or a hardcoded local example as `WORKDIR`. The source repo is only where the installer and release artifacts come from.

## Workspace Setup Script

Run the setup script against `WORKDIR`. If the script is in the current directory, this is enough:

```powershell
node scripts/setup_okf_rag_workspace.js --target $WORKDIR
```

If the setup script lives in a separate cloned `okf-rag` source repo, still install into the current `WORKDIR`:

```powershell
node <OKF_RAG_REPO>\scripts\setup_okf_rag_workspace.js --target $WORKDIR --runtime-source <OKF_RAG_REPO>\target\release
```

The setup script creates basic directories, creates one demo OKF file, copies the bundled MiniLM model when the installation source includes it, removes stale non-MiniLM derived index state, installs the OKF writing skill into `.agents/skills/`, updates the project `.gitignore`, and copies prebuilt runtime artifacts into `okf-rag-workspace/bin/` when they are available from `target/release` or `--runtime-source`.

The script refuses to run without `--target`, and it refuses to install into the `okf-rag` source repo by default. This is intentional, so an agent cannot accidentally install into the source repo after reading its README.

```text
.okf-rag/
.okf-rag/models/
.okf-rag/models/all-MiniLM-L6-v2/onnx/model.onnx
.okf-rag/models/all-MiniLM-L6-v2/tokenizer.json
okf-rag-workspace/
okf-rag-workspace/bin/
okf-rag-workspace/okfs/
okf-rag-workspace/okfs/local-first-okf-rag-demo.md
.agents/skills/okf-rag-okf-format/SKILL.md
```

It must not create, edit, or validate any `.codex/config.toml`. Project-local Codex config is an explicit manual setup step documented below.

After copying the demo or extracting a release package, rebuild the runtime index instead of trusting copied stale state:

```powershell
okf-rag-workspace\bin\okf-rag.exe ingest --root $WORKDIR --force
```

The ignore policy should keep source and OKF truth trackable, while ignoring derived runtime files.

The setup script writes this rule to the repository's tracked ignore file in `WORKDIR`, normally:

```text
<WORKDIR>\.gitignore
```

Do not put OKF-RAG ignore rules in `.git/info/exclude`; that is local-only state and other agents will not see it.

```gitignore
# OKF-RAG local memory
/.okf-rag/
!/okf-rag-workspace/
!/okf-rag-workspace/**
```

Do not add ignore rules for `okf-rag-workspace/`. Its OKF Markdown, runtime binary, DLLs, and README files should remain visible to the project.

## Install Location

Project-local Codex setup is manual. Setup scripts must not create, edit, or validate `.codex/config.toml`.

The MCP executable for agents must be the workspace-local binary:

```text
<WORKDIR>\okf-rag-workspace\bin\okf-rag.exe
```

Do not point normal agent MCP config at a repository build output such as `target\release\okf-rag.exe`. Build outputs are maintainer artifacts; the workspace-local `bin` directory is the install location agents should use.

If Codex should load this MCP server for the current workspace, create the project-local config file yourself:

```text
<WORKDIR>\.codex\config.toml
```

If you are installing into the `okf-rag` source repo itself, you can start from the checked-in template:

```text
<WORKDIR>\.codex\config.toml.example
```

For any other user workspace, use the TOML snippet below directly instead of copying extra directories into the workspace.

Do not install this project's `okf-rag` MCP server into the user-level Codex config unless the user explicitly asks for a global install:

```text
C:\Users\<USER>\.codex\config.toml
```

Project-local install keeps `okf-rag` scoped to this workspace and prevents it from appearing in unrelated Codex sessions.

Recommended project-local TOML uses paths relative to the current workspace. Because this file lives at `<WORKDIR>\.codex\config.toml`, keep the MCP command and root relative:

```toml
[mcp_servers.okf-rag]
type = "stdio"
command = ".\\okf-rag-workspace\\bin\\okf-rag.exe"
args = ["mcp", "--root", ".", "--no-watch"]
```

Codex stdio startup should use `--no-watch` so `tools/list` returns quickly and startup is not coupled to background file watching. If an agent writes absolute paths here, replace them with the relative form above. Restart Codex from `WORKDIR` so the MCP server list is reloaded.

Equivalent generic stdio MCP config:

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

## Start MCP

Use the release binary when available. For Codex stdio MCP, prefer `--no-watch`:

```powershell
okf-rag-workspace\bin\okf-rag.exe mcp --root . --no-watch
```

For hosts that cannot resolve relative paths from the workspace root, fix the host working directory instead of copying an absolute path from another project.

Generic stdio MCP config with explicit workspace-relative paths:

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

The MCP server starts a background watcher by default when `--no-watch` is omitted. Use watcher mode only for an intentionally long-running process outside Codex startup:

```powershell
okf-rag-workspace\bin\okf-rag.exe mcp --root .
```

## MCP Tools

Use `okf_rag_status` first.

Arguments:

```json
{ "root": "." }
```

Use `okf_rag_query` to retrieve OKF memory.

Once `okf_rag_query` has been used for a lookup, keep using MCP results for that lookup. Do not run shell text searches such as `rg`, `grep`, `Select-String`, or broad `Get-ChildItem | Select-String` over `okf-rag-workspace/okfs` to re-find the same OKF content. Use returned `hits[].source_path`, open the parent folder's `index.md` directly when the hit belongs to a bundle, or issue another `okf_rag_query` with improved natural-language terms. Shell is only appropriate for targeted reads/lists of known paths, file edits, or MCP troubleshooting.

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
There is no hash embedding fallback. Missing `onnx/model.onnx` or `tokenizer.json` is a setup error.
The setup script should copy the model from the okf-rag source or release package into the target workspace when that source includes `.okf-rag/models/all-MiniLM-L6-v2/`.
