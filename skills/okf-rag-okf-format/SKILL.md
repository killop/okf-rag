---
name: okf-rag-okf-format
description: Use this skill whenever the user asks to create, edit, review, validate, organize, generate, daemon-ingest, or index OKF Markdown for OKF-RAG; asks where to add raw Markdown or notes for automatic consumption; writes files under okf-rag-workspace/raw or okf-rag-workspace/okfs; mentions "our OKF format", "okf md", "OKF truth", Knowledge Catalog compatible OKF bundles, top-level URI/disclosure recall metadata, or agent-readable memory documents that will be vectorized by zvec. This skill teaches the Raw Inbox workflow, Knowledge Catalog OKF bundle layout, and exact Markdown/YAML shape expected by the local okf-rag parser. Trigger it even when the user casually asks to整理/organize a feature, subsystem, workflow, architecture area, or project memory; multi-concept topics should become a folder with index.md and concept files, not one monolithic Markdown file.
---

# OKF-RAG OKF Format

Write OKF Markdown that is compatible with the Knowledge Catalog Open Knowledge Format and useful as local `okf-rag` memory.

## Required Reference

Before creating or restructuring OKF content, read the bundled reference:

```text
references/knowledge-catalog-okf-spec.md
```

Treat the Knowledge Catalog OKF spec as the structural source of truth. This skill adds OKF-RAG retrieval fields, but it should not override the OKF bundle model.

## MCP Retrieval Discipline

When OKF-RAG MCP tools are available, use them as the first retrieval path for existing OKF memory.

After calling `okf_rag_query` for a task, do not run shell search commands such as `rg`, `grep`, `Select-String`, or broad `Get-ChildItem | Select-String` over `okf-rag-workspace/okfs` for the same lookup. That duplicates the MCP retrieval work and burns context on raw text matches.

Use the MCP response instead:

- Treat `hits[].source_path` as the authoritative concept entry point.
- If a hit is inside a folder bundle, inspect the parent folder's `index.md` directly for progressive disclosure.
- If the first query is too narrow, run another `okf_rag_query` with better natural-language terms instead of switching to shell text search.
- Use `okf_rag_relationships` with a canonical ID, exact title, URI, or alias to inspect outgoing relations and incoming backlinks through MCP.
- Use shell only for targeted operations after MCP has identified a path: reading a specific known file, listing a specific known folder, creating/editing files, or debugging MCP/index availability.

## Raw Markdown Inbox

When a daemon owns a topic, treat Raw Markdown as input and the published OKF bundle as generated output.

Use this stable mapping:

```text
okf-rag-workspace/raw/<topic-slug>/     # Agent/user input
okf-rag-workspace/okfs/<topic-slug>/    # Reconciled OKF output
```

Start one background daemon per topic from the project root. When `--source` is omitted, the daemon creates and recursively watches the default Raw Inbox:

```powershell
node okf-rag-workspace/tools/okf_llmwiki_daemon.js start --bundle <topic-slug>
```

Before starting an LLM-backed daemon, configure the project-local secret file:

```text
.okf-rag/llmwiki.env
```

Use `.okf-rag/llmwiki.env.example` as the template. The pipeline, daemon, and stream probe load the file automatically; explicit process environment variables override it. Keep API keys only in this Git-ignored file or the process environment, never in Markdown, command arguments, logs, skill files, `AGENTS.md`, or `CLAUDE.md`.

Before adding a Raw Markdown file:

1. Run `node okf-rag-workspace/tools/okf_llmwiki_daemon.js status --bundle <topic-slug> --json`.
2. Confirm `projectEnv.exists` is true and `projectEnv.configuredKeys` includes the provider, model, and required credential key names. Values are intentionally never returned.
3. Confirm `running` is true and `inbox` points to `okf-rag-workspace/raw/<topic-slug>/`.
4. If it is not running, start it with the command above and check status again.
5. Create or edit a descriptive lowercase kebab-case `.md` file in that inbox. Raw files do not need OKF frontmatter; preserve headings, code, evidence paths, and source links that help llmwiki extract concepts.
6. Wait until status reports `state.status: idle` and `state.lastRun.status: succeeded`.
7. Query the result through OKF-RAG MCP. Do not repeat the lookup with shell corpus search.

Adding, changing, or deleting a `.md` file in the inbox triggers a debounced pipeline pass. The daemon synchronizes Raw Markdown into llmwiki sources, compiles candidate concepts, reconciles ownership and duplicates, writes directed wiki relationships, validates and atomically publishes `okfs/<topic-slug>/`, refreshes navigation indexes, and runs Rust ingest. It also compares the published bundle with the sync manifest; deleting the topic directory, index, or a managed output queues automatic recovery. A successful run therefore makes the new knowledge queryable without a manual ingest command.

Do not manually edit daemon-managed files under `okfs/<topic-slug>/`; a later reconciliation may replace them. Put corrections in the Raw Markdown or `.okf-rag/INSTRUCTIONS.md`. Directly author files under `okfs/` only for explicitly user-managed concepts that are outside a daemon-owned bundle.

