#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { inferPredicate, predicateLabel } = require("./okf_relationships.js");

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    writeIndex: false,
    writeLinks: false,
    rootIndex: false,
    json: false,
    failOnDuplicates: false,
    minLinkScore: 4,
    maxLinks: 6,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[++i];
      if (!value) throw new Error("--root requires a directory");
      args.root = path.resolve(value);
    } else if (arg === "--write-index") {
      args.writeIndex = true;
    } else if (arg === "--write-links") {
      args.writeLinks = true;
    } else if (arg === "--root-index") {
      args.rootIndex = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--fail-on-duplicates") {
      args.failOnDuplicates = true;
    } else if (arg === "--min-link-score") {
      const value = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(value) || value < 1) {
        throw new Error("--min-link-score requires a positive integer");
      }
      args.minLinkScore = value;
    } else if (arg === "--max-links") {
      const value = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(value) || value < 1) {
        throw new Error("--max-links requires a positive integer");
      }
      args.maxLinks = value;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`okf_maintain

Usage:
  node scripts/okf_maintain.js --root .
  node scripts/okf_maintain.js --root . --write-index
  node scripts/okf_maintain.js --root . --write-links --write-index

Options:
  --root DIR              Workspace root. Defaults to current directory.
  --write-index           Refresh index.md files inside topic folders.
  --write-links           Refresh generated Related Concepts blocks.
  --root-index            Also allow okfs/index.md when --write-index is set.
  --min-link-score N      Minimum score for generated links. Defaults to 4.
  --max-links N           Maximum generated related links per concept. Defaults to 6.
  --json                  Print machine-readable JSON.
  --fail-on-duplicates    Exit non-zero when likely duplicates are found.

Notes:
  - Concept truth is scanned under okf-rag-workspace/okfs.
  - index.md and log.md are reserved and are not treated as concepts.
  - --write-index does not create a root index unless --root-index is also set.
  - --write-links writes Obsidian wikilinks plus outgoing/incoming relation metadata in a generated Related Concepts block.
`);
}

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDirectoryName(entry.name)) continue;
      walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function shouldSkipDirectoryName(name) {
  return [".git", ".okf-rag", "target", "third_party", "references"].includes(name);
}

function directDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !shouldSkipDirectoryName(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

function directMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

function isReservedMarkdown(file) {
  const name = path.basename(file).toLowerCase();
  return name === "index.md" || name === "log.md";
}

function slash(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function titleCaseSlug(slug) {
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[`"'’‘“”()[\]{}]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripAutoLinksBlock(body) {
  return String(body || "")
    .replace(
      /\n*## Related Concepts\s*\n\s*<!-- okf-rag:auto-links:start -->[\s\S]*?<!-- okf-rag:auto-links:end -->\s*/gm,
      "\n"
    )
    .trim();
}

function hashText(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function parseInlineList(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return trimmed ? [unquote(trimmed)] : [];
  }
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((item) => unquote(item.trim()))
    .filter(Boolean);
}

function unquote(value) {
  let text = String(value || "").trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1);
  }
  return text;
}

function parseFrontmatter(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0] !== "---") {
    return { frontmatter: null, body: text, error: "missing frontmatter" };
  }

  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  if (end < 0) {
    return { frontmatter: null, body: text, error: "unterminated frontmatter" };
  }

  const frontmatterLines = lines.slice(1, end);
  const body = lines.slice(end + 1).join("\n").trim();
  const frontmatter = {};
  let listKey = null;

  for (const rawLine of frontmatterLines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (listKey && line.startsWith("- ")) {
      frontmatter[listKey].push(unquote(line.slice(2).trim()));
      continue;
    }

    listKey = null;
    const splitAt = line.indexOf(":");
    if (splitAt < 0) continue;

    const key = line.slice(0, splitAt).trim();
    const value = line.slice(splitAt + 1).trim();
    if (!key) continue;

    if (!value) {
      frontmatter[key] = [];
      listKey = key;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      frontmatter[key] = parseInlineList(value);
    } else {
      frontmatter[key] = unquote(value);
    }
  }

  return { frontmatter, body, error: null };
}

function conceptFromFile(okfsDir, file) {
  const text = fs.readFileSync(file, "utf8");
  const parsed = parseFrontmatter(text);
  const rel = slash(path.relative(okfsDir, file));
  const fm = parsed.frontmatter || {};
  const stableBody = stripAutoLinksBlock(parsed.body);
  const title =
    typeof fm.title === "string" && fm.title.trim()
      ? fm.title.trim()
      : titleCaseSlug(path.basename(file, ".md"));

  return {
    path: rel,
    absPath: file,
    directory: slash(path.dirname(rel)),
    type: typeof fm.type === "string" ? fm.type.trim() : "",
    title,
    description: typeof fm.description === "string" ? fm.description.trim() : "",
    resource: typeof fm.resource === "string" ? fm.resource.trim() : "",
    uri: typeof fm.uri === "string" ? fm.uri.trim() : "",
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    contentHash: hashText(normalizeText(stableBody)),
    frontmatter: fm,
    body: stableBody,
    error: parsed.error,
  };
}

function addGroup(groups, kind, key, concept, severity) {
  if (!key) return;
  const mapKey = `${kind}:${key}`;
  if (!groups.has(mapKey)) {
    groups.set(mapKey, { kind, key, severity, concepts: [] });
  }
  groups.get(mapKey).concepts.push(concept.path);
}

function duplicateGroups(concepts) {
  const groups = new Map();
  for (const concept of concepts) {
    addGroup(groups, "uri", concept.uri.toLowerCase(), concept, "strong");
    addGroup(groups, "resource", concept.resource.toLowerCase(), concept, "strong");
    addGroup(groups, "content", concept.contentHash, concept, "strong");
    addGroup(
      groups,
      "title-type",
      `${normalizeText(concept.type)}|${normalizeText(concept.title)}`,
      concept,
      "review"
    );
  }

  return Array.from(groups.values())
    .filter((group) => new Set(group.concepts).size > 1)
    .map((group) => ({
      ...group,
      concepts: Array.from(new Set(group.concepts)).sort(),
    }))
    .sort((a, b) => {
      const severity = a.severity.localeCompare(b.severity);
      if (severity !== 0) return severity;
      return a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key);
    });
}

function hasConceptDescendants(dir) {
  if (path.basename(dir) === "references") return false;
  return walkFiles(dir).some(
    (file) => file.toLowerCase().endsWith(".md") && !isReservedMarkdown(file)
  );
}

function indexEntryForConcept(okfsDir, file) {
  const concept = conceptFromFile(okfsDir, file);
  const label = concept.title || titleCaseSlug(path.basename(file, ".md"));
  const description = concept.description || `${label} concept.`;
  return `* [${label}](${encodeURI(path.basename(file))}) - ${description}`;
}

function firstIndexDescription(indexPath) {
  if (!fs.existsSync(indexPath)) return "";
  const text = fs.readFileSync(indexPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("* ")) continue;
    return line;
  }
  return "";
}

function indexEntryForDirectory(dir) {
  const label = titleCaseSlug(path.basename(dir));
  const description = firstIndexDescription(path.join(dir, "index.md")) || "Nested OKF bundle.";
  return `* [${label}](${encodeURI(path.basename(dir))}/) - ${description}`;
}

function buildIndex(okfsDir, dir) {
  const entries = [];
  for (const file of directMarkdownFiles(dir).filter((file) => !isReservedMarkdown(file))) {
    entries.push(indexEntryForConcept(okfsDir, file));
  }
  for (const subdir of directDirs(dir).filter(hasConceptDescendants)) {
    entries.push(indexEntryForDirectory(subdir));
  }

  if (entries.length === 0) return null;
  const isCatalogRoot = path.resolve(dir) === path.resolve(okfsDir);
  const title = isCatalogRoot ? "OKF Knowledge Bundles" : titleCaseSlug(path.basename(dir));
  const isBundleRoot = path.resolve(path.dirname(dir)) === path.resolve(okfsDir);
  const frontmatter = isBundleRoot ? '---\nokf_version: "0.1"\n---\n\n' : "";
  return `${frontmatter}# ${title}\n\n${entries.join("\n")}\n`;
}

function refreshIndexes(okfsDir, allowRootIndex) {
  const dirs = Array.from(
    new Set(walkFiles(okfsDir).map((file) => path.dirname(file)).concat([okfsDir]))
  ).sort((a, b) => b.length - a.length);

  const results = [];
  for (const dir of dirs) {
    const isRoot = path.resolve(dir) === path.resolve(okfsDir);
    if (isRoot && !allowRootIndex) continue;
    if (!hasConceptDescendants(dir)) continue;

    const next = buildIndex(okfsDir, dir);
    if (!next) continue;

    const indexPath = path.join(dir, "index.md");
    const previous = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : "";
    if (previous !== next) {
      fs.writeFileSync(indexPath, next, "utf8");
      results.push({ path: slash(path.relative(okfsDir, indexPath)), status: "written" });
    } else {
      results.push({ path: slash(path.relative(okfsDir, indexPath)), status: "unchanged" });
    }
  }

  return results.sort((a, b) => a.path.localeCompare(b.path));
}

const COMMON_LINK_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "this",
  "to",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "okf",
  "rag",
  "memory",
  "knowledge",
  "concept",
  "reference",
]);

const COMMON_TAGS = new Set(["okf", "memory", "knowledge", "reference"]);

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function splitWords(value) {
  return normalizeText(value)
    .split(" ")
    .map((word) => word.trim())
    .filter((word) => word.length > 2 && !COMMON_LINK_WORDS.has(word));
}

function conceptKeywords(concept) {
  const uriParts = `${concept.uri} ${concept.resource}`.replace(/[/:#?=&._-]+/g, " ");
  return new Set(
    unique([
      ...splitWords(concept.title),
      ...splitWords(concept.description),
      ...concept.tags.flatMap(splitWords),
      ...splitWords(uriParts),
    ])
  );
}

function conceptTextForMentions(concept) {
  return normalizeText(
    `${concept.title}\n${concept.description}\n${concept.tags.join(" ")}\n${concept.body}`
  );
}

function resourcePrefix(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  const parts = text.split(/[/?#]/)[0].split("/").filter(Boolean);
  if (parts.length <= 2) return "";
  return parts.slice(0, -1).join("/");
}

function isNestedDirectory(a, b) {
  if (!a || !b || a === "." || b === ".") return false;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function markdownLinkTargets(body) {
  const targets = [];
  const re = /\[[^\]]+\]\(([^)]+)\)/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    targets.push(decodeURI(match[1].split("#")[0]));
  }
  return targets;
}

function normalizedTargetPath(fromConcept, target) {
  if (!target || /^[a-z]+:\/\//i.test(target) || target.startsWith("#")) return "";
  if (target.startsWith("/")) return slash(target.slice(1));
  const fromDir = fromConcept.directory === "." ? "" : fromConcept.directory;
  return path.posix.normalize(path.posix.join(fromDir, target));
}

function alreadyLinksTo(fromConcept, toConcept) {
  return markdownLinkTargets(fromConcept.body).some(
    (target) => normalizedTargetPath(fromConcept, target) === toConcept.path
  );
}

function relativeConceptLink(fromConcept, toConcept) {
  const fromDir = fromConcept.directory === "." ? "" : fromConcept.directory;
  let rel = path.posix.relative(fromDir, toConcept.path);
  if (!rel) rel = path.posix.basename(toConcept.path);
  return encodeURI(rel);
}

function scoreDirectedLink(fromConcept, toConcept, keywordCache) {
  const reasons = [];
  let score = 0;
  let semanticEvidence = false;
  let predicate = "references";

  if (alreadyLinksTo(fromConcept, toConcept)) {
    score += 8;
    semanticEvidence = true;
    predicate = inferPredicate(fromConcept.body);
    reasons.push(`${predicateLabel(predicate)} (existing link)`);
  }

  const targetTitle = normalizeText(toConcept.title);
  const sourceText = conceptTextForMentions(fromConcept);
  if (targetTitle && targetTitle.length >= 4 && sourceText.includes(targetTitle)) {
    score += 8;
    semanticEvidence = true;
    const titleIndex = sourceText.indexOf(targetTitle);
    const context = sourceText.slice(Math.max(0, titleIndex - 100), titleIndex + targetTitle.length + 100);
    predicate = inferPredicate(context);
    reasons.push(`${predicateLabel(predicate)} (title mention)`);
  }

  const fromTags = new Set(
    fromConcept.tags.map((tag) => normalizeText(tag)).filter((tag) => tag && !COMMON_TAGS.has(tag))
  );
  const toTags = new Set(
    toConcept.tags.map((tag) => normalizeText(tag)).filter((tag) => tag && !COMMON_TAGS.has(tag))
  );
  const sharedTags = Array.from(fromTags).filter((tag) => toTags.has(tag)).sort();
  if (sharedTags.length > 0) {
    score += Math.min(sharedTags.length * 3, 6);
    reasons.push(`shared tags: ${sharedTags.slice(0, 3).join(", ")}`);
  }

  if (fromConcept.directory !== "." && fromConcept.directory === toConcept.directory) {
    score += 4;
    reasons.push("same topic folder");
  } else if (isNestedDirectory(fromConcept.directory, toConcept.directory)) {
    score += 2;
    reasons.push("nearby folder");
  }

  const fromPrefix = resourcePrefix(fromConcept.uri || fromConcept.resource);
  const toPrefix = resourcePrefix(toConcept.uri || toConcept.resource);
  if (fromPrefix && toPrefix && fromPrefix === toPrefix) {
    score += 3;
    reasons.push("same uri/resource prefix");
  }

  const fromKeywords = keywordCache.get(fromConcept.path);
  const toKeywords = keywordCache.get(toConcept.path);
  const sharedKeywords = Array.from(fromKeywords)
    .filter((word) => toKeywords.has(word))
    .sort();
  if (sharedKeywords.length > 0) {
    score += Math.min(sharedKeywords.length, 4);
    reasons.push(`shared terms: ${sharedKeywords.slice(0, 4).join(", ")}`);
  }

  return {
    score,
    reasons: unique(reasons),
    semanticEvidence,
    predicate,
  };
}

function buildLinkSuggestions(concepts, minScore, maxLinks) {
  const keywordCache = new Map(concepts.map((concept) => [concept.path, conceptKeywords(concept)]));
  const suggestions = new Map(concepts.map((concept) => [concept.path, []]));

  for (let i = 0; i < concepts.length; i += 1) {
    for (let j = i + 1; j < concepts.length; j += 1) {
      const a = concepts[i];
      const b = concepts[j];
      const ab = scoreDirectedLink(a, b, keywordCache);
      const ba = scoreDirectedLink(b, a, keywordCache);
      if (ab.semanticEvidence && ab.score >= minScore) {
        suggestions.get(a.path).push({
          path: b.path,
          title: b.title,
          href: relativeConceptLink(a, b),
          score: ab.score,
          predicate: ab.predicate,
          reasons: ab.reasons,
        });
      }
      if (ba.semanticEvidence && ba.score >= minScore) {
        suggestions.get(b.path).push({
          path: a.path,
          title: a.title,
          href: relativeConceptLink(b, a),
          score: ba.score,
          predicate: ba.predicate,
          reasons: ba.reasons,
        });
      }
    }
  }

  const result = {};
  for (const [conceptPath, links] of suggestions) {
    const ranked = links
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, maxLinks)
      .map((link) => ({
        ...link,
        reasons: link.reasons.slice(0, 3),
      }));
    if (ranked.length > 0) {
      result[conceptPath] = ranked;
    }
  }
  return result;
}

function splitFrontmatterRaw(text) {
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!match) return { prefix: "", body: text };
  return { prefix: match[0], body: text.slice(match[0].length) };
}

function upsertInlineFrontmatter(text, key, values) {
  const lines = String(text || "").split(/\r?\n/);
  if (lines[0] !== "---") return text;
  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  if (end < 0) return text;
  const kept = lines
    .slice(1, end)
    .filter((line) => !new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`).test(line));
  return ["---", ...kept, `${key}: ${JSON.stringify(values)}`, ...lines.slice(end)].join("\n");
}

function obsidianLink(link) {
  let target = String(link.href || link.path || "");
  try {
    target = decodeURI(target);
  } catch {
    // Keep the original target when it is not URI encoded.
  }
  target = target.replace(/\.md(?=#|$)/i, "");
  const title = String(link.title || link.path || target).replace(/[\]|]/g, " ").trim();
  return `[[${target}|${title}]]`;
}

function relatedLinksBlock(outgoing, incoming) {
  if ((!outgoing || outgoing.length === 0) && (!incoming || incoming.length === 0)) return "";
  const sections = [];
  if (outgoing?.length) {
    sections.push(
      "### Outgoing",
      "",
      ...outgoing.map(
        (link) => `- ${obsidianLink(link)} - ${predicateLabel(link.predicate || "references")}`
      )
    );
  }
  if (incoming?.length) {
    if (sections.length) sections.push("");
    sections.push(
      "### Backlinks",
      "",
      ...incoming.map(
        (link) =>
          `- ${obsidianLink(link)} - incoming: ${predicateLabel(link.predicate || "references")}`
      )
    );
  }
  return [
    "## Related Concepts",
    "",
    "<!-- okf-rag:auto-links:start -->",
    ...sections,
    "<!-- okf-rag:auto-links:end -->",
  ].join("\n");
}

function replaceAutoLinks(body, outgoing, incoming) {
  const block = relatedLinksBlock(outgoing, incoming);
  const autoBlock =
    /\n*## Related Concepts\s*\n\s*<!-- okf-rag:auto-links:start -->[\s\S]*?<!-- okf-rag:auto-links:end -->\s*/m;

  if (autoBlock.test(body)) {
    if (!block) return body.replace(autoBlock, "\n").trimEnd() + "\n";
    return body.replace(autoBlock, `\n\n${block}\n`);
  }

  if (!block) return body;

  const retrievalNotes = body.search(/\n## Retrieval Notes\b/);
  if (retrievalNotes >= 0) {
    return `${body.slice(0, retrievalNotes).trimEnd()}\n\n${block}\n${body.slice(retrievalNotes)}`;
  }
  return `${body.trimEnd()}\n\n${block}\n`;
}

function refreshLinks(concepts, linkSuggestions) {
  const results = [];
  const conceptsByPath = new Map(concepts.map((concept) => [concept.path, concept]));
  const incomingByPath = new Map(concepts.map((concept) => [concept.path, []]));
  for (const [sourcePath, links] of Object.entries(linkSuggestions)) {
    const source = conceptsByPath.get(sourcePath);
    if (!source) continue;
    for (const link of links) {
      const target = conceptsByPath.get(link.path);
      if (!target) continue;
      incomingByPath.get(target.path).push({
        path: source.path,
        title: source.title,
        href: relativeConceptLink(target, source),
        predicate: link.predicate || "references",
        reasons: link.reasons || [],
      });
    }
  }
  for (const concept of concepts) {
    const links = linkSuggestions[concept.path] || [];
    const incoming = incomingByPath.get(concept.path) || [];
    const text = fs.readFileSync(concept.absPath, "utf8");
    const outboundRelations = links.map((link) => {
      const target = conceptsByPath.get(link.path);
      const targetId =
        typeof target?.frontmatter?.canonical_id === "string"
          ? target.frontmatter.canonical_id
          : String(link.path).replace(/\.md$/i, "");
      return `${link.predicate || "references"}|${targetId}`;
    });
    const inboundRelations = incoming.map((link) => {
      const source = conceptsByPath.get(link.path);
      const sourceId =
        typeof source?.frontmatter?.canonical_id === "string"
          ? source.frontmatter.canonical_id
          : String(link.path).replace(/\.md$/i, "");
      return `${link.predicate || "references"}|${sourceId}`;
    });
    const withMetadata = upsertInlineFrontmatter(text, "outbound_relations", outboundRelations);
    const withBidirectionalMetadata = upsertInlineFrontmatter(
      withMetadata,
      "inbound_relations",
      inboundRelations
    );
    const parts = splitFrontmatterRaw(withBidirectionalMetadata);
    const nextBody = replaceAutoLinks(parts.body.trimEnd(), links, incoming);
    const next = `${parts.prefix}${nextBody.trimEnd()}\n`;
    if (next !== text) {
      fs.writeFileSync(concept.absPath, next, "utf8");
      results.push({
        path: concept.path,
        status: "written",
        links: links.length,
      });
    } else {
      results.push({
        path: concept.path,
        status: "unchanged",
        links: links.length,
      });
    }
  }
  return results;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const okfsDir = path.join(args.root, "okf-rag-workspace", "okfs");
  if (!fs.existsSync(okfsDir)) {
    throw new Error(`OKF source directory not found: ${okfsDir}`);
  }

  const conceptFiles = walkFiles(okfsDir)
    .filter((file) => file.toLowerCase().endsWith(".md"))
    .filter((file) => !isReservedMarkdown(file))
    .sort((a, b) => a.localeCompare(b));

  const concepts = conceptFiles.map((file) => conceptFromFile(okfsDir, file));
  const invalid = concepts
    .filter((concept) => concept.error || !concept.type)
    .map((concept) => ({
      path: concept.path,
      error: concept.error || "missing required type",
    }));
  const duplicates = duplicateGroups(concepts);
  const linkSuggestions = buildLinkSuggestions(concepts, args.minLinkScore, args.maxLinks);
  const linkWrites = args.writeLinks ? refreshLinks(concepts, linkSuggestions) : [];
  const indexes = args.writeIndex ? refreshIndexes(okfsDir, args.rootIndex) : [];

  const report = {
    root: args.root,
    okfs: okfsDir,
    conceptCount: concepts.length,
    invalid,
    duplicates,
    linkSuggestions,
    linkWrites,
    indexes,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`OKF concepts: ${report.conceptCount}`);
    console.log(`Invalid concepts: ${invalid.length}`);
    for (const item of invalid) {
      console.log(`  - ${item.path}: ${item.error}`);
    }

    console.log(`Duplicate groups: ${duplicates.length}`);
    for (const group of duplicates) {
      console.log(`  - ${group.severity} ${group.kind}: ${group.key}`);
      for (const conceptPath of group.concepts) {
        console.log(`    * ${conceptPath}`);
      }
    }

    const suggestedLinkCount = Object.values(linkSuggestions).reduce(
      (sum, links) => sum + links.length,
      0
    );
    console.log(`Link suggestions: ${suggestedLinkCount}`);
    for (const [conceptPath, links] of Object.entries(linkSuggestions)) {
      console.log(`  - ${conceptPath}`);
      for (const link of links) {
        console.log(`    * ${link.title} -> ${link.href} (${link.reasons.join("; ")})`);
      }
    }

    if (args.writeLinks) {
      const written = linkWrites.filter((item) => item.status === "written");
      console.log(
        `Links refreshed: ${written.length} written, ${linkWrites.length - written.length} unchanged`
      );
      for (const item of written) {
        console.log(`  - ${item.path} (${item.links} links)`);
      }
    } else {
      console.log("Links refreshed: 0 (use --write-links)");
    }

    if (args.writeIndex) {
      const written = indexes.filter((item) => item.status === "written");
      console.log(`Indexes refreshed: ${written.length} written, ${indexes.length - written.length} unchanged`);
      for (const item of written) {
        console.log(`  - ${item.path}`);
      }
    } else {
      console.log("Indexes refreshed: 0 (use --write-index)");
    }
  }

  if (invalid.length > 0 || (args.failOnDuplicates && duplicates.length > 0)) {
    process.exitCode = 2;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildLinkSuggestions,
  conceptFromFile,
  refreshIndexes,
  refreshLinks,
};
