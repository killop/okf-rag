---
name: okf-rag-okf-format
description: Use this skill whenever the user asks to create, edit, review, validate, organize, or index OKF Markdown for OKF-RAG, writes files under okf-rag-workspace/okfs, mentions "our OKF format", "okf md", "OKF truth", Knowledge Catalog compatible OKF bundles, top-level URI/disclosure recall metadata, or agent-readable memory documents that will be vectorized by zvec. This skill teaches the Knowledge Catalog OKF bundle layout plus the exact Markdown and YAML shape expected by the local okf-rag parser. Trigger it even when the user casually asks to整理/organize a feature, subsystem, workflow, architecture area, or project memory; multi-concept topics should become a folder with index.md and concept files, not one monolithic Markdown file.
---

# OKF-RAG OKF Format

Write OKF Markdown that is compatible with the Knowledge Catalog Open Knowledge Format and useful as local `okf-rag` memory.

## Required Reference

Before creating or restructuring OKF content, read the bundled reference:

```text
references/knowledge-catalog-okf-spec.md
```

If the bundled reference is missing in a development checkout, read this local source of truth instead:

```text
E:\knowledge-catalog\okf\SPEC.md
```

Treat the Knowledge Catalog OKF spec as the structural source of truth. This skill adds OKF-RAG retrieval fields, but it should not override the OKF bundle model.

## MCP Retrieval Discipline

When OKF-RAG MCP tools are available, use them as the first retrieval path for existing OKF memory.

After calling `okf_rag_query` for a task, do not run shell search commands such as `rg`, `grep`, `Select-String`, or broad `Get-ChildItem | Select-String` over `okf-rag-workspace/okfs` for the same lookup. That duplicates the MCP retrieval work and burns context on raw text matches.

Use the MCP response instead:

- Treat `hits[].source_path` as the authoritative concept entry point.
- If a hit is inside a folder bundle, inspect the parent folder's `index.md` directly for progressive disclosure.
- If the first query is too narrow, run another `okf_rag_query` with better natural-language terms instead of switching to shell text search.
- Use shell only for targeted operations after MCP has identified a path: reading a specific known file, listing a specific known folder, creating/editing files, or debugging MCP/index availability.

## Source Of Truth

Create and edit OKF truth files only under the current workspace:

```text
okf-rag-workspace/okfs/
```

Use lowercase kebab-case filenames:

```text
okf-rag-workspace/okfs/domain-router-retrieval/overview.md
okf-rag-workspace/okfs/domain-router-retrieval/query-routing.md
okf-rag-workspace/okfs/local-embedding-index.md
```

Do not use these filenames for concept documents:

```text
index.md
log.md
```

The OKF spec reserves `index.md` for progressive disclosure and `log.md` for update history. The indexer also skips them as memory truth.

## Bundle Shape

An OKF knowledge bundle is a directory tree. Use a single concept file only when the user asks for one atomic memory. When the user asks to整理, document, import, or organize a feature, subsystem, workflow, architecture area, integration, asset pipeline, or any topic with multiple facts and evidence paths, create a folder under `okf-rag-workspace/okfs/`.

Recommended shape for a multi-concept topic:

```text
okf-rag-workspace/okfs/<topic-slug>/
├── index.md
├── overview.md
├── <concept-or-flow>.md
└── <decision-or-integration>.md
```

For example, a Unity resource hot update / YooAsset topic should be a bundle folder such as:

```text
okf-rag-workspace/okfs/resource-hot-update-yooasset/
├── index.md
├── overview.md
├── package-versioning.md
├── manifest-update-flow.md
├── download-cache-policy.md
└── runtime-integration.md
```

Choose concept files from the evidence. Do not invent empty sections just to match this example.

`index.md` is required for multi-concept folders because it gives progressive disclosure. It is not concept truth and is skipped by OKF-RAG ingest.

Write folder `index.md` files with no YAML frontmatter unless the user explicitly asks for bundle metadata. Use this shape:

