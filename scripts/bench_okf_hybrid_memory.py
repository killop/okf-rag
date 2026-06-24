"""Generate OKF markdown memory data and benchmark hybrid retrieval.

The script turns public Objective/Key Results examples into OKF + Nocturne
markdown concept files, then compares body/OKF/full/full-hybrid retrieval.
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
from urllib.request import urlretrieve

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


DEFAULT_SOURCE_URL = "https://raw.githubusercontent.com/joelparkerhenderson/objectives-and-key-results/main/examples/okfs-by-atiim/index.md"
PROFILE_CONFIGS = (
    {"name": "body", "embedding_profile": "body", "rerank": False},
    {"name": "okf", "embedding_profile": "okf", "rerank": False},
    {"name": "full", "embedding_profile": "full", "rerank": False},
    {"name": "full_hybrid", "embedding_profile": "full", "rerank": True},
)
PROFILES = tuple(str(config["name"]) for config in PROFILE_CONFIGS)
TOP_KS = (1, 3, 5, 10)
TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9+_-]*")
NUMBER_RE = re.compile(r"(?:\$?\d+(?:[.,]\d+)*(?:\s?%|\s?Million|\s?Billion|\s?K|\+)?)", re.I)
STOPWORDS = {
    "a",
    "about",
    "achieve",
    "and",
    "based",
    "build",
    "by",
    "company",
    "customer",
    "customers",
    "for",
    "from",
    "get",
    "grow",
    "improve",
    "increase",
    "key",
    "launch",
    "more",
    "new",
    "of",
    "okf",
    "okfs",
    "our",
    "results",
    "the",
    "to",
    "with",
}


@dataclass(frozen=True)
class SourceOkf:
    ordinal: int
    domain: str
    objective: str
    key_results: tuple[str, ...]


@dataclass(frozen=True)
class OkfCase:
    case_id: str
    query_type: str
    query: str
    expected: tuple[str, ...]


@dataclass(frozen=True)
class OkfHit:
    rank: int
    score: float
    concept_id: str
    title: str


@dataclass(frozen=True)
class OkfResult:
    case: OkfCase
    hits: tuple[OkfHit, ...]
    latency_ms: float

    def first_rank(self) -> int | None:
        expected = set(self.case.expected)
        for hit in self.hits:
            if hit.concept_id in expected:
                return hit.rank
        return None

    def hit_at(self, k: int) -> float:
        expected = set(self.case.expected)
        return 1.0 if any(hit.concept_id in expected for hit in self.hits[:k]) else 0.0

    def mrr_at(self, k: int) -> float:
        expected = set(self.case.expected)
        for rank, hit in enumerate(self.hits[:k], start=1):
            if hit.concept_id in expected:
                return 1.0 / rank
        return 0.0


def now_id() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def slugify(text: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_]+", "-", text.lower()).strip("-")
    return slug or "okf"


def clean_line(line: str) -> str:
    return re.sub(r"\s+", " ", line.strip()).strip()


def tokens(text: str) -> list[str]:
    ordered = []
    seen = set()
    for token in TOKEN_RE.findall(text):
        lowered = token.lower()
        if lowered in STOPWORDS or len(lowered) < 3:
            continue
        if lowered not in seen:
            seen.add(lowered)
            ordered.append(lowered)
    return ordered


def extract_metrics(text: str) -> list[str]:
    values = []
    seen = set()
    for match in NUMBER_RE.findall(text):
        value = clean_line(match)
        key = value.lower()
        if value and key not in seen:
            seen.add(key)
            values.append(value)
    return values


def ensure_source(source_path: Path, source_url: str) -> None:
    if source_path.exists():
        return
    source_path.parent.mkdir(parents=True, exist_ok=True)
    urlretrieve(source_url, source_path)


def parse_source_okfs(source_path: Path) -> list[SourceOkf]:
    lines = source_path.read_text(encoding="utf-8").splitlines()
    domain_stack: list[str] = []
    okfs: list[SourceOkf] = []
    current_objective = ""
    current_key_results: list[str] = []

    def flush() -> None:
        nonlocal current_objective, current_key_results
        if current_objective and current_key_results:
            domain = " / ".join(domain_stack[-2:]) if domain_stack else "General OKFs"
            okfs.append(
                SourceOkf(
                    ordinal=len(okfs),
                    domain=domain,
                    objective=current_objective,
                    key_results=tuple(current_key_results),
                )
            )
        current_objective = ""
        current_key_results = []

    for raw_line in lines:
        line = clean_line(raw_line)
        if not line:
            continue
        heading = re.match(r"^(#{2,4})\s+(.+)$", line)
        if heading:
            flush()
            level = len(heading.group(1))
            title = clean_line(heading.group(2))
            if title.lower().startswith("objectives and key results"):
                continue
            while len(domain_stack) >= max(1, level - 1):
                domain_stack.pop()
            domain_stack.append(title)
            continue
        objective = re.match(r"^Objective:\s+(.+)$", line, re.I)
        if objective:
            flush()
            current_objective = clean_line(objective.group(1))
            continue
        bullet = re.match(r"^\*\s+(.+)$", line)
        if current_objective and bullet:
            current_key_results.append(clean_line(bullet.group(1)))
    flush()
    return okfs


def summarize_okf(okf: SourceOkf) -> dict[str, Any]:
    source_text = " ".join([okf.objective, *okf.key_results])
    keywords = tokens(source_text)[:8]
    metrics = extract_metrics(source_text)[:8]
    first_results = "; ".join(okf.key_results[:2])
    theme = ", ".join(keywords[:4]) if keywords else okf.objective.lower()
    summary = (
        f"This OKF focuses on {theme} within {okf.domain}. "
        f"Progress is measured through key results such as {first_results}."
    )
    return {
        "keywords": keywords,
        "metrics": metrics,
        "summary": summary,
        "theme": theme,
    }


def write_okf_bundle(okfs: list[SourceOkf], bundle_root: Path, source_url: str) -> None:
    objectives_dir = bundle_root / "objectives"
    objectives_dir.mkdir(parents=True, exist_ok=True)
    for okf in okfs:
        summary = summarize_okf(okf)
        slug = f"{okf.ordinal:03d}-{slugify(okf.objective)}"
        tags = ["okf", "objective", slugify(okf.domain), *summary["keywords"][:5]]
        concept_id = f"objectives/{slug}"
        disclosure = (
            f"When planning OKFs for {okf.domain} around {summary['theme']} "
            f"or reviewing measurable key results."
        )
        frontmatter = {
            "type": "OKF Objective",
            "title": okf.objective,
            "description": summary["summary"],
            "resource": f"{source_url}#{slug}",
            "tags": tags,
            "timestamp": "2026-06-23T00:00:00Z",
            "nocturne": {
                "uri": f"okf://{slugify(okf.domain).replace('-', '_')}/{slug}",
                "disclosure": disclosure,
                "priority": 2,
                "aliases": [
                    {
                        "uri": f"planning://okf/{slug}",
                        "disclosure": f"When selecting OKF examples for {okf.domain}.",
                        "priority": 3,
                    }
                ],
            },
            "okf": {
                "domain": okf.domain,
                "objective": okf.objective,
                "key_results": list(okf.key_results),
                "metrics": summary["metrics"],
                "keywords": summary["keywords"],
            },
        }
        body_lines = [
            f"# {okf.objective}",
            "",
            f"Domain: {okf.domain}",
            "",
            "## Summary",
            summary["summary"],
            "",
            "## Objective",
            okf.objective,
            "",
            "## Key Results",
        ]
        body_lines.extend(f"- {key_result}" for key_result in okf.key_results)
        body_lines.extend(
            [
                "",
                "## Recall Notes",
                f"- Disclosure: {disclosure}",
                f"- Keywords: {', '.join(summary['keywords'])}",
                f"- Metrics: {', '.join(summary['metrics']) if summary['metrics'] else 'none'}",
            ]
        )
        fm_text = yaml.safe_dump(frontmatter, sort_keys=False, allow_unicode=True).rstrip()
        (objectives_dir / f"{slug}.md").write_text(
            f"---\n{fm_text}\n---\n\n" + "\n".join(body_lines).strip() + "\n",
            encoding="utf-8",
        )
    write_okf_indexes(bundle_root)


def load_bundle_concepts(bundle_root: Path):
    concepts, errors = load_concepts(bundle_root, ignore_non_concepts=False)
    fail_if_invalid(concepts, errors, allow_missing_nocturne=False)
    return concepts


def build_cases(concepts, max_cases_per_concept: int) -> list[OkfCase]:
    cases: list[OkfCase] = []
    for concept in concepts:
        okf_meta = concept.frontmatter.get("okf") if isinstance(concept.frontmatter.get("okf"), dict) else {}
        objective = str(okf_meta.get("objective") or concept.title)
        domain = str(okf_meta.get("domain") or "")
        key_results = [str(item) for item in okf_meta.get("key_results") or []]
        metrics = [str(item) for item in okf_meta.get("metrics") or []]
        keywords = [str(item) for item in okf_meta.get("keywords") or []]
        concept_id = concept.concept_id
        local = [
            OkfCase(
                case_id=f"objective_{slugify(concept_id)}",
                query_type="objective",
                query=f"Which OKF objective focuses on {objective}?",
                expected=(concept_id,),
            ),
            OkfCase(
                case_id=f"summary_{slugify(concept_id)}",
                query_type="summary",
                query=f"I need an OKF for {domain} about {', '.join(keywords[:4])}. Which objective fits?",
                expected=(concept_id,),
            ),
            OkfCase(
                case_id=f"disclosure_{slugify(concept_id)}",
                query_type="disclosure",
                query=concept.disclosure,
                expected=(concept_id,),
            ),
        ]
        if key_results:
            local.append(
                OkfCase(
                    case_id=f"key_result_{slugify(concept_id)}",
                    query_type="key_result",
                    query=f"Which OKF includes a key result to {key_results[0]}?",
                    expected=(concept_id,),
                )
            )
        if metrics:
            local.append(
                OkfCase(
                    case_id=f"metric_{slugify(concept_id)}",
                    query_type="metric",
                    query=f"Which OKF tracks metrics like {', '.join(metrics[:3])} for {', '.join(keywords[:4])}?",
                    expected=(concept_id,),
                )
            )
        cases.extend(local[:max_cases_per_concept])
    return cases


def percentile(values: Sequence[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = int(round((len(ordered) - 1) * q))
    return ordered[max(0, min(idx, len(ordered) - 1))]


def query_collection(
    collection: zvec.Collection,
    case: OkfCase,
    vector: list[float],
    *,
    top_k: int,
    candidate_k: int,
    rerank: bool,
) -> OkfResult:
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
        OkfHit(
            rank=rank,
            score=float(getattr(doc, "score", 0.0)),
            concept_id=str(doc.fields.get("concept_id", "")),
            title=str(doc.fields.get("title", "")),
        )
        for rank, doc in enumerate(docs, start=1)
    )
    return OkfResult(case=case, hits=hits, latency_ms=latency_ms)


def metrics_for(results: list[OkfResult], top_ks: Sequence[int]) -> dict[str, Any]:
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
        metrics[f"mrr@{k}"] = statistics.fmean(result.mrr_at(k) for result in results)
    return metrics


def grouped_metrics(results: list[OkfResult], top_ks: Sequence[int]) -> dict[str, Any]:
    grouped: dict[str, list[OkfResult]] = {}
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
    cases: list[OkfCase],
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
        "# OKF Hybrid Knowledge Memory Benchmark",
        "",
        f"- Run ID: `{payload['run_id']}`",
        f"- Source URL: `{payload['source_url']}`",
        f"- Source path: `{payload['source_path']}`",
        f"- OKF bundle: `{payload['bundle']}`",
        f"- OKF objectives: {payload['okf_count']}",
        f"- Generated markdown concepts: {payload['concept_count']}",
        f"- Queries: {payload['query_count']}",
        f"- Query types: {', '.join(query_types)}",
        f"- Query embedding avg ms: {payload['query_embedding_avg_ms']:.3f}",
        "",
        "## Summary",
        "",
        "| Profile | Embedding | Rerank | hit@1 | hit@3 | hit@5 | hit@10 | MRR@10 | Zvec median ms |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for profile in PROFILES:
        result = payload["profiles"][profile]
        lines.append(
            "| "
            f"{profile} | "
            f"{result['embedding_profile']} | "
            f"{str(result['rerank']).lower()} | "
            f"{metric(result, 'hit@1'):.4f} | "
            f"{metric(result, 'hit@3'):.4f} | "
            f"{metric(result, 'hit@5'):.4f} | "
            f"{metric(result, 'hit@10'):.4f} | "
            f"{metric(result, 'mrr@10'):.4f} | "
            f"{result['metrics']['latency_ms']['median']:.3f} |"
        )

    lines.extend(["", "## hit@1 By Query Type", ""])
    lines.append("| Profile | " + " | ".join(query_types) + " |")
    lines.append("|---" + "|---:" * len(query_types) + "|")
    for profile in PROFILES:
        result = payload["profiles"][profile]
        values = " | ".join(f"{by_type_hit(result, query_type, 1):.4f}" for query_type in query_types)
        lines.append(f"| {profile} | {values} |")

    lines.extend(
        [
            "",
            "## What Was Generated",
            "",
            "Each OKF objective was converted into an OKF markdown concept with:",
            "",
            "- OKF frontmatter: type, title, description, resource, tags, timestamp.",
            "- Nocturne metadata: uri, disclosure, priority, aliases.",
            "- Body sections: Summary, Objective, Key Results, Recall Notes.",
            "",
            "## Caveats",
            "",
            "- The OKF objectives and key results come from a public example source.",
            "- The summaries, tags, disclosures, and benchmark queries are generated deterministically by this script.",
            "- This measures whether the hybrid memory structure can retrieve generated OKF knowledge points. It is not a human-labeled OKF search benchmark.",
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
    parser.add_argument("--source-path", default="data/external-okf-source-atiim.md")
    parser.add_argument("--source-url", default=DEFAULT_SOURCE_URL)
    parser.add_argument("--run-root", default="data/okf-memory-benchmark")
    parser.add_argument("--output-dir", default="reports")
    parser.add_argument("--run-id", default="")
    parser.add_argument("--max-cases-per-concept", type=int, default=5)
    parser.add_argument("--candidate-k", type=int, default=60)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--cache-dir", default=".cache/huggingface")
    parser.add_argument("--onnx-file", default="onnx/model.onnx")
    parser.add_argument("--max-length", type=int, default=256)
    args = parser.parse_args()

    source_path = Path(args.source_path)
    ensure_source(source_path, args.source_url)
    okfs = parse_source_okfs(source_path)
    if not okfs:
        raise SystemExit(f"No OKFs parsed from {source_path}")

    run_id = args.run_id or f"okf-hybrid-{now_id()}"
    run_root = Path(args.run_root) / run_id
    if run_root.exists():
        raise SystemExit(f"Run root already exists: {run_root}")
    bundle_root = run_root / "bundle"
    db_root = run_root / "zvec"
    db_root.mkdir(parents=True, exist_ok=True)

    write_okf_bundle(okfs, bundle_root, args.source_url)
    concepts = load_bundle_concepts(bundle_root)
    cases = build_cases(concepts, args.max_cases_per_concept)
    if not cases:
        raise SystemExit("No benchmark cases generated")

    eval_path = run_root / "eval.json"
    eval_path.write_text(
        json.dumps(
            {
                "name": "okf-hybrid-memory",
                "source_url": args.source_url,
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
        "source_url": args.source_url,
        "source_path": str(source_path),
        "bundle": str(bundle_root),
        "eval": str(eval_path),
        "okf_count": len(okfs),
        "concept_count": len(concepts),
        "query_count": len(cases),
        "query_types": query_types,
        "query_embedding_total_ms": query_embedding_ms,
        "query_embedding_avg_ms": query_embedding_ms / len(cases),
        "profiles": profiles,
    }

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / f"okf-hybrid-memory-benchmark-{run_id}.json"
    md_path = output_dir / f"okf-hybrid-memory-benchmark-{run_id}.md"
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    md_path.write_text(render_markdown(payload), encoding="utf-8")

    print(f"JSON: {json_path}")
    print(f"Markdown: {md_path}")
    print(f"OKF bundle: {bundle_root}")
    print(f"OKFs: {len(okfs)} concepts={len(concepts)} queries={len(cases)}")
    for profile in PROFILES:
        result = profiles[profile]
        print(
            f"{profile}: "
            f"hit@1={metric(result, 'hit@1'):.4f} "
            f"hit@5={metric(result, 'hit@5'):.4f} "
            f"mrr@10={metric(result, 'mrr@10'):.4f}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
