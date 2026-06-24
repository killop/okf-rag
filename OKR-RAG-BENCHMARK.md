# OKR-RAG Benchmark

Date: 2026-06-24

## Setup

- Binary: `target\release\okr-rag.exe`
- Embedding: `minilm-l6-v2-onnx`
- Model: `.okr-rag/models/all-MiniLM-L6-v2`
- Vector store: local zvec
- Corpus: 53 OKR Markdown concepts
- Eval: `data/okr-memory-benchmark/okr-hybrid-20260623-211957/eval.json`
- Queries: 258
- TopK: 10
- CandidateK requested: 100
- CandidateK effective: 53

## Recall

This eval has one expected OKR concept per query, so recall@K is equivalent to hit@K.

| Metric | Value |
|---|---:|
| hit@1 / recall@1 | 0.9535 |
| hit@3 / recall@3 | 0.9845 |
| hit@5 / recall@5 | 0.9922 |
| hit@10 / recall@10 | 1.0000 |
| MRR@10 | 0.9700 |

## Recall By Query Type

| Query Type | Count | hit@1 | hit@5 | hit@10 |
|---|---:|---:|---:|---:|
| disclosure | 53 | 1.0000 | 1.0000 | 1.0000 |
| key_result | 53 | 0.8302 | 0.9623 | 1.0000 |
| metric | 46 | 1.0000 | 1.0000 | 1.0000 |
| objective | 53 | 0.9434 | 1.0000 | 1.0000 |
| summary | 53 | 1.0000 | 1.0000 | 1.0000 |

## Speed

Hot path benchmark loads the ONNX model and zvec collection once, then runs all 258 queries.

| Stage | Total ms | Avg ms | P50 ms | P95 ms | Min ms | Max ms |
|---|---:|---:|---:|---:|---:|---:|
| Total query | 1374.331 | 5.327 | 5.280 | 6.285 | 4.275 | 7.104 |
| ONNX embedding | 896.165 | 3.474 | 3.419 | 4.355 | 2.612 | 5.070 |
| zvec + rerank | 478.073 | 1.853 | 1.845 | 2.016 | 1.663 | 2.205 |

Cold CLI query, including process startup and ONNX session load, averaged 314.342 ms over 5 runs.

## ONNX Thread Sweep

Dynamic padding made 4 ONNX intra-op threads the fastest tested default for this eval.

| ONNX Threads | recall@10 | Avg Total ms | P95 Total ms | Avg Embedding ms | Avg zvec ms |
|---:|---:|---:|---:|---:|---:|
| 1 | 1.0000 | 8.745 | 11.129 | 6.719 | 2.026 |
| 2 | 1.0000 | 6.857 | 8.428 | 4.766 | 2.091 |
| 4 | 1.0000 | 5.661 | 6.691 | 3.576 | 2.084 |
| 8 | 1.0000 | 6.194 | 10.308 | 4.136 | 2.058 |

## Ingest

Release build ingest results:

| Run | Cache Hits | Cache Misses | Total ms |
|---|---:|---:|---:|
| Cold embedding cache, forced rebuild | 0 | 53 | 1834.119 |
| Warm embedding cache, forced rebuild | 53 | 0 | 190.061 |
| Unchanged source, skipped rebuild | 0 | 0 | 71.584 |

The cold cache run uses batched ONNX embedding with dynamic padding. The warm cache run reuses `.okr-rag/cache/embeddings/` vectors and still rebuilds the zvec index. The skipped rebuild path uses `.okr-rag/ingest-state.json` to verify that Markdown content and embedding metadata are unchanged.

## Optimizations Applied

- Added embedding cache keyed by embedding provider, model path, and full embedding text hash.
- Added batch ONNX embedding for ingest.
- Changed ONNX intra-op thread default from 1 to 4.
- Added `OKR_RAG_ONNX_BATCH_SIZE` and `OKR_RAG_ONNX_THREADS` environment overrides.
- Changed MiniLM tokenization from fixed 256-token padding to batch-longest dynamic padding.
- Made ingest load the ONNX model only after an embedding cache miss.
- Added source fingerprint state so unchanged Markdown skips derived index rebuilds.

## Raw Output

- `.okr-rag/reports/okr-rag-bench-minilm-onnx-release-optimized.json`
- `.okr-rag/reports/okr-rag-bench-minilm-onnx-release-dynamic-padding.json`
