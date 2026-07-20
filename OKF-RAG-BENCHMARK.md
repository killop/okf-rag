# OKF-RAG Benchmark

Date: 2026-06-24

## Setup

- Binary: `target\release\okf-rag.exe`
- Embedding: `minilm-l6-v2-onnx`
- Model: `.okf-rag/models/all-MiniLM-L6-v2`
- Vector store: local zvec
- Corpus: 53 OKF Markdown concepts
- Eval: `data/okf-memory-benchmark/okf-hybrid-20260623-211957/eval.json`
- Queries: 258
- TopK: 10
- CandidateK requested: 100
- CandidateK effective: 53

## Recall

This eval has one expected OKF concept per query, so recall@K is equivalent to hit@K.

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

The cold cache run uses batched ONNX embedding with dynamic padding. The warm cache run reuses `.okf-rag/cache/embeddings/` vectors and still rebuilds the zvec index. The skipped rebuild path uses `.okf-rag/ingest-state.json` to verify that Markdown content and embedding metadata are unchanged.

## Daemon Incremental Benchmark

Date: 2026-07-17

- OS: Windows 10 10.0.19045
- CPU: Intel Core i7-9700K, 8 cores / 8 logical processors
- Memory: 63.9 GB
- System Node: v22.11.0
- llmwiki runtime: Node 24.16.0 with `llm-wiki-compiler@1.1.0`
- OpenAI-compatible model: `gpt-5.4-mini`
- Source corpus for the full pipeline sample: one Markdown file producing 5-8 concepts

The local benchmark drives the real daemon watcher in `--stage-only` mode. It includes `fs.watch`, debounce, child process startup, content hashing, manifest updates, stable source synchronization, and deletion propagation. It does not call an LLM or Rust ingest.

### MCP Startup Isolation

Date: 2026-07-20

The release MCP binary now flushes `tools/list` before starting its incremental watcher thread. A direct JSON-RPC timing run in the U3D workspace measured:

| Measurement | Result |
|---|---:|
| Process start to `initialize` response | 1116.31 ms |
| `initialize` round trip | 1006.38 ms |
| `tools/list` round trip | 0.56 ms |
| Watcher state update after `tools/list` | 2 ms |

A pending-change run inserted one temporary OKF concept before MCP startup. `tools/list` still completed in 0.58 ms. Queries continued reading 2 concepts from slot `b` while the watcher rebuilt slot `a`; after the background refresh they saw 3 concepts. Deleting the temporary source triggered another background refresh and restored 2 concepts in slot `b`. Both refreshes reported `ok`.

Reproduce it with:

```powershell
node scripts\bench_okf_daemon_incremental.js --iterations 10 --debounce-ms 250 --json
node scripts\bench_okf_daemon_incremental.js --iterations 5 --debounce-ms 1500 --json
```

| Local daemon run | Samples | Trigger P50/P95 ms | Bridge P50/P95 ms | Total P50/P95 ms |
|---|---:|---:|---:|---:|
| Pre-warmed, 250 ms debounce | 13 | 262.76 / 265.05 | 101.80 / 117.96 | 365.05 / 382.35 |
| Default 1500 ms debounce, warm events only | 7 | 1506.70 / 1510.93 | 107.87 / 220.31 | 1612.32 / 1731.25 |
| Reconciler + daemon state, 250 ms debounce | 13 | 273.14 / 357.60 | 125.72 / 561.08 | 395.62 / 918.67 |
| Source manifest v2 + sanitized state, 50 ms debounce | 13 | 87.00 / 161.16 | 131.40 / 470.09 | 216.77 / 558.95 |

The first event in the default-debounce run took 6648.77 ms total: 1561.00 ms waiting for debounce and 5087.77 ms resolving and starting the cold llmwiki runtime. Later events did not repeat that cost.

The full pipeline benchmark includes llmwiki compile/export, OKF synchronization, and Rust MiniLM/zvec ingest:

