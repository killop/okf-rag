---
name: okr-rag-okr-format
description: Use this skill whenever the user asks to create, edit, review, validate, or index OKR Markdown for OKR-RAG, writes files under okr-rag-workspace/okrs, mentions "our OKR format", "okr md", "OKR truth", Knowledge Catalog compatible OKR notes, Nocturne disclosure metadata, or wants agent-readable memory documents that will be vectorized by zvec. This skill teaches the exact Markdown and YAML shape expected by the local okr-rag parser, so trigger it even when the user only casually says to add an OKR note or update project memory.
---

# OKR-RAG OKR Format

Write OKR Markdown that is both human-readable truth and machine-readable input for the local `okr-rag` indexer.

## Mental Model

Use `okr-rag-workspace/okrs/` as the source of truth.

Do not write truth into `.okr-rag/`. That directory is derived runtime state and may be deleted.

Each OKR Markdown file is one durable memory document. The file should explain an objective, the key results that prove progress, and the evidence or language needed for future retrieval.

## Where To Write

Create and edit OKR truth files only under:

```text
okr-rag-workspace/okrs/
```

Use lowercase kebab-case filenames:

```text
okr-rag-workspace/okrs/domain-router-okr.md
okr-rag-workspace/okrs/local-embedding-okr.md
```

Do not use these names for indexed OKR truth:

```text
index.md
log.md
```

The indexer skips `index.md` and `log.md`; keep them for navigation or human logs only.

## Frontmatter Contract

Use simple YAML frontmatter. The current parser intentionally supports a small, stable subset.

Recommended frontmatter:

```yaml
---
type: OKR
title: Domain Router Retrieval OKR
description: Defines how OKR-RAG selects retrieval behavior from corpus and query signals.
tags: [okr, domain-router, retrieval, zvec]
timestamp: 2026-06-24T00:00:00+08:00
nocturne:
  uri: okr://retrieval/domain-router
  disclosure: When deciding how an agent should search OKR memory for a query.
---
```

Fields that are indexed today:

- `title`
- `description`
- `tags`
- `nocturne.uri`
- `nocturne.disclosure`
- top-level `uri` and `disclosure`, for compatibility
- Markdown body text

Other frontmatter fields are allowed for humans, but do not rely on them for retrieval unless the codebase has been updated to index them.

Prefer inline tags:

```yaml
tags: [okr, retrieval, domain-memory]
```

List tags are also accepted:

```yaml
tags:
  - okr
  - retrieval
  - domain-memory
```

Avoid complex YAML in OKR truth files: nested arrays, aliases, multiline scalars, anchors, and deeply nested objects are not part of the current parser contract.

## Nocturne Metadata

Treat `uri` as the stable address of the memory.

Treat `disclosure` as the wake-up rule. It should answer:

```text
When should this memory be recalled?
```

Good disclosure:

```yaml
disclosure: When choosing between dense, lexical, and hybrid retrieval for OKR memory.
```

Weak disclosure:

```yaml
disclosure: This document is about retrieval.
```

The first version helps an agent decide when to use the memory. The second is only a summary.

## Body Template

Use this structure unless the user asks for a different shape:

```markdown
# Domain Router Retrieval OKR

Short context paragraph. Explain why this OKR exists and what durable system behavior it defines.

## Objective 1: Select retrieval behavior from domain signals

Describe the outcome in plain language.

### Key Results

- KR1. The router classifies memory sets using generic signals such as timestamps, text length, entity density, and query specificity.
- KR2. The selected retrieval profile is recorded in query diagnostics.
- KR3. Recall and latency benchmarks compare the router against a fixed full-hybrid baseline.

## Objective 2: Keep routing generic

Describe the outcome in plain language.

### Key Results

- KR1. No project-specific terms are hardcoded in router logic.
- KR2. Source-specific behavior is expressed through workspace configuration or evidence, not global code branches.
- KR3. Tests include at least two unrelated corpora.

## Ubiquitous Language

**Domain Signal**:
A generic observable property of a memory corpus or query that helps choose retrieval behavior.
_Avoid_: a hardcoded project name or framework-specific shortcut.

## Evidence

- `path/to/source-or-doc.md`: What this source proves.

## Retrieval Notes

- Recall this OKR for queries about domain-driven retrieval, routing profiles, or benchmark-driven search selection.
```

