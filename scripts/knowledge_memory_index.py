"""Index OKF markdown knowledge memories into a local Zvec collection.

The script treats Knowledge Catalog / OKF markdown files as durable source
documents and Nocturne-style URI metadata as recall hints for semantic search.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np
import yaml
import zvec

from minilm_onnx_embed import EMBEDDING_DIMENSION, MiniLMOnnxEmbedder


RESERVED_MARKDOWN_NAMES = {"index.md", "log.md"}
FRONTMATTER_DELIMITER = "---"
URI_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*://.*$")
TOKEN_RE = re.compile(r"[A-Za-z0-9_]+")
MARKER_FILE = ".knowledge-memory-zvec.json"
OUTPUT_FIELDS = [
    "concept_id",
    "source_path",
    "title",
    "type",
    "description",
    "resource",
    "tags",
    "timestamp",
    "nocturne_uri",
    "disclosure",
    "priority",
    "aliases",
    "body",
    "embedding_text",
]
EMBEDDING_PROFILES = ("body", "okf", "full")
RERANK_FIELD_WEIGHTS = {
    "title": 2.0,
    "type": 0.6,
    "description": 1.5,
    "resource": 0.8,
    "tags": 1.4,
    "nocturne_uri": 1.2,
    "disclosure": 3.0,
    "aliases": 2.0,
    "body": 1.0,
}
RERANK_STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "how",
    "in",
    "into",
    "is",
    "it",
    "of",
    "on",
    "or",
    "should",
    "that",
    "the",
    "this",
    "to",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
    "with",
}


class KnowledgeMemoryError(ValueError):
    pass


@dataclass(frozen=True)
class ParsedMarkdown:
    frontmatter: dict[str, Any]
    body: str
    has_frontmatter: bool


@dataclass(frozen=True)
class KnowledgeConcept:
    concept_id: str
    source_path: Path
    relative_path: str
    frontmatter: dict[str, Any]
    body: str
    title: str
    type_name: str
    description: str
    resource: str
    tags: list[str]
    timestamp: str
    nocturne_uri: str
    disclosure: str
    priority: int
    aliases: list[dict[str, Any]]
    warnings: tuple[str, ...] = field(default_factory=tuple)

    @property
    def doc_id(self) -> str:
        digest = hashlib.sha1(self.concept_id.encode("utf-8")).hexdigest()[:24]
        return f"km_{digest}"

    @property
    def aliases_text(self) -> str:
        if not self.aliases:
            return ""
        return json.dumps(self.aliases, ensure_ascii=False, sort_keys=True)

    @property
    def embedding_text(self) -> str:
        return build_embedding_text(self, "full")


def build_embedding_text(concept: KnowledgeConcept, profile: str) -> str:
    if profile not in EMBEDDING_PROFILES:
        raise KnowledgeMemoryError(f"Unknown embedding profile: {profile}")
    if profile == "body":
        return concept.body.strip()

    parts = [
        "body:",
        concept.body.strip(),
        "",
        "catalog:",
        f"concept_id: {concept.concept_id}",
        f"title: {concept.title}",
        f"type: {concept.type_name}",
        f"description: {concept.description}",
        f"resource: {concept.resource}",
        f"tags: {', '.join(concept.tags)}",
        f"timestamp: {concept.timestamp}",
    ]
    if profile == "full":
        parts.extend(
            [
                "",
                "recall:",
                f"nocturne_uri: {concept.nocturne_uri}",
                f"disclosure: {concept.disclosure}",
                f"when_to_recall: {concept.disclosure}",
                f"priority: {concept.priority}",
                f"aliases: {concept.aliases_text}",
            ]
        )
    return "\n".join(parts).strip()


def rerank_tokens(text: Any) -> set[str]:
    return {
        token.lower()
        for token in TOKEN_RE.findall(str(text or ""))
        if len(token) > 1 and token.lower() not in RERANK_STOPWORDS
    }


def lexical_rerank_score(query: str, fields: dict[str, Any]) -> float:
    query_tokens = rerank_tokens(query)
    if not query_tokens:
        return 0.0
    weighted_overlap = 0.0
    for field_name, weight in RERANK_FIELD_WEIGHTS.items():
        field_tokens = rerank_tokens(fields.get(field_name, ""))
        if not field_tokens:
            continue
        weighted_overlap += weight * len(query_tokens & field_tokens)
    return weighted_overlap / len(query_tokens)


def rerank_zvec_docs(query: str, docs: Sequence[zvec.Doc], top_k: int) -> list[zvec.Doc]:
    scored = []
    for rank, doc in enumerate(docs):
        base_score = float(getattr(doc, "score", 0.0))
        lexical_score = lexical_rerank_score(query, dict(doc.fields))
        scored.append((lexical_score, base_score, -rank, doc))
    scored.sort(reverse=True, key=lambda item: (item[0], item[1], item[2]))
    return [item[3] for item in scored[:top_k]]


def parse_markdown(text: str) -> ParsedMarkdown:
    lines = text.splitlines()
    if not lines or lines[0].strip() != FRONTMATTER_DELIMITER:
        return ParsedMarkdown(frontmatter={}, body=text, has_frontmatter=False)

    end_idx = None
    for idx in range(1, len(lines)):
        if lines[idx].strip() == FRONTMATTER_DELIMITER:
            end_idx = idx
            break
    if end_idx is None:
        raise KnowledgeMemoryError("Unterminated YAML frontmatter block")

    fm_text = "\n".join(lines[1:end_idx])
    try:
        frontmatter = yaml.safe_load(fm_text) or {}
    except yaml.YAMLError as exc:
        raise KnowledgeMemoryError(f"Invalid YAML frontmatter: {exc}") from exc
    if not isinstance(frontmatter, dict):
        raise KnowledgeMemoryError("Frontmatter must be a YAML mapping")

    body = "\n".join(lines[end_idx + 1 :])
    if body.startswith("\n"):
        body = body[1:]
    return ParsedMarkdown(frontmatter=frontmatter, body=body, has_frontmatter=True)


def as_string(value: Any, default: str = "") -> str:
    if value is None:
        return default
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def normalize_tags(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        return [as_string(item).strip() for item in value if as_string(item).strip()]
    return [as_string(value)]


def normalize_aliases(value: Any) -> list[dict[str, Any]]:
    if not value:
        return []
    raw_items = value if isinstance(value, list) else [value]
    aliases: list[dict[str, Any]] = []
    for item in raw_items:
        if isinstance(item, str):
            aliases.append({"uri": item, "disclosure": "", "priority": 0})
            continue
        if isinstance(item, dict):
            aliases.append(
                {
                    "uri": as_string(item.get("uri")),
                    "disclosure": as_string(item.get("disclosure")),
                    "priority": normalize_priority(item.get("priority")),
                }
            )
    return aliases


def normalize_priority(value: Any) -> int:
    if value is None or value == "":
        return 0
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def nocturne_block(frontmatter: dict[str, Any]) -> dict[str, Any]:
    block = frontmatter.get("nocturne")
    return block if isinstance(block, dict) else {}


def concept_from_file(bundle_root: Path, path: Path) -> KnowledgeConcept:
    parsed = parse_markdown(path.read_text(encoding="utf-8"))
    if not parsed.has_frontmatter:
        raise KnowledgeMemoryError("Missing OKF YAML frontmatter")

    frontmatter = parsed.frontmatter
    rel_path = path.relative_to(bundle_root).as_posix()
    concept_id = rel_path.removesuffix(".md")
    warnings: list[str] = []

    type_name = as_string(frontmatter.get("type")).strip()
    if not type_name:
        raise KnowledgeMemoryError("Missing required OKF frontmatter field: type")

    title = as_string(frontmatter.get("title")).strip() or path.stem.replace("-", " ").title()
    description = as_string(frontmatter.get("description")).strip()
    resource = as_string(frontmatter.get("resource")).strip()
    tags = normalize_tags(frontmatter.get("tags"))
    timestamp = as_string(frontmatter.get("timestamp")).strip()

    for key in ("title", "description", "timestamp"):
        if not as_string(frontmatter.get(key)).strip():
            warnings.append(f"Missing recommended OKF field: {key}")

    block = nocturne_block(frontmatter)
    nocturne_uri = (
        as_string(block.get("uri")).strip()
        or as_string(frontmatter.get("nocturne_uri")).strip()
        or as_string(frontmatter.get("uri")).strip()
    )
    disclosure = (
        as_string(block.get("disclosure")).strip()
        or as_string(frontmatter.get("disclosure")).strip()
    )
    priority = normalize_priority(block.get("priority", frontmatter.get("priority")))
    aliases = normalize_aliases(block.get("aliases", frontmatter.get("aliases")))

    if nocturne_uri and not URI_RE.match(nocturne_uri):
        warnings.append(f"Nocturne URI is not domain://path format: {nocturne_uri}")
    if not nocturne_uri:
        warnings.append("Missing Nocturne URI")
    if not disclosure:
        warnings.append("Missing Nocturne disclosure")

    return KnowledgeConcept(
        concept_id=concept_id,
        source_path=path,
        relative_path=rel_path,
        frontmatter=frontmatter,
        body=parsed.body,
        title=title,
        type_name=type_name,
        description=description,
        resource=resource,
        tags=tags,
        timestamp=timestamp,
        nocturne_uri=nocturne_uri,
        disclosure=disclosure,
        priority=priority,
        aliases=aliases,
        warnings=tuple(warnings),
    )


def iter_concept_paths(bundle_root: Path) -> Iterable[Path]:
    for path in sorted(bundle_root.rglob("*.md")):
        if any(part.startswith(".") for part in path.relative_to(bundle_root).parts):
            continue
        if path.name.lower() in RESERVED_MARKDOWN_NAMES:
            continue
        yield path


def load_concepts(
    bundle_root: Path,
    *,
    ignore_non_concepts: bool,
) -> tuple[list[KnowledgeConcept], list[str]]:
    concepts: list[KnowledgeConcept] = []
    errors: list[str] = []
    for path in iter_concept_paths(bundle_root):
        try:
            concepts.append(concept_from_file(bundle_root, path))
        except KnowledgeMemoryError as exc:
            if ignore_non_concepts and "Missing OKF YAML frontmatter" in str(exc):
                continue
            rel = path.relative_to(bundle_root).as_posix()
            errors.append(f"{rel}: {exc}")
    return concepts, errors


def fail_if_invalid(
    concepts: list[KnowledgeConcept],
    errors: list[str],
    *,
    allow_missing_nocturne: bool,
) -> None:
    blocking = list(errors)
    if not allow_missing_nocturne:
        for concept in concepts:
            for warning in concept.warnings:
                if warning in {"Missing Nocturne URI", "Missing Nocturne disclosure"}:
                    blocking.append(f"{concept.relative_path}: {warning}")
    if blocking:
        joined = "\n".join(f"- {item}" for item in blocking)
        raise KnowledgeMemoryError(f"Cannot build knowledge memory index:\n{joined}")


def safe_collection_name(bundle_root: Path) -> str:
    name = bundle_root.name or "knowledge_memory"
    safe = re.sub(r"[^A-Za-z0-9_]+", "_", name).strip("_").lower()
    return safe or "knowledge_memory"


def create_schema(
    name: str,
    *,
    index_type: str,
    hnsw_m: int,
    hnsw_ef_construction: int,
) -> zvec.CollectionSchema:
    if index_type == "hnsw":
        index_param = zvec.HnswIndexParam(
            m=hnsw_m,
            ef_construction=hnsw_ef_construction,
        )
    else:
        index_param = zvec.FlatIndexParam()

    return zvec.CollectionSchema(
        name=name,
        fields=[
            zvec.FieldSchema("concept_id", zvec.DataType.STRING, nullable=False),
            zvec.FieldSchema("source_path", zvec.DataType.STRING, nullable=False),
            zvec.FieldSchema("title", zvec.DataType.STRING, nullable=False),
            zvec.FieldSchema("type", zvec.DataType.STRING, nullable=False),
            zvec.FieldSchema("description", zvec.DataType.STRING, nullable=False),
            zvec.FieldSchema("resource", zvec.DataType.STRING, nullable=False),
            zvec.FieldSchema("tags", zvec.DataType.STRING, nullable=False),
            zvec.FieldSchema("timestamp", zvec.DataType.STRING, nullable=False),
            zvec.FieldSchema("nocturne_uri", zvec.DataType.STRING, nullable=False),
            zvec.FieldSchema("disclosure", zvec.DataType.STRING, nullable=False),
            zvec.FieldSchema("priority", zvec.DataType.INT64, nullable=False),
            zvec.FieldSchema("aliases", zvec.DataType.STRING, nullable=False),
            zvec.FieldSchema("body", zvec.DataType.STRING, nullable=False),
            zvec.FieldSchema("embedding_text", zvec.DataType.STRING, nullable=False),
        ],
        vectors=zvec.VectorSchema(
            "embedding",
            zvec.DataType.VECTOR_FP32,
            EMBEDDING_DIMENSION,
            index_param=index_param,
        ),
    )


def concept_to_doc(
    concept: KnowledgeConcept,
    vector: np.ndarray,
    embedding_text: str,
) -> zvec.Doc:
    return zvec.Doc(
        id=concept.doc_id,
        fields={
            "concept_id": concept.concept_id,
            "source_path": str(concept.source_path),
            "title": concept.title,
            "type": concept.type_name,
            "description": concept.description,
            "resource": concept.resource,
            "tags": ", ".join(concept.tags),
            "timestamp": concept.timestamp,
            "nocturne_uri": concept.nocturne_uri,
            "disclosure": concept.disclosure,
            "priority": concept.priority,
            "aliases": concept.aliases_text,
            "body": concept.body,
            "embedding_text": embedding_text,
        },
        vectors={"embedding": vector.tolist()},
    )


def chunked(items: Sequence[KnowledgeConcept], size: int) -> Iterable[list[KnowledgeConcept]]:
    size = max(1, size)
    for start in range(0, len(items), size):
        yield list(items[start : start + size])


def collection_has_zvec_markers(path: Path) -> bool:
    return (
        (path / MARKER_FILE).exists()
        or (path / "LOCK").exists()
        or (path / "idmap.0").exists()
        or any(path.glob("manifest.*"))
    )


def recreate_collection_path(path: Path) -> None:
    if not path.exists():
        return
    resolved = path.resolve()
    if resolved == resolved.parent:
        raise KnowledgeMemoryError(f"Refusing to delete filesystem root: {resolved}")
    if not path.is_dir():
        raise KnowledgeMemoryError(f"Zvec db path exists and is not a directory: {path}")
    has_children = any(path.iterdir())
    if has_children and not collection_has_zvec_markers(path):
        raise KnowledgeMemoryError(
            f"Refusing to recreate non-Zvec-looking directory: {path}"
        )
    shutil.rmtree(path)


def write_marker(
    db_path: Path,
    bundle_root: Path,
    concept_count: int,
    index_type: str,
    embedding_profile: str,
) -> None:
    marker = {
        "kind": "knowledge-memory-zvec",
        "bundle": str(bundle_root.resolve()),
        "concept_count": concept_count,
        "index_type": index_type,
        "embedding_profile": embedding_profile,
        "embedding_dimension": EMBEDDING_DIMENSION,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    (db_path / MARKER_FILE).write_text(
        json.dumps(marker, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def build_zvec_index(
    concepts: list[KnowledgeConcept],
    *,
    bundle_root: Path,
    db_path: Path,
    recreate: bool,
    embedder: MiniLMOnnxEmbedder,
    index_type: str,
    embedding_profile: str,
    hnsw_m: int,
    hnsw_ef_construction: int,
    batch_size: int,
    optimize: bool,
) -> None:
    if not concepts:
        raise KnowledgeMemoryError("No OKF concept documents found")
    if recreate:
        recreate_collection_path(db_path)
    elif db_path.exists():
        raise KnowledgeMemoryError(
            f"Zvec db path already exists. Use --recreate to rebuild: {db_path}"
        )

    db_path.parent.mkdir(parents=True, exist_ok=True)
    collection = zvec.create_and_open(
        str(db_path),
        create_schema(
            safe_collection_name(bundle_root),
            index_type=index_type,
            hnsw_m=hnsw_m,
            hnsw_ef_construction=hnsw_ef_construction,
        ),
    )

    for batch in chunked(concepts, batch_size):
        embedding_texts = [
            build_embedding_text(concept, embedding_profile)
            for concept in batch
        ]
        vectors = embedder.encode(embedding_texts)
        docs = [
            concept_to_doc(concept, vector, embedding_text)
            for concept, vector, embedding_text in zip(
                batch,
                vectors,
                embedding_texts,
                strict=True,
            )
        ]
        collection.upsert(docs)

    collection.flush()
    if optimize:
        collection.optimize()
    write_marker(db_path, bundle_root, len(concepts), index_type, embedding_profile)


def index_entries_for_directory(directory: Path, bundle_root: Path) -> list[tuple[str, str, str, str]]:
    entries: list[tuple[str, str, str, str]] = []
    for child in sorted(directory.iterdir()):
        if child.name.lower() == "index.md":
            continue
        if child.is_dir():
            count = sum(1 for path in iter_concept_paths(child))
            if count:
                entries.append(
                    (
                        "Subdirectories",
                        child.name,
                        f"{child.name}/index.md",
                        f"Contains {count} knowledge concept(s).",
                    )
                )
            continue
        if child.is_file() and child.suffix.lower() == ".md":
            if child.name.lower() in RESERVED_MARKDOWN_NAMES:
                continue
            try:
                concept = concept_from_file(bundle_root, child)
            except KnowledgeMemoryError:
                continue
            entries.append(
                (
                    concept.type_name,
                    concept.title,
                    child.name,
                    concept.description,
                )
            )
    return entries


def render_index(entries: list[tuple[str, str, str, str]]) -> str:
    grouped: dict[str, list[tuple[str, str, str]]] = {}
    for type_name, title, link, description in entries:
        grouped.setdefault(type_name or "Other", []).append((title, link, description))

    sections: list[str] = []
    for type_name in sorted(grouped):
        lines = [f"# {type_name}", ""]
        for title, link, description in sorted(grouped[type_name], key=lambda item: item[0].lower()):
            suffix = f" - {description}" if description else ""
            lines.append(f"* [{title}]({link}){suffix}")
        sections.append("\n".join(lines))
    return "\n\n".join(sections).rstrip() + "\n"


def write_okf_indexes(bundle_root: Path) -> list[Path]:
    directories = {
        path.parent
        for path in iter_concept_paths(bundle_root)
    }
    directories.add(bundle_root)
    written: list[Path] = []
    for directory in sorted(directories, key=lambda path: len(path.parts), reverse=True):
        entries = index_entries_for_directory(directory, bundle_root)
        if not entries:
            continue
        index_path = directory / "index.md"
        index_path.write_text(render_index(entries), encoding="utf-8")
        written.append(index_path)
    return written


def validate_bundle(args: argparse.Namespace) -> int:
    bundle_root = Path(args.bundle)
    concepts, errors = load_concepts(
        bundle_root,
        ignore_non_concepts=args.ignore_non_concepts,
    )
    print(f"Bundle: {bundle_root}")
    print(f"Concepts: {len(concepts)}")
    if errors:
        print("Errors:")
        for error in errors:
            print(f"- {error}")
    warning_count = 0
    for concept in concepts:
        for warning in concept.warnings:
            warning_count += 1
            print(f"Warning: {concept.relative_path}: {warning}")
    if not errors and warning_count == 0:
        print("OK")
    return 1 if errors else 0


def command_build(args: argparse.Namespace) -> int:
    bundle_root = Path(args.bundle)
    db_path = Path(args.db)
    concepts, errors = load_concepts(
        bundle_root,
        ignore_non_concepts=args.ignore_non_concepts,
    )
    fail_if_invalid(
        concepts,
        errors,
        allow_missing_nocturne=args.allow_missing_nocturne,
    )

    if args.write_indexes:
        written = write_okf_indexes(bundle_root)
        print(f"Wrote {len(written)} OKF index file(s)")

    embedder = MiniLMOnnxEmbedder(
        cache_dir=args.cache_dir,
        onnx_file=args.onnx_file,
        max_length=args.max_length,
    )
    build_zvec_index(
        concepts,
        bundle_root=bundle_root,
        db_path=db_path,
        recreate=args.recreate,
        embedder=embedder,
        index_type=args.index_type,
        embedding_profile=args.embedding_profile,
        hnsw_m=args.hnsw_m,
        hnsw_ef_construction=args.hnsw_ef_construction,
        batch_size=args.batch_size,
        optimize=args.optimize,
    )
    print(f"Indexed {len(concepts)} concept(s) into {db_path}")
    return 0


def doc_to_result(doc: zvec.Doc) -> dict[str, Any]:
    fields = dict(doc.fields)
    return {
        "id": doc.id,
        "score": float(getattr(doc, "score", 0.0)),
        **fields,
    }


def command_query(args: argparse.Namespace) -> int:
    embedder = MiniLMOnnxEmbedder(
        cache_dir=args.cache_dir,
        onnx_file=args.onnx_file,
        max_length=args.max_length,
    )
    collection = zvec.open(str(Path(args.db)))
    vector = embedder.encode(args.text)
    query_param = None
    if args.hnsw_ef:
        query_param = zvec.HnswQueryParam(ef=args.hnsw_ef)
    candidate_k = max(args.top_k, args.candidate_k or args.top_k)
    docs = collection.query(
        queries=zvec.Query(
            field_name="embedding",
            vector=vector.tolist(),
            param=query_param,
        ),
        topk=candidate_k,
        output_fields=OUTPUT_FIELDS,
    )
    if args.rerank:
        docs = rerank_zvec_docs(args.text, docs, args.top_k)
    else:
        docs = docs[: args.top_k]
    results = [doc_to_result(doc) for doc in docs]
    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return 0

    for idx, result in enumerate(results, start=1):
        print(
            f"{idx}. score={result['score']:.6f} "
            f"{result['title']} [{result['concept_id']}]"
        )
        print(f"   uri: {result['nocturne_uri']}")
        print(f"   disclosure: {result['disclosure']}")
        if result.get("description"):
            print(f"   description: {result['description']}")
    return 0


def command_write_indexes(args: argparse.Namespace) -> int:
    written = write_okf_indexes(Path(args.bundle))
    for path in written:
        print(path)
    print(f"Wrote {len(written)} OKF index file(s)")
    return 0


def add_common_embedding_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--cache-dir", default=".cache/huggingface")
    parser.add_argument("--onnx-file", default="onnx/model.onnx")
    parser.add_argument("--max-length", type=int, default=256)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build and query a Zvec semantic index for OKF + Nocturne markdown memories."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate = subparsers.add_parser("validate", help="Validate an OKF memory bundle.")
    validate.add_argument("--bundle", required=True)
    validate.add_argument("--ignore-non-concepts", action="store_true")
    validate.set_defaults(func=validate_bundle)

    build = subparsers.add_parser("build", help="Build a local Zvec memory index.")
    build.add_argument("--bundle", required=True)
    build.add_argument("--db", required=True)
    build.add_argument("--recreate", action="store_true")
    build.add_argument("--write-indexes", action="store_true")
    build.add_argument("--allow-missing-nocturne", action="store_true")
    build.add_argument("--ignore-non-concepts", action="store_true")
    build.add_argument("--index-type", choices=("flat", "hnsw"), default="hnsw")
    build.add_argument(
        "--embedding-profile",
        choices=EMBEDDING_PROFILES,
        default="full",
        help="body=body only, okf=OKF metadata plus body, full=OKF plus Nocturne metadata plus body.",
    )
    build.add_argument("--hnsw-m", type=int, default=32)
    build.add_argument("--hnsw-ef-construction", type=int, default=128)
    build.add_argument("--batch-size", type=int, default=64)
    build.add_argument("--optimize", action="store_true")
    add_common_embedding_args(build)
    build.set_defaults(func=command_build)

    query = subparsers.add_parser("query", help="Query a local Zvec memory index.")
    query.add_argument("--db", required=True)
    query.add_argument("--text", required=True)
    query.add_argument("--top-k", type=int, default=5)
    query.add_argument("--candidate-k", type=int, default=0)
    query.add_argument("--hnsw-ef", type=int, default=128)
    query.add_argument("--rerank", action="store_true")
    query.add_argument("--json", action="store_true")
    add_common_embedding_args(query)
    query.set_defaults(func=command_query)

    indexes = subparsers.add_parser("write-indexes", help="Generate OKF index.md files.")
    indexes.add_argument("--bundle", required=True)
    indexes.set_defaults(func=command_write_indexes)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return int(args.func(args))
    except KnowledgeMemoryError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
