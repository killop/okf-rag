#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const {
  sanitizeDiagnosticText,
  sanitizeDiagnosticValue,
} = require("./diagnostics.js");
const {
  applyRelationshipGraph,
  buildRelationshipGraph,
  resolveMarkdownTarget,
} = require("./okf_relationships.js");
const {
  booleanFromEnv,
  loadProjectLlmwikiEnv,
  rootFromArgv,
} = require("./llmwiki_env.js");

const DEFAULT_LLMWIKI_PACKAGE = "llm-wiki-compiler@1.1.0";
const DEFAULT_NODE_PACKAGE = "node@24.16.0";
const DEFAULT_LLMWIKI_REPO = "";
const MAX_SOURCE_CHARS = 100_000;
const SOURCE_SKIP_DIRS = new Set([
  ".git",
  ".okf-rag",
  ".llmwiki",
  "node_modules",
  "target",
  "dist",
  "okf-rag-workspace",
]);
const PIPELINE_STATE_FILE = process.env.OKF_PIPELINE_STATE_FILE || "";

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    sources: [],
    bundle: "",
    project: "",
    exportDir: "",
    okfsDir: "",
    okfRagBin: process.env.OKF_RAG_BIN || "",
    llmwikiRoot: process.env.LLMWIKI_REPO || DEFAULT_LLMWIKI_REPO,
    llmwikiBin: process.env.LLMWIKI_BIN || "",
    llmwikiPackage: process.env.LLMWIKI_PACKAGE || DEFAULT_LLMWIKI_PACKAGE,
    nodePackage: process.env.LLMWIKI_NODE_PACKAGE || DEFAULT_NODE_PACKAGE,
    llmwikiRuntime: process.env.LLMWIKI_RUNTIME_DIR || "",
    provider: process.env.LLMWIKI_PROVIDER || "",
    model: process.env.LLMWIKI_MODEL || "",
    openaiBaseUrl: process.env.OPENAI_BASE_URL || "",
    streamOnlyOpenai: booleanFromEnv(
      process.env.LLMWIKI_STREAM_ONLY_OPENAI,
      "LLMWIKI_STREAM_ONLY_OPENAI"
    ),
    streamAdapterPort: 0,
    lang: process.env.LLMWIKI_OUTPUT_LANG || "Chinese",
    concurrency: process.env.LLMWIKI_COMPILE_CONCURRENCY || "",
    resetProject: false,
    stageOnly: false,
    skipCompile: false,
    skipLint: false,
    strictLint: false,
    skipMaintain: false,
    noPruneSources: false,
    writeLinks: true,
    writeIndex: false,
    failOnDuplicates: false,
    noRecallFields: false,
    noIngest: false,
    force: false,
    dryRun: false,
    fastSkip: true,
    authoritativePrune: true,
    deterministicDedupe: true,
    atomicPublish: true,
    mirrorWorkspace: process.env.OKF_RAG_MIRROR_WORKSPACE || "",
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") args.root = requireValue(argv, ++i, arg);
    else if (arg === "--source") args.sources.push(requireValue(argv, ++i, arg));
    else if (arg === "--bundle") args.bundle = requireValue(argv, ++i, arg);
    else if (arg === "--llmwiki-project") args.project = requireValue(argv, ++i, arg);
    else if (arg === "--export-dir") args.exportDir = requireValue(argv, ++i, arg);
    else if (arg === "--okfs-dir") args.okfsDir = requireValue(argv, ++i, arg);
    else if (arg === "--okf-rag-bin") args.okfRagBin = requireValue(argv, ++i, arg);
    else if (arg === "--llmwiki-root") args.llmwikiRoot = requireValue(argv, ++i, arg);
    else if (arg === "--llmwiki-bin") args.llmwikiBin = requireValue(argv, ++i, arg);
    else if (arg === "--llmwiki-package") args.llmwikiPackage = requireValue(argv, ++i, arg);
    else if (arg === "--node-package") args.nodePackage = requireValue(argv, ++i, arg);
    else if (arg === "--llmwiki-runtime") args.llmwikiRuntime = requireValue(argv, ++i, arg);
    else if (arg === "--provider") args.provider = requireValue(argv, ++i, arg);
    else if (arg === "--model") args.model = requireValue(argv, ++i, arg);
    else if (arg === "--openai-base-url") args.openaiBaseUrl = requireValue(argv, ++i, arg);
    else if (arg === "--stream-only-openai") args.streamOnlyOpenai = true;
    else if (arg === "--stream-adapter-port") {
      args.streamAdapterPort = requireNonNegativeInteger(argv, ++i, arg);
    }
    else if (arg === "--lang") args.lang = requireValue(argv, ++i, arg);
    else if (arg === "--concurrency") args.concurrency = requirePositiveInteger(argv, ++i, arg);
    else if (arg === "--mirror-workspace") args.mirrorWorkspace = requireValue(argv, ++i, arg);
    else if (arg === "--reset-project") args.resetProject = true;
    else if (arg === "--stage-only") args.stageOnly = true;
    else if (arg === "--skip-compile") args.skipCompile = true;
    else if (arg === "--skip-lint") args.skipLint = true;
    else if (arg === "--strict-lint") args.strictLint = true;
    else if (arg === "--skip-maintain") args.skipMaintain = true;
    else if (arg === "--no-prune-sources") args.noPruneSources = true;
    else if (arg === "--write-links") args.writeLinks = true;
    else if (arg === "--no-write-links") args.writeLinks = false;
    else if (arg === "--write-index") args.writeIndex = true;
    else if (arg === "--fail-on-duplicates") args.failOnDuplicates = true;
    else if (arg === "--no-recall-fields") args.noRecallFields = true;
    else if (arg === "--no-ingest") args.noIngest = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--no-fast-skip") args.fastSkip = false;
    else if (arg === "--no-authoritative-prune") args.authoritativePrune = false;
    else if (arg === "--no-deterministic-dedupe") args.deterministicDedupe = false;
    else if (arg === "--no-atomic-publish") args.atomicPublish = false;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }

  return args;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function requirePositiveInteger(argv, index, flag) {
  const value = requireValue(argv, index, flag);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return String(parsed);
}

function requireNonNegativeInteger(argv, index, flag) {
  const value = requireValue(argv, index, flag);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} requires a non-negative integer`);
  }
  return parsed;
}

function printHelp() {
  console.log(`compile_okf_with_llmwiki

Use llm-wiki-compiler as the OKF producer, then hand the synced OKF bundle to
Rust okf-rag for ingestion.

Usage:
  node scripts/compile_okf_with_llmwiki.js --source docs/raw.md --bundle resource-hot-update-yooasset
  node scripts/compile_okf_with_llmwiki.js --source E:\\repo\\docs --bundle repo-knowledge
  node scripts/compile_okf_with_llmwiki.js --source E:\\repo\\README.md --bundle repo-memory --reset-project
  node scripts/compile_okf_with_llmwiki.js --llmwiki-project .okf-rag\\llmwiki-projects\\topic --skip-compile --bundle topic

Options:
  --root DIR                 okf-rag repo/workspace root. Defaults to cwd.
  --source PATH_OR_URL       Markdown file, Markdown directory, or llmwiki ingest source. May repeat.
  --bundle SLUG              Target folder under okf-rag-workspace/okfs.
  --llmwiki-project DIR      Persistent llmwiki project dir. Defaults to .okf-rag/llmwiki-projects/<bundle>.
  --export-dir DIR           Derived llmwiki OKF export dir. Defaults to .okf-rag/llmwiki-exports/<bundle>.
  --okfs-dir DIR             OKF truth dir. Defaults to okf-rag-workspace/okfs.
  --okf-rag-bin EXE          Explicit Rust okf-rag executable for ingest.
  --llmwiki-root DIR         Prefer a local llm-wiki-compiler dist/cli.js if built.
  --llmwiki-bin EXE          Explicit llmwiki executable or cli.js.
  --llmwiki-package NAME     npm fallback package. Defaults to llm-wiki-compiler@1.1.0.
  --node-package NAME        Node runtime used by npm fallback. Defaults to node@24.16.0.
  --llmwiki-runtime DIR      Persistent npm runtime. Defaults to .okf-rag/llmwiki-runtime.
  --provider NAME            Set LLMWIKI_PROVIDER for llmwiki commands.
  --model NAME               Set LLMWIKI_MODEL without putting the key on the command line.
  --openai-base-url URL      Set OPENAI_BASE_URL. The API key still comes from the environment.
  --stream-only-openai       Adapt llmwiki non-stream requests to an upstream stream-only API.
  --stream-adapter-port N    Local adapter port; 0 selects a free port. Defaults to 0.
  --lang TEXT                llmwiki compile language. Defaults to Chinese.
  --concurrency N            Max concurrent llmwiki LLM calls.
  --reset-project            Delete the derived llmwiki project before ingest/compile.
  --stage-only               Sync raw Markdown into sources/ and stop before compile.
  --skip-compile             Export an existing llmwiki project without LLM calls.
  --skip-lint                Do not run llmwiki lint before OKF export.
  --strict-lint              Treat llmwiki lint findings as a pipeline failure.
  --no-prune-sources         Keep previously generated sources when raw Markdown is deleted.
  --write-links              Generate Related Concepts links during staged publish (default).
  --no-write-links           Disable generated Related Concepts links.
  --write-index              Also let okf_maintain refresh folder index.md files.
  --fail-on-duplicates       Fail if okf_maintain detects likely duplicates.
  --no-recall-fields         Do not add OKF-RAG resource/uri/disclosure fallback fields.
  --no-ingest                Do not run Rust okf-rag ingest after sync.
  --mirror-workspace DIR     Copy okf-rag-workspace to another project after ingest.
  --force                    Overwrite files not previously generated by this script.
  --dry-run                  Run llmwiki stages, but preview sync only; no Rust ingest/mirror.
  --no-fast-skip             Do not bypass llmwiki when local source content is unchanged.
  --no-authoritative-prune   Keep previously generated concepts missing from llmwiki state.
  --no-deterministic-dedupe  Disable conservative exact duplicate reconciliation.
  --no-atomic-publish        Write the target bundle in place instead of staging and swapping.
  --json                     Print a machine-readable summary.

Notes:
  - Project-local LLM settings are loaded from .okf-rag/llmwiki.env. Explicit process environment variables win.
  - Local Markdown files/directories are synced directly to llmwiki sources/ using SOURCES_CONTRACT.md.
  - Unchanged source files remain byte-identical, so llmwiki incremental compile can skip them.
  - Each generated bundle gets an OKF v0.1 index.md, and okfs/index.md is refreshed as a catalog.
  - okf-rag-workspace/index.md is not generated because the workspace also contains runtime files.
  - references/ is kept as OKF evidence, and okf-rag/okf_maintain skip it during ingest/linking.
