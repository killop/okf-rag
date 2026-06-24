---
name: okf-rag-okf-format
description: Use this skill whenever the user asks to create, edit, review, validate, or index OKF Markdown for OKF-RAG, writes files under okf-rag-workspace/okfs, mentions "our OKF format", "okf md", "OKF truth", Knowledge Catalog compatible OKF notes, top-level URI/disclosure recall metadata, or agent-readable memory documents that will be vectorized by zvec. This skill teaches the exact Markdown and YAML shape expected by the local okf-rag parser, so trigger it even when the user casually says to add an OKF note or update project memory.
---

# OKF-RAG OKF Format

Write OKF Markdown that is compatible with the Knowledge Catalog Open Knowledge Format and useful as local `okf-rag` memory.

## Source Of Truth

Create and edit OKF truth files only under the current workspace:

```text
okf-rag-workspace/okfs/
```

Use lowercase kebab-case filenames:

```text
okf-rag-workspace/okfs/domain-router-retrieval.md
okf-rag-workspace/okfs/local-embedding-index.md
```

Do not use these filenames for concept documents:

```text
index.md
log.md
```

The OKF spec reserves `index.md` for progressive disclosure and `log.md` for update history. The indexer also skips them as memory truth.

## OKF Base Contract

Follow OKF v0.1 from the Knowledge Catalog spec:

```text
https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
```

- A knowledge bundle is a directory tree of UTF-8 Markdown files.
- Every concept document has YAML frontmatter delimited by `---`, followed by a Markdown body.
- `type` is required and must be non-empty.
- `title`, `description`, `resource`, `tags`, and `timestamp` are recommended.
- Extra producer-defined keys are allowed and should be preserved.
- The body is standard Markdown. Prefer headings, lists, tables, and fenced code blocks over loose prose.
- Use standard Markdown links for relationships between concepts.
- Use `# Citations` when the body makes sourced claims.

## OKF-RAG Extension Fields

Add these two top-level fields to memory documents:

```yaml
uri: okf://retrieval/domain-router
disclosure: When deciding how an agent should search OKF memory for a query.
```

`uri` is the stable address of the memory.

`disclosure` is the recall rule. It should answer:

```text
When should this memory be retrieved?
```

Good disclosure:

```yaml
disclosure: When choosing between dense, lexical, and hybrid retrieval for OKF memory.
```

Weak disclosure:

```yaml
disclosure: This document is about retrieval.
```

The first version names the situation where the memory should wake up. The second is only a vague summary.

## Frontmatter Template

Use simple YAML that the Rust parser can read without a full YAML engine:

```yaml
---
type: Reference
title: Domain Router Retrieval
description: How OKF-RAG chooses retrieval behavior from query and corpus signals.
resource: okf://retrieval/domain-router
tags: [okf, retrieval, domain-router, zvec]
timestamp: 2026-06-24T00:00:00+08:00
uri: okf://retrieval/domain-router
disclosure: When deciding how an agent should search OKF memory for a query.
---
```

Prefer inline tags:

```yaml
tags: [okf, retrieval, domain-memory]
```

List tags are also accepted:

```yaml
tags:
  - okf
  - retrieval
  - domain-memory
```

Avoid YAML anchors, aliases, nested arrays, and deeply nested objects in memory truth files. OKF allows extensions, but the local parser intentionally stays simple.

## Body Shape

There are no required body sections. Choose sections that make the memory easy to read and retrieve.

For most agent memory documents, this shape works well:

```markdown
# Domain Router Retrieval

One short paragraph explaining what this concept is and why future agents should care.

## Details

- Describe the stable rules or facts.
- Keep the logic generic unless the file is explicitly about one project.
- Name important terms exactly as users and code will query them.

## Evidence

- `relative/path/to/source.md`: What this source proves.
- `relative/path/to/file.rs`: What this implementation shows.

# Citations

[1] [Related OKF concept](/retrieval/other-concept.md)

## Retrieval Notes

- Recall this memory for questions about retrieval routing, hybrid search, candidate selection, and zvec index behavior.
```

Use `# Citations` for sourced external claims. Use `## Evidence` for local source files, commands, benchmark outputs, or project artifacts that support the memory.

## Writing Rules

Make `title`, `description`, `tags`, `uri`, `disclosure`, and the first paragraph carry the important retrieval words. Zvec indexes these signals, so do not hide the core terms only deep in the body.

Write durable facts, rules, and evidence. Avoid temporary task lists unless the user explicitly asks for planning content.

Keep generic system behavior generic. Do not hardcode a specific game engine, repository, company, benchmark, or user machine path as a global rule. If project-specific evidence matters, put it in `Evidence` with relative paths from the current workspace when possible.

Use a descriptive `type` value. Examples:

- `Reference`
- `Playbook`
- `Metric`
- `API Endpoint`
- `Policy`
- `Domain Term`
- `Architecture Decision`

Unknown types are valid OKF. Prefer clear language over a fixed taxonomy.

## Good Example

```markdown
---
type: Reference
title: Local Embedding Index
description: Defines the local-first embedding and zvec indexing loop for OKF-RAG memory.
resource: okf://index/local-embedding
tags: [okf, local-embedding, zvec, indexing]
timestamp: 2026-06-24T00:00:00+08:00
uri: okf://index/local-embedding
disclosure: When configuring or debugging local embedding, zvec indexing, or OKF-RAG ingest.
---

# Local Embedding Index

This concept defines how OKF-RAG builds a searchable local index from OKF Markdown.

## Details

- `okf-rag ingest` reads Markdown from `okf-rag-workspace/okfs/` by default.
- Runtime state is written under `.okf-rag/`.
- The preferred embedding provider is local ONNX MiniLM.
- Zvec stores the local searchable vector index.

## Evidence

- `setup-for-agent.md`: Documents workspace layout, MCP setup, and local embedding behavior.
- `OKF-RAG-BENCHMARK.md`: Records recall and speed measurements.

## Retrieval Notes

- Recall this memory for local embedding setup, zvec ingest behavior, and benchmark questions.
```

## Avoid

Avoid files with no frontmatter. They are not OKF-conformant concept documents.

Avoid vague titles such as `Memory Notes` or `Project Plan`.

Avoid putting concept truth into `.okf-rag/`; that directory is derived runtime state.

Avoid putting all knowledge into `index.md`; it is reserved for navigation and is skipped as concept truth.

Avoid absolute local machine paths in reusable memory. Prefer relative workspace paths or stable URIs.

Avoid claiming a benchmark is proven unless the OKF names the data, command, metric, and expected output.

## After Writing

If the MCP watcher is running, file changes under `okf-rag-workspace/okfs/` should be indexed automatically after a short debounce.

If indexing must be forced from the CLI:

```powershell
okf-rag-workspace\bin\okf-rag.exe ingest --root .
```

If querying from the CLI:

```powershell
okf-rag-workspace\bin\okf-rag.exe query --root . --top-k 5 --candidate-k 50 "local embedding zvec index"
```

Before finishing, check:

- The file is under `okf-rag-workspace/okfs/`.
- The filename is lowercase kebab-case and not `index.md` or `log.md`.
- Frontmatter starts and ends with `---`.
- `type`, `title`, `description`, `tags`, `timestamp`, `uri`, and `disclosure` are present.
- The H1 matches the title closely.
- Claims are backed by evidence or citations when they are not self-contained.
- Project-specific facts are isolated as evidence, not global rules.
