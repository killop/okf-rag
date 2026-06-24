# okr-rag

Source repository scaffold for the future standalone OKR-RAG GitHub repo.

In this prototype workspace, the active Rust implementation still lives at the project root:

```text
crates/okr-rag/
Cargo.toml
Cargo.lock
third_party/
```

Keep this folder in the demo copy so agents learn the three-folder layout:

- `.okr-rag/`: derived runtime state
- `okr-rag/`: source repository location
- `okr-rag-workspace/`: user-authored OKR truth

When the project is split for GitHub, move the Rust source, docs, vendored native dependency wiring, and MCP setup into this repository.
