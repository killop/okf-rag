const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildLlmwikiConceptCatalog,
  copyDir,
  managedBundleComplete,
  pruneStaleProjectConcepts,
  syncMarkdownSources,
  syncOkfBundle,
} = require("./compile_okf_with_llmwiki.js");

function tempRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `okf-rag-${name}-`));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function hash(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function concept(title, body = "Shared deterministic body for exact duplicate reconciliation.") {
  return `---\ntype: Reference\ntitle: ${title}\ndescription: Shared concept description that is deliberately long enough for identity.\n---\n\n# Details\n\n${body}\n`;
}

test("catalog maps llmwiki source ownership and prunes only previously managed stale concepts", () => {
  const root = tempRoot("catalog");
  try {
    const projectDir = path.join(root, ".okf-rag", "llmwiki-projects", "bundle");
    const manifestPath = path.join(root, ".okf-rag", "llmwiki-sync", "bundle.json");
    const sourceManifestPath = path.join(root, ".okf-rag", "llmwiki-source-sync", "bundle.json");
    writeJson(path.join(projectDir, ".llmwiki", "state.json"), {
      version: 1,
      sources: { "guide-a1.md": { hash: "a", concepts: ["keep"] } },
      frozenSlugs: [],
    });
    writeJson(sourceManifestPath, {
      files: [{ destination: "guide-a1.md", sourceKey: "file:E:/docs/guide.md" }],
    });
    writeJson(manifestPath, {
      schemaVersion: 1,
      files: [
        { relativePath: "concepts/keep.md", hash: "keep" },
        { relativePath: "concepts/stale.md", hash: "stale" },
      ],
    });
    write(path.join(projectDir, "wiki", "concepts", "keep.md"), concept("Keep"));
    write(path.join(projectDir, "wiki", "concepts", "stale.md"), concept("Stale"));
    write(path.join(projectDir, "wiki", "concepts", "manual.md"), concept("Manual"));

    const catalog = buildLlmwikiConceptCatalog({ projectDir, manifestPath, sourceManifestPath });
    const removed = pruneStaleProjectConcepts(projectDir, catalog);

    assert.deepEqual(removed, ["stale"]);
    assert.deepEqual([...catalog.owners.get("keep")], ["file:E:/docs/guide.md"]);
    assert.equal(fs.existsSync(path.join(projectDir, "wiki", "concepts", "keep.md")), true);
    assert.equal(fs.existsSync(path.join(projectDir, "wiki", "concepts", "stale.md")), false);
    assert.equal(fs.existsSync(path.join(projectDir, "wiki", "concepts", "manual.md")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fast-skip bundle validation rejects partially deleted managed output", () => {
  const root = tempRoot("fast-skip-files");
  try {
    const bundle = path.join(root, "okfs", "bundle");
    write(path.join(bundle, "index.md"), "# Bundle\n");
    write(path.join(bundle, "concepts", "alpha.md"), concept("Alpha"));
    const manifest = {
      files: [
        { relativePath: "index.md" },
        { relativePath: "concepts/alpha.md" },
      ],
    };

    assert.equal(managedBundleComplete(bundle, manifest), true);
    fs.rmSync(path.join(bundle, "concepts", "alpha.md"), { force: true });
    assert.equal(managedBundleComplete(bundle, manifest), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("atomic publish deduplicates exact concepts and archives modified stale generated files", () => {
  const root = tempRoot("publish");
  try {
    const exportDir = path.join(root, ".okf-rag", "llmwiki-exports", "bundle");
    const targetBundleDir = path.join(root, "okf-rag-workspace", "okfs", "bundle");
    const manifestPath = path.join(root, ".okf-rag", "llmwiki-sync", "bundle.json");
    const a = concept("Same Concept");
    const b = concept("Same Concept");
    const oldStale = concept("Old Stale", "old generated content");
    const modifiedStale = concept("Old Stale", "user modified content");
    write(path.join(exportDir, "concepts", "alpha.md"), a);
    write(path.join(exportDir, "concepts", "beta.md"), b);
    write(path.join(exportDir, "log.md"), "# Log\n");
    write(path.join(targetBundleDir, "concepts", "stale.md"), modifiedStale);
    writeJson(manifestPath, {
      schemaVersion: 1,
      files: [{ relativePath: "concepts/stale.md", hash: hash(oldStale) }],
    });
    const owners = new Map([
      ["alpha", new Set(["file:a.md"])],
      ["beta", new Set(["file:b.md"])],
    ]);
    const result = syncOkfBundle({
      root,
      exportDir,
      targetBundleDir,
      manifestPath,
      bundle: "bundle",
      force: false,
      dryRun: false,
      addRecallFields: true,
      deterministicDedupe: true,
      atomicPublish: true,
      conceptCatalog: {
        authoritative: true,
        desiredSlugs: new Set(["alpha", "beta"]),
        owners,
        previousAliases: {},
        summary: { authoritative: true, desiredConcepts: 2 },
      },
    });

    const publishedConcepts = fs
      .readdirSync(path.join(targetBundleDir, "concepts"))
      .filter((name) => name.endsWith(".md"));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const recovered = path.join(targetBundleDir, "references", "recovered", result.generation.id);

    assert.equal(publishedConcepts.length, 1);
    assert.equal(fs.existsSync(path.join(targetBundleDir, "index.md")), true);
    assert.equal(fs.existsSync(path.join(targetBundleDir, "concepts", "stale.md")), false);
    assert.equal(fs.readdirSync(recovered).length, 1);
    assert.equal(manifest.schemaVersion, 3);
    assert.equal(manifest.concepts.length, 1);
    assert.equal(Object.keys(manifest.catalog.aliases).length, 1);
    assert.equal(result.generation.atomic, true);
    assert.equal(
      fs.existsSync(path.join(root, "okf-rag-workspace", "okfs", "index.md")),
      true
    );
    assert.equal(
      fs.existsSync(path.join(root, "okf-rag-workspace", "index.md")),
      false
    );
    assert.match(
      fs.readFileSync(path.join(targetBundleDir, "index.md"), "utf8"),
      /^---\r?\nokf_version: "0\.1"\r?\n---/
    );
    const published = fs.readFileSync(
      path.join(targetBundleDir, "concepts", publishedConcepts[0]),
      "utf8"
    );
    assert.doesNotMatch(published, /file:[A-Za-z]:[\\/]/i);
    assert.match(published, /source_refs: \["okf-source:\/\/bundle\/(?:a|b)\.md"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("publishes directed semantic relationships into Markdown, manifest, and frontmatter", () => {
  const root = tempRoot("relationships");
  try {
    const exportDir = path.join(root, ".okf-rag", "llmwiki-exports", "bundle");
    const targetBundleDir = path.join(root, "okf-rag-workspace", "okfs", "bundle");
    const manifestPath = path.join(root, ".okf-rag", "llmwiki-sync", "bundle.json");
    write(
      path.join(exportDir, "concepts", "runtime.md"),
      concept(
        "Runtime",
        "Runtime depends on [Package Manifest](/concepts/package-manifest.md) before startup.\n\n# Citations\n\n[1] [Runtime source](../references/runtime-source.md)"
      )
    );
    write(
      path.join(exportDir, "concepts", "package-manifest.md"),
      concept("Package Manifest", "Manifest state is loaded during startup.")
    );
    write(
      path.join(exportDir, "references", "runtime-source.md"),
      "---\ntitle: Runtime source\nsource: \"file:E:/private/runtime.md\"\nx-okf-rag-source-path: \"E:/private/runtime.md\"\nx-okf-rag-relative-path: \"runtime.md\"\n---\n\nRuntime source.\n"
    );

    syncOkfBundle({
      root,
      exportDir,
      targetBundleDir,
      manifestPath,
      bundle: "bundle",
      force: false,
      dryRun: false,
      addRecallFields: true,
      deterministicDedupe: true,
      atomicPublish: true,
      writeLinks: true,
      conceptCatalog: {
        authoritative: false,
        owners: new Map(),
        previousAliases: {},
        summary: { authoritative: false },
      },
    });

    const runtime = fs.readFileSync(
      path.join(targetBundleDir, "concepts", "runtime.md"),
      "utf8"
    );
    const packageManifest = fs.readFileSync(
      path.join(targetBundleDir, "concepts", "package-manifest.md"),
      "utf8"
    );
    const reference = fs.readFileSync(
      path.join(targetBundleDir, "references", "runtime-source.md"),
      "utf8"
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.match(runtime, /outbound_relations: \["depends_on\|bundle\/concepts\/package-manifest"\]/);
    assert.match(runtime, /inbound_relations: \[\]/);
    assert.match(runtime, /source_refs: \["\.\.\/references\/runtime-source\.md"\]/);
    assert.match(runtime, /\[\[package-manifest\|Package Manifest\]\] - depends on/);
    assert.match(packageManifest, /inbound_relations: \["depends_on\|bundle\/concepts\/runtime"\]/);
    assert.match(packageManifest, /\[\[runtime\|Runtime\]\] - incoming: depends on/);
    assert.match(reference, /source: "okf-source:\/\/bundle\/runtime\.md"/);
    assert.doesNotMatch(reference, /x-okf-rag-source-path:/);
    assert.doesNotMatch(reference, /(^|[^A-Za-z0-9+.-])(?:file:)?[A-Za-z]:[\\/]/m);
    assert.equal(manifest.relationships.length, 1);
    assert.equal(manifest.relationships[0].predicate, "depends_on");
    assert.equal(manifest.generation.relationCount, 1);
    assert.equal(manifest.concepts.find((item) => item.slug === "package-manifest").inboundRelations.length, 1);
    assert.equal(
      manifest.relationships.some(
        (relationship) => relationship.from === "bundle/concepts/package-manifest"
      ),
      false
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a staged bundle with a broken local Markdown link", () => {
  const root = tempRoot("broken-link");
  try {
    const exportDir = path.join(root, ".okf-rag", "llmwiki-exports", "bundle");
    const targetBundleDir = path.join(root, "okf-rag-workspace", "okfs", "bundle");
    const manifestPath = path.join(root, ".okf-rag", "llmwiki-sync", "bundle.json");
    write(
      path.join(exportDir, "concepts", "runtime.md"),
      concept("Runtime", "Runtime uses [Missing](missing.md).")
    );

    assert.throws(
      () =>
        syncOkfBundle({
          root,
          exportDir,
          targetBundleDir,
          manifestPath,
          bundle: "bundle",
          force: false,
          dryRun: false,
          addRecallFields: true,
          deterministicDedupe: true,
          atomicPublish: true,
          writeLinks: true,
          conceptCatalog: {
            authoritative: false,
            owners: new Map(),
            previousAliases: {},
            summary: { authoritative: false },
          },
        }),
      /staged Markdown link is broken/
    );
    assert.equal(fs.existsSync(targetBundleDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a staged OKF bundle that leaks a host absolute path", () => {
  const root = tempRoot("absolute-path");
  try {
    const exportDir = path.join(root, ".okf-rag", "llmwiki-exports", "bundle");
    const targetBundleDir = path.join(root, "okf-rag-workspace", "okfs", "bundle");
    const manifestPath = path.join(root, ".okf-rag", "llmwiki-sync", "bundle.json");
    write(
      path.join(exportDir, "concepts", "runtime.md"),
      concept("Runtime", "Private evidence was read from E:\\private\\runtime.md.")
    );

    assert.throws(
      () =>
        syncOkfBundle({
          root,
          exportDir,
          targetBundleDir,
          manifestPath,
          bundle: "bundle",
          force: false,
          dryRun: false,
          addRecallFields: true,
          deterministicDedupe: true,
          atomicPublish: true,
          writeLinks: true,
          conceptCatalog: {
            authoritative: false,
            owners: new Map(),
            previousAliases: {},
            summary: { authoritative: false },
          },
        }),
      /host absolute path/
    );
    assert.equal(fs.existsSync(targetBundleDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("source manifest v2 records stable adapter ownership and ignores mtime-only touches", () => {
  const root = tempRoot("source-manifest");
  try {
    const sourceRoot = path.join(root, "docs");
    const sourcePath = path.join(sourceRoot, "guide.md");
    const projectDir = path.join(root, ".okf-rag", "llmwiki-projects", "bundle");
    const manifestPath = path.join(root, ".okf-rag", "llmwiki-source-sync", "bundle.json");
    write(sourcePath, "# Guide\n\nStable content.\n");

    const first = syncMarkdownSources({
      bundle: "bundle",
      files: [sourcePath],
      roots: [sourceRoot],
      projectDir,
      manifestPath,
      prune: true,
      force: false,
    });
    const firstManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const destinationPath = path.join(projectDir, "sources", firstManifest.files[0].destination);
    const compilerSourceBefore = fs.readFileSync(destinationPath, "utf8");
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(sourcePath, future, future);

    const second = syncMarkdownSources({
      bundle: "bundle",
      files: [sourcePath],
      roots: [sourceRoot],
      projectDir,
      manifestPath,
      prune: true,
      force: false,
    });
    const secondManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    assert.equal(first.created, 1);
    assert.equal(second.unchanged, 1);
    assert.equal(secondManifest.schemaVersion, 2);
    assert.equal(secondManifest.instances[0].adapter, "markdown-directory");
    assert.match(secondManifest.files[0].sourceInstanceId, /^markdown:/);
    assert.equal(
      secondManifest.files[0].sourceContentHash,
      firstManifest.files[0].sourceContentHash
    );
    assert.equal(fs.readFileSync(destinationPath, "utf8"), compilerSourceBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace mirror updates changed files and removes stale target files", () => {
  const root = tempRoot("mirror");
  try {
    const source = path.join(root, "source", "okf-rag-workspace");
    const target = path.join(root, "target", "okf-rag-workspace");
    write(path.join(source, "bin", "okf-rag.exe"), "new-runtime");
    write(path.join(source, "okfs", "bundle", "index.md"), "# Bundle\n");
    write(path.join(target, "bin", "okf-rag.exe"), "old-runtime");
    write(path.join(target, "okfs", "stale.md"), "stale\n");

    const result = copyDir(source, target);

    assert.equal(fs.readFileSync(path.join(target, "bin", "okf-rag.exe"), "utf8"), "new-runtime");
    assert.equal(fs.existsSync(path.join(target, "okfs", "stale.md")), false);
    assert.equal(fs.existsSync(path.join(target, "okfs", "bundle", "index.md")), true);
    assert.equal(result.copied >= 2, true);
    assert.equal(result.deleted >= 1, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
