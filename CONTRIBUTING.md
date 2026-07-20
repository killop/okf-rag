# Contributing

## Development Environment

The current runtime target is Windows x64.

Required tools:

- Rust 1.88 or newer
- Node.js 22 or newer for orchestration tests
- PowerShell

The repository vendors the Windows x64 ONNX Runtime and zvec native libraries used by Cargo builds.

## Validation

Run these checks before opening a pull request:

```powershell
cargo fmt --check
cargo test -p okf-rag
cargo clippy -p okf-rag --no-deps -- -D warnings
cargo build -p okf-rag --release
node --test scripts\okf_llmwiki_daemon.test.js scripts\llmwiki_env.test.js scripts\compile_okf_with_llmwiki.test.js scripts\diagnostics.test.js scripts\okf_maintain.test.js scripts\okf_relationships.test.js
git diff --check
```

## Repository Rules

- Keep API keys in `.okf-rag/llmwiki.env` or process environment variables. Never commit them.
- Do not commit `.okf-rag/`, vector indexes, caches, benchmark runs, packaged releases, or workspace-local binaries.
- Keep reusable OKF Markdown free of host absolute paths.
- Put daemon input under `okf-rag-workspace/raw/<topic>/`; do not edit daemon-managed output as raw input.
- Add focused tests for changes to publishing, deduplication, relationships, MCP behavior, or watcher lifecycle.

## Pull Requests

Describe the behavioral change, compatibility impact, and validation performed. Keep unrelated refactors out of the same pull request.
