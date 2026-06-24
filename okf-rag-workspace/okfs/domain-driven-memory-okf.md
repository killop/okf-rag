---
type: OKF
title: Generic Domain-Driven Memory System
description: OKF and test contract for a reusable domain-driven memory system over arbitrary source repositories and knowledge corpora.
tags: [domain-memory, okf, zvec, ddd, retrieval]
timestamp: 2026-06-22T17:36:00+08:00
nocturne:
  uri: okf://memory/domain-driven-system
  disclosure: When designing, validating, or benchmarking a generic domain-driven memory system with OKF-RAG and zvec.
source_repositories:
  knowledge_catalog: E:/knowledge-catalog
  matt_skills: E:/github/matt-skills
  zvec: E:/github/zvec
---

# Generic Domain-Driven Memory OKF

This document defines the reusable core. Project-specific repositories are inputs handled by adapters, not assumptions baked into the memory model.

The core combines:

- OKF-style Markdown concepts with YAML frontmatter, progressive `index.md` navigation, and graph links.
- Domain modeling discipline: ubiquitous language, bounded contexts, explicit ambiguity handling, and ADRs only for hard-to-reverse trade-offs.
- Zvec as a local retrieval substrate for vector search, full-text search, scalar filters, and hybrid retrieval.
- Pluggable source adapters for code, docs, tickets, chat logs, design notes, and existing Markdown knowledge bases.

## Objective 1: Build a Markdown-first domain memory corpus

Create a portable knowledge bundle that humans, agents, and search infrastructure can inspect and regenerate.

### Key Results

- KR1. Generate a root `index.md` and per-context indexes from configured source adapters.
- KR2. Represent every memory unit as one Markdown concept with frontmatter fields: `type`, `title`, `description`, `tags`, `resource`, `source_path`, `bounded_context`, `concept_type`, `evidence_paths`, `timestamp`, and `content_hash`.
- KR3. Preserve existing Markdown knowledge sources as first-class evidence instead of replacing them.
- KR4. Generate links between concepts when source evidence shows relationships such as `depends-on`, `refines`, `implements`, `publishes-event`, `consumes-event`, or `uses-term`.

## Objective 2: Encode domain boundaries without hardcoding a project

Make the memory system understand domain language and architectural boundaries through configuration and extracted evidence.

### Key Results

- KR1. Detect candidate bounded contexts from configured path rules, namespaces, package/module names, docs, and repeated domain terms.
- KR2. Separate domain concepts from implementation details.
- KR3. Treat generated/vendor/build/cache directories as adapter-level exclusions, not global assumptions.
- KR4. Record source-specific placement rules as `Rule` concepts only when backed by evidence.
- KR5. Keep project names, framework names, and code-layer names in source profiles, not in core benchmark logic.

## Objective 3: Use Zvec as the retrieval substrate

Implement local retrieval that supports semantic search, exact terms, and structured filtering.

### Key Results

- KR1. Store one Zvec document per memory concept with scalar fields for `type`, `bounded_context`, `concept_type`, `source_path`, `tags`, `content_hash`, and `updated_at`.
- KR2. Store `title`, `description`, `body`, and extracted symbols in FTS-enabled string fields when FTS is enabled.
- KR3. Store dense embeddings for summaries and snippets; support local ONNX embedding models as the default offline option.
- KR4. Support filters such as `bounded_context = 'billing' AND concept_type = 'Policy'`.
- KR5. Benchmark both latency and recall against exact NumPy ground truth before selecting ANN parameters.

## Objective 4: Make memory generation verifiable

Every generated concept must carry evidence and be reproducible.

### Key Results

- KR1. Each concept includes `evidence_paths` and a short evidence summary.
- KR2. Source adapters can be configured read-only.
- KR3. Regeneration uses `content_hash` to avoid rewriting unchanged concepts.
- KR4. Validation checks frontmatter, broken links, missing evidence paths, excluded-source violations, and unsupported concept types.
- KR5. Reports distinguish exact-search baselines from ANN recall measurements.

# Ubiquitous Language

## Memory Terms

**Knowledge Bundle**:
A directory of Markdown concepts plus indexes that can be read by humans, agents, and retrieval infrastructure.
_Avoid_: opaque database dump

**Concept**:
One unit of domain or architecture knowledge represented as Markdown with frontmatter and evidence.
_Avoid_: random summary, note blob

**Bounded Context**:
A domain boundary where terms have stable meanings and relationships.
_Avoid_: folder-only category

