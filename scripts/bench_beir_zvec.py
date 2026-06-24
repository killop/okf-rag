"""Run Zvec + MiniLM retrieval benchmarks on external BEIR datasets.

Downloads BEIR-style corpus/query/qrels files from Hugging Face, builds a
local Zvec index, and reports standard recall-oriented retrieval metrics.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import shutil
import statistics
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Sequence

import pyarrow.parquet as pq
import zvec
from huggingface_hub import hf_hub_download

from minilm_onnx_embed import EMBEDDING_DIMENSION, MiniLMOnnxEmbedder


TOP_KS = (1, 5, 10, 20, 50, 100)
MARKER_FILE = ".beir-zvec.json"


@dataclass(frozen=True)
class BeirDoc:
    doc_id: str
    title: str
    text: str

    @property
    def embedding_text(self) -> str:
        title = self.title.strip()
        text = self.text.strip()
        if title and text:
            return f"title: {title}\n\ntext: {text}"
        return title or text


@dataclass(frozen=True)
class BeirQuery:
    query_id: str
    text: str
    relevant: dict[str, int]


@dataclass(frozen=True)
class QueryResult:
    query: BeirQuery
    ranked_doc_ids: tuple[str, ...]
    latency_ms: float

    def hit_at(self, k: int) -> float:
        relevant = set(self.query.relevant)
        return 1.0 if any(doc_id in relevant for doc_id in self.ranked_doc_ids[:k]) else 0.0

    def recall_at(self, k: int) -> float:
        relevant = set(self.query.relevant)
        if not relevant:
            return 0.0
        retrieved = set(self.ranked_doc_ids[:k])
        return len(relevant & retrieved) / len(relevant)

    def mrr_at(self, k: int) -> float:
        relevant = set(self.query.relevant)
        for rank, doc_id in enumerate(self.ranked_doc_ids[:k], start=1):
            if doc_id in relevant:
                return 1.0 / rank
        return 0.0

    def ndcg_at(self, k: int) -> float:
        dcg = 0.0
        for rank, doc_id in enumerate(self.ranked_doc_ids[:k], start=1):
            rel = self.query.relevant.get(doc_id, 0)
            if rel > 0:
                dcg += (2**rel - 1) / math.log2(rank + 1)
        ideal_rels = sorted(self.query.relevant.values(), reverse=True)[:k]
        idcg = sum((2**rel - 1) / math.log2(rank + 1) for rank, rel in enumerate(ideal_rels, start=1))
        return 0.0 if idcg == 0.0 else dcg / idcg


def now_id() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def dataset_slug(dataset: str) -> str:
    return dataset.split("/")[-1].lower().replace("_", "-")


def read_parquet_records(path: Path) -> list[dict[str, Any]]:
    table = pq.read_table(path)
    return table.to_pylist()


def download_beir_files(dataset: str, qrels_repo: str, split: str, cache_dir: Path) -> tuple[Path, Path, Path]:
    corpus_path = Path(
        hf_hub_download(
            dataset,
            "corpus/corpus-00000-of-00001.parquet",
            repo_type="dataset",
            cache_dir=str(cache_dir),
        )
    )
    queries_path = Path(
        hf_hub_download(
            dataset,
            "queries/queries-00000-of-00001.parquet",
            repo_type="dataset",
            cache_dir=str(cache_dir),
        )
    )
    qrels_path = Path(
        hf_hub_download(
            qrels_repo,
            f"{split}.tsv",
            repo_type="dataset",
            cache_dir=str(cache_dir),
        )
    )
    return corpus_path, queries_path, qrels_path


def load_corpus(path: Path, limit: int) -> list[BeirDoc]:
    docs = [
        BeirDoc(
            doc_id=str(row["_id"]),
            title=str(row.get("title") or ""),
            text=str(row.get("text") or ""),
        )
        for row in read_parquet_records(path)
    ]
    return docs[:limit] if limit > 0 else docs


def load_query_texts(path: Path) -> dict[str, str]:
    return {
        str(row["_id"]): str(row.get("text") or row.get("title") or "")
        for row in read_parquet_records(path)
    }


def load_qrels(path: Path) -> dict[str, dict[str, int]]:
    qrels: dict[str, dict[str, int]] = {}
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        for row in reader:
            query_id = str(row["query-id"])
            doc_id = str(row["corpus-id"])
            score = int(float(row["score"]))
            if score <= 0:
                continue
            qrels.setdefault(query_id, {})[doc_id] = score
    return qrels


def build_queries(
    query_texts: dict[str, str],
    qrels: dict[str, dict[str, int]],
    corpus_ids: set[str],
    limit: int,
) -> list[BeirQuery]:
    queries: list[BeirQuery] = []
    for query_id in sorted(qrels, key=lambda item: int(item) if item.isdigit() else item):
        relevant = {
            doc_id: score
            for doc_id, score in qrels[query_id].items()
            if doc_id in corpus_ids
        }
        text = query_texts.get(query_id, "")
        if not relevant or not text:
            continue
        queries.append(BeirQuery(query_id=query_id, text=text, relevant=relevant))
        if limit > 0 and len(queries) >= limit:
            break
    return queries


def create_schema(name: str, index_type: str, hnsw_m: int, hnsw_ef_construction: int) -> zvec.CollectionSchema:
    if index_type == "hnsw":
        index_param = zvec.HnswIndexParam(m=hnsw_m, ef_construction=hnsw_ef_construction)
    else:
        index_param = zvec.FlatIndexParam()
    return zvec.CollectionSchema(
        name=name,
        fields=[
            zvec.FieldSchema("doc_id", zvec.DataType.STRING, nullable=False),
            zvec.FieldSchema("title", zvec.DataType.STRING, nullable=False),
            zvec.FieldSchema("text", zvec.DataType.STRING, nullable=False),
            zvec.FieldSchema("ordinal", zvec.DataType.INT64, nullable=False),
        ],
        vectors=zvec.VectorSchema(
            "embedding",
            zvec.DataType.VECTOR_FP32,
            EMBEDDING_DIMENSION,
            index_param=index_param,
        ),
    )


def recreate_path(path: Path) -> None:
    if not path.exists():
        return
    if not path.is_dir():
        raise ValueError(f"DB path exists and is not a directory: {path}")
    if any(path.iterdir()) and not (
        (path / MARKER_FILE).exists()
        or (path / "LOCK").exists()
        or (path / "idmap.0").exists()
        or any(path.glob("manifest.*"))
    ):
        raise ValueError(f"Refusing to delete non-Zvec-looking directory: {path}")
    shutil.rmtree(path)


def chunked(items: Sequence[BeirDoc], size: int) -> Iterable[list[BeirDoc]]:
    for start in range(0, len(items), max(1, size)):
        yield list(items[start : start + size])


def build_index(
    docs: list[BeirDoc],
    *,
    db_path: Path,
    dataset_name: str,
    embedder: MiniLMOnnxEmbedder,
    batch_size: int,
    index_type: str,
    hnsw_m: int,
    hnsw_ef_construction: int,
    optimize: bool,
) -> tuple[zvec.Collection, float]:
    recreate_path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    collection = zvec.create_and_open(
        str(db_path),
        create_schema(dataset_name, index_type, hnsw_m, hnsw_ef_construction),
    )
    start = time.perf_counter()
    ordinal = 0
    for batch in chunked(docs, batch_size):
        vectors = embedder.encode([doc.embedding_text for doc in batch])
        zdocs = []
        for doc, vector in zip(batch, vectors, strict=True):
            zdocs.append(
                zvec.Doc(
                    id=f"doc_{ordinal:08d}",
                    fields={
                        "doc_id": doc.doc_id,
                        "title": doc.title,
                        "text": doc.text,
                        "ordinal": ordinal,
                    },
                    vectors={"embedding": vector.tolist()},
                )
            )
            ordinal += 1
        collection.upsert(zdocs)
    collection.flush()
    if optimize:
        collection.optimize()
    build_ms = (time.perf_counter() - start) * 1000.0
    (db_path / MARKER_FILE).write_text(
        json.dumps(
            {
                "kind": "beir-zvec",
                "dataset": dataset_name,
                "doc_count": len(docs),
                "index_type": index_type,
                "embedding_dimension": EMBEDDING_DIMENSION,
                "built_at": datetime.now().isoformat(),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return collection, build_ms


def percentile(values: Sequence[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = int(round((len(ordered) - 1) * q))
    return ordered[max(0, min(idx, len(ordered) - 1))]


def run_queries(
    collection: zvec.Collection,
    embedder: MiniLMOnnxEmbedder,
    queries: list[BeirQuery],
    *,
    top_k: int,
    query_batch_size: int,
    hnsw_ef: int,
    index_type: str,
) -> tuple[list[QueryResult], float]:
    results: list[QueryResult] = []
    embed_start = time.perf_counter()
    vectors = []
    for start in range(0, len(queries), max(1, query_batch_size)):
        batch = queries[start : start + query_batch_size]
        encoded = embedder.encode([query.text for query in batch])
        vectors.extend(vector.tolist() for vector in encoded)
    embedding_ms = (time.perf_counter() - embed_start) * 1000.0

    query_param = zvec.HnswQueryParam(ef=hnsw_ef) if index_type == "hnsw" else None
    for query, vector in zip(queries, vectors, strict=True):
        start = time.perf_counter()
        found = collection.query(
            queries=zvec.Query(field_name="embedding", vector=vector, param=query_param),
            topk=top_k,
            output_fields=["doc_id", "title", "ordinal"],
        )
        latency_ms = (time.perf_counter() - start) * 1000.0
        results.append(
            QueryResult(
                query=query,
                ranked_doc_ids=tuple(str(doc.fields["doc_id"]) for doc in found),
                latency_ms=latency_ms,
            )
        )
    return results, embedding_ms


def summarize(results: list[QueryResult], top_ks: Sequence[int]) -> dict[str, Any]:
    latencies = [result.latency_ms for result in results]
    metrics: dict[str, Any] = {
        "query_count": len(results),
        "latency_ms": {
            "mean": statistics.fmean(latencies) if latencies else 0.0,
            "median": statistics.median(latencies) if latencies else 0.0,
            "p95": percentile(latencies, 0.95),
            "max": max(latencies) if latencies else 0.0,
        },
    }
    for k in top_ks:
        metrics[f"hit@{k}"] = statistics.fmean(result.hit_at(k) for result in results)
        metrics[f"recall@{k}"] = statistics.fmean(result.recall_at(k) for result in results)
        metrics[f"mrr@{k}"] = statistics.fmean(result.mrr_at(k) for result in results)
        metrics[f"ndcg@{k}"] = statistics.fmean(result.ndcg_at(k) for result in results)
    return metrics


def render_markdown(payload: dict[str, Any]) -> str:
    metrics = payload["metrics"]
    lines = [
        f"# BEIR Zvec Benchmark: {payload['dataset']}",
        "",
        f"- Dataset repo: `{payload['dataset_repo']}`",
        f"- Qrels repo: `{payload['qrels_repo']}`",
        f"- Split: `{payload['split']}`",
        f"- Docs indexed: {payload['doc_count']}",
        f"- Queries evaluated: {payload['query_count']}",
        f"- Index type: `{payload['index_type']}`",
        f"- Build ms: {payload['build_ms']:.3f}",
        f"- Query embedding total ms: {payload['query_embedding_ms']:.3f}",
        "",
        "## Retrieval Metrics",
        "",
        "| K | hit@k | recall@k | mrr@k | ndcg@k |",
        "|---:|---:|---:|---:|---:|",
    ]
    for k in payload["top_ks"]:
        lines.append(
            f"| {k} | "
            f"{metrics[f'hit@{k}']:.4f} | "
            f"{metrics[f'recall@{k}']:.4f} | "
            f"{metrics[f'mrr@{k}']:.4f} | "
            f"{metrics[f'ndcg@{k}']:.4f} |"
        )
    lines.extend(
        [
            "",
            "## Latency",
            "",
            "| Metric | ms |",
            "|---|---:|",
            f"| zvec query mean | {metrics['latency_ms']['mean']:.3f} |",
            f"| zvec query median | {metrics['latency_ms']['median']:.3f} |",
            f"| zvec query p95 | {metrics['latency_ms']['p95']:.3f} |",
            f"| zvec query max | {metrics['latency_ms']['max']:.3f} |",
        ]
    )
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="BeIR/scifact")
    parser.add_argument("--qrels-repo", default="")
    parser.add_argument("--split", default="test")
    parser.add_argument("--db-root", default="data/beir-zvec")
    parser.add_argument("--output-dir", default="reports")
    parser.add_argument("--cache-dir", default=".cache/huggingface")
    parser.add_argument("--onnx-file", default="onnx/model.onnx")
    parser.add_argument("--max-length", type=int, default=256)
    parser.add_argument("--doc-limit", type=int, default=0)
    parser.add_argument("--query-limit", type=int, default=0)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--query-batch-size", type=int, default=64)
    parser.add_argument("--index-type", choices=("flat", "hnsw"), default="flat")
    parser.add_argument("--hnsw-m", type=int, default=32)
    parser.add_argument("--hnsw-ef-construction", type=int, default=128)
    parser.add_argument("--hnsw-ef", type=int, default=128)
    parser.add_argument("--optimize", action="store_true")
    args = parser.parse_args()

    qrels_repo = args.qrels_repo or f"{args.dataset}-qrels"
    slug = dataset_slug(args.dataset)
    run_id = f"{slug}-{args.split}-{now_id()}"
    db_path = Path(args.db_root) / run_id

    corpus_path, queries_path, qrels_path = download_beir_files(
        args.dataset,
        qrels_repo,
        args.split,
        Path(args.cache_dir),
    )
    docs = load_corpus(corpus_path, args.doc_limit)
    query_texts = load_query_texts(queries_path)
    qrels = load_qrels(qrels_path)
    queries = build_queries(query_texts, qrels, {doc.doc_id for doc in docs}, args.query_limit)
    if not docs or not queries:
        raise SystemExit("No documents or no qrel-backed queries loaded")

    embedder = MiniLMOnnxEmbedder(
        cache_dir=args.cache_dir,
        onnx_file=args.onnx_file,
        max_length=args.max_length,
    )
    collection, build_ms = build_index(
        docs,
        db_path=db_path,
        dataset_name=slug,
        embedder=embedder,
        batch_size=args.batch_size,
        index_type=args.index_type,
        hnsw_m=args.hnsw_m,
        hnsw_ef_construction=args.hnsw_ef_construction,
        optimize=args.optimize,
    )
    top_ks = [k for k in TOP_KS if k <= len(docs)]
    results, query_embedding_ms = run_queries(
        collection,
        embedder,
        queries,
        top_k=max(top_ks),
        query_batch_size=args.query_batch_size,
        hnsw_ef=args.hnsw_ef,
        index_type=args.index_type,
    )
    metrics = summarize(results, top_ks)
    payload = {
        "run_id": run_id,
        "dataset": slug,
        "dataset_repo": args.dataset,
        "qrels_repo": qrels_repo,
        "split": args.split,
        "corpus_path": str(corpus_path),
        "queries_path": str(queries_path),
        "qrels_path": str(qrels_path),
        "db_path": str(db_path),
        "doc_count": len(docs),
        "query_count": len(queries),
        "index_type": args.index_type,
        "top_ks": top_ks,
        "build_ms": build_ms,
        "query_embedding_ms": query_embedding_ms,
        "metrics": metrics,
    }

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / f"beir-zvec-{run_id}.json"
    md_path = output_dir / f"beir-zvec-{run_id}.md"
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    md_path.write_text(render_markdown(payload), encoding="utf-8")

    print(f"JSON: {json_path}")
    print(f"Markdown: {md_path}")
    print(f"docs={len(docs)} queries={len(queries)}")
    for k in top_ks:
        print(
            f"k={k} "
            f"hit={metrics[f'hit@{k}']:.4f} "
            f"recall={metrics[f'recall@{k}']:.4f} "
            f"mrr={metrics[f'mrr@{k}']:.4f} "
            f"ndcg={metrics[f'ndcg@{k}']:.4f}"
        )
    print(
        "latency_ms="
        f"median:{metrics['latency_ms']['median']:.3f} "
        f"p95:{metrics['latency_ms']['p95']:.3f}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
