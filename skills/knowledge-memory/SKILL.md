---
name: knowledge-memory
description: Use this skill whenever the user wants to create, validate, index, query, or maintain a skill-like knowledge memory system from Markdown knowledge points, Knowledge Catalog / OKF bundles, Nocturne-style URI/disclosure metadata, or Zvec semantic search. Trigger it for requests about memory notes, OKF frontmatter, index.md generation, disclosure-based recall, local ONNX embeddings, or vectorizing YAML frontmatter into Zvec.
---

# Knowledge Memory

Build and query a local semantic memory layer where Markdown is the source of truth, OKF frontmatter gives each knowledge point a stable catalog shape, Nocturne metadata says when a memory should be recalled, and Zvec stores the searchable vectors.

## Source Contract

Use ordinary Markdown concept files as knowledge points. Keep `index.md` as an OKF directory listing, not as the only storage place for all knowledge.

A concept file should have OKF frontmatter:

```yaml
---
type: Knowledge Concept
title: Domain Router
description: Chooses a retrieval profile from corpus and query signals.
resource: domain-router
tags: [memory, retrieval]
timestamp: 2026-06-23T00:00:00Z
nocturne:
  uri: knowledge://memory/domain-router
  disclosure: When choosing how to search a memory bundle.
  priority: 2
  aliases:
    - uri: architecture://retrieval/domain-router
      disclosure: When explaining the retrieval architecture.
      priority: 3
---
```

The script also accepts top-level compatibility fields:

```yaml
nocturne_uri: knowledge://memory/domain-router
disclosure: When choosing how to search a memory bundle.
priority: 2
```

Prefer nested `nocturne` for new files because it keeps the OKF fields and recall fields separate.

## Workflow

1. Read the target bundle before changing it.
2. Validate that concept files have OKF YAML frontmatter and a non-empty `type`.
3. Require Nocturne `uri` and `disclosure` for memory bundles unless the user is only importing plain OKF docs.
4. Generate or refresh OKF-style `index.md` files from concept frontmatter.
5. Build the Zvec index from both YAML frontmatter and Markdown body.
6. Query the Zvec index and return the concept title, path, Nocturne URI, disclosure, and score.
7. For recall-sensitive searches, retrieve a larger candidate set and rerank with generic frontmatter/body token overlap.

## Commands

From this repository:

```powershell
.\.venv\Scripts\python.exe scripts\knowledge_memory_index.py validate --bundle data\knowledge-memory-sample
.\.venv\Scripts\python.exe scripts\knowledge_memory_index.py build --bundle data\knowledge-memory-sample --db data\knowledge-memory-zvec-sample --recreate --write-indexes
.\.venv\Scripts\python.exe scripts\knowledge_memory_index.py query --db data\knowledge-memory-zvec-sample --text "when should I use disclosure metadata"
.\.venv\Scripts\python.exe scripts\knowledge_memory_index.py query --db data\knowledge-memory-zvec-sample --text "when should I use disclosure metadata" --candidate-k 20 --rerank
.\.venv\Scripts\python.exe scripts\prove_knowledge_memory_system.py --concept-count 60 --candidate-k 50
```

Use `python` instead of `.\.venv\Scripts\python.exe` if the workspace has no virtual environment.

## Design Rules

Keep the system generic. Do not bake project names, game-engine terms, benchmark datasets, or one repository's domain vocabulary into the parser, router, or schema.

Treat `disclosure` as a recall trigger, not as a summary. It should answer: "In what situation should this memory wake up?"

Treat `uri` as an access path. It can have aliases, and aliases may carry different disclosure and priority values.

Vectorize the YAML and the body together. Title, description, tags, URI, disclosure, aliases, and body text all help recall.

Use hybrid rerank when the query depends on exact metadata signals such as URI, tags, title words, or disclosure trigger wording. Dense vectors find candidates; structured metadata rerank makes the final ordering less brittle.

Keep generated indexes deterministic. Do not use an LLM for `index.md` generation unless the user explicitly asks for synthesized directory descriptions.
