# .okf-rag

Derived runtime state for OKF-RAG.

This directory is part of the demo layout so agents see the three core folders:

- `.okf-rag/`
- `okf-rag/`
- `okf-rag-workspace/`

The contents of `.okf-rag/` are not truth. Indexes, caches, watcher state, reports, and local model state may be deleted and rebuilt.

After copying a demo workspace, rebuild runtime state:

```powershell
target\release\okf-rag.exe ingest --root . --force
```