## Writing Rules

Make the `title`, `description`, `tags`, `disclosure`, and first paragraph contain the important retrieval words. Zvec indexes all of them, so do not hide the core terms only deep in the body.

Write objectives as durable outcomes, not tasks. A task is "add a CLI flag"; an objective is "make ingestion reproducible from a workspace-local OKR corpus."

Write key results as observable proof. Prefer measurable checks, commands, benchmark expectations, or acceptance criteria.

Keep the logic generic. Do not hardcode a specific game engine, repository, benchmark, company, or user's temporary path as a system rule. If project-specific evidence matters, put it under `Evidence`, `source_repositories`, or a source profile field.

Use domain-driven language when it clarifies boundaries:

- `Ubiquitous Language`
- `Bounded Context`
- `Policy`
- `Domain Event`
- `Aggregate`
- `Evidence`
- `Source Profile`

Only include these sections when they help the memory stay useful. Do not add DDD vocabulary as decoration.

## Good Example

```markdown
---
type: OKR
title: Local Embedding Index OKR
description: Defines a local-first embedding and zvec indexing loop for OKR-RAG memory.
tags: [okr, local-embedding, zvec, indexing]
timestamp: 2026-06-24T00:00:00+08:00
nocturne:
  uri: okr://index/local-embedding
  disclosure: When configuring or debugging local embedding, zvec indexing, or OKR-RAG ingest.
---

# Local Embedding Index OKR

This OKR defines the local-first indexing behavior for OKR Markdown memory.

## Objective 1: Build indexes without remote embedding APIs

The system should ingest OKR truth files and produce a searchable local index using local model files and zvec.

### Key Results

- KR1. `okr-rag ingest` succeeds when the local ONNX embedding model exists.
- KR2. The generated state is written under `.okr-rag/`, not into the source OKR folder.
- KR3. A recall benchmark reports Recall@1, Recall@5, Recall@10, p50 latency, and p95 latency.

## Evidence

- `setup-for-agent.md`: Documents the workspace and local embedding workflow.

## Retrieval Notes

- Recall this OKR for local embedding setup, zvec ingest behavior, and benchmark questions.
```

## Avoid

Avoid files with no frontmatter. They can be indexed, but retrieval is weaker.

Avoid vague titles like `Memory Notes` or `Project Plan`.

Avoid treating `.okr-rag/` as editable source.

Avoid putting all knowledge into `index.md`; the indexer skips it.

Avoid frontmatter that depends on a full YAML parser unless the Rust parser has been updated.

Avoid saying a benchmark is proven unless the OKR names the data, command, metric, and expected output.

## After Writing

If MCP watcher is running, the file should be picked up automatically after a short debounce.

If indexing must be forced from the CLI:

```powershell
E:\domain-driven-zv\target\release\okr-rag.exe ingest --root E:\domain-driven-zv
```

If querying from the CLI:

```powershell
E:\domain-driven-zv\target\release\okr-rag.exe query --root E:\domain-driven-zv --top-k 5 --candidate-k 50 "local embedding zvec index"
```

Before finishing, check:

- The file is under `okr-rag-workspace/okrs/`.
- The filename is lowercase kebab-case and not `index.md` or `log.md`.
- Frontmatter starts and ends with `---`.
- `title`, `description`, `tags`, `timestamp`, `nocturne.uri`, and `nocturne.disclosure` are present.
- The H1 matches the title closely.
- Every objective has key results.
- Project-specific facts are backed by evidence or isolated as source metadata.
