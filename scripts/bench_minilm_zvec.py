"""Benchmark ONNX MiniLM embeddings and Zvec vector retrieval.

Runs repeatable micro-benchmarks for local embedding generation, Zvec writes,
flushes, and vector query latency. Results are written as JSON and Markdown.
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable

import zvec
import numpy as np

from minilm_onnx_embed import EMBEDDING_DIMENSION, MiniLMOnnxEmbedder


SHORT_TEXT = "Ordering uses canonical domain terms for order lifecycle decisions."
MEDIUM_TEXT = (
    "A domain memory concept records a bounded context, its ubiquitous language, "
    "evidence sources, relationships to neighboring contexts, and the rules that "
    "make business decisions understandable across teams."
)
LONG_TEXT = " ".join(
    [
        "The domain-driven memory system stores concepts with evidence paths,",
        "frontmatter, source hashes, bounded context tags, and concept types.",
        "It combines semantic embeddings with Zvec vector retrieval, scalar",
        "filters, and optional full-text search for exact domain terms.",
    ]
    * 24
)


@dataclass(frozen=True)
class TimingStats:
    count: int
    min_ms: float
    median_ms: float
    mean_ms: float
    p95_ms: float
    max_ms: float


@dataclass(frozen=True)
class EmbeddingBenchResult:
    onnx_file: str
    text_profile: str
    batch_size: int
    repeats: int
    warmups: int
    total_texts: int
    total_ms: float
    texts_per_second: float
    dimensions: int
    timing: TimingStats


@dataclass(frozen=True)
class ZvecBenchResult:
    corpus_size: int
    query_count: int
    query_warmups: int
    doc_embed_batch_size: int
    write_batch_size: int
    topk: int
    db_path: str
    embed_docs_ms: float
    upsert_ms: float
    flush_ms: float
    query_embed_timing: TimingStats
    query_zvec_timing: TimingStats
    query_end_to_end_timing: TimingStats
    qps_zvec_only: float
    qps_end_to_end: float


def parse_csv_ints(value: str) -> list[int]:
    return [int(item.strip()) for item in value.split(",") if item.strip()]


def parse_csv_strings(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, round((len(ordered) - 1) * pct)))
    return ordered[index]


def stats(values: list[float]) -> TimingStats:
    if not values:
        return TimingStats(0, 0.0, 0.0, 0.0, 0.0, 0.0)
    return TimingStats(
        count=len(values),
        min_ms=min(values),
        median_ms=statistics.median(values),
        mean_ms=statistics.mean(values),
        p95_ms=percentile(values, 0.95),
        max_ms=max(values),
    )


def now_id() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def ms_since(start: float) -> float:
    return (time.perf_counter() - start) * 1000.0


def text_profiles() -> dict[str, str]:
    return {
        "short": SHORT_TEXT,
        "medium": MEDIUM_TEXT,
        "long": LONG_TEXT,
    }


def run_embedding_bench(
    *,
    cache_dir: str,
    onnx_file: str,
    batch_sizes: Iterable[int],
    profile_names: Iterable[str],
    repeats: int,
    warmups: int,
) -> list[EmbeddingBenchResult]:
    embedder = MiniLMOnnxEmbedder(cache_dir=cache_dir, onnx_file=onnx_file)
    profiles = text_profiles()
    results: list[EmbeddingBenchResult] = []

    for profile_name in profile_names:
        text = profiles[profile_name]
        for batch_size in batch_sizes:
            batch = [f"{text} sample={i}" for i in range(batch_size)]
            for _ in range(warmups):
                embedder.encode(batch)

            timings: list[float] = []
            total_start = time.perf_counter()
            for _ in range(repeats):
                start = time.perf_counter()
                vectors = embedder.encode(batch)
                timings.append(ms_since(start))
                if vectors.shape[-1] != EMBEDDING_DIMENSION:
                    raise RuntimeError(f"Unexpected embedding dimension: {vectors.shape}")
            total_ms = ms_since(total_start)
            total_texts = batch_size * repeats
            results.append(
                EmbeddingBenchResult(
                    onnx_file=onnx_file,
                    text_profile=profile_name,
                    batch_size=batch_size,
                    repeats=repeats,
                    warmups=warmups,
                    total_texts=total_texts,
                    total_ms=total_ms,
                    texts_per_second=total_texts / (total_ms / 1000.0),
                    dimensions=EMBEDDING_DIMENSION,
                    timing=stats(timings),
                )
            )
    return results


def create_schema() -> zvec.CollectionSchema:
    return zvec.CollectionSchema(
        name="domain_memory_bench",
        fields=[
            zvec.FieldSchema("title", zvec.DataType.STRING, nullable=False),
            zvec.FieldSchema("body", zvec.DataType.STRING, nullable=False),
            zvec.FieldSchema("domain_context", zvec.DataType.STRING, nullable=False),
            zvec.FieldSchema("ordinal", zvec.DataType.INT64, nullable=False),
        ],
        vectors=zvec.VectorSchema(
            "embedding",
            zvec.DataType.VECTOR_FP32,
            EMBEDDING_DIMENSION,
        ),
    )


def make_docs(corpus_size: int) -> list[dict[str, str | int]]:
    contexts = ["ordering", "billing", "fulfillment", "catalog", "identity", "support"]
    profiles = list(text_profiles().values())
    docs: list[dict[str, str | int]] = []
    for i in range(corpus_size):
        context = contexts[i % len(contexts)]
        body = profiles[i % len(profiles)]
        docs.append(
            {
                "id": f"doc_{i:08d}",
                "title": f"{context.title()} concept {i}",
                "body": f"{body} corpus_ordinal={i} bounded_context={context}",
                "domain_context": context,
                "ordinal": i,
            }
        )
    return docs


def doc_text(doc: dict[str, str | int]) -> str:
    return f"{doc['title']}\n\n{doc['body']}"


def encode_in_chunks(
    embedder: MiniLMOnnxEmbedder,
    texts: list[str],
    batch_size: int,
) -> np.ndarray:
    vectors = []
    for start in range(0, len(texts), batch_size):
        vectors.append(embedder.encode(texts[start : start + batch_size]))
    return np.concatenate(vectors, axis=0)


def upsert_in_chunks(
    collection: zvec.Collection,
    docs: list[zvec.Doc],
    batch_size: int,
) -> None:
    for start in range(0, len(docs), batch_size):
        collection.upsert(docs[start : start + batch_size])


def run_zvec_bench(
    *,
    cache_dir: str,
    onnx_file: str,
    db_root: Path,
    corpus_sizes: Iterable[int],
    query_count: int,
    topks: Iterable[int],
    query_warmups: int,
    doc_embed_batch_size: int,
    write_batch_size: int,
) -> list[ZvecBenchResult]:
    embedder = MiniLMOnnxEmbedder(cache_dir=cache_dir, onnx_file=onnx_file)
    results: list[ZvecBenchResult] = []

    for corpus_size in corpus_sizes:
        docs = make_docs(corpus_size)
        start = time.perf_counter()
        vectors = encode_in_chunks(
            embedder,
            [doc_text(doc) for doc in docs],
            doc_embed_batch_size,
        )
        embed_docs_ms = ms_since(start)

        db_path = db_root / f"zvec_corpus_{corpus_size}_{now_id()}"
        collection = zvec.create_and_open(str(db_path), create_schema())
        zvec_docs = [
            zvec.Doc(
                id=str(doc["id"]),
                fields={
                    "title": str(doc["title"]),
                    "body": str(doc["body"]),
                    "domain_context": str(doc["domain_context"]),
                    "ordinal": int(doc["ordinal"]),
                },
                vectors={"embedding": vector.tolist()},
            )
            for doc, vector in zip(docs, vectors, strict=True)
        ]

        start = time.perf_counter()
        upsert_in_chunks(collection, zvec_docs, write_batch_size)
        upsert_ms = ms_since(start)

        start = time.perf_counter()
        collection.flush()
        flush_ms = ms_since(start)

        query_texts = [
            f"Find {docs[i % corpus_size]['domain_context']} concept with evidence and canonical language {i}"
            for i in range(query_count)
        ]
        query_vectors = []
        query_embed_timings: list[float] = []
        for text in query_texts:
            start = time.perf_counter()
            query_vectors.append(embedder.encode(text).tolist())
            query_embed_timings.append(ms_since(start))

        for topk in topks:
            warmup_vector = query_vectors[0]
            for _ in range(query_warmups):
                collection.query(
                    queries=zvec.Query(field_name="embedding", vector=warmup_vector),
                    topk=topk,
                    output_fields=["title", "domain_context", "ordinal"],
                )

            zvec_timings: list[float] = []
            end_to_end_timings: list[float] = []
            for text, vector in zip(query_texts, query_vectors, strict=True):
                start = time.perf_counter()
                collection.query(
                    queries=zvec.Query(field_name="embedding", vector=vector),
                    topk=topk,
                    output_fields=["title", "domain_context", "ordinal"],
                )
                zvec_ms = ms_since(start)
                zvec_timings.append(zvec_ms)

                start = time.perf_counter()
                encoded = embedder.encode(text).tolist()
                collection.query(
                    queries=zvec.Query(field_name="embedding", vector=encoded),
                    topk=topk,
                    output_fields=["title", "domain_context", "ordinal"],
                )
                end_to_end_timings.append(ms_since(start))

            zvec_total_ms = sum(zvec_timings)
            end_to_end_total_ms = sum(end_to_end_timings)
            results.append(
                ZvecBenchResult(
                    corpus_size=corpus_size,
                    query_count=query_count,
                    query_warmups=query_warmups,
                    doc_embed_batch_size=doc_embed_batch_size,
                    write_batch_size=write_batch_size,
                    topk=topk,
                    db_path=str(db_path),
                    embed_docs_ms=embed_docs_ms,
                    upsert_ms=upsert_ms,
                    flush_ms=flush_ms,
                    query_embed_timing=stats(query_embed_timings),
                    query_zvec_timing=stats(zvec_timings),
                    query_end_to_end_timing=stats(end_to_end_timings),
                    qps_zvec_only=query_count / (zvec_total_ms / 1000.0),
                    qps_end_to_end=query_count / (end_to_end_total_ms / 1000.0),
                )
            )
    return results


def to_jsonable(items: list[object]) -> list[dict[str, object]]:
    return [asdict(item) for item in items]


def write_markdown_report(
    path: Path,
    embedding_results: list[EmbeddingBenchResult],
    zvec_results: list[ZvecBenchResult],
) -> None:
    lines = [
        "# MiniLM ONNX + Zvec Benchmark",
        "",
        f"Generated: {datetime.now().isoformat(timespec='seconds')}",
        "",
        "## Embedding",
        "",
        "| ONNX | Profile | Batch | Median ms | P95 ms | Texts/s |",
        "|---|---|---:|---:|---:|---:|",
    ]
    for result in embedding_results:
        lines.append(
            "| {onnx} | {profile} | {batch} | {median:.3f} | {p95:.3f} | {tps:.2f} |".format(
                onnx=result.onnx_file,
                profile=result.text_profile,
                batch=result.batch_size,
                median=result.timing.median_ms,
                p95=result.timing.p95_ms,
                tps=result.texts_per_second,
            )
        )

    lines.extend(
        [
            "",
            "## Zvec",
            "",
            "| Corpus | TopK | Upsert ms | Flush ms | Query median ms | Query p95 ms | Zvec QPS | E2E median ms | E2E QPS |",
            "|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for result in zvec_results:
        lines.append(
            "| {corpus} | {topk} | {upsert:.3f} | {flush:.3f} | {qmed:.3f} | {qp95:.3f} | {qps:.2f} | {emed:.3f} | {eqps:.2f} |".format(
                corpus=result.corpus_size,
                topk=result.topk,
                upsert=result.upsert_ms,
                flush=result.flush_ms,
                qmed=result.query_zvec_timing.median_ms,
                qp95=result.query_zvec_timing.p95_ms,
                qps=result.qps_zvec_only,
                emed=result.query_end_to_end_timing.median_ms,
                eqps=result.qps_end_to_end,
            )
        )

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache-dir", default=".cache/huggingface")
    parser.add_argument("--onnx-files", default="onnx/model.onnx")
    parser.add_argument("--batch-sizes", default="1,4,16")
    parser.add_argument("--text-profiles", default="short,medium,long")
    parser.add_argument("--embedding-repeats", type=int, default=5)
    parser.add_argument("--embedding-warmups", type=int, default=1)
    parser.add_argument("--corpus-sizes", default="32,128")
    parser.add_argument("--query-count", type=int, default=10)
    parser.add_argument("--query-warmups", type=int, default=2)
    parser.add_argument("--doc-embed-batch-size", type=int, default=32)
    parser.add_argument("--write-batch-size", type=int, default=512)
    parser.add_argument("--topks", default="1,5")
    parser.add_argument("--output-dir", default="reports")
    parser.add_argument("--db-root", default="data/bench-runs")
    parser.add_argument("--embedding-only", action="store_true")
    parser.add_argument("--zvec-only", action="store_true")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    db_root = Path(args.db_root)
    db_root.mkdir(parents=True, exist_ok=True)

    onnx_files = parse_csv_strings(args.onnx_files)
    batch_sizes = parse_csv_ints(args.batch_sizes)
    profile_names = parse_csv_strings(args.text_profiles)
    corpus_sizes = parse_csv_ints(args.corpus_sizes)
    topks = parse_csv_ints(args.topks)

    embedding_results: list[EmbeddingBenchResult] = []
    zvec_results: list[ZvecBenchResult] = []

    for onnx_file in onnx_files:
        if not args.zvec_only:
            embedding_results.extend(
                run_embedding_bench(
                    cache_dir=args.cache_dir,
                    onnx_file=onnx_file,
                    batch_sizes=batch_sizes,
                    profile_names=profile_names,
                    repeats=args.embedding_repeats,
                    warmups=args.embedding_warmups,
                )
            )
        if not args.embedding_only:
            zvec_results.extend(
                run_zvec_bench(
                    cache_dir=args.cache_dir,
                    onnx_file=onnx_file,
                    db_root=db_root,
                    corpus_sizes=corpus_sizes,
                    query_count=args.query_count,
                    topks=topks,
                    query_warmups=args.query_warmups,
                    doc_embed_batch_size=args.doc_embed_batch_size,
                    write_batch_size=args.write_batch_size,
                )
            )

    run_id = now_id()
    json_path = output_dir / f"bench-minilm-zvec-{run_id}.json"
    md_path = output_dir / f"bench-minilm-zvec-{run_id}.md"
    payload = {
        "embedding": to_jsonable(embedding_results),
        "zvec": to_jsonable(zvec_results),
    }
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    write_markdown_report(md_path, embedding_results, zvec_results)

    print(f"Wrote {json_path}")
    print(f"Wrote {md_path}")


if __name__ == "__main__":
    main()