**Evidence Path**:
A source path that supports a generated claim.
_Avoid_: unsupported statement

**Source Adapter**:
A configurable reader that extracts candidates from a source such as code, docs, tickets, or Markdown notes.
_Avoid_: hardcoded project scanner

**Source Profile**:
Project-specific configuration for include paths, exclude paths, concept mappings, and source-specific rules.
_Avoid_: core logic branch

## Domain Modeling Terms

**Ubiquitous Language**:
The canonical vocabulary shared by domain experts, developers, and generated memory.
_Avoid_: synonym soup

**Aggregate**:
A consistency boundary that protects invariants around one or more entities.
_Avoid_: data record, table

**Policy**:
A named business decision rule.
_Avoid_: if statement when the rule has domain meaning

**Domain Event**:
A meaningful fact that has happened in the domain.
_Avoid_: callback, notification

**Application Service**:
An orchestration layer for use cases that should not own domain rules.
_Avoid_: domain service when it only coordinates IO

# Generic Source Adapter Rules

## Include by Configuration

- Handwritten source files.
- Product, design, architecture, and operating docs.
- Existing Markdown knowledge bases.
- Protocol/schema files when they define domain contracts.
- Tests when they describe expected domain behavior.

## Exclude by Configuration

- Vendor dependencies.
- Build output.
- Cache directories.
- Generated files, unless the source profile marks them as authoritative evidence.
- Binary artifacts.

# Proposed Memory Concept Types

| Type | Purpose | Example |
|---|---|---|
| `Bounded Context` | Domain boundary and vocabulary scope. | `Ordering`, `Billing` |
| `Domain Term` | Canonical language entry. | `Invoice`, `Customer`, `Shipment` |
| `Aggregate` | Consistency boundary. | `Order` |
| `Policy` | Business decision rule. | `Refund Eligibility Policy` |
| `Domain Event` | Fact that happened. | `OrderPlaced` |
| `Application Service` | Use-case orchestration. | `CheckoutService` |
| `Source Layer` | Architecture or code placement layer from a source profile. | `api`, `domain`, `infrastructure` |
| `Rule` | Guardrail backed by evidence. | `UI reads view model only` |
| `ADR` | Hard-to-reverse architectural decision. | `Use local Zvec for retrieval` |

# Zvec Index Schema Draft

```text
collection: domain_memory

fields:
  id: string
  type: string
  title: string [FTS]
  description: string [FTS]
  body: string [FTS]
  source_path: string
  bounded_context: string
  concept_type: string
  tags: string[]
  evidence_paths: string[]
  content_hash: string
  updated_at: timestamp

vectors:
  summary_embedding: fp32[d]
  snippet_embedding: fp32[d]
```

# Benchmark Requirements

## Latency

- Measure embedding initialization and throughput.
- Measure Zvec upsert, flush, optimize, and query latency.
- Report Zvec-only latency separately from embedding-plus-query latency.

## Recall

- Compute exact TopK with NumPy cosine or inner product on normalized vectors.
- Compare Zvec TopK to exact TopK.
- Report `Recall@1`, `Recall@5`, `Recall@10`, hit counts, query p50/p95, and QPS.
- Label `flat` as exact baseline.
- Use `hnsw + optimize` for meaningful ANN recall curves.

# Acceptance Tests

## Test 1: Bounded Context Query

Query:

```text
Which concepts describe billing payment requests?
```

Expected retrieval:

- Billing context concepts.
- Invoice or payment-request domain terms.
- Evidence paths from configured source adapters.

## Test 2: Policy Query

Query:

```text
What rule decides refund eligibility?
```

Expected retrieval:

- `Policy` concepts.
- Linked domain terms and source evidence.

## Test 3: Recall Benchmark

Command shape:

```powershell
.\.venv\Scripts\python.exe scripts\bench_recall_minilm_zvec.py --vector-source random --index-type hnsw --corpus-size 10000 --query-count 200 --topk 10 --recall-ks 1,5,10 --efs 10,20,50,100,300,500,1000 --optimize
```

Expected output:

- A Markdown and JSON report.
- Non-100% recall at low `ef`.
- Increasing recall and latency as `ef` increases.

# First Implementation Slice

1. Define a source profile format for include/exclude paths and concept mappings.
2. Build a read-only scanner interface that emits generic concept candidates.
3. Convert candidates to OKF Markdown concepts with evidence paths.
4. Generate indexes and link graphs.
5. Build a Zvec collection from the Markdown bundle.
6. Add latency and recall benchmark commands.
