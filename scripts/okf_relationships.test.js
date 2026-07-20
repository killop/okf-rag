const assert = require("node:assert/strict");
const test = require("node:test");

const {
  applyRelationshipGraph,
  buildRelationshipGraph,
} = require("./okf_relationships.js");

function concept(relativePath, title, body) {
  return {
    relativePath,
    text: `---\ntype: Reference\ntitle: ${title}\n---\n\n${body}\n`,
  };
}

function identity(entry) {
  const title = /^title:\s*(.+)$/m.exec(entry.text)?.[1] || entry.relativePath;
  return { title };
}

function upsertFrontmatter(text, fields) {
  const lines = text.split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  return [
    "---",
    ...lines.slice(1, end),
    ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`),
    ...lines.slice(end),
  ].join("\n");
}

test("builds one directed predicate edge from an explicit semantic link", () => {
  const entries = [
    concept(
      "concepts/runtime.md",
      "Runtime",
      "Runtime depends on [Package Manifest](package-manifest.md) before startup."
    ),
    concept("concepts/package-manifest.md", "Package Manifest", "Manifest data."),
  ];

  const graph = buildRelationshipGraph(entries, {
    bundle: "hot-update",
    identity,
    ownersBySlug: new Map(),
  });

  assert.equal(graph.relationships.length, 1);
  assert.deepEqual(
    {
      from: graph.relationships[0].from,
      predicate: graph.relationships[0].predicate,
      to: graph.relationships[0].to,
      source: graph.relationships[0].source,
    },
    {
      from: "hot-update/concepts/runtime",
      predicate: "depends_on",
      to: "hot-update/concepts/package-manifest",
      source: "explicit-markdown-link",
    }
  );
  assert.equal(
    graph.relationships.some(
      (relationship) => relationship.from === "hot-update/concepts/package-manifest"
    ),
    false
  );
});

test("publishes Obsidian-style outgoing links and backlinks with directional metadata", () => {
  const entries = [
    concept("concepts/producer.md", "Producer", "Producer generates [Catalog](catalog.md)."),
    concept("concepts/catalog.md", "Catalog", "Catalog state."),
  ];
  const graph = buildRelationshipGraph(entries, {
    bundle: "bundle",
    identity,
    ownersBySlug: new Map(),
  });
  const applied = applyRelationshipGraph(entries, graph, upsertFrontmatter);
  const producer = applied.find((entry) => entry.relativePath === "concepts/producer.md");
  const catalog = applied.find((entry) => entry.relativePath === "concepts/catalog.md");

  assert.match(producer.text, /outbound_relations: \["produces\|bundle\/concepts\/catalog"\]/);
  assert.match(producer.text, /inbound_relations: \[\]/);
  assert.match(producer.text, /\[\[catalog\|Catalog\]\] - produces/);
  assert.match(catalog.text, /outbound_relations: \[\]/);
  assert.match(catalog.text, /inbound_relations: \["produces\|bundle\/concepts\/producer"\]/);
  assert.match(catalog.text, /\[\[producer\|Producer\]\] - incoming: produces/);
});

test("recognizes an explicit Obsidian wikilink as a directed relationship", () => {
  const entries = [
    concept("concepts/runtime.md", "Runtime", "Runtime depends on [[package-manifest|Package Manifest]]."),
    concept("concepts/package-manifest.md", "Package Manifest", "Manifest data."),
  ];
  const graph = buildRelationshipGraph(entries, {
    bundle: "hot-update",
    identity,
    ownersBySlug: new Map(),
  });

  assert.equal(graph.relationships.length, 1);
  assert.equal(graph.relationships[0].predicate, "depends_on");
  assert.equal(graph.relationships[0].source, "explicit-wikilink");
});

test("shared ownership alone does not invent graph edges", () => {
  const entries = [
    concept("concepts/alpha.md", "Alpha", "Independent alpha behavior."),
    concept("concepts/beta.md", "Beta", "Independent beta behavior."),
  ];
  const graph = buildRelationshipGraph(entries, {
    bundle: "bundle",
    identity,
    ownersBySlug: new Map([
      ["alpha", new Set(["file:guide.md"])],
      ["beta", new Set(["file:guide.md"])],
    ]),
  });

  assert.equal(graph.relationships.length, 0);
  assert.deepEqual(graph.orphans, ["bundle/concepts/alpha", "bundle/concepts/beta"]);
});
