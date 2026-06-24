# OKF-RAG Runtime

Setup and release packaging place the runnable MCP executable and required DLLs here:

```text
okf-rag-workspace/bin/okf-rag.exe
okf-rag-workspace/bin/onnxruntime.dll
okf-rag-workspace/bin/onnxruntime_providers_shared.dll
okf-rag-workspace/bin/zvec_c_api.dll
```

Point MCP hosts at this workspace-local executable, not at a repository build directory.

