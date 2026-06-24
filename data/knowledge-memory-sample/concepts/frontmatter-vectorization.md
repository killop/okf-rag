---
type: Knowledge Concept
title: Frontmatter Vectorization
description: Embeds YAML metadata together with the markdown body for better semantic recall.
resource: knowledge-memory://concept/frontmatter-vectorization
tags:
  - vector-search
  - yaml
  - zvec
timestamp: 2026-06-23T00:00:00Z
nocturne:
  uri: knowledge://memory/frontmatter-vectorization
  disclosure: When a query may match metadata such as tags, URI, disclosure, or description rather than body text.
  priority: 2
---

The vector text should include the full frontmatter and the body. This lets search match questions about title, type, tags, disclosure, URI, priority, aliases, and normal document text.

Keeping the source markdown readable matters because the markdown file remains the durable memory record. Zvec is the fast lookup layer, not the source of truth.
