"use strict";

const path = require("path");

const AUTO_LINKS_RE = /\n*## Related Concepts\s*\n\s*<!-- okf-rag:auto-links:start -->[\s\S]*?<!-- okf-rag:auto-links:end -->\s*/gm;

const PREDICATE_PATTERNS = [
  { predicate: "depends_on", pattern: /(depends? on|requires?|依赖|需要)/i },
  { predicate: "calls", pattern: /(calls?|invokes?|dispatches? to|调用|触发|分发到)/i },
  { predicate: "uses", pattern: /(uses?|consumes?|reads? from|使用|消费|读取)/i },
  { predicate: "produces", pattern: /(produces?|generates?|writes? to|emits?|生成|产出|写入|输出)/i },
  { predicate: "configures", pattern: /(configures?|controls?|governs?|配置|控制|约束)/i },
  { predicate: "implements", pattern: /(implements?|realizes?|实现|落地)/i },
  { predicate: "part_of", pattern: /(part of|belongs? to|contained by|属于|组成部分|包含于)/i },
  { predicate: "publishes_to", pattern: /(publishes? to|deploys? to|mirrors? to|发布到|部署到|镜像到|同步到)/i },
  { predicate: "updates", pattern: /(updates?|refreshes?|synchroni[sz]es?|更新|刷新|同步)/i },
  { predicate: "validates", pattern: /(validates?|verifies?|checks?|校验|验证|检查)/i },
];

const PREDICATE_LABELS = {
  calls: "calls",
  configures: "configures",
  depends_on: "depends on",
  implements: "implements",
  part_of: "is part of",
  produces: "produces",
  publishes_to: "publishes to",
  references: "references",
  updates: "updates",
  uses: "uses",
  validates: "validates",
};

function slash(value) {
  return String(value || "").replace(/\\/g, "/");
}

function stripFrontmatter(text) {
  const match = String(text || "").match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? String(text).slice(match[0].length) : String(text || "");
}