```markdown
# Resource Hot Update YooAsset

* [Overview](overview.md) - Scope, vocabulary, and entry points for the resource hot update system.
* [Package Versioning](package-versioning.md) - How package names, versions, manifests, and remote catalogs are chosen.
* [Manifest Update Flow](manifest-update-flow.md) - Runtime sequence for checking, downloading, and applying updates.
```

Each bullet should link to a sibling concept file or subdirectory and include a short description from that concept's frontmatter.

## OKF Base Contract

Follow OKF v0.1 from the Knowledge Catalog spec:

```text
references/knowledge-catalog-okf-spec.md
```

- A knowledge bundle is a directory tree of UTF-8 Markdown files.
- Every concept document has YAML frontmatter delimited by `---`, followed by a Markdown body.
- `type` is required and must be non-empty.
- `title`, `description`, `resource`, `tags`, and `timestamp` are recommended.
- Extra producer-defined keys are allowed and should be preserved.
- The body is standard Markdown. Prefer headings, lists, tables, and fenced code blocks over loose prose.
- Use standard Markdown links for relationships between concepts.
- Use `# Citations` when the body makes sourced claims.

Conformance checklist:

- Every non-reserved `.md` concept file must have parseable YAML frontmatter.
- Every concept frontmatter must contain a non-empty `type`.
- `index.md` is navigation and `log.md` is update history; do not use either as a concept memory file.
- Multi-concept topics should have a directory `index.md` that lists child concept files for progressive disclosure.

## OKF-RAG Extension Fields

Use the OKF `resource` field for the canonical asset or concept URI:

```yaml
resource: okf://retrieval/domain-router
```

Add these two OKF-RAG recall fields as top-level frontmatter fields:

```yaml
uri: okf://retrieval/domain-router
disclosure: When deciding how an agent should search OKF memory for a query.
```

`uri` is the stable recall address of the memory. It may equal `resource` for abstract concepts.

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

Keep `uri` and `disclosure` at the top level for new OKF-RAG memory. Do not hide recall metadata under a nested object.

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

Make `title`, `description`, `resource`, `tags`, `uri`, `disclosure`, and the first paragraph carry the important retrieval words. Zvec indexes these signals, so do not hide the core terms only deep in the body.

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
- The required embedding provider is local ONNX MiniLM.
- Zvec stores the local searchable vector index.

## Evidence

- `setup-for-agent.md`: Documents workspace layout, MCP setup, skill installation, and local embedding behavior.
- `OKF-RAG-BENCHMARK.md`: Records recall and speed measurements.

## Retrieval Notes

- Recall this memory for local embedding setup, zvec ingest behavior, and benchmark questions.
```

## Avoid

Avoid files with no frontmatter. They are not OKF-conformant concept documents.

Avoid vague titles such as `Memory Notes` or `Project Plan`.

Avoid putting concept truth into `.okf-rag/`; that directory is derived runtime state.

Avoid putting all knowledge into `index.md`; it is reserved for navigation and is skipped as concept truth.

Avoid collapsing a subsystem, workflow, or feature area into one large Markdown file when the evidence naturally contains multiple concepts. Use a folder with an `index.md` and focused concept files.

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
- For a multi-concept topic, the output is a folder under `okf-rag-workspace/okfs/`, not a single monolithic file.
- Each multi-concept folder has an `index.md` that lists the child concepts or subdirectories.
- Concept filenames are lowercase kebab-case and not `index.md` or `log.md`.
- Concept frontmatter starts and ends with `---`.
- Concept frontmatter includes `type`, `title`, `description`, `resource`, `tags`, `timestamp`, `uri`, and `disclosure`.
- Folder `index.md` files are navigation files, not concept files; they normally have no frontmatter.
- The H1 matches the title closely.
- Claims are backed by evidence or citations when they are not self-contained.
- Project-specific facts are isolated as evidence, not global rules.
