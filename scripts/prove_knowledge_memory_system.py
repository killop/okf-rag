"""Run a controlled system proof for OKF + Nocturne + Zvec memory retrieval.

The proof generates a deterministic OKF bundle, builds three comparable Zvec
indexes, and measures whether metadata-aware indexes recover knowledge points
that body-only indexing cannot see.
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Sequence

import yaml
import zvec

from knowledge_memory_index import (
    OUTPUT_FIELDS,
    build_zvec_index,
    fail_if_invalid,
    load_concepts,
    rerank_zvec_docs,
    write_okf_indexes,
)
from minilm_onnx_embed import MiniLMOnnxEmbedder


PROFILE_CONFIGS = (
    {"name": "body", "embedding_profile": "body", "rerank": False},
    {"name": "okf", "embedding_profile": "okf", "rerank": False},
    {"name": "full", "embedding_profile": "full", "rerank": False},
    {"name": "full_hybrid", "embedding_profile": "full", "rerank": True},
)
PROFILES = tuple(config["name"] for config in PROFILE_CONFIGS)
TOP_KS = (1, 5, 10)

BODY_ADJECTIVES = [
    "steady",
    "narrow",
    "layered",
    "portable",
    "durable",
    "careful",
    "modular",
    "bounded",
    "explicit",
    "reusable",
]
BODY_NOUNS = [
    "handoff",
    "ledger",
    "contract",
    "snapshot",
    "trace",
    "checkpoint",
    "outline",
    "bridge",
    "filter",
    "marker",
]
CATALOG_ADJECTIVES = [
    "crimson",
    "silver",
    "opal",
    "cobalt",
    "ivory",
    "jade",
    "saffron",
    "violet",
    "coral",
    "bronze",
]
CATALOG_NOUNS = [
    "atlas",
    "beacon",
    "compass",
    "harbor",
    "meadow",
    "summit",
    "forge",
    "garden",
    "orbit",
    "ribbon",
]
TRIGGER_ADJECTIVES = [
    "rainy",
    "midnight",
    "winter",
    "silent",
    "golden",
    "eastern",
    "rapid",
    "hidden",
    "bright",
    "northern",
]
TRIGGER_NOUNS = [
    "launch",
    "handover",
    "audit",
    "migration",
    "triage",
    "review",
    "dispatch",
    "calibration",
    "restore",
    "handoff",
]


@dataclass(frozen=True)
class ProofConcept:
    index: int
    concept_id: str
    slug: str
    body_phrase: str
    catalog_phrase: str
    trigger_phrase: str


@dataclass(frozen=True)
class ProofCase:
    case_id: str
    query_type: str
    query: str
    expected: str


@dataclass(frozen=True)
class ProofHit:
    rank: int
    score: float
    concept_id: str
    title: str


@dataclass(frozen=True)
class ProofResult:
    case: ProofCase
    hits: tuple[ProofHit, ...]
    zvec_latency_ms: float

    def first_rank(self) -> int | None:
        for hit in self.hits:
            if hit.concept_id == self.case.expected:
                return hit.rank
        return None

    def hit_at(self, k: int) -> float:
        return 1.0 if any(hit.concept_id == self.case.expected for hit in self.hits[:k]) else 0.0


def now_id() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def slugify(text: str) -> str:
    return text.lower().replace(" ", "-")


def phrase_pair(adjectives: Sequence[str], nouns: Sequence[str], index: int) -> str:
    return f"{adjectives[index % len(adjectives)]} {nouns[(index // len(adjectives)) % len(nouns)]}"


def make_concept(index: int) -> ProofConcept:
    body_phrase = f"{phrase_pair(BODY_ADJECTIVES, BODY_NOUNS, index)} operating rule"
    catalog_phrase = f"{phrase_pair(CATALOG_ADJECTIVES, CATALOG_NOUNS, index)} catalog signal"
    trigger_phrase = f"{phrase_pair(TRIGGER_ADJECTIVES, TRIGGER_NOUNS, index)} recall moment"
    slug = f"proof-{index:03d}-{slugify(catalog_phrase)}"
    return ProofConcept(
        index=index,
        concept_id=f"concepts/{slug}",
        slug=slug,
        body_phrase=body_phrase,
        catalog_phrase=catalog_phrase,
        trigger_phrase=trigger_phrase,
    )


def concept_markdown(concept: ProofConcept) -> str:
    frontmatter = {
        "type": "Knowledge Concept",
        "title": f"{concept.catalog_phrase.title()} Pattern",
        "description": f"Catalog entry for {concept.catalog_phrase} retrieval behavior.",
        "resource": f"knowledge-memory-proof://concept/{concept.slug}",
        "tags": [
            "system-proof",
            f"catalog-{slugify(concept.catalog_phrase)}",
            "memory",
        ],
        "timestamp": "2026-06-23T00:00:00Z",
        "nocturne": {
            "uri": f"proof://memory/{concept.slug}",
            "disclosure": f"When handling {concept.trigger_phrase} requests.",
            "priority": (concept.index % 4) + 1,
            "aliases": [
                {
                    "uri": f"architecture://proof/{concept.slug}",
                    "disclosure": f"When auditing {concept.trigger_phrase} retrieval paths.",
                    "priority": (concept.index % 4) + 2,
                }
            ],
        },
    }
    body = (
        f"This concept documents the {concept.body_phrase}.\n\n"
        "The reusable idea is to keep durable markdown notes independent from "
        "the fast lookup layer, then route questions through evidence before "
        "answer synthesis. The note emphasizes deterministic validation, "
        "stable concept files, and measurable retrieval behavior.\n"
    )
    fm = yaml.safe_dump(frontmatter, sort_keys=False, allow_unicode=True).rstrip()
    return f"---\n{fm}\n---\n\n{body}"


def write_bundle(bundle_root: Path, concept_count: int) -> tuple[list[ProofConcept], list[ProofCase]]:
    concepts_dir = bundle_root / "concepts"
    concepts_dir.mkdir(parents=True, exist_ok=True)
    concepts = [make_concept(index) for index in range(concept_count)]
    for concept in concepts:
        (concepts_dir / f"{concept.slug}.md").write_text(
            concept_markdown(concept),
            encoding="utf-8",
        )

    cases: list[ProofCase] = []
    for concept in concepts:
        cases.extend(
            [
                ProofCase(
                    case_id=f"body_{concept.index:03d}",
                    query_type="body",
                    query=f"which concept documents the {concept.body_phrase}",
                    expected=concept.concept_id,
                ),
                ProofCase(
                    case_id=f"okf_{concept.index:03d}",
                    query_type="okf",
                    query=f"find the catalog entry for {concept.catalog_phrase} retrieval behavior",
                    expected=concept.concept_id,
                ),
                ProofCase(
                    case_id=f"nocturne_{concept.index:03d}",
                    query_type="nocturne",
                    query=f"what memory should wake up when handling {concept.trigger_phrase} requests",
                    expected=concept.concept_id,
                ),
            ]
        )
    write_okf_indexes(bundle_root)
    return concepts, cases


def percentile(values: Sequence[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = int(round((len(ordered) - 1) * q))
    return ordered[max(0, min(idx, len(ordered) - 1))]


def query_collection(
    collection: zvec.Collection,
    case: ProofCase,
    vector: list[float],
    top_k: int,
    candidate_k: int,
    rerank: bool,
) -> ProofResult:
    start = time.perf_counter()
    docs = collection.query(
        queries=zvec.Query(field_name="embedding", vector=vector),
        topk=candidate_k,
        output_fields=OUTPUT_FIELDS,
    )
    if rerank:
        docs = rerank_zvec_docs(case.query, docs, top_k)
    else:
        docs = docs[:top_k]
    zvec_latency_ms = (time.perf_counter() - start) * 1000.0
    hits = tuple(
        ProofHit(
            rank=rank,
            score=float(getattr(doc, "score", 0.0)),
            concept_id=str(doc.fields.get("concept_id", "")),
            title=str(doc.fields.get("title", "")),
        )
        for rank, doc in enumerate(docs, start=1)
    )
    return ProofResult(case=case, hits=hits, zvec_latency_ms=zvec_latency_ms)


def metrics_for(results: list[ProofResult], top_ks: Sequence[int]) -> dict[str, Any]:
    latencies = [result.zvec_latency_ms for result in results]
    reciprocal_ranks = []
    for result in results:
        rank = result.first_rank()
        reciprocal_ranks.append(0.0 if rank is None else 1.0 / rank)
    metrics: dict[str, Any] = {
        "case_count": len(results),
        "mrr": statistics.fmean(reciprocal_ranks) if reciprocal_ranks else 0.0,
        "zvec_latency_ms": {
            "mean": statistics.fmean(latencies) if latencies else 0.0,
            "median": statistics.median(latencies) if latencies else 0.0,
            "p95": percentile(latencies, 0.95),
            "max": max(latencies) if latencies else 0.0,
        },
    }
    for k in top_ks:
        metrics[f"hit@{k}"] = statistics.fmean(result.hit_at(k) for result in results)
        metrics[f"recall@{k}"] = metrics[f"hit@{k}"]
    return metrics


def grouped_metrics(results: list[ProofResult], top_ks: Sequence[int]) -> dict[str, Any]:
    grouped: dict[str, list[ProofResult]] = {}
    for result in results:
        grouped.setdefault(result.case.query_type, []).append(result)
    return {
        query_type: metrics_for(items, top_ks)
        for query_type, items in sorted(grouped.items())
    }


def run_profile(
    profile_name: str,
    embedding_profile: str,
    rerank: bool,
    *,
    bundle_root: Path,
    db_path: Path,
    cases: list[ProofCase],
    query_vectors: list[list[float]],
    embedder: MiniLMOnnxEmbedder,
    batch_size: int,
    top_k: int,
    candidate_k: int,
) -> dict[str, Any]:
    concepts, errors = load_concepts(bundle_root, ignore_non_concepts=False)
    fail_if_invalid(concepts, errors, allow_missing_nocturne=False)
    build_start = time.perf_counter()
    build_zvec_index(
        concepts,
        bundle_root=bundle_root,
        db_path=db_path,
        recreate=False,
        embedder=embedder,
        index_type="flat",
        embedding_profile=embedding_profile,
        hnsw_m=32,
        hnsw_ef_construction=128,
        batch_size=batch_size,
        optimize=False,
    )
    build_ms = (time.perf_counter() - build_start) * 1000.0

    collection = zvec.open(str(db_path))
    results = [
        query_collection(
            collection,
            case,
            vector,
            top_k=top_k,
            candidate_k=candidate_k if rerank else top_k,
            rerank=rerank,
        )
        for case, vector in zip(cases, query_vectors, strict=True)
    ]
    return {
        "profile": profile_name,
        "embedding_profile": embedding_profile,
        "rerank": rerank,
        "candidate_k": candidate_k if rerank else top_k,
        "db": str(db_path),
        "build_ms": build_ms,
        "metrics": metrics_for(results, TOP_KS),
        "by_type": grouped_metrics(results, TOP_KS),
        "failures": [
            {
                "id": result.case.case_id,
                "query_type": result.case.query_type,
                "expected": result.case.expected,
                "first_rank": result.first_rank(),
                "top_hit": result.hits[0].concept_id if result.hits else "",
                "query": result.case.query,
            }
            for result in results
            if result.first_rank() != 1
        ],
    }


def metric(payload: dict[str, Any], name: str) -> float:
    return float(payload["metrics"][name])


def by_type_hit(payload: dict[str, Any], query_type: str, k: int) -> float:
    return float(payload["by_type"][query_type][f"hit@{k}"])


def render_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Knowledge Memory System Proof",
        "",
        f"- Run ID: `{payload['run_id']}`",
        f"- Bundle: `{payload['bundle']}`",
        f"- Concepts: {payload['concept_count']}",
        f"- Queries: {payload['query_count']}",
        f"- Index type: `flat`",
        f"- Query embedding avg ms: {payload['query_embedding_avg_ms']:.3f}",
        "",
        "## Summary",
        "",
        "| Profile | Embedding | Rerank | Overall hit@1 | Overall hit@5 | MRR | Body hit@1 | OKF hit@1 | Nocturne hit@1 | Zvec median ms |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for profile in PROFILES:
        result = payload["profiles"][profile]
        lines.append(
            "| "
            f"{profile} | "
            f"{result['embedding_profile']} | "
            f"{str(result['rerank']).lower()} | "
            f"{metric(result, 'hit@1'):.4f} | "
            f"{metric(result, 'hit@5'):.4f} | "
            f"{metric(result, 'mrr'):.4f} | "
            f"{by_type_hit(result, 'body', 1):.4f} | "
            f"{by_type_hit(result, 'okf', 1):.4f} | "
            f"{by_type_hit(result, 'nocturne', 1):.4f} | "
            f"{result['metrics']['zvec_latency_ms']['median']:.3f} |"
        )

    lines.extend(
        [
            "",
            "## Interpretation",
            "",
            "- `body` only sees markdown body text.",
            "- `okf` sees title, description, resource, tags, timestamp, and body.",
            "- `full` sees OKF metadata, Nocturne URI/disclosure/priority/aliases, and body.",
            "- `full_hybrid` uses the same full vector index, then reranks Zvec candidates with generic frontmatter/body token overlap.",
            "- The proof is synthetic and controlled. It proves the indexing path and the value of searchable metadata under metadata-only queries; it does not prove real-world recall quality by itself.",
            "",
            "## Failures",
            "",
        ]
    )
    for profile in PROFILES:
        failures = payload["profiles"][profile]["failures"]
        lines.append(f"### {profile}")
        lines.append("")
        if not failures:
            lines.append("No rank-1 failures.")
            lines.append("")
            continue
        lines.extend(
            [
                "| ID | Type | Expected | Top Hit | First Rank |",
                "|---|---|---|---|---:|",
            ]
        )
        for failure in failures[:25]:
            first_rank = failure["first_rank"] if failure["first_rank"] is not None else "miss"
            lines.append(
                "| "
                f"{failure['id']} | "
                f"{failure['query_type']} | "
                f"{failure['expected']} | "
                f"{failure['top_hit']} | "
                f"{first_rank} |"
            )
        if len(failures) > 25:
            lines.append(f"Only first 25 of {len(failures)} failures shown.")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--concept-count", type=int, default=60)
    parser.add_argument("--run-root", default="data/knowledge-memory-system-proof")
    parser.add_argument("--output-dir", default="reports")
    parser.add_argument("--cache-dir", default=".cache/huggingface")
    parser.add_argument("--onnx-file", default="onnx/model.onnx")
    parser.add_argument("--max-length", type=int, default=256)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--candidate-k", type=int, default=50)
    parser.add_argument("--run-id", default="")
    args = parser.parse_args()

    if args.concept_count < 5:
        raise SystemExit("--concept-count must be at least 5")

    run_id = args.run_id or now_id()
    run_root = Path(args.run_root) / run_id
    if run_root.exists():
        raise SystemExit(f"Run root already exists: {run_root}")
    bundle_root = run_root / "bundle"
    db_root = run_root / "zvec"
    db_root.mkdir(parents=True, exist_ok=True)

    concepts, cases = write_bundle(bundle_root, args.concept_count)
    eval_path = run_root / "eval.json"
    eval_path.write_text(
        json.dumps(
            {
                "name": "knowledge-memory-system-proof",
                "queries": [
                    {
                        "id": case.case_id,
                        "query_type": case.query_type,
                        "query": case.query,
                        "expected": case.expected,
                    }
                    for case in cases
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    embedder = MiniLMOnnxEmbedder(
        cache_dir=args.cache_dir,
        onnx_file=args.onnx_file,
        max_length=args.max_length,
    )
    query_start = time.perf_counter()
    encoded_queries = embedder.encode([case.query for case in cases])
    query_embedding_ms = (time.perf_counter() - query_start) * 1000.0
    query_vectors = [vector.tolist() for vector in encoded_queries]

    profiles: dict[str, Any] = {}
    for config in PROFILE_CONFIGS:
        profile_name = str(config["name"])
        profiles[profile_name] = run_profile(
            profile_name,
            str(config["embedding_profile"]),
            bool(config["rerank"]),
            bundle_root=bundle_root,
            db_path=db_root / profile_name,
            cases=cases,
            query_vectors=query_vectors,
            embedder=embedder,
            batch_size=args.batch_size,
            top_k=max(TOP_KS),
            candidate_k=min(args.candidate_k, args.concept_count),
        )

    payload: dict[str, Any] = {
        "run_id": run_id,
        "run_root": str(run_root),
        "bundle": str(bundle_root),
        "eval": str(eval_path),
        "concept_count": len(concepts),
        "query_count": len(cases),
        "query_embedding_total_ms": query_embedding_ms,
        "query_embedding_avg_ms": query_embedding_ms / len(cases),
        "profiles": profiles,
    }

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / f"knowledge-memory-system-proof-{run_id}.json"
    md_path = output_dir / f"knowledge-memory-system-proof-{run_id}.md"
    json_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    md_path.write_text(render_markdown(payload), encoding="utf-8")

    print(f"JSON: {json_path}")
    print(f"Markdown: {md_path}")
    for profile in PROFILES:
        result = profiles[profile]
        print(
            f"{profile}: "
            f"overall_hit@1={metric(result, 'hit@1'):.4f} "
            f"body_hit@1={by_type_hit(result, 'body', 1):.4f} "
            f"okf_hit@1={by_type_hit(result, 'okf', 1):.4f} "
            f"nocturne_hit@1={by_type_hit(result, 'nocturne', 1):.4f}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