| Full pipeline run | Samples | Avg ms | P50 ms | P95/max ms | Result |
|---|---:|---:|---:|---:|---|
| No source content change | 5 | 4248.81 | 4257.42 | 4885.13 | llmwiki reported all sources up to date; Rust skipped unchanged work |
| No source content change, fast-skip enabled | 10 | 154.14 | 115.36 | 432.51 | provider/runtime/export/Rust were not started |
| Add one rule to one source file | 1 | 63980.23 | 63980.23 | 63980.23 | 6 concepts extracted, 8 pages exported, Rust cache hits/misses 2/6 |
| Revert that source file | 1 | 42991.23 | 42991.23 | 42991.23 | 5 concepts extracted, but 8 pages remained in the incremental project |
| Clean project rebuild | 1 | 42613.16 | 42613.16 | 42613.16 | 6 concepts extracted/exported, Rust cache hits/misses 0/6 |

Findings:

- Warm daemon bookkeeping is about 100-220 ms. The configured debounce and remote LLM latency dominate end-to-end update time.
- Before fast-skip, an unchanged full pass cost about 4.25 seconds because llmwiki refreshed its index and probed page embeddings. Source/content and publication-option checks now bypass llmwiki entirely: P50 dropped to 115.36 ms, about a 97% reduction.
- File-level source synchronization is incremental and deletion-aware.
- Concept extraction is not deterministic: the same original source produced 5 concepts in an earlier clean run and 6 concepts in the clean benchmark rebuild.
- Concept-level pruning is incomplete in `llm-wiki-compiler@1.1.0`: after changing and reverting the source, three historical near-duplicate pages remained until the project was reset. Automatic OKF generation is operational, but automatic dedupe/pruning needs another layer before production use.

## Directed Relationship Benchmark

Date: 2026-07-20

This benchmark exercises the deterministic relationship reconciler without an LLM. Each synthetic concept explicitly links to the next concept with a `depends on` sentence. The expected graph therefore contains exactly `N-1` directed `depends_on` edges and no automatic reverse edges.

Reproduce it with:

```powershell
node scripts\bench_okf_relationships.js --sizes 100,500,1000 --iterations 7
```

| Concepts | Expected/actual edges | Precision | Recall | False reverse edges | Orphans | P50/P95 ms |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 99 / 99 | 1.000 | 1.000 | 0 | 0 | 2.03 / 2.27 |
| 500 | 499 / 499 | 1.000 | 1.000 | 0 | 0 | 25.74 / 28.41 |
| 1000 | 999 / 999 | 1.000 | 1.000 | 0 | 0 | 94.56 / 99.80 |

The quality numbers are deterministic synthetic checks, not a claim about LLM relation extraction accuracy. They prove that explicit evidence is preserved directionally, predicates are emitted correctly, and the reconciler does not invent reciprocal edges.

## Optimizations Applied

- Added embedding cache keyed by embedding provider, model path, and full embedding text hash.
- Added batch ONNX embedding for ingest.
- Changed ONNX intra-op thread default from 1 to 4.
- Added `OKF_RAG_ONNX_BATCH_SIZE` and `OKF_RAG_ONNX_THREADS` environment overrides.
- Changed MiniLM tokenization from fixed 256-token padding to batch-longest dynamic padding.
- Made ingest load the ONNX model only after an embedding cache miss.
- Added source fingerprint state so unchanged Markdown skips derived index rebuilds.
- Added source manifest v2 with stable adapter/source-instance ownership and mtime-only no-op preservation.
- Replaced reciprocal similarity links with evidence-backed directed predicates and graph audit metadata.
- Added staged local Markdown link validation and OKF v0.1 bundle-root indexes.
- Added centralized credential redaction for daemon state, provider output, and stream-adapter failures.

## Raw Output

- `.okf-rag/reports/okf-rag-bench-minilm-onnx-release-optimized.json`
- `.okf-rag/reports/okf-rag-bench-minilm-onnx-release-dynamic-padding.json`
