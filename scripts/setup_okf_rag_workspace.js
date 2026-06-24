#!/usr/bin/env node
// Initializes the local OKF-RAG directory scaffold after git clone.
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    root: path.resolve(__dirname, ".."),
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        throw new Error("--root requires a value");
      }
      args.root = path.resolve(value);
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
  console.log(`Usage: node scripts/setup_okf_rag_workspace.js [--root DIR]

Creates the local OKF-RAG scaffold after git clone. This script does not create,
edit, or validate .codex/config.toml. Codex MCP setup is documented in
setup-for-agent.md and should be applied manually.`);
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

function main() {
  const args = parseArgs(process.argv);
  const rootPath = path.resolve(args.root);

  const dirs = [
    ".okf-rag",
    ".okf-rag/models",
    ".codex",
    "okf-rag",
    "okf-rag-workspace",
    "okf-rag-workspace/okfs",
    "dist",
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
    path.join(rootPath, ".codex", "config.toml.example"),
    [
      "[mcp_servers.okf-rag]",
      'type = "stdio"',
      'command = ".\\\\target\\\\release\\\\okf-rag.exe"',
      'args = ["mcp", "--root", "."]',
      "",
    ].join("\n"),
  );

  writeFileIfMissing(
    path.join(rootPath, "okf-rag", "README.md"),
    [
      "# okf-rag",
      "",
      "Source scaffold for the OKF-RAG Rust project.",
      "",
      "In this workspace layout, the active Rust crate lives under `crates/okf-rag/`.",
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
      "Generated indexes and caches belong under `.okf-rag/`, not here.",
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
      "target\\release\\okf-rag.exe ingest --force",
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
      "nocturne:",
      "  uri: okf://demo/local-first-okf-rag",
      "  disclosure: When testing whether a fresh OKF-RAG workspace can ingest, query, and expose local MCP memory.",
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
      "- KR1. `target\\release\\okf-rag.exe ingest --root . --force` builds a local index from `okf-rag-workspace/okfs/`.",
      "- KR2. `target\\release\\okf-rag.exe status --root .` reports at least one indexed concept.",
      "- KR3. `target\\release\\okf-rag.exe query --root . \"local first okf rag demo\"` returns this OKF.",
      "",
      "## Evidence",
      "",
      "- `setup-for-agent.md`: Agent setup and MCP config location.",
      "- `.codex/config.toml.example`: Project-local MCP config template.",
      "",
      "## Retrieval Notes",
      "",
      "- Recall this OKF for setup smoke tests, project-local MCP config, local indexing, and demo workspace validation.",
      "",
    ].join("\n"),
  );

  console.log("Codex MCP config was not changed. See setup-for-agent.md for manual project-local Codex setup.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
