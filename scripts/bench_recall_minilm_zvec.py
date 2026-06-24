"""Recall benchmark for Zvec vector search against exact cosine search.

Builds a Zvec collection from ONNX MiniLM embeddings, computes exact TopK with
NumPy dot products, then reports recall@K and query latency for Zvec.
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

import numpy as np
import zvec

from minilm_onnx_embed import EMBEDDING_DIMENSION, MiniLMOnnxEmbedder


CONTEXTS = ["ordering", "billing", "fulfillment", "catalog", "identity", "support"]
TERMS = [
    "Aggregate roots protect domain invariants",
    "Repositories load and persist aggregate state",
    "Domain services coordinate behavior that does not belong to one entity",
    "Application services orchestrate use cases without owning business rules",
    "Value objects describe immutable domain measurements",
    "Policies encode business decisions in canonical language",
    "Domain events record meaningful facts that already happened",
    "OKF concepts use Markdown frontmatter and evidence paths",
]


@dataclass(frozen=True)
class TimingStats:
    count: int
    min_ms: float
    median_ms: float
    mean_ms: float
    p95_ms: float
    max_ms: float


@dataclass(frozen=True)
class RecallAtK:
    k: int
    recall: float
    exact_total: int
    hit_total: int


@dataclass(frozen=True)
class RecallBenchResult:
    corpus_size: int
    query_count: int
    topk: int
    index_type: str
    vector_source: str
    ef: str
    onnx_file: str
    db_path: str
    doc_embed_ms: float
    query_embed_ms: float
    exact_search_ms: float
    upsert_ms: float
    flush_ms: float
    optimize_ms: float
    recall: list[RecallAtK]
    zvec_query_timing: TimingStats
    zvec_qps: float


def now_id() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def ms_since(start: float) -> float:
    return (time.perf_counter() - start) * 1000.0


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


def parse_csv_ints(value: str) -> list[int]:
    return [int(item.strip()) for item in value.split(",") if item.strip()]


def parse_efs(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def encode_in_chunks(
    embedder: MiniLMOnnxEmbedder,
    texts: list[str],
    batch_size: int,
) -> np.ndarray:
    vectors = []
    for start in range(0, len(texts), batch_size):
        vectors.append(embedder.encode(texts[start : start + batch_size]))
    return np.concatenate(vectors, axis=0)


def make_doc_texts(corpus_size: int) -> list[str]:
    docs: list[str] = []
    for i in range(corpus_size):
        context = CONTEXTS[i % len(CONTEXTS)]
        primary = TERMS[i % len(TERMS)]
        secondary = TERMS[(i * 3 + 1) % len(TERMS)]
        docs.append(
            " ".join(
                [
                    f"{context.title()} domain concept {i}.",
                    primary,
                    secondary,
                    f"source_path=src/{context}/concept_{i}.md",
                    f"bounded_context={context}",
                ]
            )
        )
    return docs


def make_query_texts(query_count: int) -> list[str]:
    queries: list[str] = []
    for i in range(query_count):
        context = CONTEXTS[(i * 5 + 2) % len(CONTEXTS)]
        primary = TERMS[(i * 7 + 3) % len(TERMS)]
        queries.append(
            " ".join(
                [
                    f"Find {context} memory concepts.",
                    primary,
                    "Need source evidence and bounded context information.",
                ]
            )
        )
    return queries


def random_unit_vectors(count: int, dimension: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    vectors = rng.standard_normal((count, dimension), dtype=np.float32)
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    return vectors / np.clip(norms, a_min=1e-12, a_max=None)


def create_schema(index_type: str, hnsw_m: int, hnsw_ef_construction: int) -> zvec.CollectionSchema:
    if index_type == "hnsw":
        index_param = zvec.HnswIndexParam(m=hnsw_m, ef_construction=hnsw_ef_construction)
    elif index_type == "flat":
        index_param = zvec.FlatIndexParam()
    else:
        raise ValueError("--index-type must be flat or hnsw")

    return zvec.CollectionSchema(
        name="domain_memory_recall_bench",
        fields=[
            zvec.FieldSchema("body", zvec.DataType.STRING, nullable=False),
            zvec.FieldSchema("ordinal", zvec.DataType.INT64, nullable=False),
        ],
        vectors=zvec.VectorSchema(
            "embedding",
            zvec.DataType.VECTOR_FP32,
            EMBEDDING_DIMENSION,
            index_param=index_param,
        ),
    )


def upsert_in_chunks(
    collection: zvec.Collection,
    docs: list[zvec.Doc],
    batch_size: int,
) -> None:
    for start in range(0, len(docs), batch_size):
        collection.upsert(docs[start : start + batch_size])


def exact_topk(
    doc_vectors: np.ndarray,
    query_vectors: np.ndarray,
    topk: int,
) -> list[list[int]]:
    scores = query_vectors @ doc_vectors.T
    top_indexes = np.argpartition(-scores, kth=topk - 1, axis=1)[:, :topk]
    sorted_indexes: list[list[int]] = []
    for row, candidates in zip(scores, top_indexes, strict=True):
        ordered = candidates[np.argsort(-row[candidates])]
        sorted_indexes.append([int(item) for item in ordered])
    return sorted_indexes


def make_query_param(index_type: str, ef: str) -> object | None:
    if index_type == "flat" or ef == "default":
        return None
    return zvec.HnswQueryParam(ef=int(ef))


def run_recall_bench(
    *,
    cache_dir: str,
    onnx_file: str,
    corpus_size: int,
    query_count: int,
    topk: int,
    index_type: str,
    hnsw_m: int,
    hnsw_ef_construction: int,
    vector_source: str,
    random_seed: int,
    recall_ks: list[int],
    efs: list[str],
    doc_embed_batch_size: int,
    query_embed_batch_size: int,
    write_batch_size: int,
    query_warmups: int,
    db_root: Path,
    optimize: bool,
) -> list[RecallBenchResult]:
    if max(recall_ks) > topk:
        raise ValueError("--topk must be >= every value in --recall-ks")

    doc_texts = make_doc_texts(corpus_size)
    query_texts = make_query_texts(query_count)

    if vector_source == "minilm":
        embedder = MiniLMOnnxEmbedder(cache_dir=cache_dir, onnx_file=onnx_file)
        start = time.perf_counter()
        doc_vectors = encode_in_chunks(embedder, doc_texts, doc_embed_batch_size)
        doc_embed_ms = ms_since(start)

        start = time.perf_counter()
        query_vectors = encode_in_chunks(embedder, query_texts, query_embed_batch_size)
        query_embed_ms = ms_since(start)
    elif vector_source == "random":
        start = time.perf_counter()
        doc_vectors = random_unit_vectors(corpus_size, EMBEDDING_DIMENSION, random_seed)
        doc_embed_ms = ms_since(start)

        start = time.perf_counter()
        query_vectors = random_unit_vectors(
            query_count,
            EMBEDDING_DIMENSION,
            random_seed + 1,
        )
        query_embed_ms = ms_since(start)
    else:
        raise ValueError("--vector-source must be minilm or random")

    start = time.perf_counter()
    exact = exact_topk(doc_vectors, query_vectors, topk)
    exact_search_ms = ms_since(start)

    db_path = db_root / f"zvec_recall_{corpus_size}_{now_id()}"
    collection = zvec.create_and_open(
        str(db_path),
        create_schema(index_type, hnsw_m, hnsw_ef_construction),
    )
    zvec_docs = [
        zvec.Doc(
            id=f"doc_{i:08d}",
            fields={"body": body, "ordinal": i},
            vectors={"embedding": vector.tolist()},
        )
        for i, (body, vector) in enumerate(zip(doc_texts, doc_vectors, strict=True))
    ]

    start = time.perf_counter()
    upsert_in_chunks(collection, zvec_docs, write_batch_size)
    upsert_ms = ms_since(start)

    start = time.perf_counter()
    collection.flush()
    flush_ms = ms_since(start)

    if optimize:
        start = time.perf_counter()
        collection.optimize()
        optimize_ms = ms_since(start)
    else:
        optimize_ms = 0.0

    results: list[RecallBenchResult] = []
    active_efs = ["default"] if index_type == "flat" else efs
    for ef in active_efs:
        query_param = make_query_param(index_type, ef)
        for _ in range(query_warmups):
            collection.query(
                queries=zvec.Query(
                    field_name="embedding",
                    vector=query_vectors[0].tolist(),
                    param=query_param,
                ),
                topk=topk,
                output_fields=["ordinal"],
            )

        timings: list[float] = []
        retrieved: list[list[int]] = []
        for vector in query_vectors:
            start = time.perf_counter()
            docs = collection.query(
                queries=zvec.Query(
                    field_name="embedding",
                    vector=vector.tolist(),
                    param=query_param,
                ),
                topk=topk,
                output_fields=["ordinal"],
            )
            timings.append(ms_since(start))
            retrieved.append([int(doc.fields["ordinal"]) for doc in docs])

        recall_rows: list[RecallAtK] = []
        for k in recall_ks:
            hit_total = 0
            exact_total = k * query_count
            for exact_ids, retrieved_ids in zip(exact, retrieved, strict=True):
                hit_total += len(set(exact_ids[:k]) & set(retrieved_ids[:k]))
            recall_rows.append(
                RecallAtK(
                    k=k,
                    recall=hit_total / exact_total if exact_total else 0.0,
                    exact_total=exact_total,
                    hit_total=hit_total,
                )
            )

        total_query_ms = sum(timings)
        results.append(
            RecallBenchResult(
                corpus_size=corpus_size,
                query_count=query_count,
                topk=topk,
                index_type=index_type,
                vector_source=vector_source,
                ef=ef,
                onnx_file=onnx_file,
                db_path=str(db_path),
                doc_embed_ms=doc_embed_ms,
                query_embed_ms=query_embed_ms,
                exact_search_ms=exact_search_ms,
                upsert_ms=upsert_ms,
                flush_ms=flush_ms,
                optimize_ms=optimize_ms,
                recall=recall_rows,
                zvec_query_timing=stats(timings),
                zvec_qps=query_count / (total_query_ms / 1000.0),
            )
        )

    return results


def write_markdown_report(path: Path, results: list[RecallBenchResult]) -> None:
    recall_headers = sorted({row.k for result in results for row in result.recall})
    header = [
        "Corpus",
        "Queries",
        "TopK",
        "Index",
        "Vectors",
        "EF",
        "Query median ms",
        "Query p95 ms",
        "QPS",
        "Optimize ms",
        *[f"Recall@{k}" for k in recall_headers],
        "Hits",
    ]
    lines = [
        "# MiniLM ONNX + Zvec Recall Benchmark",
        "",
        f"Generated: {datetime.now().isoformat(timespec='seconds')}",
        "",
        "| " + " | ".join(header) + " |",
        "|" + "|".join(["---:" for _ in header]) + "|",
    ]
    for result in results:
        recall_by_k = {row.k: row for row in result.recall}
        recall_values = [
            f"{recall_by_k[k].recall:.4f}" if k in recall_by_k else ""
            for k in recall_headers
        ]
        hits = ", ".join(
            f"@{row.k} {row.hit_total}/{row.exact_total}" for row in result.recall
        )
        values = [
            str(result.corpus_size),
            str(result.query_count),
            str(result.topk),
            result.index_type,
            result.vector_source,
            result.ef,
            f"{result.zvec_query_timing.median_ms:.3f}",
            f"{result.zvec_query_timing.p95_ms:.3f}",
            f"{result.zvec_qps:.2f}",
            f"{result.optimize_ms:.3f}",
            *recall_values,
            hits,
        ]
        lines.append("| " + " | ".join(values) + " |")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache-dir", default=".cache/huggingface")
    parser.add_argument("--onnx-file", default="onnx/model_O2.onnx")
    parser.add_argument("--corpus-size", type=int, default=1024)
    parser.add_argument("--query-count", type=int, default=100)
    parser.add_argument("--topk", type=int, default=10)
    parser.add_argument("--index-type", choices=["flat", "hnsw"], default="hnsw")
    parser.add_argument("--vector-source", choices=["minilm", "random"], default="minilm")
    parser.add_argument("--random-seed", type=int, default=42)
    parser.add_argument("--hnsw-m", type=int, default=50)
    parser.add_argument("--hnsw-ef-construction", type=int, default=500)
    parser.add_argument("--recall-ks", default="1,5,10")
    parser.add_argument("--efs", default="default,20,50,100,300")
    parser.add_argument("--doc-embed-batch-size", type=int, default=32)
    parser.add_argument("--query-embed-batch-size", type=int, default=32)
    parser.add_argument("--write-batch-size", type=int, default=512)
    parser.add_argument("--query-warmups", type=int, default=2)
    parser.add_argument("--optimize", action="store_true")
    parser.add_argument("--db-root", default="data/recall-runs")
    parser.add_argument("--output-dir", default="reports")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    db_root = Path(args.db_root)
    db_root.mkdir(parents=True, exist_ok=True)

    results = run_recall_bench(
        cache_dir=args.cache_dir,
        onnx_file=args.onnx_file,
        corpus_size=args.corpus_size,
        query_count=args.query_count,
        topk=args.topk,
        index_type=args.index_type,
        hnsw_m=args.hnsw_m,
        hnsw_ef_construction=args.hnsw_ef_construction,
        vector_source=args.vector_source,
        random_seed=args.random_seed,
        recall_ks=parse_csv_ints(args.recall_ks),
        efs=parse_efs(args.efs),
        doc_embed_batch_size=args.doc_embed_batch_size,
        query_embed_batch_size=args.query_embed_batch_size,
        write_batch_size=args.write_batch_size,
        query_warmups=args.query_warmups,
        db_root=db_root,
        optimize=args.optimize,
    )

    run_id = now_id()
    json_path = output_dir / f"bench-recall-minilm-zvec-{run_id}.json"
    md_path = output_dir / f"bench-recall-minilm-zvec-{run_id}.md"
    json_path.write_text(
        json.dumps([asdict(result) for result in results], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    write_markdown_report(md_path, results)
    print(f"Wrote {json_path}")
    print(f"Wrote {md_path}")


if __name__ == "__main__":
    main()
