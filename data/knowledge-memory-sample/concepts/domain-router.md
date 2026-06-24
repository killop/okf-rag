---
type: Knowledge Concept
title: Domain Router
description: Selects a retrieval profile from generic corpus and query signals.
resource: knowledge-memory://concept/domain-router
tags:
  - memory
  - retrieval
  - routing
timestamp: 2026-06-23T00:00:00Z
nocturne:
  uri: knowledge://memory/domain-router
  disclosure: When deciding how a memory search should choose its retrieval profile.
  priority: 2
  aliases:
    - uri: architecture://retrieval/domain-router
      disclosure: When explaining the search architecture.
      priority: 3
---

The domain router is a small decision step before retrieval. It looks at the shape of the memory bundle and the query, then picks a retrieval profile.

It should use generic signals: timestamps, document length, density of named entities, number of numeric facts, query specificity, and whether the question asks for evidence.

The router should not know about a specific game engine, benchmark, company, or project. Those details belong in source documents, not in the retrieval core.
