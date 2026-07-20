# okf-rag-workspace

User workspace for OKF-RAG.

This directory is source truth. OKF Markdown files that should be indexed live under:

```text
okf-rag-workspace/okfs/
```

Raw Markdown that should be converted by a topic daemon lives under:

```text
okf-rag-workspace/raw/<topic-slug>/
```

Starting `okf_llmwiki_daemon.js` with `--bundle <topic-slug>` and no `--source`
creates and watches that inbox. Add, edit, or delete `.md` files there; the daemon
runs the compile, reconcile, publish, and Rust ingest pipeline. Do not manually edit
the generated `okfs/<topic-slug>/` bundle as the input source.

Project-local provider settings and credentials live outside this portable workspace:

```text
.okf-rag/llmwiki.env
```

Use `.okf-rag/llmwiki.env.example` as the template. The file is ignored by Git and is
not mirrored with `okf-rag-workspace/`.

The demo OKF file is:

```text
okf-rag-workspace/okfs/domain-driven-memory-okf.md
```

The workspace-local MCP executable lives here when prebuilt runtime files are available:

```text
okf-rag-workspace/bin/okf-rag.exe
```

Portable pipeline and daemon scripts are installed under:

```text
okf-rag-workspace/tools/
```

Do not put generated vector indexes, caches, or MCP runtime state here. Those belong under `.okf-rag/`. Deterministic Markdown navigation indexes may live under `okfs/`.