Use explicit `--source <file-or-directory>` only when importing an existing source location instead of the default inbox. Do not combine `--source` and `--inbox`.

## Auto Generation And Dedup Workflow

For automatic OKF generation, use `llm-wiki-compiler` as a candidate producer instead of treating its wiki directory as final truth. Let llmwiki extract semantic proposals. The OKF reconciler owns the published file set: it reads llmwiki source-to-concept state, prunes stale managed concepts, performs conservative exact dedupe, generates standard Markdown relationships, validates a staged bundle, and atomically publishes it. Rust `okf-rag` then consumes the reconciled Markdown through local ingest.

Use this bridge command when available:

```powershell
node okf-rag-workspace/tools/okf_pipeline.js --source <markdown-file-or-directory> --bundle <topic-slug>
```

The bridge keeps llmwiki's project and export state under `.okf-rag/`, syncs the exported OKF bundle into:

```text
okf-rag-workspace/okfs/<topic-slug>/
```

and runs Rust ingest unless `--no-ingest` is passed. The reconciler generates an OKF v0.1 `index.md` at each topic bundle root and refreshes `okfs/index.md` as a deterministic catalog of bundles. It does not create `okf-rag-workspace/index.md`, because that directory also contains runtime artifacts rather than one OKF bundle.

For Unity/U3D projects that need the prepared OKF-RAG workspace copied after generation, pass an explicit mirror target:

```powershell
node okf-rag-workspace/tools/okf_pipeline.js --source <markdown-file-or-directory> --bundle <topic-slug> --mirror-workspace F:\path\to\target-project\okf-rag-workspace
```

When mirroring, build the Rust release first if `okf-rag-workspace/bin` is missing. The bridge copies `okf-rag.exe` and required DLLs from `target/release` before copying the workspace.

Use `okf_maintain` after publication for validation or explicit manual maintenance. Normal generated links are written during staged publication so they are part of the same atomic generation.

For local Markdown input, the pipeline writes llmwiki `sources/*.md` directly according to `SOURCES_CONTRACT.md`. Source manifest v2 records adapter type, stable source-instance identity, raw and compiler hashes, file ownership, observed timestamps, and deletion propagation. Use `--stage-only` when validating this first stage without making LLM calls. Read `.okf-rag/INSTRUCTIONS.md` when present; it is project-owned control metadata and must not be published as an OKF concept.

The pipeline keeps a persistent Node 24 + llm-wiki-compiler runtime under `.okf-rag/llmwiki-runtime/`. For `--provider claude-agent`, require `claude auth status` to report `loggedIn: true`; otherwise tell the user to run `claude auth login` before starting compile or daemon mode.

For an OpenAI-compatible endpoint that only accepts streamed chat completions, require `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `LLMWIKI_MODEL`, and `LLMWIKI_STREAM_ONLY_OPENAI=true` in `.okf-rag/llmwiki.env` or the explicit process environment. Run `node okf-rag-workspace/tools/openai_stream_adapter.js --probe` first; both text streaming and streamed function/tool calls must pass. Never put the API key in command-line arguments or generated Markdown.

For a long-running OKF producer, use the OKF-RAG daemon instead of llmwiki's native `watch` alone. Native `llmwiki watch` recompiles `wiki/`, but it does not export OKF, sync `okf-rag-workspace/okfs`, run Rust ingest, or mirror the prepared workspace.

Foreground daemon:

```powershell
node okf-rag-workspace/tools/okf_llmwiki_daemon.js run --bundle <topic-slug>
```

Background daemon:

```powershell
node okf-rag-workspace/tools/okf_llmwiki_daemon.js start --bundle <topic-slug>
node okf-rag-workspace/tools/okf_llmwiki_daemon.js status --bundle <topic-slug>
node okf-rag-workspace/tools/okf_llmwiki_daemon.js stop --bundle <topic-slug>
```

With no explicit source, the daemon watches `okf-rag-workspace/raw/<topic-slug>/`. The daemon reruns the same bridge loop on Markdown changes and self-recovers missing or partially deleted managed output. On normal MCP startup, after `tools/list` has been flushed, Rust scans raw topic folders and idempotently starts these daemons in the background. Background mode uses a supervisor that restarts a crashed worker. PID, logs, source paths, inbox, heartbeat, pending work, pipeline stage, duration, published-bundle health, and last error live under `.okf-rag/llmwiki-daemon/` and are returned by `status --json`.

Successful publication stores the five most recent rollback snapshots under `.okf-rag/generations/<topic-slug>/`. Use `node okf-rag-workspace/tools/okf_generation.js list --bundle <topic-slug>` and `rollback --bundle <topic-slug> --generation <id>` when a generated concept set needs to be restored.

When the user asks to generate OKF from a source repository, feature area, agent session, raw notes, or an existing document set, treat generation as a proposal-to-truth pipeline:

1. Discover the target topic and source evidence.
2. Check existing OKF memory before writing.
3. Convert evidence into candidate concepts.
4. Deduplicate candidates against existing concepts.
5. Write only the accepted concepts under `okf-rag-workspace/okfs/`.
6. Generate or refresh the topic bundle's versioned `index.md` and the `okfs/index.md` catalog.
7. Run ingest, or when the source came through a running topic daemon, verify its successful status because the daemon already ingests after publication.

Do not create `okf-rag-workspace/index.md` just because generation ran. Topic bundle indexes are required for multi-concept bundles, and `okfs/index.md` may be generated as a progressive-disclosure catalog.

Use this local maintenance command when available:

```powershell
node okf-rag-workspace/tools/okf_maintain.js --root .
```

It reports malformed concept files and likely duplicate OKFs. To refresh topic-folder indexes after writing concept files:

```powershell
node okf-rag-workspace/tools/okf_maintain.js --root . --write-index
```

Use `--root-index` with `--write-index` when manual maintenance should also refresh `okfs/index.md`.

To weave OKF concepts into a wiki-like graph, generate related-concept links after writing or merging concepts:

```powershell
node okf-rag-workspace/tools/okf_maintain.js --root . --write-links --write-index
```

The link generator should create Obsidian-compatible wikilinks between concept documents plus structured relation metadata for Rust/zvec. Relations are directed and carry a predicate, confidence, and evidence references. It should prefer durable evidence:

- Exact title mentions in another concept's body or description.
- Existing Markdown links and the sentence around each link.
- Exact title mentions with a relationship verb such as depends on, uses, calls, produces, updates, validates, or publishes to.
- Shared source ownership may raise confidence but must not create a relation by itself.

Do not automatically add a reverse semantic edge. Always publish a navigation backlink on the target document, but keep it in `inbound_relations`; add an inverse outbound relation only when the target concept independently contains evidence for it.

Write generated links in a clearly marked `## Related Concepts` block so the section can be refreshed safely:

