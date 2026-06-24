"""Run MemPalace memory benchmarks through Zvec retrieval.

Adapters load LongMemEval, LoCoMo, and ConvoMem data while the core indexer
only handles generic text documents, embeddings, and TopK vector search.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shutil
import time
import urllib.request
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Iterable

import numpy as np
import zvec

from minilm_onnx_embed import EMBEDDING_DIMENSION, MiniLMOnnxEmbedder


LME_URL = (
    "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/"
    "resolve/main/longmemeval_s_cleaned.json"
)
LOCOMO_URL = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json"
CONVOMEM_HF_BASE = (
    "https://huggingface.co/datasets/Salesforce/ConvoMem/resolve/main/"
    "core_benchmark/evidence_questions"
)
CONVOMEM_HF_API = (
    "https://huggingface.co/api/datasets/Salesforce/ConvoMem/tree/main/"
    "core_benchmark/evidence_questions"
)

LME_KS = [1, 3, 5, 10, 30, 50]
WORD_NUMBERS = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
}
STOP_WORDS = {
    "a",
    "about",
    "after",
    "all",
    "also",
    "am",
    "an",
    "and",
    "any",
    "are",
    "as",
    "at",
    "be",
    "been",
    "between",
    "but",
    "by",
    "can",
    "could",
    "did",
    "do",
    "does",
    "for",
    "from",
    "gave",
    "get",
    "got",
    "had",
    "has",
    "have",
    "he",
    "her",
    "him",
    "his",
    "how",
    "i",
    "in",
    "is",
    "it",
    "me",
    "mention",
    "mentioned",
    "my",
    "of",
    "on",
    "or",
    "our",
    "she",
    "that",
    "the",
    "their",
    "there",
    "they",
    "this",
    "to",
    "was",
    "we",
    "were",
    "what",
    "when",
    "where",
    "which",
    "who",
    "with",
    "would",
    "you",
    "your",
}
TEMPORAL_WORDS = {
    "ago",
    "april",
    "august",
    "couple",
    "day",
    "days",
    "december",
    "february",
    "friday",
    "january",
    "july",
    "june",
    "last",
    "march",
    "may",
    "monday",
    "month",
    "months",
    "november",
    "october",
    "saturday",
    "september",
    "sunday",
    "thursday",
    "tuesday",
    "wednesday",
    "week",
    "weeks",
    "yesterday",
}
LOCOMO_CATEGORIES = {
    1: "Single-hop",
    2: "Temporal",
    3: "Temporal-inference",
    4: "Open-domain",
    5: "Adversarial",
}
CONVOMEM_CATEGORIES = {
    "user_evidence": "User Facts",
    "assistant_facts_evidence": "Assistant Facts",
    "changing_evidence": "Changing Facts",
    "abstention_evidence": "Abstention",
    "preference_evidence": "Preferences",
    "implicit_connection_evidence": "Implicit Connections",
}
CONVOMEM_SAMPLE_FILES = {
    "user_evidence": "1_evidence/0050e213-5032-42a0-8041-b5eef2f8ab91_Telemarketer.json",
    "assistant_facts_evidence": None,
    "changing_evidence": None,
    "abstention_evidence": None,
    "preference_evidence": None,
    "implicit_connection_evidence": None,
}


@dataclass(frozen=True)
class TextDoc:
    corpus_id: str
    body: str
    timestamp: str = ""
    variant: str = "raw"


@dataclass(frozen=True)
class RetrievalHit:
    doc: TextDoc
    rank: int
    score: float


@dataclass(frozen=True)
class SignalWeights:
    vector: float = 1.0
    keyword: float = 0.52
    phrase: float = 0.20
    number: float = 0.16
    entity: float = 0.16
    temporal: float = 0.24


SIGNAL_PROFILES = {
    "default": SignalWeights(),
    "balanced": SignalWeights(
        vector=0.55,
        keyword=0.65,
        phrase=0.20,
        number=0.20,
        entity=0.22,
        temporal=0.24,
    ),
    "evidence-heavy": SignalWeights(
        vector=0.35,
        keyword=0.85,
        phrase=0.20,
        number=0.24,
        entity=0.28,
        temporal=0.24,
    ),
}


@dataclass(frozen=True)
class CorpusShape:
    doc_count: int
    avg_tokens: float
    timestamp_coverage: float
    entity_density: float
    number_density: float


@dataclass(frozen=True)
class DomainRouteDecision:
    memory_mode: str
    signal_profile: str
    signal_weights: SignalWeights
    candidate_k: int
    reason: str


@dataclass
class MetricSummary:
    count: int = 0
    values: dict[str, float] = field(default_factory=dict)
    counts: dict[str, int] = field(default_factory=dict)


@dataclass
class BenchmarkResult:
    name: str
    total: int
    elapsed_seconds: float
    top_k: int
    metrics: dict[str, float]
    per_category: dict[str, dict[str, float]]
    distribution: dict[str, int]
    output_file: str
    notes: list[str]


@dataclass
class RunSummary:
    generated_at: str
    engine: str
    embedding_model: str
    onnx_file: str
    memory_mode: str
    signal_weights: SignalWeights
    index_type: str
    hnsw_ef: int
    max_length: int
    route_counts: dict[str, int]
    results: list[BenchmarkResult]


def now_id() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S-%f")


def ms_since(start: float) -> float:
    return (time.perf_counter() - start) * 1000.0


def safe_name(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("_")
    return safe[:80] or "group"


def ensure_file(path: Path, url: str) -> Path:
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    print(f"  Downloading {url}")
    urllib.request.urlretrieve(url, path)
    return path


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def dcg(relevances: list[float], k: int) -> float:
    score = 0.0
    for i, rel in enumerate(relevances[:k]):
        score += rel / math.log2(i + 2)
    return score


def ndcg_any(ranked_ids: list[str], correct_ids: set[str], k: int) -> float:
    relevances = [1.0 if cid in correct_ids else 0.0 for cid in ranked_ids[:k]]
    ideal = sorted(relevances, reverse=True)
    idcg = dcg(ideal, k)
    if idcg == 0:
        return 0.0
    return dcg(relevances, k) / idcg


def recall_any(ranked_ids: list[str], correct_ids: set[str], k: int) -> float:
    top_ids = set(ranked_ids[:k])
    return float(any(cid in top_ids for cid in correct_ids))


def recall_all(ranked_ids: list[str], correct_ids: set[str], k: int) -> float:
    if not correct_ids:
        return 1.0
    top_ids = set(ranked_ids[:k])
    return float(all(cid in top_ids for cid in correct_ids))


def fraction_recall(ranked_ids: list[str], correct_ids: set[str]) -> float:
    if not correct_ids:
        return 1.0
    found = sum(1 for cid in correct_ids if cid in ranked_ids)
    return found / len(correct_ids)


def session_id_from_corpus_id(corpus_id: str) -> str:
    if "_turn_" in corpus_id:
        return corpus_id.rsplit("_turn_", 1)[0]
    return corpus_id


def tokenize(text: str) -> list[str]:
    return [
        token.lower()
        for token in re.findall(r"[A-Za-z0-9][A-Za-z0-9'_+-]*", text)
        if len(token) > 1
    ]


def keywords(text: str) -> list[str]:
    return [token for token in tokenize(text) if token not in STOP_WORDS]


def quoted_phrases(text: str) -> list[str]:
    phrases = []
    for pattern in (r'"([^"]+)"', r"'([^']+)'", r"“([^”]+)”"):
        phrases.extend(match.strip().lower() for match in re.findall(pattern, text))
    return [phrase for phrase in phrases if phrase]


def number_tokens(text: str) -> set[str]:
    tokens = set(re.findall(r"\b\d+(?:[.,]\d+)?%?\b", text.lower()))
    for word, number in WORD_NUMBERS.items():
        if re.search(rf"\b{word}\b", text.lower()):
            tokens.add(str(number))
    return tokens


def entity_tokens(text: str) -> set[str]:
    entities = set()
    for match in re.finditer(r"\b[A-Z][A-Za-z0-9+-]{2,}\b", text):
        value = match.group(0)
        if value.lower() not in STOP_WORDS:
            entities.add(value.lower())
    return entities


def parse_timestamp(value: str) -> datetime | None:
    if not value:
        return None
    cleaned = re.sub(r"\s+\([A-Za-z]+\)", "", value)
    for fmt in ("%Y/%m/%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(cleaned[: len(datetime.now().strftime(fmt))], fmt)
        except Exception:
            pass
    match = re.search(r"(\d{4})[/-](\d{1,2})[/-](\d{1,2})", value)
    if match:
        year, month, day = [int(item) for item in match.groups()]
        try:
            return datetime(year, month, day)
        except ValueError:
            return None
    return None


def word_or_int(value: str) -> int | None:
    value = value.lower()
    if value.isdigit():
        return int(value)
    return WORD_NUMBERS.get(value)


def relative_days(query: str) -> int | None:
    lower = query.lower()
    patterns = [
        (r"\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+days?\s+ago\b", 1),
        (r"\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+weeks?\s+ago\b", 7),
        (r"\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+months?\s+ago\b", 30),
    ]
    for pattern, multiplier in patterns:
        match = re.search(pattern, lower)
        if match:
            value = word_or_int(match.group(1))
            if value is not None:
                return value * multiplier
    if "couple of days ago" in lower or "couple days ago" in lower:
        return 2
    if "yesterday" in lower:
        return 1
    if "a week ago" in lower or "last week" in lower:
        return 7
    if "a month ago" in lower or "last month" in lower:
        return 30
    return None


def temporal_signal(query: str, timestamp: str, context: dict[str, str]) -> float:
    ref = parse_timestamp(str(context.get("reference_time", "")))
    doc_time = parse_timestamp(timestamp)
    offset = relative_days(query)
    if ref is None or doc_time is None or offset is None:
        return 0.0
    target_days = offset
    actual_days = abs((ref - doc_time).total_seconds()) / 86400.0
    diff = abs(actual_days - target_days)
    window = max(2.0, target_days * 0.25)
    return math.exp(-(diff / window))


def facet_body(doc: TextDoc) -> str:
    kws = keywords(doc.body)
    counts: dict[str, int] = defaultdict(int)
    for token in kws:
        counts[token] += 1
    salient = [
        token
        for token, _ in sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:32]
    ]
    entities = sorted(entity_tokens(doc.body))[:24]
    numbers = sorted(number_tokens(doc.body))[:24]
    parts = [
        "Evidence facets.",
        f"keywords: {' '.join(salient)}",
        f"entities: {' '.join(entities)}",
        f"numbers: {' '.join(numbers)}",
    ]
    if doc.timestamp:
        parts.append(f"timestamp: {doc.timestamp}")
    return "\n".join(parts)


def expand_docs_with_facets(docs: list[TextDoc]) -> list[TextDoc]:
    expanded: list[TextDoc] = []
    for doc in docs:
        expanded.append(doc)
        expanded.append(
            TextDoc(
                corpus_id=doc.corpus_id,
                body=facet_body(doc),
                timestamp=doc.timestamp,
                variant="facet",
            )
        )
    return expanded


def corpus_shape(docs: list[TextDoc]) -> CorpusShape:
    if not docs:
        return CorpusShape(
            doc_count=0,
            avg_tokens=0.0,
            timestamp_coverage=0.0,
            entity_density=0.0,
            number_density=0.0,
        )
    token_counts = [len(tokenize(doc.body)) for doc in docs]
    timestamp_count = sum(1 for doc in docs if parse_timestamp(doc.timestamp) is not None)
    entity_count = sum(len(entity_tokens(doc.body)) for doc in docs)
    number_count = sum(len(number_tokens(doc.body)) for doc in docs)
    return CorpusShape(
        doc_count=len(docs),
        avg_tokens=float(np.mean(token_counts)),
        timestamp_coverage=timestamp_count / len(docs),
        entity_density=entity_count / len(docs),
        number_density=number_count / len(docs),
    )


class DomainRouter:
    def route(
        self,
        *,
        docs: list[TextDoc],
        queries: list[str],
        top_k: int,
        requested_candidate_k: int | None,
    ) -> DomainRouteDecision:
        shape = corpus_shape(docs)
        query_text = " ".join(queries)
        query_has_precise_clues = bool(
            quoted_phrases(query_text) or number_tokens(query_text) or entity_tokens(query_text)
        )
        query_has_time = relative_days(query_text) is not None or any(
            word in set(keywords(query_text)) for word in TEMPORAL_WORDS
        )

        if shape.timestamp_coverage >= 0.8 and shape.doc_count >= 30:
            profile = "default"
            mode = "signals"
            default_candidate_k = max(top_k, 50)
            reason = "timestamped_chronological_evidence"
        else:
            needs_facets = (
                shape.avg_tokens >= 80.0
                or shape.timestamp_coverage < 0.5
                or shape.entity_density >= 4.0
                or shape.number_density >= 2.0
            )
            if needs_facets:
                profile = "evidence-heavy"
                mode = "facets"
                default_candidate_k = max(top_k * 8, 80)
                reason = (
                    "long_or_sparse_evidence"
                    if shape.avg_tokens >= 80.0 or shape.timestamp_coverage < 0.5
                    else "dense_entities_or_numbers"
                )
            elif query_has_precise_clues or query_has_time:
                profile = "default"
                mode = "signals"
                default_candidate_k = max(top_k, 50)
                reason = "precise_query_clues"
            else:
                profile = "default"
                mode = "signals"
                default_candidate_k = max(top_k, 30)
                reason = "semantic_first_with_light_signals"

        candidate_k = requested_candidate_k or default_candidate_k
        if mode == "facets":
            candidate_k = min(candidate_k, max(len(docs) * 2, top_k))
        else:
            candidate_k = min(candidate_k, max(len(docs), top_k))
        return DomainRouteDecision(
            memory_mode=mode,
            signal_profile=profile,
            signal_weights=SIGNAL_PROFILES[profile],
            candidate_k=candidate_k,
            reason=reason,
        )


class DomainSignalReranker:
    def __init__(self, docs: list[TextDoc], weights: SignalWeights) -> None:
        self.docs = docs
        self.weights = weights
        self.doc_terms: dict[str, set[str]] = {}
        document_frequency: dict[str, int] = defaultdict(int)
        for doc in docs:
            terms = set(keywords(doc.body))
            self.doc_terms[doc.corpus_id] = terms
            for term in terms:
                document_frequency[term] += 1
        doc_count = max(len(docs), 1)
        self.idf = {
            term: math.log((doc_count + 1) / (count + 1)) + 1.0
            for term, count in document_frequency.items()
        }

    def lexical_overlap(self, query_terms: list[str], doc: TextDoc) -> float:
        terms = self.doc_terms.get(doc.corpus_id, set(keywords(doc.body)))
        weighted_total = sum(self.idf.get(term, 1.0) for term in query_terms)
        if weighted_total <= 0:
            return 0.0
        weighted_hit = sum(self.idf.get(term, 1.0) for term in query_terms if term in terms)
        return weighted_hit / weighted_total

    def rerank(self, query: str, hits: list[RetrievalHit], context: dict[str, str]) -> list[RetrievalHit]:
        if not hits:
            return hits
        query_terms = keywords(query)
        phrases = quoted_phrases(query)
        query_numbers = number_tokens(query)
        query_entities = entity_tokens(query)
        max_rank = max(len(hits) - 1, 1)
        scored: list[tuple[float, RetrievalHit]] = []
        for hit in hits:
            doc_text = hit.doc.body.lower()
            lexical = self.lexical_overlap(query_terms, hit.doc)
            phrase = (
                sum(1 for phrase_text in phrases if phrase_text in doc_text) / len(phrases)
                if phrases
                else 0.0
            )
            doc_numbers = number_tokens(hit.doc.body)
            number = (
                len(query_numbers & doc_numbers) / len(query_numbers) if query_numbers else 0.0
            )
            doc_entities = entity_tokens(hit.doc.body)
            entity = (
                len(query_entities & doc_entities) / len(query_entities)
                if query_entities
                else 0.0
            )
            temporal = temporal_signal(query, hit.doc.timestamp, context)
            rank_norm = hit.rank / max_rank
            signal = (
                self.weights.keyword * lexical
                + self.weights.phrase * phrase
                + self.weights.number * number
                + self.weights.entity * entity
                + self.weights.temporal * temporal
            )
            final_score = self.weights.vector * rank_norm - signal
            scored.append((final_score, hit))
        scored.sort(key=lambda item: item[0])
        return [hit for _, hit in scored]


class EmbeddingCache:
    def __init__(self, embedder: MiniLMOnnxEmbedder, batch_size: int) -> None:
        self.embedder = embedder
        self.batch_size = batch_size
        self.cache: dict[str, np.ndarray] = {}

    def encode_many(self, texts: Iterable[str]) -> np.ndarray:
        ordered = list(texts)
        missing = [text for text in ordered if text not in self.cache]
        for start in range(0, len(missing), self.batch_size):
            batch = missing[start : start + self.batch_size]
            vectors = self.embedder.encode(batch)
            for text, vector in zip(batch, vectors, strict=True):
                self.cache[text] = vector
        if not ordered:
            return np.empty((0, EMBEDDING_DIMENSION), dtype=np.float32)
        return np.stack([self.cache[text] for text in ordered]).astype(np.float32)


class ZvecMemoryIndex:
    def __init__(
        self,
        *,
        db_root: Path,
        embeddings: EmbeddingCache,
        memory_mode: str,
        signal_weights: SignalWeights,
        index_type: str,
        hnsw_m: int,
        hnsw_ef_construction: int,
        hnsw_ef: int,
        write_batch_size: int,
        optimize: bool,
    ) -> None:
        self.db_root = db_root
        self.embeddings = embeddings
        self.memory_mode = memory_mode
        self.signal_weights = signal_weights
        self.router = DomainRouter()
        self.route_counts: dict[str, int] = defaultdict(int)
        self.index_type = index_type
        self.hnsw_m = hnsw_m
        self.hnsw_ef_construction = hnsw_ef_construction
        self.hnsw_ef = hnsw_ef
        self.write_batch_size = write_batch_size
        self.optimize = optimize

    def create_schema(self, name: str) -> zvec.CollectionSchema:
        if self.index_type == "hnsw":
            index_param = zvec.HnswIndexParam(
                m=self.hnsw_m,
                ef_construction=self.hnsw_ef_construction,
            )
        else:
            index_param = zvec.FlatIndexParam()

        return zvec.CollectionSchema(
            name=safe_name(name),
            fields=[
                zvec.FieldSchema("corpus_id", zvec.DataType.STRING, nullable=False),
                zvec.FieldSchema("body", zvec.DataType.STRING, nullable=False),
                zvec.FieldSchema("timestamp", zvec.DataType.STRING, nullable=False),
                zvec.FieldSchema("variant", zvec.DataType.STRING, nullable=False),
                zvec.FieldSchema("ordinal", zvec.DataType.INT64, nullable=False),
            ],
            vectors=zvec.VectorSchema(
                "embedding",
                zvec.DataType.VECTOR_FP32,
                EMBEDDING_DIMENSION,
                index_param=index_param,
            ),
        )

    def query_group(
        self,
        *,
        group_name: str,
        docs: list[TextDoc],
        queries: list[str],
        top_k: int,
        candidate_k: int | None = None,
        query_contexts: list[dict[str, str]] | None = None,
    ) -> list[list[TextDoc]]:
        if not docs:
            return [[] for _ in queries]

        if self.memory_mode == "domain":
            route = self.router.route(
                docs=docs,
                queries=queries,
                top_k=top_k,
                requested_candidate_k=candidate_k,
            )
            active_memory_mode = route.memory_mode
            active_signal_weights = route.signal_weights
            active_candidate_k = route.candidate_k
            route_key = f"{route.memory_mode}/{route.signal_profile}/{route.reason}"
            self.route_counts[route_key] += 1
        else:
            active_memory_mode = self.memory_mode
            active_signal_weights = self.signal_weights
            active_candidate_k = candidate_k or top_k

        canonical_by_id: dict[str, TextDoc] = {}
        for doc in docs:
            canonical_by_id.setdefault(doc.corpus_id, doc)
        index_docs = expand_docs_with_facets(docs) if active_memory_mode == "facets" else docs
        reranker = (
            DomainSignalReranker(docs, active_signal_weights)
            if active_memory_mode in ("signals", "facets")
            else None
        )
        active_candidate_k = min(active_candidate_k, len(index_docs))
        query_contexts = query_contexts or [{} for _ in queries]

        group_hash = hashlib.sha1(group_name.encode("utf-8")).hexdigest()[:12]
        group_path = self.db_root / f"{safe_name(group_name)}_{group_hash}"
        group_path.parent.mkdir(parents=True, exist_ok=True)
        collection = zvec.create_and_open(str(group_path), self.create_schema(group_name))

        doc_vectors = self.embeddings.encode_many([doc.body for doc in index_docs])
        zdocs = [
            zvec.Doc(
                id=f"doc_{i:08d}",
                fields={
                    "corpus_id": doc.corpus_id,
                    "body": doc.body,
                    "timestamp": doc.timestamp,
                    "variant": doc.variant,
                    "ordinal": i,
                },
                vectors={"embedding": vector.tolist()},
            )
            for i, (doc, vector) in enumerate(zip(index_docs, doc_vectors, strict=True))
        ]
        for start in range(0, len(zdocs), self.write_batch_size):
            collection.upsert(zdocs[start : start + self.write_batch_size])
        collection.flush()
        if self.optimize:
            collection.optimize()

        query_vectors = self.embeddings.encode_many(queries)
        query_param = None
        if self.index_type == "hnsw":
            query_param = zvec.HnswQueryParam(ef=self.hnsw_ef)

        ranked: list[list[TextDoc]] = []
        for query, vector, context in zip(queries, query_vectors, query_contexts, strict=True):
            found = collection.query(
                queries=zvec.Query(
                    field_name="embedding",
                    vector=vector.tolist(),
                    param=query_param,
                ),
                topk=active_candidate_k,
                output_fields=["corpus_id", "body", "timestamp", "variant", "ordinal"],
            )
            hits = []
            for rank, item in enumerate(found):
                hit_doc = TextDoc(
                    corpus_id=str(item.fields["corpus_id"]),
                    body=str(item.fields["body"]),
                    timestamp=str(item.fields["timestamp"]),
                    variant=str(item.fields["variant"]),
                )
                canonical = canonical_by_id.get(hit_doc.corpus_id, hit_doc)
                score = float(getattr(item, "score", rank))
                hits.append(RetrievalHit(doc=canonical, rank=rank, score=score))
            if reranker is not None:
                hits = reranker.rerank(query, hits, context)

            unique_docs: list[TextDoc] = []
            seen: set[str] = set()
            for hit in hits:
                if hit.doc.corpus_id in seen:
                    continue
                seen.add(hit.doc.corpus_id)
                unique_docs.append(hit.doc)
                if len(unique_docs) >= top_k:
                    break
            ranked.append(unique_docs)
        return ranked


def load_lme_data(path: Path, limit: int) -> list[dict]:
    ensure_file(path, LME_URL)
    data = json.loads(path.read_text(encoding="utf-8"))
    if limit > 0:
        return data[:limit]
    return data


def build_lme_docs(entry: dict, granularity: str) -> list[TextDoc]:
    docs: list[TextDoc] = []
    sessions = entry.get("haystack_sessions", [])
    session_ids = entry.get("haystack_session_ids", [])
    dates = entry.get("haystack_dates", [""] * len(sessions))
    for session, sess_id, date in zip(sessions, session_ids, dates, strict=False):
        if granularity == "session":
            turns = [turn.get("content", "") for turn in session if turn.get("role") == "user"]
            body = "\n".join(text for text in turns if text)
            if body:
                docs.append(TextDoc(corpus_id=str(sess_id), body=body, timestamp=str(date)))
        else:
            turn_num = 0
            for turn in session:
                if turn.get("role") == "user":
                    body = turn.get("content", "")
                    if body:
                        docs.append(
                            TextDoc(
                                corpus_id=f"{sess_id}_turn_{turn_num}",
                                body=body,
                                timestamp=str(date),
                            )
                        )
                    turn_num += 1
    return docs


def run_lme(
    *,
    data_path: Path,
    limit: int,
    granularity: str,
    top_k: int,
    candidate_k: int,
    index: ZvecMemoryIndex,
    output_dir: Path,
) -> BenchmarkResult:
    data = load_lme_data(data_path, limit)
    start_time = time.perf_counter()
    metrics: dict[str, list[float]] = defaultdict(list)
    per_type: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    rows = []

    for i, entry in enumerate(data):
        question_id = str(entry.get("question_id", f"q_{i}"))
        qtype = str(entry.get("question_type", "unknown"))
        docs = build_lme_docs(entry, granularity)
        ranked_docs = index.query_group(
            group_name=f"lme_{i}_{question_id}",
            docs=docs,
            queries=[str(entry["question"])],
            top_k=top_k,
            candidate_k=candidate_k,
            query_contexts=[{"reference_time": str(entry.get("question_date", ""))}],
        )[0]
        ranked_ids = [session_id_from_corpus_id(doc.corpus_id) for doc in ranked_docs]
        correct_ids = {str(item) for item in entry.get("answer_session_ids", [])}

        entry_metrics = {}
        for k in LME_KS:
            if k > top_k:
                continue
            ra = recall_any(ranked_ids, correct_ids, k)
            rl = recall_all(ranked_ids, correct_ids, k)
            nd = ndcg_any(ranked_ids, correct_ids, k)
            metrics[f"recall_any@{k}"].append(ra)
            metrics[f"recall_all@{k}"].append(rl)
            metrics[f"ndcg_any@{k}"].append(nd)
            per_type[qtype][f"recall_any@{k}"].append(ra)
            entry_metrics[f"recall_any@{k}"] = ra
            entry_metrics[f"ndcg_any@{k}"] = nd

        rows.append(
            {
                "question_id": question_id,
                "question_type": qtype,
                "question": entry.get("question", ""),
                "answer": entry.get("answer", ""),
                "answer_session_ids": sorted(correct_ids),
                "retrieved_ids": ranked_ids[:top_k],
                "metrics": entry_metrics,
            }
        )
        if (i + 1) % 25 == 0 or i + 1 == len(data):
            r5 = np.mean(metrics.get("recall_any@5", [0.0]))
            print(f"  LongMemEval {i + 1}/{len(data)} R@5={r5:.3f}")

    elapsed = time.perf_counter() - start_time
    result_path = output_dir / f"zvec_lme_results_{now_id()}.jsonl"
    result_path.write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n",
        encoding="utf-8",
    )

    metric_summary = {name: float(np.mean(vals)) for name, vals in sorted(metrics.items())}
    category_summary = {
        qtype: {name: float(np.mean(vals)) for name, vals in sorted(values.items())}
        for qtype, values in sorted(per_type.items())
    }
    hits_at_5 = int(sum(metrics.get("recall_any@5", [])))
    distribution = {"hit@5": hits_at_5, "miss@5": len(data) - hits_at_5}
    return BenchmarkResult(
        name="LongMemEval",
        total=len(data),
        elapsed_seconds=elapsed,
        top_k=top_k,
        metrics=metric_summary,
        per_category=category_summary,
        distribution=distribution,
        output_file=str(result_path),
        notes=[
            "Raw user-turn session retrieval.",
            "Metric is session-level retrieval recall, not QA accuracy.",
        ],
    )


def load_locomo_data(path: Path, limit: int) -> list[dict]:
    ensure_file(path, LOCOMO_URL)
    data = json.loads(path.read_text(encoding="utf-8"))
    if limit > 0:
        return data[:limit]
    return data


def load_locomo_sessions(conversation: dict, summaries: dict | None) -> list[dict]:
    sessions = []
    session_num = 1
    while True:
        key = f"session_{session_num}"
        if key not in conversation:
            break
        summary = ""
        if summaries:
            summary = summaries.get(f"session_{session_num}_summary", "")
        sessions.append(
            {
                "session_num": session_num,
                "date": conversation.get(f"session_{session_num}_date_time", ""),
                "dialogs": conversation[key],
                "summary": summary,
            }
        )
        session_num += 1
    return sessions


def build_locomo_docs(sessions: list[dict], granularity: str) -> list[TextDoc]:
    docs: list[TextDoc] = []
    for session in sessions:
        if granularity == "session":
            lines = []
            for dialog in session["dialogs"]:
                speaker = dialog.get("speaker", "?")
                text = dialog.get("text", "")
                lines.append(f'{speaker} said, "{text}"')
            docs.append(
                TextDoc(
                    corpus_id=f"session_{session['session_num']}",
                    body="\n".join(lines),
                    timestamp=str(session.get("date", "")),
                )
            )
        else:
            for dialog in session["dialogs"]:
                speaker = dialog.get("speaker", "?")
                text = dialog.get("text", "")
                dialog_id = dialog.get("dia_id", f"D{session['session_num']}:?")
                docs.append(
                    TextDoc(
                        corpus_id=str(dialog_id),
                        body=f'{speaker} said, "{text}"',
                        timestamp=str(session.get("date", "")),
                    )
                )
    return docs


def locomo_evidence_to_session_ids(evidence: Iterable[str]) -> set[str]:
    sessions = set()
    for evidence_id in evidence:
        match = re.match(r"D(\d+):", str(evidence_id))
        if match:
            sessions.add(f"session_{match.group(1)}")
    return sessions


def run_locomo(
    *,
    data_path: Path,
    limit: int,
    granularity: str,
    top_k: int,
    candidate_k: int,
    index: ZvecMemoryIndex,
    output_dir: Path,
) -> BenchmarkResult:
    data = load_locomo_data(data_path, limit)
    start_time = time.perf_counter()
    all_recall: list[float] = []
    per_category: dict[str, list[float]] = defaultdict(list)
    rows = []

    for conv_idx, sample in enumerate(data):
        sample_id = str(sample.get("sample_id", f"conv_{conv_idx}"))
        sessions = load_locomo_sessions(
            sample["conversation"],
            sample.get("session_summary", {}),
        )
        docs = build_locomo_docs(sessions, granularity)
        qa_pairs = sample.get("qa", [])
        questions = [str(qa["question"]) for qa in qa_pairs]
        ranked_groups = index.query_group(
            group_name=f"locomo_{conv_idx}_{sample_id}",
            docs=docs,
            queries=questions,
            top_k=top_k,
            candidate_k=candidate_k,
        )

        for qa, ranked_docs in zip(qa_pairs, ranked_groups, strict=True):
            if granularity == "session":
                correct_ids = locomo_evidence_to_session_ids(qa.get("evidence", []))
            else:
                correct_ids = {str(item) for item in qa.get("evidence", [])}
            ranked_ids = [doc.corpus_id for doc in ranked_docs]
            score = fraction_recall(ranked_ids, correct_ids)
            category = LOCOMO_CATEGORIES.get(qa.get("category"), f"Cat-{qa.get('category')}")
            all_recall.append(score)
            per_category[category].append(score)
            rows.append(
                {
                    "sample_id": sample_id,
                    "question": qa.get("question", ""),
                    "answer": qa.get("answer", qa.get("adversarial_answer", "")),
                    "category": category,
                    "evidence": qa.get("evidence", []),
                    "correct_ids": sorted(correct_ids),
                    "retrieved_ids": ranked_ids,
                    "recall": score,
                }
            )
        print(
            f"  LoCoMo {conv_idx + 1}/{len(data)} "
            f"avg_recall={np.mean(all_recall) if all_recall else 0.0:.3f}"
        )

    elapsed = time.perf_counter() - start_time
    result_path = output_dir / f"zvec_locomo_results_{now_id()}.json"
    write_json(result_path, rows)
    perfect = sum(1 for score in all_recall if score >= 1.0)
    partial = sum(1 for score in all_recall if 0.0 < score < 1.0)
    zero = sum(1 for score in all_recall if score == 0.0)
    return BenchmarkResult(
        name="LoCoMo",
        total=len(all_recall),
        elapsed_seconds=elapsed,
        top_k=top_k,
        metrics={"avg_recall": float(np.mean(all_recall)) if all_recall else 0.0},
        per_category={
            name: {"avg_recall": float(np.mean(vals)), "count": float(len(vals))}
            for name, vals in sorted(per_category.items())
        },
        distribution={"perfect": perfect, "partial": partial, "zero": zero},
        output_file=str(result_path),
        notes=[
            f"Raw {granularity}-granularity retrieval.",
            "Metric is fraction of labelled evidence IDs retrieved.",
        ],
    )


def convomem_file_cache_path(cache_dir: Path, category: str, subpath: str) -> Path:
    return cache_dir / category / subpath.replace("/", "_")


def convomem_download_file(category: str, subpath: str, cache_dir: Path) -> dict | None:
    url = f"{CONVOMEM_HF_BASE}/{category}/{subpath}"
    cache_path = convomem_file_cache_path(cache_dir, category, subpath)
    if cache_path.exists():
        return json.loads(cache_path.read_text(encoding="utf-8"))
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"    Downloading ConvoMem {category}/{subpath}")
    try:
        urllib.request.urlretrieve(url, cache_path)
        return json.loads(cache_path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"    Failed: {exc}")
        return None


def convomem_discover_files(category: str, cache_dir: Path) -> list[str]:
    cache_path = cache_dir / f"{category}_filelist.json"
    if cache_path.exists():
        return json.loads(cache_path.read_text(encoding="utf-8"))
    subdir = "1_evidence"
    api_url = f"{CONVOMEM_HF_API}/{category}/{subdir}"
    try:
        with urllib.request.urlopen(api_url, timeout=20) as response:
            files = json.loads(response.read())
    except Exception as exc:
        print(f"    Failed to list ConvoMem {category}/{subdir}: {exc}")
        try:
            with urllib.request.urlopen(f"{CONVOMEM_HF_API}/{category}", timeout=20) as response:
                children = json.loads(response.read())
            subdirs = [
                item["path"].rsplit("/", 1)[-1]
                for item in children
                if item.get("type") == "directory"
                and re.match(r"^\d+_evidence$", item.get("path", "").rsplit("/", 1)[-1])
            ]
            subdirs.sort(key=lambda value: int(value.split("_", 1)[0]))
            if not subdirs:
                sample = CONVOMEM_SAMPLE_FILES.get(category)
                return [sample] if sample else []
            subdir = subdirs[0]
            with urllib.request.urlopen(f"{CONVOMEM_HF_API}/{category}/{subdir}", timeout=20) as response:
                files = json.loads(response.read())
            print(f"    Using ConvoMem {category}/{subdir}")
        except Exception as fallback_exc:
            print(f"    Failed to list ConvoMem {category}: {fallback_exc}")
            sample = CONVOMEM_SAMPLE_FILES.get(category)
            return [sample] if sample else []
    paths = [
        item["path"].split(f"{category}/", 1)[1]
        for item in files
        if item.get("path", "").endswith(".json")
    ]
    write_json(cache_path, paths)
    return paths


def load_convomem_items(categories: list[str], limit: int, cache_dir: Path) -> list[dict]:
    items = []
    for category in categories:
        files = convomem_discover_files(category, cache_dir)
        category_items = []
        for subpath in files:
            if len(category_items) >= limit:
                break
            data = convomem_download_file(category, subpath, cache_dir)
            if data and "evidence_items" in data:
                for item in data["evidence_items"]:
                    item["_category_key"] = category
                    category_items.append(item)
                    if len(category_items) >= limit:
                        break
        print(f"  ConvoMem {CONVOMEM_CATEGORIES.get(category, category)}: {len(category_items)}")
        items.extend(category_items)
    return items


def build_convomem_docs(item: dict) -> list[TextDoc]:
    docs = []
    i = 0
    for conversation in item.get("conversations", []):
        for message in conversation.get("messages", []):
            text = str(message.get("text", ""))
            if text:
                docs.append(
                    TextDoc(
                        corpus_id=f"msg_{i:08d}",
                        body=text,
                        timestamp=str(message.get("timestamp", "")),
                    )
                )
                i += 1
    return docs


def convomem_recall(ranked_docs: list[TextDoc], evidence_messages: list[dict]) -> float:
    evidence_texts = {
        str(item.get("text", "")).strip().lower()
        for item in evidence_messages
        if str(item.get("text", "")).strip()
    }
    if not evidence_texts:
        return 1.0
    retrieved_texts = [doc.body.strip().lower() for doc in ranked_docs]
    found = 0
    for evidence_text in evidence_texts:
        for retrieved_text in retrieved_texts:
            if evidence_text in retrieved_text or retrieved_text in evidence_text:
                found += 1
                break
    return found / len(evidence_texts)


def run_convomem(
    *,
    categories: list[str],
    limit_per_category: int,
    cache_dir: Path,
    top_k: int,
    candidate_k: int,
    index: ZvecMemoryIndex,
    output_dir: Path,
) -> BenchmarkResult:
    items = load_convomem_items(categories, limit_per_category, cache_dir)
    start_time = time.perf_counter()
    all_recall: list[float] = []
    per_category: dict[str, list[float]] = defaultdict(list)
    rows = []

    for i, item in enumerate(items):
        category_key = str(item.get("_category_key", "unknown"))
        category_name = CONVOMEM_CATEGORIES.get(category_key, category_key)
        docs = build_convomem_docs(item)
        ranked_docs = index.query_group(
            group_name=f"convomem_{i}_{category_key}",
            docs=docs,
            queries=[str(item["question"])],
            top_k=top_k,
            candidate_k=candidate_k,
        )[0]
        score = convomem_recall(ranked_docs, item.get("message_evidences", []))
        all_recall.append(score)
        per_category[category_name].append(score)
        rows.append(
            {
                "question": item.get("question", ""),
                "answer": item.get("answer", ""),
                "category": category_key,
                "retrieved_ids": [doc.corpus_id for doc in ranked_docs],
                "retrieved_texts": [doc.body for doc in ranked_docs],
                "recall": score,
            }
        )
        if (i + 1) % 20 == 0 or i + 1 == len(items):
            print(f"  ConvoMem {i + 1}/{len(items)} avg_recall={np.mean(all_recall):.3f}")

    elapsed = time.perf_counter() - start_time
    result_path = output_dir / f"zvec_convomem_results_{now_id()}.json"
    write_json(result_path, rows)
    perfect = sum(1 for score in all_recall if score >= 1.0)
    partial = sum(1 for score in all_recall if 0.0 < score < 1.0)
    zero = sum(1 for score in all_recall if score == 0.0)
    return BenchmarkResult(
        name="ConvoMem",
        total=len(all_recall),
        elapsed_seconds=elapsed,
        top_k=top_k,
        metrics={"avg_recall": float(np.mean(all_recall)) if all_recall else 0.0},
        per_category={
            name: {"avg_recall": float(np.mean(vals)), "count": float(len(vals))}
            for name, vals in sorted(per_category.items())
        },
        distribution={"perfect": perfect, "partial": partial, "zero": zero},
        output_file=str(result_path),
        notes=[
            "Raw message-level retrieval.",
            "Metric matches evidence text containment used by MemPalace ConvoMem script.",
        ],
    )


def write_markdown(path: Path, summary: RunSummary) -> None:
    lines = [
        "# Zvec Memory Benchmark",
        "",
        f"Generated: {summary.generated_at}",
        "",
        "| Setting | Value |",
        "|---|---|",
        f"| Engine | {summary.engine} |",
        f"| Embedding | {summary.embedding_model} |",
        f"| ONNX file | {summary.onnx_file} |",
        f"| Memory mode | {summary.memory_mode} |",
        f"| Signal weights | vector={summary.signal_weights.vector}, keyword={summary.signal_weights.keyword}, phrase={summary.signal_weights.phrase}, number={summary.signal_weights.number}, entity={summary.signal_weights.entity}, temporal={summary.signal_weights.temporal} |",
        f"| Index | {summary.index_type} |",
        f"| HNSW ef | {summary.hnsw_ef} |",
        f"| Max tokens | {summary.max_length} |",
    ]
    if summary.route_counts:
        lines.extend(["", "## Domain Routes", "", "| Route | Count |", "|---|---:|"])
        for route, count in sorted(summary.route_counts.items()):
            lines.append(f"| {route} | {count} |")
    lines.extend(
        [
            "",
            "## Summary",
            "",
            "| Benchmark | Items | TopK | Main recall | Time s | Distribution |",
            "|---|---:|---:|---:|---:|---|",
        ]
    )
    for result in summary.results:
        if result.name == "LongMemEval":
            main = result.metrics.get("recall_any@5", 0.0)
        else:
            main = result.metrics.get("avg_recall", 0.0)
        dist = ", ".join(f"{key}={value}" for key, value in result.distribution.items())
        lines.append(
            f"| {result.name} | {result.total} | {result.top_k} | "
            f"{main:.4f} | {result.elapsed_seconds:.1f} | {dist} |"
        )

    for result in summary.results:
        lines.extend(["", f"## {result.name}", ""])
        lines.append("| Metric | Value |")
        lines.append("|---|---:|")
        for name, value in result.metrics.items():
            lines.append(f"| {name} | {value:.4f} |")
        if result.per_category:
            lines.extend(["", "| Category | Metric | Value |", "|---|---|---:|"])
            for category, values in result.per_category.items():
                for metric, value in values.items():
                    lines.append(f"| {category} | {metric} | {value:.4f} |")
        lines.extend(["", "Notes:"])
        for note in result.notes:
            lines.append(f"- {note}")
        lines.append(f"- Raw result file: `{result.output_file}`")

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def parse_categories(value: str) -> list[str]:
    if value == "all":
        return list(CONVOMEM_CATEGORIES.keys())
    return [item.strip() for item in value.split(",") if item.strip()]


def cleanup_db_root(db_root: Path, workspace: Path) -> None:
    resolved_root = db_root.resolve()
    resolved_workspace = workspace.resolve()
    if resolved_workspace not in resolved_root.parents and resolved_root != resolved_workspace:
        raise ValueError(f"Refusing to remove outside workspace: {resolved_root}")
    if db_root.exists():
        shutil.rmtree(db_root, ignore_errors=True)


def effective_candidate_k(memory_mode: str, requested: int, fallback_top_k: int) -> int | None:
    if requested > 0:
        return requested
    if memory_mode == "domain":
        return None
    return fallback_top_k


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--benchmarks",
        default="longmemeval,locomo,convomem",
        help="Comma-separated: longmemeval, locomo, convomem.",
    )
    parser.add_argument("--cache-dir", default=".cache/huggingface")
    parser.add_argument("--onnx-file", default="onnx/model_O2.onnx")
    parser.add_argument("--max-length", type=int, default=256)
    parser.add_argument("--embed-batch-size", type=int, default=32)
    parser.add_argument("--write-batch-size", type=int, default=512)
    parser.add_argument(
        "--memory-mode",
        choices=["raw", "signals", "facets", "domain"],
        default="raw",
        help=(
            "raw=vector order, signals=generic rerank, facets=facet variants + rerank, "
            "domain=auto-route strategy/profile from corpus shape."
        ),
    )
    parser.add_argument(
        "--candidate-k",
        type=int,
        default=0,
        help="Retrieve this many candidates before final TopK rerank. 0 means benchmark TopK.",
    )
    parser.add_argument(
        "--signal-profile",
        choices=sorted(SIGNAL_PROFILES.keys()),
        default="default",
        help="Named generic signal-weight profile. Individual weights override it.",
    )
    parser.add_argument("--signal-vector-weight", type=float, default=None)
    parser.add_argument("--signal-keyword-weight", type=float, default=None)
    parser.add_argument("--signal-phrase-weight", type=float, default=None)
    parser.add_argument("--signal-number-weight", type=float, default=None)
    parser.add_argument("--signal-entity-weight", type=float, default=None)
    parser.add_argument("--signal-temporal-weight", type=float, default=None)
    parser.add_argument("--index-type", choices=["flat", "hnsw"], default="flat")
    parser.add_argument("--hnsw-m", type=int, default=16)
    parser.add_argument("--hnsw-ef-construction", type=int, default=100)
    parser.add_argument("--hnsw-ef", type=int, default=300)
    parser.add_argument("--optimize", action="store_true")
    parser.add_argument("--lme-data", default="data/benchmarks/longmemeval_s_cleaned.json")
    parser.add_argument("--lme-limit", type=int, default=0)
    parser.add_argument("--lme-granularity", choices=["session", "turn"], default="session")
    parser.add_argument("--lme-top-k", type=int, default=50)
    parser.add_argument("--locomo-data", default="data/benchmarks/locomo10.json")
    parser.add_argument("--locomo-limit", type=int, default=0)
    parser.add_argument("--locomo-granularity", choices=["session", "dialog"], default="session")
    parser.add_argument("--locomo-top-k", type=int, default=10)
    parser.add_argument("--convomem-cache-dir", default="data/benchmarks/convomem_cache")
    parser.add_argument("--convomem-category", default="all")
    parser.add_argument("--convomem-limit", type=int, default=50)
    parser.add_argument("--convomem-top-k", type=int, default=10)
    parser.add_argument("--output-dir", default="reports")
    parser.add_argument("--db-root", default="")
    parser.add_argument("--cleanup-dbs", action="store_true")
    args = parser.parse_args()

    run_id = now_id()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    db_root = Path(args.db_root) if args.db_root else Path("data/mempalace-zvec-runs") / run_id
    db_root.mkdir(parents=True, exist_ok=True)

    print("Loading ONNX embedder...")
    embedder = MiniLMOnnxEmbedder(
        cache_dir=args.cache_dir,
        onnx_file=args.onnx_file,
        max_length=args.max_length,
    )
    embeddings = EmbeddingCache(embedder, batch_size=args.embed_batch_size)
    profile_weights = SIGNAL_PROFILES[args.signal_profile]
    signal_weights = SignalWeights(
        vector=args.signal_vector_weight
        if args.signal_vector_weight is not None
        else profile_weights.vector,
        keyword=args.signal_keyword_weight
        if args.signal_keyword_weight is not None
        else profile_weights.keyword,
        phrase=args.signal_phrase_weight
        if args.signal_phrase_weight is not None
        else profile_weights.phrase,
        number=args.signal_number_weight
        if args.signal_number_weight is not None
        else profile_weights.number,
        entity=args.signal_entity_weight
        if args.signal_entity_weight is not None
        else profile_weights.entity,
        temporal=args.signal_temporal_weight
        if args.signal_temporal_weight is not None
        else profile_weights.temporal,
    )
    index = ZvecMemoryIndex(
        db_root=db_root,
        embeddings=embeddings,
        memory_mode=args.memory_mode,
        signal_weights=signal_weights,
        index_type=args.index_type,
        hnsw_m=args.hnsw_m,
        hnsw_ef_construction=args.hnsw_ef_construction,
        hnsw_ef=args.hnsw_ef,
        write_batch_size=args.write_batch_size,
        optimize=args.optimize,
    )

    selected = {item.strip().lower() for item in args.benchmarks.split(",") if item.strip()}
    results: list[BenchmarkResult] = []
    try:
        if "longmemeval" in selected:
            print("\nRunning LongMemEval through Zvec...")
            results.append(
                run_lme(
                    data_path=Path(args.lme_data),
                    limit=args.lme_limit,
                    granularity=args.lme_granularity,
                    top_k=args.lme_top_k,
                    candidate_k=effective_candidate_k(
                        args.memory_mode,
                        args.candidate_k,
                        args.lme_top_k,
                    ),
                    index=index,
                    output_dir=output_dir,
                )
            )
        if "locomo" in selected:
            print("\nRunning LoCoMo through Zvec...")
            results.append(
                run_locomo(
                    data_path=Path(args.locomo_data),
                    limit=args.locomo_limit,
                    granularity=args.locomo_granularity,
                    top_k=args.locomo_top_k,
                    candidate_k=effective_candidate_k(
                        args.memory_mode,
                        args.candidate_k,
                        args.locomo_top_k,
                    ),
                    index=index,
                    output_dir=output_dir,
                )
            )
        if "convomem" in selected:
            print("\nRunning ConvoMem through Zvec...")
            results.append(
                run_convomem(
                    categories=parse_categories(args.convomem_category),
                    limit_per_category=args.convomem_limit,
                    cache_dir=Path(args.convomem_cache_dir),
                    top_k=args.convomem_top_k,
                    candidate_k=effective_candidate_k(
                        args.memory_mode,
                        args.candidate_k,
                        args.convomem_top_k,
                    ),
                    index=index,
                    output_dir=output_dir,
                )
            )
    finally:
        if args.cleanup_dbs:
            cleanup_db_root(db_root, Path.cwd())

    summary = RunSummary(
        generated_at=datetime.now().isoformat(timespec="seconds"),
        engine="Zvec + ONNX Runtime",
        embedding_model="sentence-transformers/all-MiniLM-L6-v2",
        onnx_file=args.onnx_file,
        memory_mode=args.memory_mode,
        signal_weights=signal_weights,
        index_type=args.index_type,
        hnsw_ef=args.hnsw_ef,
        max_length=args.max_length,
        route_counts=dict(index.route_counts),
        results=results,
    )
    json_path = output_dir / f"bench-mempalace-zvec-{run_id}.json"
    md_path = output_dir / f"bench-mempalace-zvec-{run_id}.md"
    write_json(json_path, asdict(summary))
    write_markdown(md_path, summary)
    print(f"\nWrote {json_path}")
    print(f"Wrote {md_path}")
    print(f"Zvec DB root: {db_root}")


if __name__ == "__main__":
    main()
