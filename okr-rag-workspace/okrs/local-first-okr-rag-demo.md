---
type: OKR
title: Local-First OKR-RAG Demo
description: Demonstrates the portable OKR-RAG workspace layout, local indexing, and project-scoped MCP setup.
tags: [okr, demo, local-first, mcp, zvec]
timestamp: 2026-06-24T00:00:00+08:00
nocturne:
  uri: okr://demo/local-first-okr-rag
  disclosure: When testing whether a fresh OKR-RAG workspace can ingest, query, and expose local MCP memory.
---

# Local-First OKR-RAG Demo

This demo OKR proves that the workspace contains at least one portable, indexable OKR memory document with Knowledge Catalog-style frontmatter and Nocturne recall metadata.

## Objective 1: Make a fresh workspace queryable

The workspace should become searchable without remote embedding APIs or project-specific hardcoding.

### Key Results

- KR1. `target\release\okr-rag.exe ingest --root . --force` builds a local index from `okr-rag-workspace/okrs/`.
- KR2. `target\release\okr-rag.exe status --root .` reports at least one indexed concept.
- KR3. `target\release\okr-rag.exe query --root . "local first okr rag demo"` returns this OKR.

## Objective 2: Keep setup scoped to the current project

Codex MCP configuration should be project-local unless the user explicitly asks for a global install.

### Key Results

- KR1. The template config lives at `.codex/config.toml.example`.
- KR2. The active local config, if created, lives at `.codex/config.toml`.
- KR3. User-level Codex config is not modified by setup or packaging scripts.

## Evidence

- `setup-for-agent.md`: Agent setup, MCP config location, and hot-sync workflow.
- `.codex/config.toml.example`: Project-local MCP config template.
- `.gitignore`: Keeps machine-local config and runtime state out of source control.

## Retrieval Notes

- Recall this OKR for setup smoke tests, project-local MCP config, local indexing, and demo workspace validation.
