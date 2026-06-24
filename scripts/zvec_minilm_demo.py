"""Minimal Zvec demo fed by all-MiniLM-L6-v2 ONNX embeddings.

Creates or opens a local Zvec collection, inserts a few Markdown-memory sample
documents, embeds the query with ONNX Runtime, and prints nearest matches.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Sequence

import zvec

from minilm_onnx_embed import EMBEDDING_DIMENSION, MiniLMOnnxEmbedder


SAMPLE_DOCS = [
    {
        "id": "contexts_ordering",
        "title": "Ordering Context",
        "body": "Ordering owns order placement, order lifecycle state, and customer-facing order decisions.",
        "domain_context": "architecture",
    },
    {
        "id": "rules_domain_language",
        "title": "Ubiquitous Language Rule",
        "body": "Concepts should use canonical domain terms and avoid implementation-only aliases when describing business behavior.",
        "domain_context": "governance",
    },
    {
        "id": "concepts_invoice",
        "title": "Invoice Concept",
        "body": "An invoice is a request for payment that belongs to one customer and references billable order events.",
        "domain_context": "billing",
    },
]


def create_schema() -> zvec.CollectionSchema:
    return zvec.CollectionSchema(
        name="domain_memory_demo",
        fields=[
            zvec.FieldSchema("title", zvec.DataType.STRING, nullable=False),
            zvec.FieldSchema("body", zvec.DataType.STRING, nullable=False),
            zvec.FieldSchema("domain_context", zvec.DataType.STRING, nullable=False),
        ],
        vectors=zvec.VectorSchema(
            "embedding",
            zvec.DataType.VECTOR_FP32,
            EMBEDDING_DIMENSION,
        ),
    )


def open_or_create(path: Path) -> zvec.Collection:
    try:
        return zvec.open(str(path))
    except Exception:
        path.parent.mkdir(parents=True, exist_ok=True)
        return zvec.create_and_open(str(path), create_schema())


def embed_text(doc: dict[str, str]) -> str:
    return f"{doc['title']}\n\n{doc['body']}"


def upsert_samples(collection: zvec.Collection, embedder: MiniLMOnnxEmbedder) -> None:
    vectors = embedder.encode([embed_text(doc) for doc in SAMPLE_DOCS])
    docs = [
        zvec.Doc(
            id=doc["id"],
            fields={
                "title": doc["title"],
                "body": doc["body"],
                "domain_context": doc["domain_context"],
            },
            vectors={"embedding": vector.tolist()},
        )
        for doc, vector in zip(SAMPLE_DOCS, vectors, strict=True)
    ]
    collection.upsert(docs)
    collection.flush()


def query(collection: zvec.Collection, embedder: MiniLMOnnxEmbedder, text: str) -> Sequence[zvec.Doc]:
    vector = embedder.encode(text).tolist()
    return collection.query(
        queries=zvec.Query(field_name="embedding", vector=vector),
        topk=3,
        output_fields=["title", "body", "domain_context"],
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--db",
        default="data/zvec-minilm-demo",
        help="Local Zvec collection path.",
    )
    parser.add_argument(
        "--query",
        default="Which concept explains billing payment requests",
        help="Query text to embed and search.",
    )
    parser.add_argument("--cache-dir", default=".cache/huggingface")
    parser.add_argument("--onnx-file", default="onnx/model.onnx")
    args = parser.parse_args()

    embedder = MiniLMOnnxEmbedder(
        cache_dir=args.cache_dir,
        onnx_file=args.onnx_file,
    )
    collection = open_or_create(Path(args.db))
    upsert_samples(collection, embedder)

    for doc in query(collection, embedder, args.query):
        print(f"{doc.id}\tscore={doc.score:.6f}\t{doc.fields['title']}")
        print(doc.fields["body"])


if __name__ == "__main__":
    main()
