# okf-rag

Source repository scaffold for the future standalone OKF-RAG GitHub repo.

In this prototype workspace, the active Rust implementation still lives at the project root:

```text
crates/okf-rag/
Cargo.toml
Cargo.lock
third_party/
```

Keep this folder in the demo copy so agents learn the three-folder layout:

- `.okf-rag/`: derived runtime state
- `okf-rag/`: source repository location
- `okf-rag-workspace/`: user-authored OKF truth

When the project is split for GitHub, move the Rust source, docs, vendored native dependency wiring, and MCP setup into this repository.
