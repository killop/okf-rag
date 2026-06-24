"""Benchmark OKF + Nocturne knowledge-memory retrieval on a Zvec index.

The benchmark measures whether expected concept IDs are retrieved for each
query, plus end-to-end query latency including ONNX embedding and Zvec search.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Sequence

import zvec

from knowledge_memory_index import OUTPUT_FIELDS
from minilm_onnx_embed import MiniLMOnnxEmbedder


@dataclass(frozen=True)
class BenchCase:
    case_id: str
    query: str
    expected: tuple[str, ...]
    tags: tuple[str, ...]


@dataclass(frozen=True)
class BenchHit:
    rank: int
    score: float
    concept_id: str
    title: str
    nocturne_uri: str
    disclosure: str


@dataclass(frozen=True)
class BenchResult:
    case: BenchCase
    hits: tuple[BenchHit, ...]
    latency_ms: float

    def first_expected_rank(self) -> int | None:
        expected = set(self.case.expected)
        for hit in self.hits:
            if hit.concept_id in expected:
                return hit.rank
        return None

    def recall_at(self, k: int) -> float:
        if not self.case.expected:
            return 0.0
        expected = set(self.case.expected)
        retrieved = {hit.concept_id for hit in self.hits[:k]}
        return len(expected & retrieved) / len(expected)

    def hit_at(self, k: int) -> float:
        return 1.0 if self.recall_at(k) > 0 else 0.0


def now_id() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def percentile(values: Sequence[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = int(round((len(ordered) - 1) * q))
    return ordered[max(0, min(idx, len(ordered) - 1))]


def parse_top_ks(raw: str) -> list[int]:
    top_ks = sorted({int(item.strip()) for item in raw.split(",") if item.strip()})
    if not top_ks or any(k < 1 for k in top_ks):
        raise ValueError("--top-ks must contain positive integers")
    return top_ks


def load_cases(path: Path) -> tuple[str, list[BenchCase]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, list):
        name = path.stem
        raw_cases = payload
    else:
        name = str(payload.get("name") or path.stem)
        raw_cases = payload.get("queries") or payload.get("cases") or []

    cases: list[BenchCase] = []
    for idx, item in enumerate(raw_cases):
        expected = item.get("expected") or item.get("expected_concept_ids") or []
        if isinstance(expected, str):
            expected = [expected]
        tags = item.get("tags") or []
        if isinstance(tags, str):
            tags = [tags]
        cases.append(
            BenchCase(
                case_id=str(item.get("id") or f"case_{idx:03d}"),
                query=str(item["query"]),
                expected=tuple(str(value) for value in expected),
                tags=tuple(str(value) for value in tags),
            )
        )
    return name, cases


def run_case(
    collection: zvec.Collection,
    embedder: MiniLMOnnxEmbedder,
    case: BenchCase,
    *,
    max_k: int,
    hnsw_ef: int | None,
) -> BenchResult:
    query_param = zvec.HnswQueryParam(ef=hnsw_ef) if hnsw_ef else None
    start = time.perf_counter()
    vector = embedder.encode(case.query)
    docs = collection.query(
        queries=zvec.Query(
            field_name="embedding",
            vector=vector.tolist(),
            param=query_param,
        ),
        topk=max_k,
        output_fields=OUTPUT_FIELDS,
    )
    latency_ms = (time.perf_counter() - start) * 1000.0

    hits = []
    for idx, doc in enumerate(docs, start=1):
        fields = dict(doc.fields)
        hits.append(
            BenchHit(
                rank=idx,
                score=float(getattr(doc, "score", 0.0)),
                concept_id=str(fields.get("concept_id", "")),
                title=str(fields.get("title", "")),
                nocturne_uri=str(fields.get("nocturne_uri", "")),
                disclosure=str(fields.get("disclosure", "")),
            )
        )
    return BenchResult(case=case, hits=tuple(hits), latency_ms=latency_ms)


def summarize(results: list[BenchResult], top_ks: list[int]) -> dict[str, Any]:
    latencies = [result.latency_ms for result in results]
    metrics: dict[str, Any] = {
        "case_count": len(results),
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

    reciprocal_ranks = []
    for result in results:
        rank = result.first_expected_rank()
        reciprocal_ranks.append(0.0 if rank is None else 1.0 / rank)
    metrics["mrr"] = statistics.fmean(reciprocal_ranks) if reciprocal_ranks else 0.0
    return metrics


def result_to_json(result: BenchResult) -> dict[str, Any]:
    return {
        "id": result.case.case_id,
        "query": result.case.query,
        "expected": list(result.case.expected),
        "tags": list(result.case.tags),
        "latency_ms": result.latency_ms,
        "first_expected_rank": result.first_expected_rank(),
        "hits": [
            {
                "rank": hit.rank,
                "score": hit.score,
                "concept_id": hit.concept_id,
                "title": hit.title,
                "nocturne_uri": hit.nocturne_uri,
                "disclosure": hit.disclosure,
            }
            for hit in result.hits
        ],
    }


def render_markdown(
    *,
    benchmark_name: str,
    db_path: Path,
    eval_path: Path,
    top_ks: list[int],
    warmup: int,
    metrics: dict[str, Any],
    results: list[BenchResult],
) -> str:
    lines = [
        f"# Knowledge Memory Benchmark: {benchmark_name}",
        "",
        f"- DB: `{db_path}`",
        f"- Eval: `{eval_path}`",
        f"- Cases: {metrics['case_count']}",
        f"- Top-K: {', '.join(str(k) for k in top_ks)}",
        f"- Warmup queries: {warmup}",
        "",
        "## Metrics",
        "",
        "| Metric | Value |",
        "|---|---:|",
    ]
    for k in top_ks:
        lines.append(f"| hit@{k} | {metrics[f'hit@{k}']:.4f} |")
        lines.append(f"| recall@{k} | {metrics[f'recall@{k}']:.4f} |")
    lines.extend(
        [
            f"| MRR | {metrics['mrr']:.4f} |",
            f"| latency mean ms | {metrics['latency_ms']['mean']:.3f} |",
            f"| latency median ms | {metrics['latency_ms']['median']:.3f} |",
            f"| latency p95 ms | {metrics['latency_ms']['p95']:.3f} |",
            f"| latency max ms | {metrics['latency_ms']['max']:.3f} |",
            "",
            "## Cases",
            "",
            "| ID | Expected | First Rank | Top Hit | Latency ms |",
            "|---|---|---:|---|---:|",
        ]
    )
    for result in results:
        first_rank = result.first_expected_rank()
        first_rank_text = str(first_rank) if first_rank is not None else "miss"
        top_hit = result.hits[0].concept_id if result.hits else ""
        lines.append(
            "| "
            f"{result.case.case_id} | "
            f"{', '.join(result.case.expected)} | "
            f"{first_rank_text} | "
            f"{top_hit} | "
            f"{result.latency_ms:.3f} |"
        )
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--eval", required=True)
    parser.add_argument("--top-ks", default="1,3,5")
    parser.add_argument("--output-dir", default="reports")
    parser.add_argument("--cache-dir", default=".cache/huggingface")
    parser.add_argument("--onnx-file", default="onnx/model.onnx")
    parser.add_argument("--max-length", type=int, default=256)
    parser.add_argument("--hnsw-ef", type=int, default=128)
    parser.add_argument("--warmup", type=int, default=1)
    parser.add_argument("--json-only", action="store_true")
    args = parser.parse_args()

    top_ks = parse_top_ks(args.top_ks)
    max_k = max(top_ks)
    db_path = Path(args.db)
    eval_path = Path(args.eval)
    benchmark_name, cases = load_cases(eval_path)
    if not cases:
        print("Error: benchmark eval file has no cases", file=sys.stderr)
        return 2

    embedder = MiniLMOnnxEmbedder(
        cache_dir=args.cache_dir,
        onnx_file=args.onnx_file,
        max_length=args.max_length,
    )
    collection = zvec.open(str(db_path))
    for _ in range(max(0, args.warmup)):
        run_case(
            collection,
            embedder,
            cases[0],
            max_k=max_k,
            hnsw_ef=args.hnsw_ef,
        )
    results = [
        run_case(
            collection,
            embedder,
            case,
            max_k=max_k,
            hnsw_ef=args.hnsw_ef,
        )
        for case in cases
    ]
    metrics = summarize(results, top_ks)
    payload = {
        "name": benchmark_name,
        "db": str(db_path),
        "eval": str(eval_path),
        "top_ks": top_ks,
        "warmup": args.warmup,
        "metrics": metrics,
        "results": [result_to_json(result) for result in results],
    }

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = f"bench-knowledge-memory-{now_id()}"
    json_path = output_dir / f"{stem}.json"
    md_path = output_dir / f"{stem}.md"
    json_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    if not args.json_only:
        md_path.write_text(
            render_markdown(
                benchmark_name=benchmark_name,
                db_path=db_path,
                eval_path=eval_path,
                top_ks=top_ks,
                warmup=args.warmup,
                metrics=metrics,
                results=results,
            ),
            encoding="utf-8",
        )

    print(f"JSON: {json_path}")
    if not args.json_only:
        print(f"Markdown: {md_path}")
    for k in top_ks:
        print(f"hit@{k}={metrics[f'hit@{k}']:.4f} recall@{k}={metrics[f'recall@{k}']:.4f}")
    print(f"mrr={metrics['mrr']:.4f}")
    print(
        "latency_ms="
        f"median:{metrics['latency_ms']['median']:.3f} "
        f"p95:{metrics['latency_ms']['p95']:.3f}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