```markdown
## Related Concepts

<!-- okf-rag:auto-links:start -->
### Outgoing

- [[other-concept|Other Concept]] - depends on

### Backlinks

- [[upstream-concept|Upstream Concept]] - incoming: produces
<!-- okf-rag:auto-links:end -->
```

This block gives Obsidian, agents, and humans a traversable two-way wiki surface while keeping semantic direction explicit and the generated region replaceable. Avoid rewriting prose inline unless the user explicitly asks for inline wiki-link insertion; inline rewrites can damage evidence wording and code blocks.

### Candidate Shape

Before writing files, model each generated concept as a candidate with these fields:

```yaml
type: Reference
title: <human readable concept title>
description: <one sentence summary>
resource: okf://<stable-domain>/<stable-topic>/<stable-concept>
tags: [okf, <domain>, <topic>]
timestamp: <ISO 8601 datetime>
uri: okf://<stable-domain>/<stable-topic>/<stable-concept>
disclosure: When <specific future-agent situation where this memory should be recalled>.
```

Keep the body tied to evidence. Prefer `## Details`, `## Evidence`, `# Citations`, and `## Retrieval Notes` when they help. Avoid unsourced claims. If an LLM extracts a relationship, treat it as a candidate relationship until there is source evidence or a clear Markdown link context.

### Dedup Rules

Use a two-stage dedup check.

Strong duplicate signals:

- Same non-empty `uri`.
- Same non-empty `resource`.
- Same content hash or same generated canonical file path.
- Same title, type, and evidence path set.

Review duplicate signals:

- Same normalized title and similar type.
- High semantic similarity but different evidence.
- Same concept appears under a sibling topic folder.
- New candidate is narrower than an existing concept and can become a section or link instead.

Merge policy:

- Preserve existing frontmatter keys that are not being intentionally updated.
- Add new evidence paths, citations, and links instead of replacing the whole body.
- Prefer one canonical concept plus links from related concepts over duplicated summaries.
- If two concepts have different `resource` or `uri`, do not auto-merge unless the evidence proves they are the same thing.
- Never delete user-authored OKF files during generation unless the user explicitly asks for destructive cleanup.

### File Placement

For one atomic concept, use one concept file:

```text
okf-rag-workspace/okfs/<concept-slug>.md
```

For a subsystem, workflow, integration, feature, code area, or any multi-fact topic, write a bundle folder:

```text
okf-rag-workspace/okfs/<topic-slug>/
├── index.md
├── overview.md
└── <focused-concept>.md
```

Generate `index.md` from accepted child concept frontmatter. Do not put concept truth into `index.md`; it is navigation only and is skipped by OKF-RAG ingest.

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

Write the topic bundle root `index.md` with the OKF version declaration. Nested directory indexes have no frontmatter. Use this shape:

```markdown
---
okf_version: "0.1"
---

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
- Use Obsidian `[[target-file|Display Title]]` links in generated relationship blocks. Keep `outbound_relations` and `inbound_relations` as the machine-readable direction contract.
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

Never publish host absolute paths inside OKF Markdown, including `source_refs`, reference frontmatter, evidence blocks, or generated link metadata. Concept `source_refs` should point to bundle-local `references/` documents with relative paths; source mirror documents may retain portable `okf-source://` URIs. Fail publication when a Windows drive path, UNC path, or absolute `file:///` URI survives staging.

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
