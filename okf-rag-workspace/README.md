# okf-rag-workspace

User workspace for OKF-RAG.

This directory is source truth. OKF Markdown files that should be indexed live under:

```text
okf-rag-workspace/okfs/
```

The demo OKF file is:

```text
okf-rag-workspace/okfs/domain-driven-memory-okf.md
```

The workspace-local MCP executable lives here when prebuilt runtime files are available:

```text
okf-rag-workspace/bin/okf-rag.exe
```

Do not put generated indexes, caches, or MCP runtime state here. Those belong under `.okf-rag/`.