`);
}

function main() {
  const argv = process.argv.slice(2);
  const projectEnv = argv.some((arg) => arg === "--help" || arg === "-h")
    ? { file: path.join(rootFromArgv(argv), ".okf-rag", "llmwiki.env"), exists: false, configuredKeys: [], loadedKeys: [], ignoredKeys: [] }
    : loadProjectLlmwikiEnv(rootFromArgv(argv));
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  const root = path.resolve(args.root);
  const bundle = slugify(args.bundle || inferBundleName(args.sources) || "llmwiki-generated");
  if (!bundle) throw new Error("--bundle resolved to an empty slug");

  const projectDir = path.resolve(
    root,
    args.project || path.join(".okf-rag", "llmwiki-projects", bundle)
  );
  const exportDir = path.resolve(
    root,
    args.exportDir || path.join(".okf-rag", "llmwiki-exports", bundle)
  );
  const okfsDir = path.resolve(root, args.okfsDir || path.join("okf-rag-workspace", "okfs"));
  const targetBundleDir = path.join(okfsDir, bundle);
  const syncStateDir = path.join(root, ".okf-rag", "llmwiki-sync");
  const manifestPath = path.join(syncStateDir, `${bundle}.json`);
  const sourceSyncStateDir = path.join(root, ".okf-rag", "llmwiki-source-sync");
  const sourceManifestPath = path.join(sourceSyncStateDir, `${bundle}.json`);
  updatePipelineState("initializing", "running", { bundle, root, projectDir, targetBundleDir });

  const summary = {
    root,
    bundle,
    projectEnv: {
      file: projectEnv.file,
      exists: projectEnv.exists,
      configuredKeys: projectEnv.configuredKeys,
      loadedKeys: projectEnv.loadedKeys,
      ignoredKeys: projectEnv.ignoredKeys,
    },
    projectDir,
    exportDir,
    targetBundleDir,
    llmwiki: "not-started",
    ingestedSources: [],
    sourceSync: null,
    syncedFiles: [],
    skippedFiles: [],
    dryRun: args.dryRun,
    fastSkipped: false,
    generation: null,
    conceptCatalog: null,
  };

  if (args.resetProject) {
    safeRemoveDerivedDir(projectDir, root, "llmwiki project");
  }
  fs.mkdirSync(projectDir, { recursive: true });

  const classifiedSources = classifySources(args.sources, root);
  if (
    args.sources.length > 0 &&
    (classifiedSources.markdownFiles.length > 0 || fs.existsSync(sourceManifestPath))
  ) {
    summary.sourceSync = syncMarkdownSources({
      bundle,
      files: classifiedSources.markdownFiles,
      roots: classifiedSources.markdownRoots,
      projectDir,
      manifestPath: sourceManifestPath,
      prune: !args.noPruneSources,
      force: args.force,
    });
    updatePipelineState("source-sync", "running", summary.sourceSync);
  }

  if (args.stageOnly) {
    updatePipelineState("stage-only", "succeeded", { sourceSync: summary.sourceSync });
    return finish(summary, args);
  }

  if (
    args.fastSkip &&
    canFastSkip({
      args,
      summary,
      classifiedSources,
      projectDir,
      targetBundleDir,
      manifestPath,
    })
  ) {
    summary.fastSkipped = true;
    summary.catalogIndex = refreshOkfsCatalogIndex(okfsDir);
    if (args.mirrorWorkspace) {
      ensureWorkspaceRuntime(root);
      summary.mirror = copyDir(
        path.join(root, "okf-rag-workspace"),
        path.resolve(args.mirrorWorkspace)
      );
      summary.mirroredTo = path.resolve(args.mirrorWorkspace);
    }
    updatePipelineState("fast-skip", "succeeded", { sourceSync: summary.sourceSync });
    return finish(summary, args);
  }

  const runner = resolveLlmwikiRunner(args, root);
  summary.llmwiki = runner.label;

  const llmwikiEnv = {};
  if (args.provider) llmwikiEnv.LLMWIKI_PROVIDER = args.provider;
  if (args.model) llmwikiEnv.LLMWIKI_MODEL = args.model;
  if (args.openaiBaseUrl) llmwikiEnv.OPENAI_BASE_URL = args.openaiBaseUrl;
  for (const llmwikiSource of classifiedSources.llmwikiSources) {
    updatePipelineState("ingest-source", "running", { source: llmwikiSource });
    runCommand(runner.command, [...runner.prefixArgs, "ingest", llmwikiSource], {
      cwd: projectDir,
      label: `llmwiki ingest ${llmwikiSource}`,
      env: llmwikiEnv,
    });
    summary.ingestedSources.push(llmwikiSource);
  }

  if (!args.skipCompile) {
    if (args.sources.length === 0 && !fs.existsSync(path.join(projectDir, "sources"))) {
      throw new Error("provide --source, or use --skip-compile with an existing llmwiki project");
    }
    preflightProvider(args);
    updatePipelineState("llmwiki-compile", "running", { model: args.model, provider: args.provider });
    const compileArgs = [...runner.prefixArgs, "compile"];
    if (args.lang) compileArgs.push("--lang", args.lang);
    if (args.concurrency) compileArgs.push("--concurrency", args.concurrency);
    const streamAdapter = args.streamOnlyOpenai
      ? startOpenAIStreamAdapter(args, root, llmwikiEnv)
      : null;
    try {
      const compileEnv = streamAdapter
        ? { ...llmwikiEnv, OPENAI_BASE_URL: streamAdapter.baseURL }
        : llmwikiEnv;
      runCommand(runner.command, compileArgs, {
        cwd: projectDir,
        label: `llmwiki compile (${args.lang || "default language"})`,
        env: compileEnv,
      });
    } finally {
      streamAdapter?.stop();
    }
  }

  const conceptCatalog = buildLlmwikiConceptCatalog({
    projectDir,
    manifestPath,
    sourceManifestPath,
  });
  summary.conceptCatalog = conceptCatalog.summary;
  updatePipelineState("reconcile", "running", conceptCatalog.summary);
  if (args.authoritativePrune && conceptCatalog.authoritative) {
    summary.prunedProjectConcepts = pruneStaleProjectConcepts(projectDir, conceptCatalog);
  }

  if (!args.skipLint) {
    updatePipelineState("lint", "running", {});
    const lintStatus = runCommand(runner.command, [...runner.prefixArgs, "lint"], {
      cwd: projectDir,
      label: "llmwiki lint",
      env: llmwikiEnv,
      allowFailure: !args.strictLint,
    });
    summary.lint = lintStatus === 0 ? "passed" : "failed-advisory";
  }

  removeExportDirIfSafe(exportDir, root);
  updatePipelineState("export", "running", { exportDir });
  runCommand(runner.command, [...runner.prefixArgs, "export", "--target", "okf", "--out", exportDir], {
    cwd: projectDir,
    label: "llmwiki export --target okf",
    env: llmwikiEnv,
  });

  updatePipelineState("publish", "running", { targetBundleDir });
  const syncResult = syncOkfBundle({
    root,
    exportDir,
    targetBundleDir,
    manifestPath,
    bundle,
    force: args.force,
    dryRun: args.dryRun,
    addRecallFields: !args.noRecallFields,
    conceptCatalog,
    deterministicDedupe: args.deterministicDedupe,
    atomicPublish: args.atomicPublish,
    writeLinks: args.writeLinks,
  });
  summary.syncedFiles = syncResult.syncedFiles;
  summary.skippedFiles = syncResult.skippedFiles;
  summary.generation = syncResult.generation;
  summary.conceptCatalog = syncResult.catalogSummary;
  summary.catalogIndex = syncResult.catalogIndex;

  if (!args.dryRun && !args.skipMaintain) {
    updatePipelineState("maintain", "running", {});
    const maintainArgs = [resolveToolScript(root, "okf_maintain.js"), "--root", root];
    if (args.writeIndex) maintainArgs.push("--write-index");
    if (args.failOnDuplicates) maintainArgs.push("--fail-on-duplicates");
    runCommand(process.execPath, maintainArgs, {
      cwd: root,
      label: "okf_maintain",
    });
  }

  if (!args.dryRun && !args.noIngest) {
    updatePipelineState("rust-ingest", "running", { okfsDir });
    const okfRag = resolveOkfRagRunner(root, args);
    runCommand(okfRag.command, [...okfRag.prefixArgs, "ingest", "--root", root, okfsDir], {
      cwd: root,
      label: "okf-rag ingest",
    });
    summary.okfRag = okfRag.label;
  }

  if (!args.dryRun && args.mirrorWorkspace) {
    updatePipelineState("mirror", "running", { target: args.mirrorWorkspace });
    ensureWorkspaceRuntime(root);
    const sourceWorkspace = path.join(root, "okf-rag-workspace");
    const targetWorkspace = path.resolve(args.mirrorWorkspace);
    summary.mirror = copyDir(sourceWorkspace, targetWorkspace);
    summary.mirroredTo = targetWorkspace;
  }

  finish(summary, args);
}

function finish(summary, args) {
  updatePipelineState("done", "succeeded", {
    fastSkipped: summary.fastSkipped,
    generation: summary.generation,
    conceptCatalog: summary.conceptCatalog,
  });
  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else printSummary(summary);
}

function updatePipelineState(stage, status, details) {
  if (!PIPELINE_STATE_FILE) return;
  const previous = readJson(PIPELINE_STATE_FILE, {});
  const next = {
    ...previous,
    pipeline: {
      ...(previous.pipeline || {}),
      stage,
      status,
      details: sanitizeDiagnosticValue(details || {}),
      updatedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(PIPELINE_STATE_FILE), { recursive: true });
  const temporary = `${PIPELINE_STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, PIPELINE_STATE_FILE);
}

function inferBundleName(sources) {
  if (sources.length === 0) return "";
  const first = sources[0];
  if (isUrl(first)) {
    try {
      const url = new URL(first);
      return path.basename(url.pathname) || url.hostname;
    } catch {
      return "web-source";
    }
  }
  const trimmed = first.replace(/[\\/]+$/, "");
  return path.basename(trimmed, path.extname(trimmed));
}

function resolveSource(source, root) {
  if (isUrl(source)) return source;
  return path.isAbsolute(source) ? source : path.resolve(root, source);
}

function isUrl(value) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}

