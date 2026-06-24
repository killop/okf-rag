#!/usr/bin/env node
// Initializes the local OKF-RAG directory scaffold after git clone.
const fs = require("fs");
const path = require("path");

const RUNTIME_FILES = [
  "okf-rag.exe",
  "onnxruntime.dll",
  "onnxruntime_providers_shared.dll",
  "zvec_c_api.dll",
];

function parseArgs(argv) {
  const args = {
    root: path.resolve(__dirname, ".."),
    runtimeSource: null,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        throw new Error("--root requires a value");
      }
      args.root = path.resolve(value);
    } else if (arg === "--runtime-source") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        throw new Error("--runtime-source requires a value");
      }
      args.runtimeSource = path.resolve(value);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/setup_okf_rag_workspace.js [--root DIR] [--runtime-source DIR]

Creates the local OKF-RAG workspace scaffold and copies the prebuilt runtime
into okf-rag-workspace/bin when release artifacts are available. This script
does not create, edit, or validate .codex/config.toml. Codex MCP setup is
documented in setup-for-agent.md and should be applied manually.`);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  console.log(`dir: ${dirPath}`);
}

function writeFileIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) {
    console.log(`keep: ${filePath}`);
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  console.log(`file: ${filePath}`);
}

function hasRuntimeFiles(dirPath) {
  return RUNTIME_FILES.every((fileName) => fs.existsSync(path.join(dirPath, fileName)));
}

function firstRuntimeSource(rootPath, runtimeSource) {
  if (runtimeSource) {
    if (!hasRuntimeFiles(runtimeSource)) {
      throw new Error(`Missing one or more runtime artifacts in: ${runtimeSource}`);
    }
    return runtimeSource;
  }

  const scriptRoot = path.resolve(__dirname, "..");
  const candidates = [
    path.join(rootPath, "target", "release"),
    path.join(scriptRoot, "target", "release"),
    path.join(rootPath, "okf-rag-workspace", "bin"),
    path.join(scriptRoot, "okf-rag-workspace", "bin"),
  ];

  return candidates.find((candidate) => hasRuntimeFiles(candidate)) || null;
}

function copyFileIfChanged(source, destination) {
  if (path.resolve(source).toLowerCase() === path.resolve(destination).toLowerCase()) {
    console.log(`keep: ${destination}`);
    return;
  }

  if (fs.existsSync(destination)) {
    const sourceStat = fs.statSync(source);
    const destinationStat = fs.statSync(destination);
    if (
      sourceStat.size === destinationStat.size &&
      sourceStat.mtimeMs <= destinationStat.mtimeMs
    ) {
      console.log(`keep: ${destination}`);
      return;
    }
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  console.log(`runtime: ${destination}`);
}

function copyRuntimeArtifacts(rootPath, runtimeSource) {
  const sourceDir = firstRuntimeSource(rootPath, runtimeSource);
  const destinationDir = path.join(rootPath, "okf-rag-workspace", "bin");

  if (!sourceDir) {
    console.log("runtime: not found; build release or pass --runtime-source, then rerun setup");
    return;
  }

  for (const fileName of RUNTIME_FILES) {
    copyFileIfChanged(path.join(sourceDir, fileName), path.join(destinationDir, fileName));
  }
}

function main() {
  const args = parseArgs(process.argv);
  const rootPath = path.resolve(args.root);

  const dirs = [
    ".okf-rag",
    ".okf-rag/models",
    "okf-rag-workspace",
    "okf-rag-workspace/bin",
    "okf-rag-workspace/okfs",
  ];

  for (const dir of dirs) {
    ensureDir(path.join(rootPath, dir));
  }

  writeFileIfMissing(
    path.join(rootPath, ".okf-rag", ".gitkeep"),
    "",
  );

  writeFileIfMissing(
    path.join(rootPath, ".okf-rag", "README.md"),
    [
      "# .okf-rag",
      "",
      "Derived runtime state for OKF-RAG.",
      "",
      "Generated indexes, caches, reports, lock files, and watcher state live here.",
      "Do not treat this directory as source truth. Source OKF Markdown belongs under `okf-rag-workspace/okfs/`.",
      "",
    ].join("\n"),
  );

  writeFileIfMissing(
    path.join(rootPath, "okf-rag-workspace", "README.md"),
    [
      "# okf-rag-workspace",
      "",
      "User-authored OKF Markdown lives under `okfs/`.",
      "",
      "The workspace-local runtime entrypoint lives under `bin/` when prebuilt artifacts are available.",
      "",
      "Generated indexes and caches belong under `../.okf-rag/`, not here.",
      "",
    ].join("\n"),
  );

  writeFileIfMissing(
    path.join(rootPath, "okf-rag-workspace", "bin", "README.md"),
    [
      "# OKF-RAG Runtime",
      "",
      "Setup and release packaging place the runnable MCP executable and required DLLs here:",
      "",
      "```text",
      "okf-rag-workspace/bin/okf-rag.exe",
      "okf-rag-workspace/bin/onnxruntime.dll",
      "okf-rag-workspace/bin/onnxruntime_providers_shared.dll",
      "okf-rag-workspace/bin/zvec_c_api.dll",
      "```",
      "",
      "Point MCP hosts at this workspace-local executable, not at a repository build directory.",
      "",
    ].join("\n"),
  );

  writeFileIfMissing(
    path.join(rootPath, "okf-rag-workspace", "index.md"),
    [
      "# OKF-RAG Workspace",
      "",
      "- `okfs/`: OKF Markdown source of truth.",
      "- `../.okf-rag/`: generated runtime state.",
      "",
    ].join("\n"),
  );

  writeFileIfMissing(
    path.join(rootPath, "okf-rag-workspace", "okfs", "index.md"),
    [
      "# OKF Sources",
      "",
      "Place OKF Markdown files in this directory, then run:",
      "",
      "```powershell",
      "okf-rag-workspace\\bin\\okf-rag.exe ingest --force",
      "```",
      "",
    ].join("\n"),
  );

  writeFileIfMissing(
    path.join(rootPath, "okf-rag-workspace", "okfs", "local-first-okf-rag-demo.md"),
    [
      "---",
      "type: OKF",
      "title: Local-First OKF-RAG Demo",
      "description: Demonstrates the portable OKF-RAG workspace layout, local indexing, and project-scoped MCP setup.",
      "tags: [okf, demo, local-first, mcp, zvec]",
      "timestamp: 2026-06-24T00:00:00+08:00",
      "uri: okf://demo/local-first-okf-rag",
      "disclosure: When testing whether a fresh OKF-RAG workspace can ingest, query, and expose local MCP memory.",
      "---",
      "",
      "# Local-First OKF-RAG Demo",
      "",
      "This demo OKF proves that the workspace contains at least one portable, indexable OKF memory document.",
      "",
      "## Objective 1: Make a fresh workspace queryable",
      "",
      "The workspace should become searchable without remote embedding APIs or project-specific hardcoding.",
      "",
      "### Key Results",
      "",
      "- KR1. `okf-rag-workspace\\bin\\okf-rag.exe ingest --root . --force` builds a local index from `okf-rag-workspace/okfs/`.",
      "- KR2. `okf-rag-workspace\\bin\\okf-rag.exe status --root .` reports at least one indexed concept.",
      "- KR3. `okf-rag-workspace\\bin\\okf-rag.exe query --root . \"local first okf rag demo\"` returns this OKF.",
      "",
      "## Evidence",
      "",
      "- `setup-for-agent.md`: Agent setup and MCP config location.",
      "",
      "## Retrieval Notes",
      "",
      "- Recall this OKF for setup smoke tests, project-local MCP config, local indexing, and demo workspace validation.",
      "",
    ].join("\n"),
  );

  copyRuntimeArtifacts(rootPath, args.runtimeSource);

  console.log("Codex MCP config was not changed. See setup-for-agent.md for manual project-local Codex setup.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