function stripGeneratedLinks(text) {
  return String(text || "").replace(AUTO_LINKS_RE, "\n").trimEnd();
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function decodeLinkTarget(value) {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function resolveMarkdownTarget(fromRelativePath, rawTarget) {
  const target = decodeLinkTarget(String(rawTarget || "").split("#", 1)[0].trim());
  if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) return "";
  const fromDir = path.posix.dirname(slash(fromRelativePath));
  return target.startsWith("/")
    ? path.posix.normalize(target.slice(1))
    : path.posix.normalize(path.posix.join(fromDir === "." ? "" : fromDir, target));
}

function contextAround(text, start, length, radius = 100) {
  const left = Math.max(0, start - radius);
  const right = Math.min(text.length, start + length + radius);
  return text.slice(left, right).replace(/\s+/g, " ").trim();
}

function inferPredicate(context) {
  for (const candidate of PREDICATE_PATTERNS) {
    if (candidate.pattern.test(context)) return candidate.predicate;
  }
  return "references";
}

function predicateLabel(predicate) {
  return PREDICATE_LABELS[predicate] || predicate.replace(/_/g, " ");
}

function evidenceRefsFor(concept) {
  const owners = Array.from(concept.owners || []).filter(Boolean).sort();
  return owners.length > 0 ? owners : [`okf:${concept.relativePath}`];
}

function explicitRelationships(concept, conceptsByPath) {
  const body = concept.body;
  const relationships = [];
  const linkPattern = /\[([^\]]+)\]\(([^)]+\.md(?:#[^)]+)?)\)/gi;
  let match;
  while ((match = linkPattern.exec(body)) !== null) {
    const targetPath = resolveMarkdownTarget(concept.relativePath, match[2]);
    const target = conceptsByPath.get(targetPath);
    if (!target || target.relativePath === concept.relativePath) continue;
    const context = contextAround(body, match.index, match[0].length);
    relationships.push({
      from: concept.canonicalId,
      fromPath: concept.relativePath,
      to: target.canonicalId,
      toPath: target.relativePath,
      predicate: inferPredicate(context),
      confidence: 1,
      evidenceRefs: evidenceRefsFor(concept),
      evidenceText: context.slice(0, 240),
      source: "explicit-markdown-link",
    });
  }
  return relationships;
}

function wikilinkLookup(concepts) {
  const values = new Map();
  const register = (key, concept) => {
    const normalized = normalizeText(key);
    if (!normalized) return;
    if (!values.has(normalized)) values.set(normalized, concept);
    else if (values.get(normalized)?.canonicalId !== concept.canonicalId) values.set(normalized, null);
  };
  for (const concept of concepts) {
    const withoutExtension = concept.relativePath.replace(/\.md$/i, "");
    register(withoutExtension, concept);
    register(path.posix.basename(withoutExtension), concept);
    register(concept.title, concept);
  }
  return values;
}

function resolveWikilinkTarget(concept, rawTarget, conceptsByPath, conceptsByWikilink) {
  const target = String(rawTarget || "").split("|", 1)[0].split("#", 1)[0].trim();
  if (!target) return null;
  const normalizedTarget = slash(target).replace(/\.md$/i, "");
  const fromDir = path.posix.dirname(concept.relativePath);
  const relativePath = path.posix.normalize(
    path.posix.join(fromDir === "." ? "" : fromDir, `${normalizedTarget}.md`)
  );
  return (
    conceptsByPath.get(relativePath) ||
    conceptsByWikilink.get(normalizeText(normalizedTarget)) ||
    null
  );
}

function explicitWikilinkRelationships(concept, conceptsByPath, conceptsByWikilink) {
  const relationships = [];
  const linkPattern = /\[\[([^\]]+)\]\]/g;
  let match;
  while ((match = linkPattern.exec(concept.body)) !== null) {
    const target = resolveWikilinkTarget(
      concept,
      match[1],
      conceptsByPath,
      conceptsByWikilink
    );
    if (!target || target.relativePath === concept.relativePath) continue;
    const context = contextAround(concept.body, match.index, match[0].length);
    relationships.push({
      from: concept.canonicalId,
      fromPath: concept.relativePath,
      to: target.canonicalId,
      toPath: target.relativePath,
      predicate: inferPredicate(context),
      confidence: 1,
      evidenceRefs: evidenceRefsFor(concept),
      evidenceText: context.slice(0, 240),
      source: "explicit-wikilink",
    });
  }
  return relationships;
}

function titleMentionRelationships(concept, concepts, existingTargets) {
  const normalizedBody = concept.normalizedBody;
  const relationships = [];
  for (const target of concepts) {
    if (target.relativePath === concept.relativePath || existingTargets.has(target.canonicalId)) continue;
    const normalizedTitle = target.normalizedTitle;
    if (normalizedTitle.length < 4) continue;
    const index = normalizedBody.indexOf(normalizedTitle);
    if (index < 0) continue;
    const context = contextAround(normalizedBody, index, normalizedTitle.length);
    const predicate = inferPredicate(context);
    const sameOwner = [...(concept.owners || [])].some((owner) => target.owners?.has(owner));
    if (predicate === "references" && !sameOwner) continue;
    relationships.push({
      from: concept.canonicalId,
      fromPath: concept.relativePath,
      to: target.canonicalId,
      toPath: target.relativePath,
      predicate,
      confidence: predicate === "references" ? 0.65 : 0.82,
      evidenceRefs: evidenceRefsFor(concept),
      evidenceText: context.slice(0, 240),
      source: "title-mention",
    });
  }
  return relationships;
}

function deduplicateRelationships(relationships) {
  const byPair = new Map();
  for (const relationship of relationships) {
    const key = `${relationship.from}\0${relationship.to}`;
    const previous = byPair.get(key);
    if (
      !previous ||
      relationship.confidence > previous.confidence ||
      (relationship.confidence === previous.confidence &&
        relationship.predicate !== "references" &&
        previous.predicate === "references")
    ) {
      byPair.set(key, relationship);
    }
  }
  return [...byPair.values()].sort(
    (left, right) =>
      left.from.localeCompare(right.from) ||
      right.confidence - left.confidence ||
      left.to.localeCompare(right.to)
  );
}

function buildRelationshipGraph(entries, options = {}) {
  const bundle = options.bundle || "bundle";
  const ownersBySlug = options.ownersBySlug || new Map();
  const maxOutbound = options.maxOutbound || 6;
  const concepts = entries.map((entry) => {
    const relativePath = slash(entry.relativePath);
    const slug = relativePath.replace(/^concepts\//, "").replace(/\.md$/i, "");
    const identity = options.identity(entry);
    return {
      ...entry,
      relativePath,
      slug,
      title: identity.title,
      normalizedTitle: normalizeText(identity.title),
      body: stripGeneratedLinks(stripFrontmatter(entry.text)),
      canonicalId: `${bundle}/${relativePath.replace(/\.md$/i, "")}`,
      owners: ownersBySlug.get(slug) || new Set(),
    };
  });
  for (const concept of concepts) concept.normalizedBody = normalizeText(concept.body);
  const conceptsByPath = new Map(concepts.map((concept) => [concept.relativePath, concept]));
  const conceptsByWikilink = wikilinkLookup(concepts);
  const all = [];

  for (const concept of concepts) {
    const explicit = [
      ...explicitRelationships(concept, conceptsByPath),
      ...explicitWikilinkRelationships(concept, conceptsByPath, conceptsByWikilink),
    ];
    all.push(...explicit);
    all.push(
      ...titleMentionRelationships(
        concept,
        concepts,
        new Set(explicit.map((relationship) => relationship.to))
      )
    );
  }

  const deduplicated = deduplicateRelationships(all);
  const outbound = new Map(concepts.map((concept) => [concept.canonicalId, []]));
  for (const relationship of deduplicated) {
    outbound.get(relationship.from).push(relationship);
  }
  const limited = [];
  for (const relationships of outbound.values()) {
    limited.push(
      ...relationships
        .sort(
          (left, right) =>
            right.confidence - left.confidence || left.to.localeCompare(right.to)
        )
        .slice(0, maxOutbound)
    );
  }

  const connected = new Set();
  for (const relationship of limited) {
    connected.add(relationship.from);
    connected.add(relationship.to);
  }
  const orphans = concepts
    .filter((concept) => !connected.has(concept.canonicalId))
    .map((concept) => concept.canonicalId)
    .sort();

  return {
    concepts,
    relationships: limited,
    orphans,
    summary: {
      concepts: concepts.length,
      relationships: limited.length,
      explicit: limited.filter((item) => item.source.startsWith("explicit-")).length,
      inferred: limited.filter((item) => item.source === "title-mention").length,
      orphans: orphans.length,
    },
  };
}

function relativeMarkdownLink(fromPath, targetPath) {
  const fromDir = path.posix.dirname(slash(fromPath));
  let relative = path.posix.relative(fromDir === "." ? "" : fromDir, slash(targetPath));
  if (!relative) relative = path.posix.basename(targetPath);
  return encodeURI(relative);
}

function relativeWikilinkTarget(fromPath, targetPath) {
  const fromDir = path.posix.dirname(slash(fromPath));
  let relative = path.posix.relative(fromDir === "." ? "" : fromDir, slash(targetPath));
  if (!relative) relative = path.posix.basename(targetPath);
  return relative.replace(/\.md$/i, "");
}

function obsidianLink(fromPath, target, fallbackId) {
  const targetPath = target?.relativePath;
  const linkTarget = targetPath
    ? relativeWikilinkTarget(fromPath, targetPath)
    : String(fallbackId || "").replace(/\.md$/i, "");
  const title = String(target?.title || fallbackId || linkTarget).replace(/[\]|]/g, " ").trim();
  return `[[${linkTarget}|${title}]]`;
}

function renderRelatedConcepts(text, fromPath, outgoing, incoming, conceptById) {
  const base = stripGeneratedLinks(text).trimEnd();
  if (!outgoing.length && !incoming.length) return `${base}\n`;
  const sections = [];
  if (outgoing.length) {
    sections.push(
      "### Outgoing",
      "",
      ...outgoing.map((relationship) => {
        const target = conceptById.get(relationship.to);
        return `- ${obsidianLink(fromPath, target, relationship.to)} - ${predicateLabel(relationship.predicate)}`;
      })
    );
  }
  if (incoming.length) {
    if (sections.length) sections.push("");
    sections.push(
      "### Backlinks",
      "",
      ...incoming.map((relationship) => {
        const source = conceptById.get(relationship.from);
        return `- ${obsidianLink(fromPath, source, relationship.from)} - incoming: ${predicateLabel(relationship.predicate)}`;
      })
    );
  }
  return `${base}\n\n## Related Concepts\n\n<!-- okf-rag:auto-links:start -->\n${sections.join("\n")}\n<!-- okf-rag:auto-links:end -->\n`;
}

function applyRelationshipGraph(entries, graph, upsertFrontmatter) {
  const conceptById = new Map(graph.concepts.map((concept) => [concept.canonicalId, concept]));
  const conceptByPath = new Map(graph.concepts.map((concept) => [concept.relativePath, concept]));
  const outbound = new Map(graph.concepts.map((concept) => [concept.canonicalId, []]));
  const inbound = new Map(graph.concepts.map((concept) => [concept.canonicalId, []]));
  for (const relationship of graph.relationships) {
    outbound.get(relationship.from).push(relationship);
    inbound.get(relationship.to).push(relationship);
  }
  return entries.map((entry) => {
    const relativePath = slash(entry.relativePath);
    const canonicalId = conceptByPath.get(relativePath)?.canonicalId;
    if (!canonicalId) return entry;
    const outgoing = outbound.get(canonicalId) || [];
    const incoming = inbound.get(canonicalId) || [];
    const compactOutbound = outgoing.map(
      (relationship) => `${relationship.predicate}|${relationship.to}`
    );
    const compactInbound = incoming.map(
      (relationship) => `${relationship.predicate}|${relationship.from}`
    );
    const withMetadata = upsertFrontmatter(entry.text, {
      outbound_relations: JSON.stringify(compactOutbound),
      inbound_relations: JSON.stringify(compactInbound),
    });
    return {
      ...entry,
      text: renderRelatedConcepts(
        withMetadata,
        relativePath,
        outgoing,
        incoming,
        conceptById
      ),
    };
  });
}

module.exports = {
  applyRelationshipGraph,
  buildRelationshipGraph,
  inferPredicate,
  predicateLabel,
  resolveMarkdownTarget,
  stripGeneratedLinks,
};
