"""Benchmark knowledge-memory retrieval on a real OKF bundle.

The script copies an existing OKF bundle into the current workspace, enriches
the copy with Nocturne recall metadata, and compares body/OKF/full/hybrid
retrieval profiles on queries derived from real catalog documents.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Sequence

import yaml
import zvec

from knowledge_memory_index import (
    OUTPUT_FIELDS,
    build_zvec_index,
    fail_if_invalid,
    load_concepts,
    normalize_tags,
    parse_markdown,
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
PROFILES = tuple(str(config["name"]) for config in PROFILE_CONFIGS)
TOP_KS = (1, 5, 10)
FIELD_RE = re.compile(r"^- `([^`]+)`", re.MULTILINE)
INLINE_CODE_RE = re.compile(r"`([^`]+)`")


@dataclass(frozen=True)
class RealCase:
    case_id: str
    query_type: str
    query: str
    expected: tuple[str, ...]


@dataclass(frozen=True)
class RealHit:
    rank: int
    score: float
    concept_id: str
    title: str


@dataclass(frozen=True)
class RealResult:
    case: RealCase
    hits: tuple[RealHit, ...]
    zvec_latency_ms: float

    def first_rank(self) -> int | None:
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
        return 1.0 if self.recall_at(k) > 0.0 else 0.0


def now_id() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def slugify(text: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_]+", "-", text.strip().lower()).strip("-")
    return slug or "concept"


def relative_concept_paths(source_bundle: Path) -> list[Path]:
    paths: list[Path] = []
    for path in sorted(source_bundle.rglob("*.md")):
        if path.name.lower() in {"index.md", "log.md"}:
            continue
        paths.append(path.relative_to(source_bundle))
    return paths


def nocturne_uri_for(bundle_name: str, concept_id: str) -> str:
    return f"okf://{slugify(bundle_name).replace('-', '_')}/{concept_id}"


def enrich_frontmatter(bundle_name: str, concept_id: str, frontmatter: dict[str, Any]) -> dict[str, Any]:
    enriched = dict(frontmatter)
    title = str(enriched.get("title") or concept_id)
    type_name = str(enriched.get("type") or "Knowledge Concept")
    enriched["nocturne"] = {
        "uri": nocturne_uri_for(bundle_name, concept_id),
        "disclosure": f"When looking for the {title} {type_name} in the {bundle_name} OKF catalog.",
        "priority": 2,
        "aliases": [
            {
                "uri": f"catalog://{slugify(bundle_name).replace('-', '_')}/{concept_id}",
                "disclosure": f"When auditing OKF catalog coverage for {title}.",
                "priority": 3,
            }
        ],
    }
    return enriched


def copy_and_enrich_bundle(source_bundle: Path, target_bundle: Path) -> int:
    source_bundle = source_bundle.resolve()
    target_bundle.mkdir(parents=True, exist_ok=True)
    bundle_name = source_bundle.name
    count = 0
    for rel_path in relative_concept_paths(source_bundle):
        source_path = source_bundle / rel_path
        target_path = target_bundle / rel_path
        parsed = parse_markdown(source_path.read_text(encoding="utf-8"))
        if not parsed.frontmatter:
            continue
        concept_id = rel_path.as_posix().removesuffix(".md")
        frontmatter = enrich_frontmatter(bundle_name, concept_id, parsed.frontmatter)
        fm_text = yaml.safe_dump(
            frontmatter,
            sort_keys=False,
            allow_unicode=True,
        ).rstrip()
        target_path.parent.mkdir(parents=True, exist_ok=True)
        target_path.write_text(
            f"---\n{fm_text}\n---\n\n{parsed.body.strip()}\n",
            encoding="utf-8",
        )
        count += 1
    write_okf_indexes(target_bundle)
    return count


def extract_fields(body: str) -> list[str]:
    fields = []
    for raw in FIELD_RE.findall(body):
        field = raw.strip()
        if 2 <= len(field) <= 80:
            fields.append(field)
    return sorted(set(fields))


def resource_tail(resource: str) -> str:
    tail = resource.rstrip("/").split("/")[-1]
    return tail or resource


def short_description(description: str) -> str:
    return " ".join(description.split())[:240]


def load_enriched_concepts(bundle_root: Path):
    concepts, errors = load_concepts(bundle_root, ignore_non_concepts=False)
    fail_if_invalid(concepts, errors, allow_missing_nocturne=False)
    return concepts


def unique_field_map(concepts) -> dict[str, set[str]]:
    owner_by_field: dict[str, set[str]] = {}
    for concept in concepts:
        for field in extract_fields(concept.body):
            owner_by_field.setdefault(field.lower(), set()).add(concept.concept_id)
    return owner_by_field


def build_cases(concepts, *, max_cases_per_concept: int) -> list[RealCase]:
    field_owners = unique_field_map(concepts)
    cases: list[RealCase] = []
    seen_queries: set[str] = set()

    def add_case(case: RealCase) -> None:
        if case.query in seen_queries:
            return
        seen_queries.add(case.query)
        cases.append(case)

    for concept in concepts:
        local_count = 0
        title = concept.title
        description = short_description(concept.description)
        tags = normalize_tags(concept.frontmatter.get("tags"))
        if title and local_count < max_cases_per_concept:
            add_case(
                RealCase(
                    case_id=f"title_{slugify(concept.concept_id)}",
                    query_type="title",
                    query=f"Which OKF concept is titled {title}?",
                    expected=(concept.concept_id,),
                )
            )
            local_count += 1
        if description and local_count < max_cases_per_concept:
            add_case(
                RealCase(
                    case_id=f"description_{slugify(concept.concept_id)}",
                    query_type="description",
                    query=f"Which catalog entry matches this description: {description}",
                    expected=(concept.concept_id,),
                )
            )
            local_count += 1
        if concept.resource and local_count < max_cases_per_concept:
            add_case(
                RealCase(
                    case_id=f"resource_{slugify(concept.concept_id)}",
                    query_type="resource",
                    query=f"Which concept has resource path {resource_tail(concept.resource)}?",
                    expected=(concept.concept_id,),
                )
            )
            local_count += 1
        unique_fields = [
            field
            for field in extract_fields(concept.body)
            if field_owners.get(field.lower()) == {concept.concept_id}
        ]
        if unique_fields and local_count < max_cases_per_concept:
            selected = unique_fields[: min(3, len(unique_fields))]
            add_case(
                RealCase(
                    case_id=f"schema_{slugify(concept.concept_id)}",
                    query_type="schema",
                    query=f"Which concept documents schema field(s) {', '.join(selected)}?",
                    expected=(concept.concept_id,),
                )
            )
            local_count += 1
        if tags and local_count < max_cases_per_concept:
            tag_text = ", ".join(tags[:3])
            add_case(
                RealCase(
                    case_id=f"tags_{slugify(concept.concept_id)}",
                    query_type="tags",
                    query=f"Which concept is tagged with {tag_text}?",
                    expected=(concept.concept_id,),
                )
            )
            local_count += 1
        if concept.disclosure:
            add_case(
                RealCase(
                    case_id=f"nocturne_{slugify(concept.concept_id)}",
                    query_type="nocturne",
                    query=concept.disclosure,
                    expected=(concept.concept_id,),
                )
            )
    return cases


def percentile(values: Sequence[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = int(round((len(ordered) - 1) * q))
    return ordered[max(0, min(idx, len(ordered) - 1))]


def query_collection(
    collection: zvec.Collection,
    case: RealCase,
    vector: list[float],
    *,
    top_k: int,
    candidate_k: int,
    rerank: bool,
) -> RealResult:
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
    latency_ms = (time.perf_counter() - start) * 1000.0
    hits = tuple(
        RealHit(
            rank=rank,
            score=float(getattr(doc, "score", 0.0)),
            concept_id=str(doc.fields.get("concept_id", "")),
            title=str(doc.fields.get("title", "")),
        )
        for rank, doc in enumerate(docs, start=1)
    )
    return RealResult(case=case, hits=hits, zvec_latency_ms=latency_ms)


def metrics_for(results: list[RealResult], top_ks: Sequence[int]) -> dict[str, Any]:
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
        metrics[f"recall@{k}"] = statistics.fmean(result.recall_at(k) for result in results)
    return metrics


def grouped_metrics(results: list[RealResult], top_ks: Sequence[int]) -> dict[str, Any]:
    grouped: dict[str, list[RealResult]] = {}
    for result in results:
        grouped.setdefault(result.case.query_type, []).append(result)
    return {
        query_type: metrics_for(items, top_ks)
        for query_type, items in sorted(grouped.items())
    }


def run_profile(
    config: dict[str, Any],
    *,
    bundle_root: Path,
    db_path: Path,
    concepts,
    cases: list[RealCase],
    query_vectors: list[list[float]],
    embedder: MiniLMOnnxEmbedder,
    batch_size: int,
    candidate_k: int,
) -> dict[str, Any]:
    profile_name = str(config["name"])
    embedding_profile = str(config["embedding_profile"])
    rerank = bool(config["rerank"])
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
    top_k = max(TOP_KS)
    active_candidate_k = min(candidate_k, len(concepts)) if rerank else top_k
    results = [
        query_collection(
            collection,
            case,
            vector,
            top_k=top_k,
            candidate_k=active_candidate_k,
            rerank=rerank,
        )
        for case, vector in zip(cases, query_vectors, strict=True)
    ]
    return {
        "profile": profile_name,
        "embedding_profile": embedding_profile,
        "rerank": rerank,
        "candidate_k": active_candidate_k,
        "db": str(db_path),
        "build_ms": build_ms,
        "metrics": metrics_for(results, TOP_KS),
        "by_type": grouped_metrics(results, TOP_KS),
        "failures": [
            {
                "id": result.case.case_id,
                "query_type": result.case.query_type,
                "query": result.case.query,
                "expected": list(result.case.expected),
                "first_rank": result.first_rank(),
                "top_hit": result.hits[0].concept_id if result.hits else "",
            }
            for result in results
            if result.first_rank() != 1
        ],
    }


def metric(profile_payload: dict[str, Any], name: str) -> float:
    return float(profile_payload["metrics"].get(name, 0.0))


def by_type_hit(profile_payload: dict[str, Any], query_type: str, k: int) -> float:
    group = profile_payload["by_type"].get(query_type)
    if not group:
        return 0.0
    return float(group.get(f"hit@{k}", 0.0))


def render_markdown(payload: dict[str, Any]) -> str:
    query_types = payload["query_types"]
    lines = [
        "# Real OKF Knowledge Memory Benchmark",
        "",
        f"- Run ID: `{payload['run_id']}`",
        f"- Source bundle: `{payload['source_bundle']}`",
        f"- Enriched bundle: `{payload['bundle']}`",
        f"- Concepts: {payload['concept_count']}",
        f"- Queries: {payload['query_count']}",
        f"- Query types: {', '.join(query_types)}",
        f"- Query embedding avg ms: {payload['query_embedding_avg_ms']:.3f}",
        "",
        "## Summary",
        "",
        "| Profile | Embedding | Rerank | hit@1 | hit@5 | hit@10 | MRR | Zvec median ms |",
        "|---|---|---:|---:|---:|---:|---:|---:|",
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
            f"{metric(result, 'hit@10'):.4f} | "
            f"{metric(result, 'mrr'):.4f} | "
            f"{result['metrics']['zvec_latency_ms']['median']:.3f} |"
        )

    lines.extend(["", "## hit@1 By Query Type", ""])
    header = "| Profile | " + " | ".join(query_types) + " |"
    separator = "|---" + "|---:" * len(query_types) + "|"
    lines.extend([header, separator])
    for profile in PROFILES:
        result = payload["profiles"][profile]
        values = " | ".join(f"{by_type_hit(result, query_type, 1):.4f}" for query_type in query_types)
        lines.append(f"| {profile} | {values} |")

    lines.extend(
        [
            "",
            "## Notes",
            "",
            "- The source documents are real OKF files from the selected bundle.",
            "- Nocturne metadata is generated in the copied test bundle because the source bundle does not carry Nocturne fields.",
            "- Queries are generated from real titles, descriptions, resources, tags, and schema fields. This is more realistic than the synthetic proof, but it is still not a human-labeled benchmark.",
            "- `full_hybrid` uses full Zvec candidate retrieval plus generic structured-field reranking.",
            "",
            "## Failure Counts",
            "",
            "| Profile | Rank-1 failures |",
            "|---|---:|",
        ]
    )
    for profile in PROFILES:
        lines.append(f"| {profile} | {len(payload['profiles'][profile]['failures'])} |")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-bundle", required=True)
    parser.add_argument("--run-root", default="data/real-okf-knowledge-memory")
    parser.add_argument("--output-dir", default="reports")
    parser.add_argument("--run-id", default="")
    parser.add_argument("--max-cases-per-concept", type=int, default=4)
    parser.add_argument("--candidate-k", type=int, default=40)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--cache-dir", default=".cache/huggingface")
    parser.add_argument("--onnx-file", default="onnx/model.onnx")
    parser.add_argument("--max-length", type=int, default=256)
    args = parser.parse_args()

    source_bundle = Path(args.source_bundle)
    if not source_bundle.exists():
        raise SystemExit(f"Source bundle not found: {source_bundle}")

    run_id = args.run_id or f"{source_bundle.name}-{now_id()}"
    run_root = Path(args.run_root) / run_id
    if run_root.exists():
        raise SystemExit(f"Run root already exists: {run_root}")
    bundle_root = run_root / "bundle"
    db_root = run_root / "zvec"
    db_root.mkdir(parents=True, exist_ok=True)

    copied_count = copy_and_enrich_bundle(source_bundle, bundle_root)
    concepts = load_enriched_concepts(bundle_root)
    cases = build_cases(concepts, max_cases_per_concept=args.max_cases_per_concept)
    if not cases:
        raise SystemExit("No benchmark cases generated")

    eval_path = run_root / "eval.json"
    eval_path.write_text(
        json.dumps(
            {
                "name": f"real-okf-{source_bundle.name}",
                "source_bundle": str(source_bundle),
                "queries": [
                    {
                        "id": case.case_id,
                        "query_type": case.query_type,
                        "query": case.query,
                        "expected": list(case.expected),
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
        name = str(config["name"])
        profiles[name] = run_profile(
            config,
            bundle_root=bundle_root,
            db_path=db_root / name,
            concepts=concepts,
            cases=cases,
            query_vectors=query_vectors,
            embedder=embedder,
            batch_size=args.batch_size,
            candidate_k=args.candidate_k,
        )

    query_types = sorted({case.query_type for case in cases})
    payload: dict[str, Any] = {
        "run_id": run_id,
        "run_root": str(run_root),
        "source_bundle": str(source_bundle),
        "bundle": str(bundle_root),
        "eval": str(eval_path),
        "copied_count": copied_count,
        "concept_count": len(concepts),
        "query_count": len(cases),
        "query_types": query_types,
        "query_embedding_total_ms": query_embedding_ms,
        "query_embedding_avg_ms": query_embedding_ms / len(cases),
        "profiles": profiles,
    }

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / f"real-okf-knowledge-memory-{run_id}.json"
    md_path = output_dir / f"real-okf-knowledge-memory-{run_id}.md"
    json_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    md_path.write_text(render_markdown(payload), encoding="utf-8")

    print(f"JSON: {json_path}")
    print(f"Markdown: {md_path}")
    print(f"Concepts: {len(concepts)} copied_from_source={copied_count}")
    print(f"Queries: {len(cases)} types={', '.join(query_types)}")
    for profile in PROFILES:
        result = profiles[profile]
        print(
            f"{profile}: "
            f"hit@1={metric(result, 'hit@1'):.4f} "
            f"hit@5={metric(result, 'hit@5'):.4f} "
            f"mrr={metric(result, 'mrr'):.4f}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
