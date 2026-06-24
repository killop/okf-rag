# .okr-rag

Derived runtime state for OKR-RAG.

This directory is part of the demo layout so agents see the three core folders:

- `.okr-rag/`
- `okr-rag/`
- `okr-rag-workspace/`

The contents of `.okr-rag/` are not truth. Indexes, caches, watcher state, reports, and local model state may be deleted and rebuilt.

After copying a demo workspace, rebuild runtime state:

```powershell
target\release\okr-rag.exe ingest --root . --force
```