function classifySources(sources, root) {
  const markdownFiles = [];
  const markdownRoots = [];
  const llmwikiSources = [];

  for (const source of sources) {
    const resolved = resolveSource(source, root);
    if (isUrl(resolved)) {
      llmwikiSources.push(resolved);
      continue;
    }
    if (!fs.existsSync(resolved)) {
      throw new Error(`source not found: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      const files = collectRawMarkdownFiles(resolved);
      if (files.length === 0) {
        throw new Error(`source directory contains no Markdown files: ${resolved}`);
      }
      markdownRoots.push(resolved);
      markdownFiles.push(...files);
    } else if (stat.isFile() && path.extname(resolved).toLowerCase() === ".md") {
      markdownRoots.push(path.dirname(resolved));
      markdownFiles.push(resolved);
    } else {
      llmwikiSources.push(resolved);
    }
  }

  return {
    markdownFiles: [...new Set(markdownFiles.map((file) => path.resolve(file)))].sort((a, b) =>
      a.localeCompare(b)
    ),
    markdownRoots: [...new Set(markdownRoots.map((dir) => path.resolve(dir)))],
    llmwikiSources,
  };
}

function canFastSkip(options) {
  const { args, summary, classifiedSources, projectDir, targetBundleDir, manifestPath } = options;
  if (!summary.sourceSync || args.resetProject || args.force || args.dryRun || args.skipCompile) {
    return false;
  }
  if (args.writeIndex || args.failOnDuplicates) return false;
  if (classifiedSources.llmwikiSources.length > 0) return false;
  const changed = summary.sourceSync.created + summary.sourceSync.updated + summary.sourceSync.deleted;
  if (changed !== 0) return false;
  const previous = readJson(manifestPath, {});
  if (!previous.options) return false;
  if (
    previous.options.writeLinks !== args.writeLinks ||
    previous.options.deterministicDedupe !== args.deterministicDedupe ||
    previous.options.atomicPublish !== args.atomicPublish
  ) {
    return false;
  }
  return (
    fs.existsSync(path.join(projectDir, ".llmwiki", "state.json")) &&
    fs.existsSync(manifestPath) &&
    managedBundleComplete(targetBundleDir, previous)
  );
}

function managedBundleComplete(targetBundleDir, manifest) {
  if (!fs.existsSync(targetBundleDir)) return false;
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  if (files.length === 0) return false;
  const root = path.resolve(targetBundleDir);
  return files.every((entry) => {
    const relativePath = String(entry?.relativePath || "");
    if (!relativePath) return false;
    const target = path.resolve(root, relativePath.split("/").join(path.sep));
    const inside = target === root || target.startsWith(`${root}${path.sep}`);
    return inside && fs.existsSync(target);
  });
}

function buildLlmwikiConceptCatalog(options) {
  const statePath = path.join(options.projectDir, ".llmwiki", "state.json");
  const state = readJson(statePath, null);
  const previous = readJson(options.manifestPath, { files: [] });
  const sourceManifest = readJson(options.sourceManifestPath, { files: [] });
  const sourceByDestination = new Map(
    (sourceManifest.files || []).map((entry) => [
      String(entry.destination || ""),
      String(entry.sourceKey || entry.sourcePath || entry.destination || ""),
    ])
  );
  const owners = new Map();
  const desiredSlugs = new Set();

  if (state && state.sources && typeof state.sources === "object") {
    for (const [sourceName, entry] of Object.entries(state.sources)) {
      const owner = sourceByDestination.get(sourceName) || `llmwiki-source:${sourceName}`;
      for (const rawSlug of Array.isArray(entry?.concepts) ? entry.concepts : []) {
        const slug = normalizeConceptSlug(rawSlug);
        if (!slug) continue;
        desiredSlugs.add(slug);
        if (!owners.has(slug)) owners.set(slug, new Set());
        owners.get(slug).add(owner);
      }
    }
    for (const rawSlug of Array.isArray(state.frozenSlugs) ? state.frozenSlugs : []) {
      const slug = normalizeConceptSlug(rawSlug);
      if (!slug) continue;
      desiredSlugs.add(slug);
      if (!owners.has(slug)) owners.set(slug, new Set());
      owners.get(slug).add("llmwiki:frozen");
    }
  }

  const previousManagedSlugs = new Set();
  for (const concept of previous.concepts || []) {
    const slug = normalizeConceptSlug(concept.slug || concept.conceptId);
    if (slug) previousManagedSlugs.add(slug);
  }
  for (const file of previous.files || []) {
    const slug = conceptSlugFromRelativePath(file.relativePath);
    if (slug) previousManagedSlugs.add(slug);
  }

  const authoritative = Boolean(state && state.sources && typeof state.sources === "object");
  const staleSlugs = authoritative
    ? [...previousManagedSlugs].filter((slug) => !desiredSlugs.has(slug)).sort()
    : [];
  return {
    authoritative,
    statePath,
    desiredSlugs,
    previousManagedSlugs,
    staleSlugs,
    owners,
    previousAliases: previous.catalog?.aliases || {},
    summary: {
      authoritative,
      desiredConcepts: desiredSlugs.size,
      previousManagedConcepts: previousManagedSlugs.size,
      staleConcepts: staleSlugs.length,
      sourceCount: state?.sources ? Object.keys(state.sources).length : 0,
    },
  };
}

function pruneStaleProjectConcepts(projectDir, catalog) {
  const conceptDir = path.join(projectDir, "wiki", "concepts");
  const removed = [];
  for (const slug of catalog.staleSlugs) {
    const target = path.resolve(conceptDir, `${slug}.md`);
    ensureInside(conceptDir, target, "stale llmwiki concept");
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { force: true });
    removed.push(slug);
  }
  return removed;
}

function normalizeConceptSlug(value) {
  return slash(String(value || ""))
    .replace(/^concepts\//, "")
    .replace(/\.md$/i, "")
    .replace(/^\/+|\/+$/g, "");
}

function conceptSlugFromRelativePath(relativePath) {
  const rel = slash(String(relativePath || ""));
  if (!/^concepts\/.+\.md$/i.test(rel)) return "";
  if (/\/index\.md$/i.test(rel)) return "";
  return normalizeConceptSlug(rel);
}

function collectRawMarkdownFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SOURCE_SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectRawMarkdownFiles(full, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(full);
  }
  return out;
}

function syncMarkdownSources(options) {
  const sourcesDir = path.join(options.projectDir, "sources");
  fs.mkdirSync(sourcesDir, { recursive: true });
  const previous = readJson(options.manifestPath, { files: [] });
  const previousByDestination = new Map(
    (previous.files || []).map((entry) => [entry.destination, entry])
  );
  const currentDestinations = new Set();
  const manifestFiles = [];
  const results = [];
  const instances = new Map();

  for (const sourcePath of options.files) {
    const sourceKey = `file:${slash(path.resolve(sourcePath))}`;
    const stem = slugify(path.basename(sourcePath, path.extname(sourcePath))) || "source";
    const destination = `${stem}-${sha256(sourceKey).slice(0, 8)}.md`;
    const destinationPath = path.resolve(sourcesDir, destination);
    ensureInside(sourcesDir, destinationPath, "llmwiki source destination");

    const raw = fs.readFileSync(sourcePath, "utf8").replace(/^\uFEFF/, "");
    const stat = fs.statSync(sourcePath);
    const title = sourceTitle(raw, sourcePath);
    const root = bestContainingRoot(sourcePath, options.roots);
    const relativePath = root ? slash(path.relative(root, sourcePath)) : path.basename(sourcePath);
    const sourceContentHash = sha256(raw);
    const previousEntry = previousByDestination.get(destination);
    const sourceInstanceRoot = slash(path.resolve(root || sourcePath));
    const sourceInstanceId = `markdown:${sha256(sourceInstanceRoot).slice(0, 16)}`;
    const ingestedAt =
      previousEntry?.sourceContentHash === sourceContentHash && previousEntry.ingestedAt
        ? previousEntry.ingestedAt
        : stat.mtime.toISOString();
    instances.set(sourceInstanceId, {
      id: sourceInstanceId,
      adapter: root ? "markdown-directory" : "markdown-file",
      root: sourceInstanceRoot,
    });
    const document = buildCompilerSourceDocument({
      title,
      sourceKey,
      sourcePath,
      relativePath,
      raw,
      ingestedAt,
      sourceInstanceId,
    });
    const contentHash = sha256(document);
    const existing = fs.existsSync(destinationPath)
      ? fs.readFileSync(destinationPath, "utf8")
      : null;
    const generatedBefore = previousByDestination.has(destination);
    if (existing !== null && existing !== document && !generatedBefore && !options.force) {
      throw new Error(
        `refusing to overwrite non-generated llmwiki source: ${destinationPath}\n` +
          "Pass --force if this sources/ file is intentionally pipeline-managed."
      );
    }

    if (existing !== document) {
      fs.writeFileSync(destinationPath, document, "utf8");
      results.push({ sourcePath, destination, status: existing === null ? "created" : "updated" });
    } else {
      results.push({ sourcePath, destination, status: "unchanged" });
    }
    currentDestinations.add(destination);
    manifestFiles.push({
      sourcePath,
      sourceKey,
      sourceInstanceId,
      adapter: "markdown-file",
      relativePath,
      destination,
      sourceContentHash,
      contentHash,
      ingestedAt,
      observedMtime: stat.mtime.toISOString(),
      sizeBytes: stat.size,
    });
  }

  if (options.prune) {
    for (const entry of previous.files || []) {
      if (currentDestinations.has(entry.destination)) continue;
      const stalePath = path.resolve(sourcesDir, entry.destination);
      ensureInside(sourcesDir, stalePath, "stale llmwiki source");
      if (!fs.existsSync(stalePath)) continue;
      const currentHash = sha256(fs.readFileSync(stalePath, "utf8"));
      if (currentHash !== entry.contentHash && !options.force) {
        results.push({ sourcePath: entry.sourcePath, destination: entry.destination, status: "kept-modified" });
        continue;
      }
      fs.rmSync(stalePath, { force: true });
      results.push({ sourcePath: entry.sourcePath, destination: entry.destination, status: "deleted" });
    }
  }

  fs.mkdirSync(path.dirname(options.manifestPath), { recursive: true });
  fs.writeFileSync(
    options.manifestPath,
    JSON.stringify(
      {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        bundle: options.bundle || null,
        projectDir: options.projectDir,
        instances: [...instances.values()]
          .map((instance) => ({
            ...instance,
            fileCount: manifestFiles.filter(
              (file) => file.sourceInstanceId === instance.id
            ).length,
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
        files: manifestFiles,
        changes: {
          created: results.filter((item) => item.status === "created").length,
          updated: results.filter((item) => item.status === "updated").length,
          unchanged: results.filter((item) => item.status === "unchanged").length,
          deleted: results.filter((item) => item.status === "deleted").length,
          keptModified: results.filter((item) => item.status === "kept-modified").length,
        },
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  return {
    sourcesDir,
    total: manifestFiles.length,
    created: results.filter((item) => item.status === "created").length,
    updated: results.filter((item) => item.status === "updated").length,
    unchanged: results.filter((item) => item.status === "unchanged").length,
    deleted: results.filter((item) => item.status === "deleted").length,
    results,
  };
}

function buildCompilerSourceDocument(input) {
  const originalChars = input.raw.length;
  const body = input.raw.slice(0, MAX_SOURCE_CHARS);
  const lines = [
    "---",
    `title: ${yamlString(input.title)}`,
    `source: ${yamlString(input.sourceKey)}`,
    `ingestedAt: ${yamlString(input.ingestedAt)}`,
    "sourceType: file",
    "x-okf-rag-source-sync: true",
    `x-okf-rag-source-path: ${yamlString(slash(input.sourcePath))}`,
    `x-okf-rag-relative-path: ${yamlString(input.relativePath)}`,
    `x-okf-rag-source-instance: ${yamlString(input.sourceInstanceId)}`,
  ];
  if (originalChars > MAX_SOURCE_CHARS) {
    lines.push("truncated: true", `originalChars: ${originalChars}`);
  }
  lines.push("---", "", body.replace(/\s*$/, ""), "");
  return lines.join("\n");
}

function sourceTitle(raw, sourcePath) {
  const frontmatterTitle = readRawFrontmatterTitle(raw);
  if (frontmatterTitle) return frontmatterTitle;
  const heading = raw.match(/^#\s+(.+?)\s*$/m);
  if (heading) return heading[1].trim();
  return titleCaseSlug(path.basename(sourcePath, path.extname(sourcePath)));
}

function readRawFrontmatterTitle(raw) {
  const normalized = raw.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) return "";
  const lines = normalized.split(/\r?\n/);
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "---") break;
    const match = line.match(/^title\s*:\s*(.+?)\s*$/);
    if (match) return unquote(match[1]);
  }
  return "";
}

function bestContainingRoot(file, roots) {
  return roots
    .filter((root) => isInside(root, file))
    .sort((a, b) => b.length - a.length)[0] || "";
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function resolveLlmwikiRunner(args, root) {
  if (args.llmwikiBin) {
    const bin = path.resolve(args.llmwikiBin);
    if (!fs.existsSync(bin)) throw new Error(`--llmwiki-bin not found: ${bin}`);
    if (bin.endsWith(".js")) {
      return nodeScriptRunner(bin, args, root);
    }
    return { command: bin, prefixArgs: [], label: bin };
  }

  if (args.llmwikiRoot) {
    const localCli = path.join(path.resolve(args.llmwikiRoot), "dist", "cli.js");
    if (fs.existsSync(localCli)) {
      return nodeScriptRunner(localCli, args, root);
    }
  }

  return ensurePackagedLlmwikiRunner(args, root);
}

function ensurePackagedLlmwikiRunner(args, root) {
  const npmCli = findNpmCli();
  if (!npmCli) throw new Error("npm-cli.js was not found; cannot install llmwiki runtime");
  const runtimeDir = path.resolve(
    args.llmwikiRuntime || path.join(root, ".okf-rag", "llmwiki-runtime")
  );
  const nodeExe = process.platform === "win32"
    ? path.join(runtimeDir, "node_modules", "node", "bin", "node.exe")
    : path.join(runtimeDir, "node_modules", "node", "bin", "node");
  const llmwikiCli = path.join(
    runtimeDir,
    "node_modules",
    "llm-wiki-compiler",
    "dist",
    "cli.js"
  );
  const installedPackage = readJson(
    path.join(runtimeDir, "node_modules", "llm-wiki-compiler", "package.json"),
    null
  );
  const expectedVersion = packageVersion(args.llmwikiPackage);
  const needsInstall =
    !fs.existsSync(nodeExe) ||
    !fs.existsSync(llmwikiCli) ||
    (expectedVersion && installedPackage?.version !== expectedVersion);

  if (needsInstall) {
    fs.mkdirSync(runtimeDir, { recursive: true });
    runCommand(
      process.execPath,
      [
        npmCli,
        "install",
        "--prefix",
        runtimeDir,
        "--no-save",
        "--include=optional",
        args.nodePackage,
        args.llmwikiPackage,
      ],
      { cwd: runtimeDir, label: "install persistent llmwiki runtime" }
    );
  }

  ensureClaudeAgentNativePackage(runtimeDir, npmCli);
  if (!fs.existsSync(nodeExe) || !fs.existsSync(llmwikiCli)) {
    throw new Error(`llmwiki runtime installation is incomplete: ${runtimeDir}`);
  }
  return {
    command: nodeExe,
    prefixArgs: [llmwikiCli],
    label: `${nodeExe} ${llmwikiCli}`,
  };
}

function ensureClaudeAgentNativePackage(runtimeDir, npmCli) {
  if (process.platform !== "win32" || process.arch !== "x64") return;
  const sdkPackage = readJson(
    path.join(runtimeDir, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"),
    null
  );
  if (!sdkPackage?.version) return;
  const nativeDir = path.join(
    runtimeDir,
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk-win32-x64"
  );
  const nativeExe = path.join(nativeDir, "claude.exe");
  if (fs.existsSync(nativeExe)) return;
  if (fs.existsSync(nativeDir)) fs.rmSync(nativeDir, { recursive: true, force: true });
  runCommand(
    process.execPath,
    [
      npmCli,
      "install",
      "--prefix",
      runtimeDir,
      "--no-save",
      "--force",
      `@anthropic-ai/claude-agent-sdk-win32-x64@${sdkPackage.version}`,
    ],
    { cwd: runtimeDir, label: "install Claude Agent SDK Windows runtime" }
  );
  if (!fs.existsSync(nativeExe)) {
    throw new Error(`Claude Agent SDK Windows binary is missing after install: ${nativeExe}`);
  }
}

function packageVersion(spec) {
  const match = String(spec).match(/@([0-9]+\.[0-9]+\.[0-9]+)$/);
  return match ? match[1] : "";
}

function nodeScriptRunner(scriptPath, args, root) {
  if (currentNodeMajor() >= 24) {
    return { command: process.execPath, prefixArgs: [scriptPath], label: scriptPath };
  }
  const npmCli = findNpmCli();
  if (!npmCli) {
    throw new Error(`Node 24 is required to run ${scriptPath}; npm-cli.js was not found`);
  }
  const npmExecPrefix = path.join(root, ".okf-rag", "npm-exec");
  fs.mkdirSync(npmExecPrefix, { recursive: true });
  return {
    command: process.execPath,
    prefixArgs: [
      npmCli,
      "exec",
      "--prefix",
      npmExecPrefix,
      "--yes",
      `--package=${args.nodePackage}`,
      "--",
      "node",
      scriptPath,
    ],
    label: `${args.nodePackage} ${scriptPath}`,
  };
}

function currentNodeMajor() {
  return Number.parseInt(process.versions.node.split(".")[0], 10);
}

function preflightProvider(args) {
  if (args.provider === "openai") {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        "The OpenAI-compatible provider requires OPENAI_API_KEY in the environment. " +
          "Do not pass the key on the command line."
      );
    }
    if (args.streamOnlyOpenai && !args.openaiBaseUrl) {
      throw new Error("--stream-only-openai requires OPENAI_BASE_URL or --openai-base-url");
    }
    if (args.streamOnlyOpenai && !args.model) {
      throw new Error("--stream-only-openai requires LLMWIKI_MODEL or --model");
    }
    return;
  }
  if (args.provider !== "claude-agent") return;
  const appData = process.env.APPDATA || "";
  const claudeCli = appData
    ? path.join(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js")
    : "";
  if (!claudeCli || !fs.existsSync(claudeCli)) {
    throw new Error(
      "LLMWIKI_PROVIDER=claude-agent requires Claude Code. Install it and run `claude auth login`."
    );
  }
  const status = spawnSync(process.execPath, [claudeCli, "auth", "status"], {
    encoding: "utf8",
    windowsHide: true,
    env: process.env,
  });
  let parsed = null;
  try {
    parsed = JSON.parse(status.stdout || "{}");
  } catch {
    // The explicit status below still produces an actionable failure.
  }
  if (status.status !== 0 || parsed?.loggedIn !== true) {
    throw new Error(
      "Claude Code is not logged in. Run `claude auth login`, then rerun the OKF pipeline."
    );
  }
}

function startOpenAIStreamAdapter(args, root, llmwikiEnv) {
  if (args.provider !== "openai") {
    throw new Error("--stream-only-openai requires --provider openai");
  }
  const upstreamBaseURL = args.openaiBaseUrl || process.env.OPENAI_BASE_URL || "";
  if (!upstreamBaseURL) throw new Error("OPENAI_BASE_URL is required for stream-only mode");
  const runsDir = path.join(root, ".okf-rag", "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const readyFile = path.join(
    runsDir,
    `openai-stream-adapter-${process.pid}-${Date.now()}.json`
  );
  const adapterScript = path.join(__dirname, "openai_stream_adapter.js");
  const child = spawn(
    process.execPath,
    [
      adapterScript,
      "--host",
      "127.0.0.1",
      "--port",
      String(args.streamAdapterPort),
      "--ready-file",
      readyFile,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        ...llmwikiEnv,
        OPENAI_STREAM_UPSTREAM_BASE_URL: upstreamBaseURL,
        OPENAI_BASE_URL: upstreamBaseURL,
      },
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    }
  );

  let ready = null;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (fs.existsSync(readyFile)) {
      ready = readJson(readyFile, null);
      if (ready?.port) break;
    }
    if (child.exitCode !== null) break;
    sleepSync(100);
  }
  if (!ready?.port) {
    if (child.exitCode === null) child.kill();
    fs.rmSync(readyFile, { force: true });
    throw new Error("OpenAI stream adapter did not become ready within 15 seconds");
  }

  return {
    baseURL: `http://127.0.0.1:${ready.port}/v1`,
    stop() {
      if (child.exitCode === null) child.kill();
      fs.rmSync(readyFile, { force: true });
    },
  };
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function findNpmCli() {
  const candidates = [
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function resolveOkfRagRunner(root, args) {
  if (args.okfRagBin) {
    const explicit = path.resolve(args.okfRagBin);
    if (!fs.existsSync(explicit)) throw new Error(`--okf-rag-bin not found: ${explicit}`);
    return { command: explicit, prefixArgs: [], label: explicit };
  }
  const workspaceExe = path.join(root, "okf-rag-workspace", "bin", "okf-rag.exe");
  if (fs.existsSync(workspaceExe)) {
    return { command: workspaceExe, prefixArgs: [], label: workspaceExe };
  }
  const releaseExe = path.join(root, "target", "release", "okf-rag.exe");
  if (fs.existsSync(releaseExe)) {
    return { command: releaseExe, prefixArgs: [], label: releaseExe };
  }
  const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
  return { command: cargo, prefixArgs: ["run", "-p", "okf-rag", "--release", "--"], label: "cargo run -p okf-rag --release" };
}

function ensureWorkspaceRuntime(root) {
  const required = [
    "okf-rag.exe",
    "onnxruntime.dll",
    "onnxruntime_providers_shared.dll",
    "zvec_c_api.dll",
  ];
  const workspaceBin = path.join(root, "okf-rag-workspace", "bin");
  const releaseDir = path.join(root, "target", "release");
  const hasReleaseRuntime = required.every((file) => fs.existsSync(path.join(releaseDir, file)));
  const hasWorkspaceRuntime = required.every((file) =>
    fs.existsSync(path.join(workspaceBin, file))
  );
  if (!hasReleaseRuntime && hasWorkspaceRuntime) return;
  if (!hasReleaseRuntime) {
    throw new Error(
      `cannot mirror runnable workspace because runtime files are missing in ${workspaceBin} and ${releaseDir}. ` +
        "Run cargo build -p okf-rag --release first."
    );
  }

  fs.mkdirSync(workspaceBin, { recursive: true });
  for (const file of required) {
    const source = path.join(releaseDir, file);
    const target = path.join(workspaceBin, file);
    if (!fs.existsSync(target) || sha256Buffer(fs.readFileSync(source)) !== sha256Buffer(fs.readFileSync(target))) {
      fs.copyFileSync(source, target);
    }
  }
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function resolveToolScript(root, fileName) {
  const repositoryScript = path.join(root, "scripts", fileName);
  return fs.existsSync(repositoryScript) ? repositoryScript : path.join(__dirname, fileName);
}

function runCommand(command, args, options) {
  console.log(
    `\n$ ${sanitizeDiagnosticText([command, ...args].map(quoteArg).join(" "))}`
  );
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.stdout) process.stdout.write(sanitizeDiagnosticText(result.stdout));
  if (result.stderr) process.stderr.write(sanitizeDiagnosticText(result.stderr));
  if (result.error) {
    throw new Error(sanitizeDiagnosticText(result.error.message));
  }
  if (result.status !== 0) {
    if (options.allowFailure) {
      console.warn(`${options.label || command} exited ${result.status}; continuing as advisory`);
      return result.status;
    }
    throw new Error(`${options.label || command} failed with exit code ${result.status}`);
  }
  return result.status;
}

function quoteArg(value) {
  const text = String(value);
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function syncOkfBundle(options) {
  if (!fs.existsSync(options.exportDir)) {
    throw new Error(`llmwiki OKF export dir not found: ${options.exportDir}`);
  }

  const previous = readJson(options.manifestPath, { files: [] });
  const previousFiles = new Set(
    (previous.files || []).map((file) => path.resolve(options.targetBundleDir, file.relativePath))
  );
  const generationId = generationIdNow();
  const markdownFiles = walkFiles(options.exportDir)
    .filter((file) => file.toLowerCase().endsWith(".md"))
    .sort((a, b) => a.localeCompare(b));
  let prepared = markdownFiles
    .map((sourcePath) => {
      const relativePath = slash(path.relative(options.exportDir, sourcePath));
      return {
        sourcePath,
        relativePath,
        text: stripResidualWikilinks(
          rewriteBundleAbsoluteLinks(fs.readFileSync(sourcePath, "utf8"), relativePath)
        ),
      };
    })
    .filter((entry) => entry.relativePath !== "index.md")
    .filter((entry) => {
      if (!isConceptDocument(entry.relativePath) || !options.conceptCatalog?.authoritative) {
        return true;
      }
      const slug = conceptSlugFromRelativePath(entry.relativePath);
      return Boolean(slug && options.conceptCatalog.desiredSlugs.has(slug));
    });

  const exportedConceptCount = prepared.filter((entry) => isConceptDocument(entry.relativePath)).length;
  if (exportedConceptCount === 0 && !options.conceptCatalog?.authoritative) {
    throw new Error(
      `llmwiki exported no concept/query documents from ${options.exportDir}. ` +
        "Compile sources first, or point --llmwiki-project at a compiled llmwiki project with current frontmatter."
    );
  }

  const dedupe = options.deterministicDedupe
    ? reconcileExactDuplicateConcepts(prepared, options.conceptCatalog)
    : {
        entries: prepared,
        aliases: {},
        aliasesByCanonical: new Map(),
        ownersBySlug: options.conceptCatalog?.owners || new Map(),
        duplicateCandidates: findDuplicateCandidates(prepared),
      };
  prepared = dedupe.entries;

  const portableOwnersBySlug = new Map();
  for (const [slug, ownerSet] of dedupe.ownersBySlug) {
    portableOwnersBySlug.set(
      slug,
      new Set([...ownerSet].map((owner) => portableSourceId(owner, options.bundle)))
    );
  }

  prepared = prepared.map((entry) => ({
    ...entry,
    text: makePublishedProvenancePortable(entry.text, entry.relativePath, options.bundle),
  }));

  prepared = prepared.map((entry) => {
    if (!isConceptDocument(entry.relativePath)) return entry;
    const slug = conceptSlugFromRelativePath(entry.relativePath);
    const owners = [...(dedupe.ownersBySlug.get(slug) || [])].sort();
    const sourceRefs = extractBundleReferenceLinks(entry.text, entry.relativePath);
    const aliases = [...(dedupe.aliasesByCanonical.get(slug) || [])].sort();
    let text = rewriteConceptAliasLinks(entry.text, entry.relativePath, dedupe.aliases);
    text = upsertGeneratedFrontmatter(text, {
      okf_bundle: yamlString(options.bundle),
      okf_generation: yamlString(generationId),
      canonical_id: yamlString(`${options.bundle}/${entry.relativePath.replace(/\.md$/i, "")}`),
      source_refs: JSON.stringify(
        sourceRefs.length > 0
          ? sourceRefs
          : owners.map((owner) => portableSourceId(owner, options.bundle))
      ),
      aliases: JSON.stringify(aliases),
    });
    if (options.addRecallFields) text = ensureRecallFields(text, options.bundle, entry.relativePath);
    return { ...entry, text };
  });

  const writeLinks = options.writeLinks !== false;
  const relationshipGraph = writeLinks
    ? buildRelationshipGraph(
        prepared.filter((entry) => isConceptDocument(entry.relativePath)),
        {
          bundle: options.bundle,
          ownersBySlug: portableOwnersBySlug,
          identity: conceptIdentity,
          maxOutbound: 6,
        }
      )
    : {
        concepts: [],
        relationships: [],
        orphans: [],
        summary: { concepts: 0, relationships: 0, explicit: 0, inferred: 0, orphans: 0 },
      };
  if (writeLinks) {
    prepared = applyRelationshipGraph(prepared, relationshipGraph, upsertGeneratedFrontmatter);
  }

  const conceptEntries = prepared.filter((entry) => isConceptDocument(entry.relativePath));
  if (conceptEntries.length > 0) {
    prepared.push({
      sourcePath: "generated:index",
      relativePath: "index.md",
      text: buildGeneratedBundleIndex(options.bundle, conceptEntries),
    });
  }
  prepared.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const syncedFiles = [];
  const skippedFiles = [];
  const manifestFiles = [];
  const manifestConcepts = [];
  const currentRelativePaths = new Set();
  const metaRoot = path.join(path.resolve(options.root), ".okf-rag");
  const stagingDir = path.join(metaRoot, "publish-staging", `${options.bundle}-${generationId}`);
  let writeRoot = options.targetBundleDir;

  if (!options.dryRun && options.atomicPublish) {
    safeRemoveDerivedDir(stagingDir, options.root, "OKF publish staging");
    if (fs.existsSync(options.targetBundleDir)) {
      fs.cpSync(options.targetBundleDir, stagingDir, { recursive: true, force: true });
    } else {
      fs.mkdirSync(stagingDir, { recursive: true });
    }
    writeRoot = stagingDir;
  }

  for (const entry of prepared) {
    const targetPath = path.resolve(
      options.targetBundleDir,
      entry.relativePath.split("/").join(path.sep)
    );
    const writePath = path.resolve(writeRoot, entry.relativePath.split("/").join(path.sep));
    ensureInside(options.targetBundleDir, targetPath, "sync destination");
    ensureInside(writeRoot, writePath, "staged sync destination");
    const hash = sha256(entry.text);
    const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : null;
    const generatedBefore = previousFiles.has(targetPath);
    if (existing !== null && existing !== entry.text && !generatedBefore && !options.force) {
      throw new Error(
        `refusing to overwrite non-generated OKF file: ${targetPath}\n` +
          "Pass --force if this bundle folder is intentionally managed by llmwiki."
      );
    }

    manifestFiles.push({
      relativePath: entry.relativePath,
      sourcePath: portableManifestPath(entry.sourcePath, options.root),
      hash,
    });
    currentRelativePaths.add(entry.relativePath);
    if (isConceptDocument(entry.relativePath)) {
      const identity = conceptIdentity(entry);
      const slug = conceptSlugFromRelativePath(entry.relativePath);
      manifestConcepts.push({
        slug,
        conceptId: `${options.bundle}/${entry.relativePath.replace(/\.md$/i, "")}`,
        relativePath: entry.relativePath,
        title: identity.title,
        type: identity.type,
        hash,
        owners: [...(portableOwnersBySlug.get(slug) || [])].sort(),
        aliases: [...(dedupe.aliasesByCanonical.get(slug) || [])].sort(),
        outboundRelations: relationshipGraph.relationships
          .filter(
            (relationship) =>
              relationship.from ===
              `${options.bundle}/${entry.relativePath.replace(/\.md$/i, "")}`
          )
          .map((relationship) => ({
            predicate: relationship.predicate,
            target: relationship.to,
            confidence: relationship.confidence,
            source: relationship.source,
          })),
        inboundRelations: relationshipGraph.relationships
          .filter(
            (relationship) =>
              relationship.to ===
              `${options.bundle}/${entry.relativePath.replace(/\.md$/i, "")}`
          )
          .map((relationship) => ({
            predicate: relationship.predicate,
            sourceConcept: relationship.from,
            confidence: relationship.confidence,
            source: relationship.source,
          })),
      });
    }
    if (options.dryRun) {
      syncedFiles.push({
        path: slash(path.relative(process.cwd(), targetPath)),
        status: existing === entry.text ? "unchanged" : "would-write",
      });
      continue;
    }

    fs.mkdirSync(path.dirname(writePath), { recursive: true });
    if (!fs.existsSync(writePath) || fs.readFileSync(writePath, "utf8") !== entry.text) {
      fs.writeFileSync(writePath, entry.text, "utf8");
      syncedFiles.push({ path: slash(path.relative(process.cwd(), targetPath)), status: "written" });
    } else {
      syncedFiles.push({ path: slash(path.relative(process.cwd(), targetPath)), status: "unchanged" });
    }
  }

  for (const entry of previous.files || []) {
    if (currentRelativePaths.has(entry.relativePath)) continue;
    const staleTargetPath = path.resolve(
      options.targetBundleDir,
      entry.relativePath.split("/").join(path.sep)
    );
    const staleWritePath = path.resolve(writeRoot, entry.relativePath.split("/").join(path.sep));
    ensureInside(options.targetBundleDir, staleTargetPath, "stale OKF destination");
    ensureInside(writeRoot, staleWritePath, "staged stale OKF destination");
    if (!fs.existsSync(staleTargetPath)) continue;
    const currentText = fs.readFileSync(staleTargetPath, "utf8");
    const currentHash = sha256(currentText);
    if (currentHash !== entry.hash && !options.force) {
      const archiveRel = recoveredReferencePath(generationId, entry.relativePath);
      const archivePath = path.resolve(writeRoot, archiveRel.split("/").join(path.sep));
      ensureInside(writeRoot, archivePath, "recovered modified OKF");
      skippedFiles.push({
        path: slash(path.relative(process.cwd(), staleTargetPath)),
        status: options.dryRun ? "would-archive-modified" : "archived-modified",
        archivedTo: slash(path.relative(process.cwd(), path.join(options.targetBundleDir, archiveRel))),
      });
      if (!options.dryRun) {
        fs.mkdirSync(path.dirname(archivePath), { recursive: true });
        fs.writeFileSync(archivePath, currentText, "utf8");
        fs.rmSync(staleWritePath, { force: true });
      }
      continue;
    }
    if (options.dryRun) {
      syncedFiles.push({
        path: slash(path.relative(process.cwd(), staleTargetPath)),
        status: "would-delete",
      });
    } else {
      fs.rmSync(staleWritePath, { force: true });
      syncedFiles.push({
        path: slash(path.relative(process.cwd(), staleTargetPath)),
        status: "deleted",
      });
    }
  }

  const catalogSummary = {
    ...(options.conceptCatalog?.summary || { authoritative: false }),
    publishedConcepts: manifestConcepts.length,
    exactAliases: Object.keys(dedupe.aliases).length,
    aliases: dedupe.aliases,
    duplicateCandidates: dedupe.duplicateCandidates,
    relationshipGraph: {
      ...relationshipGraph.summary,
      orphans: relationshipGraph.orphans,
    },
  };
  const generation = {
    id: generationId,
    status: options.dryRun ? "preview" : "published",
    atomic: Boolean(options.atomicPublish),
    conceptCount: manifestConcepts.length,
    relationCount: relationshipGraph.relationships.length,
    added: syncedFiles.filter((item) => item.status === "written").length,
    deleted: syncedFiles.filter((item) => item.status === "deleted").length,
    archivedModified: skippedFiles.filter((item) => item.status === "archived-modified").length,
  };

  let catalogIndex = null;
  if (!options.dryRun) {
    pruneEmptyDirs(writeRoot, writeRoot);
    validatePreparedBundle(writeRoot, manifestConcepts);
    if (options.atomicPublish) {
      publishStagedDirectory({
        root: options.root,
        bundle: options.bundle,
        generationId,
        stagingDir,
        targetBundleDir: options.targetBundleDir,
      });
    }
    const manifest = {
      schemaVersion: 3,
      generatedAt: new Date().toISOString(),
      generation,
      bundle: options.bundle,
      targetBundleDir: slash(path.relative(options.root, options.targetBundleDir)),
      files: manifestFiles,
      concepts: manifestConcepts,
      relationships: relationshipGraph.relationships,
      catalog: catalogSummary,
      options: {
        writeLinks,
        deterministicDedupe: Boolean(options.deterministicDedupe),
        authoritativePrune: Boolean(options.conceptCatalog?.authoritative),
        atomicPublish: Boolean(options.atomicPublish),
      },
    };
    atomicWriteJson(options.manifestPath, manifest);
    writeGenerationHistory(
      options.root,
      options.bundle,
      generationId,
      manifest,
      options.targetBundleDir
    );
    catalogIndex = refreshOkfsCatalogIndex(path.dirname(options.targetBundleDir));
  }

  return { syncedFiles, skippedFiles, generation, catalogSummary, catalogIndex };
}

function generationIdNow() {
  return `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)}-${process.pid}`;
}

function recoveredReferencePath(generationId, relativePath) {
  const flattened = slash(relativePath).replace(/[^a-zA-Z0-9\u4e00-\u9fff._-]+/g, "__");
  return `references/recovered/${generationId}/${flattened}`;
}

function reconcileExactDuplicateConcepts(entries, catalog) {
  const concepts = entries.filter((entry) => isConceptDocument(entry.relativePath));
  const parents = new Map(concepts.map((entry) => [entry.relativePath, entry.relativePath]));
  const keyOwner = new Map();
  const find = (value) => {
    let current = value;
    while (parents.get(current) !== current) current = parents.get(current);
    let cursor = value;
    while (parents.get(cursor) !== cursor) {
      const next = parents.get(cursor);
      parents.set(cursor, current);
      cursor = next;
    }
    return current;
  };
  const union = (a, b) => {
    const left = find(a);
    const right = find(b);
    if (left !== right) parents.set(right, left);
  };

  for (const entry of concepts) {
    for (const key of strongConceptIdentityKeys(entry)) {
      if (keyOwner.has(key)) union(entry.relativePath, keyOwner.get(key));
      else keyOwner.set(key, entry.relativePath);
    }
  }

  const groups = new Map();
  for (const entry of concepts) {
    const root = find(entry.relativePath);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(entry);
  }

  const aliases = {};
  const aliasesByCanonical = new Map();
  const ownersBySlug = new Map();
  for (const [slug, ownerSet] of catalog?.owners || []) {
    ownersBySlug.set(slug, new Set(ownerSet));
  }
  const removed = new Set();

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const canonical = chooseCanonicalConcept(group, catalog?.previousAliases || {});
    const canonicalSlug = conceptSlugFromRelativePath(canonical.relativePath);
    if (!aliasesByCanonical.has(canonicalSlug)) aliasesByCanonical.set(canonicalSlug, new Set());
    if (!ownersBySlug.has(canonicalSlug)) ownersBySlug.set(canonicalSlug, new Set());
    for (const entry of group) {
      if (entry === canonical) continue;
      const aliasSlug = conceptSlugFromRelativePath(entry.relativePath);
      aliases[aliasSlug] = canonicalSlug;
      aliasesByCanonical.get(canonicalSlug).add(aliasSlug);
      for (const owner of ownersBySlug.get(aliasSlug) || []) ownersBySlug.get(canonicalSlug).add(owner);
      ownersBySlug.delete(aliasSlug);
      removed.add(entry.relativePath);
    }
  }

  const kept = entries.filter((entry) => !removed.has(entry.relativePath));
  return {
    entries: kept,
    aliases,
    aliasesByCanonical,
    ownersBySlug,
    duplicateCandidates: findDuplicateCandidates(kept),
  };
}

function chooseCanonicalConcept(group, previousAliases) {
  const previousCanonicals = new Set(Object.values(previousAliases || {}).map(normalizeConceptSlug));
  return [...group].sort((a, b) => {
    const aSlug = conceptSlugFromRelativePath(a.relativePath);
    const bSlug = conceptSlugFromRelativePath(b.relativePath);
    const preferred = Number(previousCanonicals.has(bSlug)) - Number(previousCanonicals.has(aSlug));
    return preferred || aSlug.length - bSlug.length || aSlug.localeCompare(bSlug);
  })[0];
}

function strongConceptIdentityKeys(entry) {
  const identity = conceptIdentity(entry);
  const keys = [];
  let hasBoundIdentity = false;
  for (const value of [identity.resource, identity.uri]) {
    if (String(value || "").trim().toLowerCase().startsWith("okf://llmwiki/")) continue;
    const normalized = normalizeIdentityText(value);
    if (normalized) {
      hasBoundIdentity = true;
      keys.push(`uri:${normalized}`);
    }
  }
  if (hasBoundIdentity) return keys;
  const body = normalizeIdentityText(identity.body);
  if (body.length >= 160) keys.push(`body:${sha256(body)}`);
  const title = normalizeIdentityText(identity.title);
  const description = normalizeIdentityText(identity.description);
  if (title && description.length >= 40) keys.push(`title-description:${title}:${description}`);
  return keys;
}

function conceptIdentity(entry) {
  const lines = entry.text.split(/\r?\n/);
  const body = stripFrontmatterText(entry.text);
  return {
    type: readTopLevelYamlString(lines, "type"),
    title: readTopLevelYamlString(lines, "title") || titleCaseSlug(path.basename(entry.relativePath, ".md")),
    description: readTopLevelYamlString(lines, "description"),
    resource: readTopLevelYamlString(lines, "resource"),
    uri: readTopLevelYamlString(lines, "uri"),
    body,
  };
}

function stripFrontmatterText(text) {
  const match = String(text || "").match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? text.slice(match[0].length) : text;
}

function normalizeIdentityText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .trim();
}

function findDuplicateCandidates(entries) {
  const concepts = entries
    .filter((entry) => isConceptDocument(entry.relativePath))
    .map((entry) => ({ entry, identity: conceptIdentity(entry) }));
  const candidates = [];
  for (let i = 0; i < concepts.length; i += 1) {
    for (let j = i + 1; j < concepts.length; j += 1) {
      const a = concepts[i];
      const b = concepts[j];
      const titleScore = bigramSimilarity(a.identity.title, b.identity.title);
      const bodyScore = bigramSimilarity(a.identity.body.slice(0, 4000), b.identity.body.slice(0, 4000));
      if (titleScore < 0.72 && !(titleScore >= 0.55 && bodyScore >= 0.62)) continue;
      candidates.push({
        left: conceptSlugFromRelativePath(a.entry.relativePath),
        right: conceptSlugFromRelativePath(b.entry.relativePath),
        titleScore: Number(titleScore.toFixed(3)),
        bodyScore: Number(bodyScore.toFixed(3)),
      });
    }
  }
  return candidates
    .sort((a, b) => b.titleScore + b.bodyScore - (a.titleScore + a.bodyScore))
    .slice(0, 50);
}

function bigramSimilarity(left, right) {
  const a = normalizeIdentityText(left).replace(/\s+/g, "");
  const b = normalizeIdentityText(right).replace(/\s+/g, "");
  if (!a || !b) return 0;
  if (a === b) return 1;
  const pairs = (value) => {
    const out = new Set();
    for (let i = 0; i < value.length - 1; i += 1) out.add(value.slice(i, i + 2));
    if (out.size === 0) out.add(value);
    return out;
  };
  const aPairs = pairs(a);
  const bPairs = pairs(b);
  let overlap = 0;
  for (const pair of aPairs) if (bPairs.has(pair)) overlap += 1;
  return (2 * overlap) / (aPairs.size + bPairs.size);
}

function rewriteConceptAliasLinks(text, fromRel, aliases) {
  if (!aliases || Object.keys(aliases).length === 0) return text;
  const fromDir = path.posix.dirname(fromRel) === "." ? "" : path.posix.dirname(fromRel);
  return text.replace(/\]\(([^)#]+\.md)(#[^)]+)?\)/g, (match, rawTarget, hash = "") => {
    if (/^[a-z]+:\/\//i.test(rawTarget)) return match;
    const normalizedTarget = rawTarget.startsWith("/")
      ? path.posix.normalize(rawTarget.slice(1))
      : path.posix.normalize(path.posix.join(fromDir, decodeURI(rawTarget)));
    const slug = conceptSlugFromRelativePath(normalizedTarget);
    const canonical = aliases[slug];
    if (!canonical) return match;
    const canonicalRel = `concepts/${canonical}.md`;
    let nextTarget = path.posix.relative(fromDir, canonicalRel);
    if (!nextTarget) nextTarget = path.posix.basename(canonicalRel);
    return `](${encodeURI(nextTarget)}${hash})`;
  });
}

function upsertGeneratedFrontmatter(text, fields) {
  const lines = String(text || "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return text;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return text;
  const keys = new Set(Object.keys(fields));
  const kept = lines.slice(1, end).filter((line) => {
    if (/^\s/.test(line)) return true;
    const key = line.split(":", 1)[0].trim();
    return !keys.has(key);
  });
  const additions = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}: ${value}`);
  return ["---", ...kept, ...additions, ...lines.slice(end)].join("\n");
}

function portableSourceId(value, bundle) {
  const text = slash(String(value || "")).trim();
  if (!text) return "";
  if (/^okf-source:\/\//i.test(text) || text === "llmwiki:frozen") return text;
  const withoutScheme = text.replace(/^file:/i, "").replace(/^\/+/, "");
  const marker = `/okf-rag-workspace/raw/${String(bundle).toLowerCase()}/`;
  const normalized = `/${withoutScheme}`;
  const markerIndex = normalized.toLowerCase().indexOf(marker);
  const relative = markerIndex >= 0
    ? normalized.slice(markerIndex + marker.length)
    : path.posix.basename(withoutScheme);
  return `okf-source://${bundle}/${relative.replace(/^\/+/, "")}`;
}

function makePublishedProvenancePortable(text, relativePath, bundle) {
  if (!/^references\/.+\.md$/i.test(slash(relativePath))) return text;
  const lines = String(text || "").split(/\r?\n/);
  const sourceRelativePath =
    readTopLevelYamlString(lines, "x-okf-rag-relative-path") || path.posix.basename(relativePath);
  return upsertGeneratedFrontmatter(text, {
    source: yamlString(portableSourceId(`file:${sourceRelativePath}`, bundle)),
    "x-okf-rag-source-path": undefined,
  });
}

function extractBundleReferenceLinks(text, fromRelativePath) {
  const references = new Set();
  const body = String(text || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "");
  const linkPattern = /\[[^\]]+\]\(([^)]+\.md(?:#[^)]+)?)\)/gi;
  let match;
  while ((match = linkPattern.exec(body)) !== null) {
    const target = resolveMarkdownTarget(fromRelativePath, match[1]);
    if (!/^references\/.+\.md$/i.test(target)) continue;
    const fromDir = path.posix.dirname(slash(fromRelativePath));
    references.add(path.posix.relative(fromDir === "." ? "" : fromDir, target));
  }
  return [...references].sort();
}

function portableManifestPath(value, root) {
  const text = String(value || "");
  if (!path.isAbsolute(text)) return slash(text);
  const relative = path.relative(path.resolve(root), path.resolve(text));
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return slash(relative);
  return path.basename(text);
}

function buildGeneratedBundleIndex(bundle, conceptEntries) {
  const rows = conceptEntries
    .map((entry) => {
      const identity = conceptIdentity(entry);
      return {
        relativePath: entry.relativePath,
        title: identity.title,
        description: identity.description || "OKF concept",
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title) || a.relativePath.localeCompare(b.relativePath))
    .map((entry) => `* [${entry.title}](${encodeURI(entry.relativePath)}) - ${entry.description}`);
  return `---\nokf_version: "0.1"\n---\n\n# ${titleCaseSlug(bundle)}\n\n${rows.join("\n")}\n`;
}

function refreshOkfsCatalogIndex(okfsDir) {
  fs.mkdirSync(okfsDir, { recursive: true });
  const rows = [];
  for (const entry of fs.readdirSync(okfsDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(okfsDir, entry.name);
    if (entry.isDirectory()) {
      const concepts = walkFiles(full).filter(
        (file) => file.toLowerCase().endsWith(".md") && isConceptDocument(slash(path.relative(full, file)))
      );
      if (concepts.length === 0) continue;
      rows.push({
        key: `dir:${entry.name}`,
        line: `* [${titleCaseSlug(entry.name)}](${encodeURI(entry.name)}/) - ${concepts.length} concepts.`,
      });
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md") || entry.name === "index.md") {
      continue;
    }
    const concept = conceptIdentity({ relativePath: entry.name, text: fs.readFileSync(full, "utf8") });
    rows.push({
      key: `file:${entry.name}`,
      line: `* [${concept.title}](${encodeURI(entry.name)}) - ${concept.description || "OKF concept."}`,
    });
  }
  rows.sort((left, right) => left.key.localeCompare(right.key));
  const indexPath = path.join(okfsDir, "index.md");
  if (rows.length === 0) {
    if (fs.existsSync(indexPath)) fs.rmSync(indexPath, { force: true });
    return { path: indexPath, status: "removed-empty", entries: 0 };
  }
  const text = `# OKF Knowledge Bundles\n\n${rows.map((row) => row.line).join("\n")}\n`;
  const previous = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : "";
  if (previous === text) return { path: indexPath, status: "unchanged", entries: rows.length };
  fs.writeFileSync(indexPath, text, "utf8");
  return { path: indexPath, status: "written", entries: rows.length };
}

function validatePreparedBundle(root, concepts) {
  for (const concept of concepts) {
    const target = path.join(root, concept.relativePath.split("/").join(path.sep));
    if (!fs.existsSync(target)) throw new Error(`staged concept missing: ${concept.relativePath}`);
    const text = fs.readFileSync(target, "utf8");
    const type = readTopLevelYamlString(text.split(/\r?\n/), "type");
    if (!type) throw new Error(`staged concept has no type: ${concept.relativePath}`);
  }
  if (concepts.length > 0 && !fs.existsSync(path.join(root, "index.md"))) {
    throw new Error("staged multi-concept bundle has no index.md");
  }
  if (concepts.length > 0) {
    const indexText = fs.readFileSync(path.join(root, "index.md"), "utf8");
    if (!/^---\r?\nokf_version:\s*["']?0\.1["']?\r?\n---/u.test(indexText)) {
      throw new Error("staged bundle index.md does not declare okf_version 0.1");
    }
  }
  validateNoHostAbsolutePaths(root);
  validateLocalMarkdownLinks(root);
}

function validateNoHostAbsolutePaths(root) {
  const markdownFiles = walkFiles(root).filter((file) => file.toLowerCase().endsWith(".md"));
  const drivePath = /(^|[^A-Za-z0-9+.-])(?:file:(?:\/\/\/?)?)?[A-Za-z]:[\\/]/;
  const uncPath = /(^|[\s"'([{])\\\\[^\\\s]+\\[^\\\s]+/;
  const absoluteFileUri = /file:\/\/\/(?:[A-Za-z]:\/|\/)/i;
  for (const file of markdownFiles) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const lineIndex = lines.findIndex(
      (line) => drivePath.test(line) || uncPath.test(line) || absoluteFileUri.test(line)
    );
    if (lineIndex < 0) continue;
    const relativePath = slash(path.relative(root, file));
    throw new Error(
      `staged OKF contains a host absolute path: ${relativePath}:${lineIndex + 1}`
    );
  }
}

function validateLocalMarkdownLinks(root) {
  const markdownFiles = walkFiles(root).filter((file) => file.toLowerCase().endsWith(".md"));
  const wikilinkTargets = new Map();
  const registerWikilinkTarget = (key, relativePath) => {
    const normalized = normalizeIdentityText(key);
    if (!normalized) return;
    if (!wikilinkTargets.has(normalized)) wikilinkTargets.set(normalized, relativePath);
    else if (wikilinkTargets.get(normalized) !== relativePath) wikilinkTargets.set(normalized, null);
  };
  for (const file of markdownFiles) {
    const relativePath = slash(path.relative(root, file));
    const withoutExtension = relativePath.replace(/\.md$/i, "");
    const text = fs.readFileSync(file, "utf8");
    const title =
      readTopLevelYamlString(text.split(/\r?\n/), "title") ||
      /^#\s+(.+)$/m.exec(stripFrontmatterText(text))?.[1] ||
      path.posix.basename(withoutExtension);
    registerWikilinkTarget(withoutExtension, relativePath);
    registerWikilinkTarget(path.posix.basename(withoutExtension), relativePath);
    registerWikilinkTarget(title, relativePath);
  }
  for (const file of markdownFiles) {
    const relativePath = slash(path.relative(root, file));
    const text = fs
      .readFileSync(file, "utf8")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/~~~[\s\S]*?~~~/g, "");
    const linkPattern = /\[[^\]]+\]\(([^)]+\.md(?:#[^)]+)?)\)/gi;
    let match;
    while ((match = linkPattern.exec(text)) !== null) {
      const target = resolveMarkdownTarget(relativePath, match[1]);
      if (!target) continue;
      const targetPath = path.resolve(root, target.split("/").join(path.sep));
      ensureInside(root, targetPath, "staged Markdown link target");
      if (!fs.existsSync(targetPath)) {
        throw new Error(`staged Markdown link is broken: ${relativePath} -> ${target}`);
      }
    }
    const wikilinkPattern = /\[\[([^\]]+)\]\]/g;
    while ((match = wikilinkPattern.exec(text)) !== null) {
      const rawTarget = match[1].split("|", 1)[0].split("#", 1)[0].trim();
      if (!rawTarget || /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) continue;
      const normalizedTarget = slash(rawTarget).replace(/\.md$/i, "");
      const fromDir = path.posix.dirname(relativePath);
      const direct = normalizedTarget.startsWith("/")
        ? `${normalizedTarget.replace(/^\/+/, "")}.md`
        : path.posix.normalize(
            path.posix.join(fromDir === "." ? "" : fromDir, `${normalizedTarget}.md`)
          );
      const resolved = fs.existsSync(path.resolve(root, direct.split("/").join(path.sep)))
        ? direct
        : wikilinkTargets.get(normalizeIdentityText(normalizedTarget));
      if (!resolved) {
        throw new Error(`staged Obsidian wikilink is broken: ${relativePath} -> ${rawTarget}`);
      }
    }
  }
}

function publishStagedDirectory(options) {
  const backupDir = path.join(
    options.root,
    ".okf-rag",
    "publish-backups",
    `${options.bundle}-${options.generationId}`
  );
  safeRemoveDerivedDir(backupDir, options.root, "OKF publish backup");
  fs.mkdirSync(path.dirname(options.targetBundleDir), { recursive: true });
  let movedExisting = false;
  try {
    if (fs.existsSync(options.targetBundleDir)) {
      fs.mkdirSync(path.dirname(backupDir), { recursive: true });
      fs.renameSync(options.targetBundleDir, backupDir);
      movedExisting = true;
    }
    fs.renameSync(options.stagingDir, options.targetBundleDir);
  } catch (error) {
    if (!fs.existsSync(options.targetBundleDir) && movedExisting && fs.existsSync(backupDir)) {
      fs.renameSync(backupDir, options.targetBundleDir);
    }
    throw error;
  }
  safeRemoveDerivedDir(backupDir, options.root, "completed OKF publish backup");
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function writeGenerationHistory(root, bundle, generationId, manifest, targetBundleDir) {
  const historyRoot = path.join(root, ".okf-rag", "generations", bundle);
  const generationDir = path.join(historyRoot, generationId);
  safeRemoveDerivedDir(generationDir, root, "existing OKF generation snapshot");
  fs.mkdirSync(generationDir, { recursive: true });
  atomicWriteJson(path.join(generationDir, "manifest.json"), manifest);
  if (fs.existsSync(targetBundleDir)) {
    fs.cpSync(targetBundleDir, path.join(generationDir, "bundle"), {
      recursive: true,
      force: true,
    });
  }
  const generations = fs
    .readdirSync(historyRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const stale of generations.slice(5)) {
    safeRemoveDerivedDir(path.join(historyRoot, stale), root, "expired OKF generation snapshot");
  }
}

function pruneEmptyDirs(root, current) {
  if (!fs.existsSync(current)) return;
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.isDirectory()) pruneEmptyDirs(root, path.join(current, entry.name));
  }
  if (path.resolve(root) !== path.resolve(current) && fs.readdirSync(current).length === 0) {
    fs.rmdirSync(current);
  }
}

function isConceptDocument(rel) {
  const parts = rel.split("/");
  const name = parts[parts.length - 1].toLowerCase();
  if (name === "index.md" || name === "log.md") return false;
  if (parts.includes("references")) return false;
  return true;
}

function ensureRecallFields(text, bundle, rel) {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return text;
  const lines = text.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return text;

  const fmLines = lines.slice(1, end);
  const bodyLines = lines.slice(end);
  const hasKey = (key) => fmLines.some((line) => new RegExp(`^${escapeRegExp(key)}\\s*:`).test(line));
  const resource = `okf://llmwiki/${bundle}/${rel.replace(/\.md$/i, "").replace(/\/index$/i, "")}`;
  const title = readTopLevelYamlString(fmLines, "title") || titleCaseSlug(path.basename(rel, ".md"));
  const additions = [];
  if (!hasKey("resource")) additions.push(`resource: ${resource}`);
  if (!hasKey("uri")) additions.push(`uri: ${resource}`);
  if (!hasKey("disclosure")) {
    additions.push(
      `disclosure: When an agent needs the llmwiki-compiled OKF concept "${escapeYamlDoubleQuoted(title)}" from bundle "${escapeYamlDoubleQuoted(bundle)}".`
    );
  }
  if (additions.length === 0) return text;
  return ["---", ...fmLines, ...additions, ...bodyLines].join("\n");
}

function readTopLevelYamlString(lines, key) {
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*:\\s*(.+?)\\s*$`);
  for (const line of lines) {
    if (/^\s/.test(line)) continue;
    const match = line.match(pattern);
    if (!match) continue;
    return unquote(match[1]);
  }
  return "";
}

function unquote(value) {
  let text = String(value || "").trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  return text;
}

function rewriteBundleAbsoluteLinks(text, fromRel) {
  const fromDir = path.posix.dirname(fromRel) === "." ? "." : path.posix.dirname(fromRel);
  return text.replace(/\]\(\/([^)#]+?\.md)(#[^)]+)?\)/g, (match, targetRel, hash = "") => {
    const normalizedTarget = targetRel.replace(/\\/g, "/").replace(/^\/+/, "");
    let relative = path.posix.relative(fromDir, normalizedTarget);
    if (!relative || relative === "") relative = path.posix.basename(normalizedTarget);
    return `](${relative}${hash})`;
  });
}

function stripResidualWikilinks(text) {
  const fence = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
  return text
    .split(fence)
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      return segment
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
        .replace(/\[\[([^\]]+)\]\]/g, "$1");
    })
    .join("");
}

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function safeRemoveDerivedDir(target, root, label) {
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) return;
  const derivedRoot = path.join(path.resolve(root), ".okf-rag");
  ensureInside(derivedRoot, resolved, label);
  if (path.resolve(derivedRoot) === resolved) {
    throw new Error(`refusing to remove entire .okf-rag directory for ${label}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function removeExportDirIfSafe(target, root) {
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) return;
  const derivedRoot = path.join(path.resolve(root), ".okf-rag");
  if (!isInside(derivedRoot, resolved) || path.resolve(derivedRoot) === resolved) {
    console.log(`export: keeping existing custom output dir ${resolved}`);
    return;
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function ensureInside(parent, child, label) {
  if (isInside(parent, child)) return;
  throw new Error(`refusing ${label} outside ${parent}: ${child}`);
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function copyDir(source, target) {
  if (!fs.existsSync(source)) throw new Error(`workspace not found: ${source}`);
  const sourceRoot = path.resolve(source);
  const targetRoot = path.resolve(target);
  if (sourceRoot === targetRoot) return { copied: 0, unchanged: 0, deleted: 0 };
  const driveRoot = path.parse(targetRoot).root;
  const targetDepth = path.relative(driveRoot, targetRoot).split(path.sep).filter(Boolean).length;
  if (targetRoot === driveRoot || targetDepth < 2) {
    throw new Error(`refusing to mirror into unsafe target: ${targetRoot}`);
  }
  const stats = { copied: 0, unchanged: 0, deleted: 0 };
  syncDirectoryExact(sourceRoot, targetRoot, stats);
  return stats;
}

function syncDirectoryExact(source, target, stats) {
  fs.mkdirSync(target, { recursive: true });
  const sourceEntries = new Map(
    fs.readdirSync(source, { withFileTypes: true }).map((entry) => [entry.name, entry])
  );
  for (const targetEntry of fs.readdirSync(target, { withFileTypes: true })) {
    if (sourceEntries.has(targetEntry.name)) continue;
    fs.rmSync(path.join(target, targetEntry.name), { recursive: true, force: true });
    stats.deleted += 1;
  }
  for (const entry of sourceEntries.values()) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (fs.existsSync(targetPath) && !fs.statSync(targetPath).isDirectory()) {
        fs.rmSync(targetPath, { force: true });
      }
      syncDirectoryExact(sourcePath, targetPath, stats);
      continue;
    }
    if (!entry.isFile()) continue;
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
      const sourceHash = sha256Buffer(fs.readFileSync(sourcePath));
      const targetHash = sha256Buffer(fs.readFileSync(targetPath));
      if (sourceHash === targetHash) {
        stats.unchanged += 1;
        continue;
      }
    } else if (fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    stats.copied += 1;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeYamlDoubleQuoted(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function printSummary(summary) {
  console.log("");
  console.log(`llmwiki OKF bundle: ${summary.bundle}`);
  console.log(`project: ${summary.projectDir}`);
  if (summary.projectEnv.exists) {
    console.log(`llm config: ${summary.projectEnv.file}`);
    if (summary.projectEnv.configuredKeys.length > 0) {
      console.log(`llm config keys: ${summary.projectEnv.configuredKeys.join(", ")}`);
    }
  }
  if (summary.sourceSync) {
    console.log(
      `raw md -> sources: ${summary.sourceSync.total} ` +
        `(created=${summary.sourceSync.created}, updated=${summary.sourceSync.updated}, ` +
        `unchanged=${summary.sourceSync.unchanged}, deleted=${summary.sourceSync.deleted})`
    );
  }
  if (summary.fastSkipped) {
    console.log("fast-skip: source content and published generation are unchanged.");
  }
  if (summary.generation) {
    console.log(
      `generation: ${summary.generation.id} (${summary.generation.status}, concepts=${summary.generation.conceptCount})`
    );
  }
  if (summary.conceptCatalog?.duplicateCandidates?.length) {
    console.log(
      `dedupe review candidates: ${summary.conceptCatalog.duplicateCandidates.length}`
    );
  }
  if (!summary.exportDir || summary.syncedFiles.length === 0) {
    return;
  }
  console.log(`export: ${summary.exportDir}`);
  console.log(`synced: ${summary.targetBundleDir}`);
  console.log(`files: ${summary.syncedFiles.length}`);
  for (const file of summary.syncedFiles.slice(0, 20)) {
    console.log(`- ${file.status}: ${file.path}`);
  }
  if (summary.syncedFiles.length > 20) {
    console.log(`- ... ${summary.syncedFiles.length - 20} more`);
  }
  if (summary.dryRun) {
    console.log("dry-run: OKF workspace, Rust ingest, and mirror copy were not modified.");
  }
  if (summary.mirroredTo) {
    console.log(`mirrored: ${summary.mirroredTo}`);
    if (summary.mirror) {
      console.log(
        `mirror files: copied=${summary.mirror.copied}, unchanged=${summary.mirror.unchanged}, deleted=${summary.mirror.deleted}`
      );
    }
  }
}

function runCli() {
  try {
    main();
  } catch (error) {
    const message = sanitizeDiagnosticText(
      error instanceof Error ? error.message : String(error)
    );
    updatePipelineState("failed", "failed", {
      error: message,
    });
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

if (require.main === module) runCli();

module.exports = {
  buildLlmwikiConceptCatalog,
  canFastSkip,
  copyDir,
  ensureWorkspaceRuntime,
  pruneStaleProjectConcepts,
  reconcileExactDuplicateConcepts,
  managedBundleComplete,
  refreshOkfsCatalogIndex,
  runCli,
  syncMarkdownSources,
  atomicWriteJson,
  publishStagedDirectory,
  syncOkfBundle,
  writeGenerationHistory,
};
